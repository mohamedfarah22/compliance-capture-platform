// Scheduled Edge Function — reconciles the compliance-media bucket against
// ttr.stored_images so privacy policy §3 ("we keep one copy of your identification on
// file") holds durably rather than only at the moment a transaction completes.
//
// §3 currently depends on every write path being correct forever. Three were not:
// cleanup-stale-drafts silently skipped drafts holding images, a failed supersede never
// retried (it is non-fatal by design, so a storage hiccup cannot roll back a completed
// legal record), and nothing compared bucket against table in either direction.
//
// ─── SAFETY POSTURE — this function deletes ID images ──────────────────────────────
//
// 1. DRY RUN BY DEFAULT. {apply:false} reports only. Schedule with apply:true only after a
//    report has been reviewed against real data.
// 2. NEVER delete a ttr.stored_images row. It carries content_hash_sha256,
//    captured_by_staff_id and captured_at — the seven-year AML/CTF evidence that a document
//    was sighted, by whom, when, and what it hashed to. Tidying a bucket never justifies
//    destroying that.
// 3. Duplicate detection groups on CHAIN ROOT, never document number — see
//    ttr.find_unsuperseded_duplicates. The document-number key deletes a different
//    person's ID (UAT finding #15).
// 4. NEVER remediate a row whose object is missing. An image cannot be recreated, and
//    deleting the row erases the proof it existed. Report it for a human.
//
// ─── gold-goods (gold goods photos, spec 4.4) ──────────────────────────────────────
// The private gold-goods bucket holds {purchase_id}/goods-{n}.jpg, one gold.goods_photos row
// each. gold-save-purchase uploads the objects before its one database transaction, so a
// failed save whose cleanup also failed leaves objects with no row. The same rules apply:
// objects with no row are reported and, with apply, removed (never one under an hour old,
// which may be a save in flight); rows are never deleted, and a row whose object is missing
// is only reported; a listing that fails aborts the run.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { supersedeImages, STORAGE_BUCKET } from "../_shared/supersede.ts";
import type { StorageOwner, SupabaseSchema } from "../_shared/supersede.ts";
import { GOLD_GOODS_BUCKET } from "../_shared/goldPurchaseShared.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STORAGE_LIST_LIMIT = 100;
// Customer-owned ID photos (gold) live under customers/{customer_id}/{verification_id}/…,
// not in a transaction folder. "customers" is therefore a top-level folder that is not a
// transaction: without special handling it would be reported as a dangling folder, and its
// objects (three levels deep, so never seen by the per-transaction listing) would be
// invisible to the orphan and missing-object checks.
const CUSTOMERS_FOLDER = "customers";
// An uploaded customer photo exists for a moment before its row is written (the upload
// function uploads, then inserts; gold create-customer uploads, then runs its SQL). An
// unmatched object younger than this is in flight, not an orphan, and must never be deleted.
const CUSTOMER_OBJECT_GRACE_MS = 60 * 60 * 1000;
const CUSTOMER_LIST_MAX_DEPTH = 4;
// gold-goods is {purchase_id}/{file}: one folder level.
const GOLD_LIST_MAX_DEPTH = 2;
const DEFAULT_WINDOW_DAYS = 30;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export interface ReconcileReport {
  mode: "dry-run" | "apply";
  scanned: { folders: number; objectsInspected: number; windowDays: number | "full" };
  orphanObjects: { count: number; paths: string[]; deleted: number };
  missingObjects: { count: number; imageIds: string[] };
  unsupersededCopies: { count: number; imageIds: string[]; superseded: number };
  danglingFolders: { count: number; folders: string[]; deleted: number };
  goldGoods: {
    objectsInspected: number;
    orphanObjects: { count: number; paths: string[]; deleted: number };
    missingObjects: { count: number; photoIds: string[] };
  };
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // This function deletes ID images with the service role and reports every entity's
  // image paths, so only a caller holding the service-role key may run it.
  const auth = req.headers.get("Authorization");
  if (!auth || auth !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  let apply = false;
  let full = false;
  let windowDays = DEFAULT_WINDOW_DAYS;
  try {
    const body = await req.json().catch(() => ({}));
    apply = body.apply === true;
    full = body.full === true;
    if (typeof body.sinceDays === "number" && body.sinceDays > 0) windowDays = body.sinceDays;
  } catch {
    // An empty or unparseable body means the safe defaults, which is the point of them.
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const report = await reconcile(
    serviceClient as unknown as StorageOwner & StorageLister,
    serviceClient.schema("ttr") as unknown as ReconcileSchema,
    { apply, full, windowDays, gold: serviceClient.schema("gold") as unknown as ReconcileSchema },
  );

  console.log("reconcile-stored-images complete:", JSON.stringify(report));
  return json(report, 200);
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}

// ─── Structural types, so tests can pass fakes ────────────────────────────────

export interface StorageLister {
  storage: {
    from: (bucket: string) => {
      list: (
        prefix: string,
        options: { limit: number; offset: number },
      ) => PromiseLike<{ data: { name: string; id?: string | null; created_at?: string | null }[] | null; error: unknown }>;
      remove: (paths: string[]) => PromiseLike<{ error: unknown }>;
    };
  };
}

type Rows = { data: Record<string, unknown>[] | null; error: unknown };
export interface ReconcileSchema extends SupabaseSchema {
  rpc?: (name: string) => PromiseLike<Rows>;
}

export interface ReconcileDeps {
  apply: boolean;
  full: boolean;
  windowDays: number;
  // Injected so tests need not stub the whole client surface.
  listFolders?: () => Promise<string[]>;
  listObjects?: (folder: string) => Promise<string[]>;
  // Every object under customers/. `recent` marks one young enough to be mid-upload.
  listCustomerObjects?: () => Promise<{ path: string; recent: boolean }[]>;
  loadTransactions?: () => Promise<{ id: string; created_at: string | null }[]>;
  loadImageRows?: () => Promise<{ id: string; object_path: string; superseded_at: string | null }[]>;
  loadDuplicates?: () => Promise<
    { image_id: string; object_path: string; replacement_image_id: string }[]
  >;
  // gold-goods. The sweep runs only when it can read gold.goods_photos: through `gold` (the
  // service client's gold schema) or an injected loader. Without either it is skipped.
  gold?: ReconcileSchema;
  loadGoldPhotoRows?: () => Promise<{ id: string; object_path: string }[]>;
  listGoldObjects?: () => Promise<{ path: string; recent: boolean }[]>;
}

// ─── The sweep ────────────────────────────────────────────────────────────────

export async function reconcile(
  client: StorageOwner & StorageLister,
  ttr: ReconcileSchema,
  deps: ReconcileDeps,
): Promise<ReconcileReport> {
  const { apply, full, windowDays } = deps;
  const report: ReconcileReport = {
    mode: apply ? "apply" : "dry-run",
    scanned: { folders: 0, objectsInspected: 0, windowDays: full ? "full" : windowDays },
    orphanObjects: { count: 0, paths: [], deleted: 0 },
    missingObjects: { count: 0, imageIds: [] },
    unsupersededCopies: { count: 0, imageIds: [], superseded: 0 },
    danglingFolders: { count: 0, folders: [], deleted: 0 },
    goldGoods: {
      objectsInspected: 0,
      orphanObjects: { count: 0, paths: [], deleted: 0 },
      missingObjects: { count: 0, photoIds: [] },
    },
  };

  // ── Class 3: duplicates that should be superseded. DB only, so always run in full.
  const duplicates = deps.loadDuplicates
    ? await deps.loadDuplicates()
    : await loadDuplicates(ttr);

  report.unsupersededCopies.count = duplicates.length;
  report.unsupersededCopies.imageIds = duplicates.map((d) => d.image_id);

  if (apply && duplicates.length > 0) {
    // Grouped by replacement so each supersede records what actually replaced it.
    const byReplacement = new Map<string, string[]>();
    for (const d of duplicates) {
      const list = byReplacement.get(d.replacement_image_id) ?? [];
      list.push(d.image_id);
      byReplacement.set(d.replacement_image_id, list);
    }
    for (const [replacement, ids] of byReplacement) {
      const result = await supersedeImages(client, ttr, ids, replacement);
      report.unsupersededCopies.superseded += result.superseded.length;
    }
  }

  // ── Class 4: folders with no transaction. One top-level listing, so always full.
  // customers/ is not a transaction folder (see CUSTOMERS_FOLDER); it is swept separately below.
  const folders = (deps.listFolders ? await deps.listFolders() : await listFolders(client))
    .filter((f) => f !== CUSTOMERS_FOLDER);
  report.scanned.folders = folders.length;

  const transactions = deps.loadTransactions
    ? await deps.loadTransactions()
    : await loadTransactions(ttr);
  const transactionIds = new Set(transactions.map((t) => t.id));

  const dangling = folders.filter((f) => !transactionIds.has(f));
  report.danglingFolders.count = dangling.length;
  report.danglingFolders.folders = dangling;

  // ── Classes 1 and 2: per-folder object listing, so windowed unless full.
  //
  // Listing objects inside every folder grows with every transaction ever made. A window
  // keeps the nightly run flat; {full:true} is for a periodic deep audit.
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();
  const recent = new Set(
    transactions.filter((t) => !t.created_at || t.created_at >= since).map((t) => t.id),
  );
  const inspect = full ? folders : folders.filter((f) => recent.has(f));

  const imageRows = deps.loadImageRows ? await deps.loadImageRows() : await loadImageRows(ttr);
  const pathToRow = new Map(imageRows.map((r) => [r.object_path, r]));
  const seenPaths = new Set<string>();

  for (const folder of inspect) {
    const objects = deps.listObjects
      ? await deps.listObjects(folder)
      : await listObjects(client, folder);

    for (const path of objects) {
      report.scanned.objectsInspected++;
      seenPaths.add(path);
      if (!pathToRow.has(path)) report.orphanObjects.paths.push(path);
    }
  }

  // Customer-owned objects: one listing under customers/, every run (their folders are not
  // tied to a transaction, so there is no created_at to window them by). An object with a
  // matching stored_images row is valid; one without is an orphan, unless it is still young.
  const customerObjects = deps.listCustomerObjects
    ? await deps.listCustomerObjects()
    : await listCustomerObjects(client);
  for (const { path, recent } of customerObjects) {
    report.scanned.objectsInspected++;
    seenPaths.add(path);
    if (!pathToRow.has(path) && !recent) report.orphanObjects.paths.push(path);
  }
  report.orphanObjects.count = report.orphanObjects.paths.length;

  // Class 2 — a row whose object is gone. Expected and correct when superseded (that is
  // exactly what finding #9 produces); a problem only when the row still claims a live
  // image. Reported, never remediated: the image cannot be recreated, and deleting the
  // row would erase the proof a document was sighted.
  const inspected = new Set(inspect);
  inspected.add(CUSTOMERS_FOLDER); // listed in full above, so its rows can be checked too
  for (const row of imageRows) {
    if (row.superseded_at) continue;
    const folder = row.object_path.split("/")[0];
    if (!inspected.has(folder)) continue;
    if (!seenPaths.has(row.object_path)) report.missingObjects.imageIds.push(row.id);
  }
  report.missingObjects.count = report.missingObjects.imageIds.length;

  // ── gold-goods: rows first, then the listing, so a photo saved in between is merely young.
  const goldRows = deps.loadGoldPhotoRows
    ? await deps.loadGoldPhotoRows()
    : deps.gold
      ? await loadGoldPhotoRows(deps.gold)
      : null;
  if (goldRows) {
    const goldObjects = deps.listGoldObjects ? await deps.listGoldObjects() : await listGoldObjects(client);
    const goldRowPaths = new Set(goldRows.map((r) => r.object_path));
    const goldSeen = new Set(goldObjects.map((o) => o.path));
    report.goldGoods.objectsInspected = goldObjects.length;
    for (const { path, recent } of goldObjects) {
      if (!goldRowPaths.has(path) && !recent) report.goldGoods.orphanObjects.paths.push(path);
    }
    report.goldGoods.orphanObjects.count = report.goldGoods.orphanObjects.paths.length;
    // A goods_photos row is append-only evidence, and a photo cannot be recreated: report, never remediate.
    for (const row of goldRows) {
      if (!goldSeen.has(row.object_path)) report.goldGoods.missingObjects.photoIds.push(row.id);
    }
    report.goldGoods.missingObjects.count = report.goldGoods.missingObjects.photoIds.length;
  }

  // ── Remediation for classes 1 and 4 — objects only, and only with apply.
  if (apply) {
    if (report.goldGoods.orphanObjects.paths.length > 0) {
      const { error } = await client.storage.from(GOLD_GOODS_BUCKET).remove(report.goldGoods.orphanObjects.paths);
      if (error) console.error("reconcile: gold-goods orphan removal failed");
      else report.goldGoods.orphanObjects.deleted = report.goldGoods.orphanObjects.paths.length;
    }
    if (report.orphanObjects.paths.length > 0) {
      const { error } = await client.storage.from(STORAGE_BUCKET).remove(report.orphanObjects.paths);
      if (error) console.error("reconcile: orphan removal failed", error);
      else report.orphanObjects.deleted = report.orphanObjects.paths.length;
    }
    for (const folder of dangling) {
      const objects = deps.listObjects
        ? await deps.listObjects(folder)
        : await listObjects(client, folder);
      if (objects.length === 0) continue;
      const { error } = await client.storage.from(STORAGE_BUCKET).remove(objects);
      if (error) console.error("reconcile: dangling folder removal failed", folder, error);
      else report.danglingFolders.deleted += objects.length;
    }
  }

  return report;
}

// ─── Data access ──────────────────────────────────────────────────────────────

async function loadDuplicates(ttr: ReconcileSchema) {
  const { data, error } = await (ttr.rpc!("find_unsuperseded_duplicates"));
  if (error) {
    console.error("reconcile: find_unsuperseded_duplicates failed", error);
    return [];
  }
  return (data ?? []) as unknown as {
    image_id: string;
    object_path: string;
    replacement_image_id: string;
  }[];
}

// One query serves both class 4 (which ids exist at all) and the class 1/2 window (which
// are recent). Filtering the window client-side keeps the shared FilterBuilder interface
// small — no .gte() needed — and the row set is two columns per transaction.
async function loadTransactions(ttr: ReconcileSchema) {
  const { data, error } = await ttr.from("transactions").select("id, created_at");
  if (error) {
    console.error("reconcile: transaction load failed", error);
    // Returning empty would mark EVERY folder dangling and, with apply:true, delete the
    // whole bucket because a query blipped. Refuse to proceed instead.
    throw new Error("Cannot reconcile without the transaction list");
  }
  return (data ?? []) as unknown as { id: string; created_at: string | null }[];
}

async function loadGoldPhotoRows(gold: ReconcileSchema) {
  const { data, error } = await gold.from("goods_photos").select("id, object_path");
  if (error) {
    console.error("reconcile: goods_photos load failed", error);
    // Without the rows every object would look like an orphan.
    throw new Error("Cannot reconcile without the goods photo metadata");
  }
  return (data ?? []) as unknown as { id: string; object_path: string }[];
}

async function loadImageRows(ttr: ReconcileSchema) {
  const { data, error } = await ttr.from("stored_images").select("id, object_path, superseded_at");
  if (error) {
    console.error("reconcile: stored_images load failed", error);
    throw new Error("Cannot reconcile without the image metadata");
  }
  return (data ?? []) as unknown as {
    id: string;
    object_path: string;
    superseded_at: string | null;
  }[];
}

// ─── Storage listing ──────────────────────────────────────────────────────────

// Top-level entries are one folder per transaction (the flat path convention). Folders come
// back with a null id; objects have one.
async function listFolders(client: StorageLister): Promise<string[]> {
  const folders: string[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await client.storage
      .from(STORAGE_BUCKET)
      .list("", { limit: STORAGE_LIST_LIMIT, offset });
    if (error) {
      console.error("reconcile: folder listing failed", error);
      throw new Error("Cannot reconcile without the bucket listing");
    }
    if (!data || data.length === 0) break;
    for (const entry of data) if (!entry.id) folders.push(entry.name);
    if (data.length < STORAGE_LIST_LIMIT) break;
    offset += STORAGE_LIST_LIMIT;
  }
  return folders;
}

async function listObjects(client: StorageLister, folder: string): Promise<string[]> {
  const prefix = `${folder}/`;
  const paths: string[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await client.storage
      .from(STORAGE_BUCKET)
      .list(prefix, { limit: STORAGE_LIST_LIMIT, offset });
    if (error) {
      console.error("reconcile: object listing failed", folder, error);
      return paths;
    }
    if (!data || data.length === 0) break;
    for (const entry of data) if (entry.id) paths.push(`${prefix}${entry.name}`);
    if (data.length < STORAGE_LIST_LIMIT) break;
    offset += STORAGE_LIST_LIMIT;
  }
  return paths;
}

// Walks customers/{customer_id}/{verification_id}/ and returns every object. Folders come
// back with a null id, objects with one. Unlike the per-transaction listing this THROWS on a
// listing error: a partial list would make the missing-object check report rows as missing
// and, with apply, is no safer than not running at all.
async function listCustomerObjects(
  client: StorageLister,
): Promise<{ path: string; recent: boolean }[]> {
  const out: { path: string; recent: boolean }[] = [];
  const now = Date.now();

  const walk = async (prefix: string, depth: number): Promise<void> => {
    let offset = 0;
    while (true) {
      const { data, error } = await client.storage
        .from(STORAGE_BUCKET)
        .list(`${prefix}/`, { limit: STORAGE_LIST_LIMIT, offset });
      if (error) {
        console.error("reconcile: customer object listing failed", prefix, error);
        throw new Error("Cannot reconcile without the customer object listing");
      }
      if (!data || data.length === 0) return;
      for (const entry of data) {
        const path = `${prefix}/${entry.name}`;
        if (entry.id) {
          // No created_at means we cannot tell, so assume the object is still in flight.
          const created = entry.created_at ? Date.parse(entry.created_at) : NaN;
          out.push({ path, recent: Number.isNaN(created) || now - created < CUSTOMER_OBJECT_GRACE_MS });
        } else if (depth < CUSTOMER_LIST_MAX_DEPTH) {
          await walk(path, depth + 1);
        }
      }
      if (data.length < STORAGE_LIST_LIMIT) return;
      offset += STORAGE_LIST_LIMIT;
    }
  };

  await walk(CUSTOMERS_FOLDER, 1);
  return out;
}

// Walks gold-goods/{purchase_id}/ and returns every object. Like the customer listing it THROWS on a
// listing error: a partial list would make rows look missing and, with apply, objects look orphaned.
async function listGoldObjects(client: StorageLister): Promise<{ path: string; recent: boolean }[]> {
  const out: { path: string; recent: boolean }[] = [];
  const now = Date.now();

  const walk = async (prefix: string, depth: number): Promise<void> => {
    let offset = 0;
    while (true) {
      const { data, error } = await client.storage
        .from(GOLD_GOODS_BUCKET)
        .list(prefix, { limit: STORAGE_LIST_LIMIT, offset });
      if (error) {
        console.error("reconcile: gold-goods listing failed", prefix || "(root)", error);
        throw new Error("Cannot reconcile without the gold-goods listing");
      }
      if (!data || data.length === 0) return;
      for (const entry of data) {
        const path = `${prefix}${entry.name}`;
        if (entry.id) {
          // No created_at means we cannot tell, so assume the object is still in flight.
          const created = entry.created_at ? Date.parse(entry.created_at) : NaN;
          out.push({ path, recent: Number.isNaN(created) || now - created < CUSTOMER_OBJECT_GRACE_MS });
        } else if (depth < GOLD_LIST_MAX_DEPTH) {
          await walk(`${path}/`, depth + 1);
        }
      }
      if (data.length < STORAGE_LIST_LIMIT) return;
      offset += STORAGE_LIST_LIMIT;
    }
  };

  await walk("", 1);
  return out;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
