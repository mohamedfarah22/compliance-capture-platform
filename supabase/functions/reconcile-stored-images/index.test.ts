import { assertEquals, assertRejects } from "std/assert";
import { handleRequest, reconcile } from "./index.ts";
import type { ReconcileDeps, ReconcileSchema, StorageLister } from "./index.ts";
import type { StorageOwner } from "../_shared/supersede.ts";

// The sweep exists so privacy policy §3 ("one copy of your identification on file") holds
// durably instead of depending on every write path being correct forever. It deletes ID
// images, so most of these tests are about what it must NOT do.

interface FakeState {
  removed: string[][];
  updated: { values: Record<string, unknown>; ids: unknown[] }[];
  storedImages: { id: string; object_path: string; superseded_at: string | null }[];
}

function makeClient(state: FakeState) {
  return {
    storage: {
      from: () => ({
        list: () => Promise.resolve({ data: [], error: null }),
        remove: (paths: string[]) => {
          state.removed.push(paths);
          return Promise.resolve({ error: null });
        },
      }),
    },
    // deno-lint-ignore no-explicit-any
  } as any as StorageOwner & StorageLister;
}

// Only the calls supersedeImages makes: select…in…is, then update…in.
function makeSchema(state: FakeState) {
  return {
    from: () => {
      const self: Record<string, unknown> = {};
      let inIds: unknown[] | null = null;
      self.select = () => self;
      self.is = () => self;
      self.eq = () => self;
      self.in = (_c: string, vals: unknown[]) => {
        inIds = vals;
        return self;
      };
      self.update = (values: Record<string, unknown>) => ({
        in: (_c: string, ids: unknown[]) => {
          state.updated.push({ values, ids });
          return Promise.resolve({ error: null });
        },
      });
      self.then = (resolve: (v: unknown) => unknown) => {
        const rows = state.storedImages.filter(
          (r) => r.superseded_at === null && (inIds === null || inIds.includes(r.id)),
        );
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      };
      return self;
    },
    // deno-lint-ignore no-explicit-any
  } as any as ReconcileSchema;
}

function baseDeps(overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    apply: false,
    full: true,
    windowDays: 30,
    listFolders: () => Promise.resolve([]),
    listObjects: () => Promise.resolve([]),
    loadTransactions: () => Promise.resolve([]),
    loadImageRows: () => Promise.resolve([]),
    loadDuplicates: () => Promise.resolve([]),
    ...overrides,
  };
}

function emptyState(): FakeState {
  return { removed: [], updated: [], storedImages: [] };
}

// ─── Dry run is the default, and it must be inert ────────────────────────────

Deno.test("dry run reports every class and deletes nothing", async () => {
  const state = emptyState();
  state.storedImages = [{ id: "img-dup", object_path: "tx-1/party-a-front.jpg", superseded_at: null }];

  const report = await reconcile(makeClient(state), makeSchema(state), baseDeps({
    apply: false,
    listFolders: () => Promise.resolve(["tx-1", "tx-gone"]),
    listObjects: (f) => Promise.resolve(f === "tx-1" ? ["tx-1/orphan.jpg"] : ["tx-gone/x.jpg"]),
    loadTransactions: () => Promise.resolve([{ id: "tx-1", created_at: null }]),
    loadImageRows: () => Promise.resolve([
      { id: "img-missing", object_path: "tx-1/vanished.jpg", superseded_at: null },
    ]),
    loadDuplicates: () => Promise.resolve([
      { image_id: "img-dup", object_path: "tx-1/party-a-front.jpg", replacement_image_id: "img-new" },
    ]),
  }));

  assertEquals(report.mode, "dry-run");
  assertEquals(report.orphanObjects.count, 2);      // tx-1/orphan.jpg + tx-gone/x.jpg
  assertEquals(report.missingObjects.count, 1);
  assertEquals(report.unsupersededCopies.count, 1);
  assertEquals(report.danglingFolders.folders, ["tx-gone"]);

  // The whole point of the default: detection without destruction.
  assertEquals(state.removed, []);
  assertEquals(state.updated, []);
  assertEquals(report.orphanObjects.deleted, 0);
  assertEquals(report.unsupersededCopies.superseded, 0);
});

// ─── Class 2 is never remediated ─────────────────────────────────────────────

Deno.test("a row whose object is missing is reported but never touched, even with apply", async () => {
  const state = emptyState();

  const report = await reconcile(makeClient(state), makeSchema(state), baseDeps({
    apply: true,
    listFolders: () => Promise.resolve(["tx-1"]),
    listObjects: () => Promise.resolve([]),         // the object is gone
    loadTransactions: () => Promise.resolve([{ id: "tx-1", created_at: null }]),
    loadImageRows: () => Promise.resolve([
      { id: "img-missing", object_path: "tx-1/vanished.jpg", superseded_at: null },
    ]),
  }));

  assertEquals(report.missingObjects.imageIds, ["img-missing"]);
  // An image cannot be recreated, and deleting its row would erase the proof a document
  // was sighted — the seven-year AML/CTF evidence. Reported for a human, never actioned.
  assertEquals(state.removed, []);
  assertEquals(state.updated, []);
});

Deno.test("a superseded row with no object is expected, not reported — that is what finding #9 produces", async () => {
  const state = emptyState();

  const report = await reconcile(makeClient(state), makeSchema(state), baseDeps({
    listFolders: () => Promise.resolve(["tx-1"]),
    listObjects: () => Promise.resolve([]),
    loadTransactions: () => Promise.resolve([{ id: "tx-1", created_at: null }]),
    loadImageRows: () => Promise.resolve([
      { id: "img-old", object_path: "tx-1/gone.jpg", superseded_at: "2026-07-27T00:00:00Z" },
    ]),
  }));

  assertEquals(report.missingObjects.count, 0);
});

// ─── Remediation, when explicitly asked for ──────────────────────────────────

Deno.test("apply deletes orphan objects and supersedes duplicates, and never deletes a row", async () => {
  const state = emptyState();
  state.storedImages = [{ id: "img-dup", object_path: "tx-1/dup.jpg", superseded_at: null }];

  const report = await reconcile(makeClient(state), makeSchema(state), baseDeps({
    apply: true,
    listFolders: () => Promise.resolve(["tx-1"]),
    listObjects: () => Promise.resolve(["tx-1/orphan.jpg"]),
    loadTransactions: () => Promise.resolve([{ id: "tx-1", created_at: null }]),
    loadImageRows: () => Promise.resolve([]),
    loadDuplicates: () => Promise.resolve([
      { image_id: "img-dup", object_path: "tx-1/dup.jpg", replacement_image_id: "img-new" },
    ]),
  }));

  assertEquals(report.orphanObjects.deleted, 1);
  assertEquals(report.unsupersededCopies.superseded, 1);
  // Rows are stamped, never removed.
  assertEquals(state.updated.length, 1);
  assertEquals(state.updated[0].values.superseded_by_image_id, "img-new");
});

Deno.test("groups duplicates by replacement so each row records what actually replaced it", async () => {
  const state = emptyState();
  state.storedImages = [
    { id: "img-a", object_path: "tx-1/a.jpg", superseded_at: null },
    { id: "img-b", object_path: "tx-2/b.jpg", superseded_at: null },
  ];

  await reconcile(makeClient(state), makeSchema(state), baseDeps({
    apply: true,
    loadDuplicates: () => Promise.resolve([
      { image_id: "img-a", object_path: "tx-1/a.jpg", replacement_image_id: "keeper-1" },
      { image_id: "img-b", object_path: "tx-2/b.jpg", replacement_image_id: "keeper-2" },
    ]),
  }));

  const replacements = state.updated.map((u) => u.values.superseded_by_image_id).sort();
  assertEquals(replacements, ["keeper-1", "keeper-2"]);
});

// ─── Refuse to run blind ─────────────────────────────────────────────────────

Deno.test("refuses to proceed when the transaction list cannot be loaded", async () => {
  const state = emptyState();

  // An empty list would mark every folder dangling and, with apply, delete the entire
  // bucket because one query blipped. Failing loudly is the only safe behaviour.
  await assertRejects(
    () =>
      reconcile(makeClient(state), makeSchema(state), baseDeps({
        apply: true,
        listFolders: () => Promise.resolve(["tx-1", "tx-2"]),
        loadTransactions: () => Promise.reject(new Error("connection reset")),
      })),
    Error,
  );

  assertEquals(state.removed, []);
});

// ─── Windowing ───────────────────────────────────────────────────────────────

Deno.test("without full, only folders for recent transactions have their objects listed", async () => {
  const state = emptyState();
  const listed: string[] = [];
  const old = new Date(Date.now() - 90 * 86400000).toISOString();

  const report = await reconcile(makeClient(state), makeSchema(state), baseDeps({
    full: false,
    windowDays: 30,
    listFolders: () => Promise.resolve(["tx-recent", "tx-old"]),
    listObjects: (f) => {
      listed.push(f);
      return Promise.resolve([]);
    },
    loadTransactions: () => Promise.resolve([
      { id: "tx-recent", created_at: new Date().toISOString() },
      { id: "tx-old", created_at: old },
    ]),
  }));

  assertEquals(listed, ["tx-recent"]);
  // Both still count as folders, and neither is dangling — the window limits per-folder
  // listing cost, not correctness of class 4.
  assertEquals(report.scanned.folders, 2);
  assertEquals(report.danglingFolders.count, 0);
});

// Without this check the public browser key was enough to run the sweep with apply:true,
// deleting ID images across every entity, or to list every entity's image paths.
Deno.test("rejects a caller without the service-role key before touching storage", async () => {
  const post = (headers: Record<string, string>) =>
    handleRequest(new Request("http://localhost/", {
      method: "POST",
      headers,
      body: JSON.stringify({ apply: true, full: true }),
    }));

  assertEquals((await post({})).status, 401);
  assertEquals((await post({ Authorization: "Bearer sb_publishable_not-the-secret" })).status, 401);
});

// â”€â”€â”€ Customer-owned photos (customers/{customer_id}/â€¦) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const OLD = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

Deno.test("customer objects with a matching row are valid, and customers/ is not a dangling folder", async () => {
  const state = emptyState();
  const path = "customers/c-1/v-1/front-aaaa.jpg";

  const report = await reconcile(makeClient(state), makeSchema(state), baseDeps({
    apply: true,
    // The bucket's top level now holds "customers" next to the transaction folders.
    listFolders: () => Promise.resolve(["tx-1", "customers"]),
    loadTransactions: () => Promise.resolve([{ id: "tx-1", created_at: null }]),
    listCustomerObjects: () => Promise.resolve([{ path, recent: false }]),
    loadImageRows: () => Promise.resolve([{ id: "img-c", object_path: path, superseded_at: null }]),
  }));

  assertEquals(report.orphanObjects.count, 0);
  assertEquals(report.missingObjects.count, 0);
  assertEquals(report.danglingFolders.count, 0);
  assertEquals(report.scanned.folders, 1); // transaction folders only
  assertEquals(report.scanned.objectsInspected, 1);
  assertEquals(state.removed, []); // nothing deleted: the object has a row
});

Deno.test("a customer object with no row is an orphan once past the grace period, never while in flight", async () => {
  const state = emptyState();

  const report = await reconcile(makeClient(state), makeSchema(state), baseDeps({
    apply: true,
    listCustomerObjects: () => Promise.resolve([
      { path: "customers/c-1/v-1/front-old.jpg", recent: false },
      { path: "customers/c-1/v-2/front-new.jpg", recent: true }, // uploaded moments ago, row not written yet
    ]),
  }));

  assertEquals(report.orphanObjects.paths, ["customers/c-1/v-1/front-old.jpg"]);
  assertEquals(state.removed, [["customers/c-1/v-1/front-old.jpg"]]);
});

Deno.test("a customer row whose object is missing is reported; a superseded one is expected", async () => {
  const state = emptyState();

  const report = await reconcile(makeClient(state), makeSchema(state), baseDeps({
    apply: true,
    listCustomerObjects: () => Promise.resolve([]),
    loadImageRows: () => Promise.resolve([
      { id: "img-lost", object_path: "customers/c-1/v-1/front-a.jpg", superseded_at: null },
      { id: "img-old", object_path: "customers/c-1/v-0/front-b.jpg", superseded_at: "2026-10-01T00:00:00Z" },
    ]),
  }));

  assertEquals(report.missingObjects.imageIds, ["img-lost"]);
  assertEquals(state.removed, []);
  assertEquals(state.updated, []);
});

Deno.test("the default customer listing walks customers/{customer}/{verification}/ and applies the grace period", async () => {
  const state = emptyState();
  const tree: Record<string, { name: string; id: string | null; created_at?: string }[]> = {
    "customers/": [{ name: "c-1", id: null }],
    "customers/c-1/": [{ name: "v-1", id: null }],
    "customers/c-1/v-1/": [
      { name: "front-a.jpg", id: "o1", created_at: OLD },
      { name: "back-b.jpg", id: "o2", created_at: new Date().toISOString() },
    ],
  };
  const client = {
    storage: {
      from: () => ({
        list: (prefix: string) => Promise.resolve({ data: tree[prefix] ?? [], error: null }),
        remove: (paths: string[]) => {
          state.removed.push(paths);
          return Promise.resolve({ error: null });
        },
      }),
    },
    // deno-lint-ignore no-explicit-any
  } as any as StorageOwner & StorageLister;

  const report = await reconcile(client, makeSchema(state), baseDeps({
    apply: true,
    listFolders: () => Promise.resolve(["customers"]),
    loadImageRows: () => Promise.resolve([
      { id: "img-a", object_path: "customers/c-1/v-1/front-a.jpg", superseded_at: null },
      { id: "img-b", object_path: "customers/c-1/v-1/back-b.jpg", superseded_at: null },
    ]),
  }));

  assertEquals(report.scanned.objectsInspected, 2);
  assertEquals(report.orphanObjects.count, 0);
  assertEquals(report.missingObjects.count, 0); // both rows' objects were found by the walk
  assertEquals(state.removed, []);
});

Deno.test("a failed customer listing aborts the run rather than reporting rows as missing", async () => {
  const state = emptyState();
  const client = {
    storage: {
      from: () => ({
        list: () => Promise.resolve({ data: null, error: { message: "boom" } }),
        remove: () => Promise.resolve({ error: null }),
      }),
    },
    // deno-lint-ignore no-explicit-any
  } as any as StorageOwner & StorageLister;

  await assertRejects(
    () => reconcile(client, makeSchema(state), baseDeps({ apply: true })),
    Error,
    "customer object listing",
  );
  assertEquals(state.removed, []);
});
