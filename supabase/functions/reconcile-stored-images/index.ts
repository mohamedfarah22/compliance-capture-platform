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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { supersedeImages, STORAGE_BUCKET } from "../_shared/supersede.ts";
import type { StorageOwner, SupabaseSchema } from "../_shared/supersede.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STORAGE_LIST_LIMIT = 100;
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
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

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
    { apply, full, windowDays },
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
      ) => PromiseLike<{ data: { name: string; id?: string | null }[] | null; error: unknown }>;
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
  loadTransactions?: () => Promise<{ id: string; created_at: string | null }[]>;
  loadImageRows?: () => Promise<{ id: string; object_path: string; superseded_at: string | null }[]>;
  loadDuplicates?: () => Promise<
    { image_id: string; object_path: string; replacement_image_id: string }[]
  >;
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
  const folders = deps.listFolders ? await deps.listFolders() : await listFolders(client);
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
  report.orphanObjects.count = report.orphanObjects.paths.length;

  // Class 2 — a row whose object is gone. Expected and correct when superseded (that is
  // exactly what finding #9 produces); a problem only when the row still claims a live
  // image. Reported, never remediated: the image cannot be recreated, and deleting the
  // row would erase the proof a document was sighted.
  const inspected = new Set(inspect);
  for (const row of imageRows) {
    if (row.superseded_at) continue;
    const folder = row.object_path.split("/")[0];
    if (!inspected.has(folder)) continue;
    if (!seenPaths.has(row.object_path)) report.missingObjects.imageIds.push(row.id);
  }
  report.missingObjects.count = report.missingObjects.imageIds.length;

  // ── Remediation for classes 1 and 4 — objects only, and only with apply.
  if (apply) {
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

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
