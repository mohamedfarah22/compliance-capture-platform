import { assert, assertEquals } from "std/assert";
import { captureLogs, ENTITY_ID, fakeContext, STAFF_ID } from "../_shared/goldFakes.ts";
import type { FakeSpec } from "../_shared/goldFakes.ts";
import { jwt, OPTS, postJson, run, storageCalls } from "../_shared/goldTestKit.ts";
import { FILTER_KEYS, handleRequest, MAX_PURCHASES, SIGNED_URL_TTL_SECONDS } from "./index.ts";
import type { Deps } from "./index.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P1 = uuid(1);
const P2 = uuid(2);
const P3 = uuid(3);
const OTHER = uuid(99);
const C1 = uuid(101);
const C2 = uuid(102);
const T1 = uuid(201);
const T2 = uuid(202);

const purchase = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  customer_id: C1,
  joint_customer_id: null,
  purchase_type: "scrap",
  cash_band: "10k_plus",
  cash_10k_or_more: true,
  cash_amount: 12000,
  erp_invoice_no: `INV-${id.slice(-2)}`,
  phone: "0412 345 678",
  id_sighted: true,
  id_expired_at_time: false,
  ttr_transaction_id: null,
  created_at: "2026-11-05T01:00:00Z",
  created_by_staff_id: STAFF_ID,
  completed_at: null,
  completed_by_staff_id: null,
  ...extra,
});

const goods = (purchaseId: string, n: number) => ({
  purchase_id: purchaseId,
  object_path: `${purchaseId}/goods-${n}.jpg`,
  sort_order: n - 1,
});

const idRow = (purchaseId: string, role: string, extra: Record<string, unknown> = {}) => ({
  purchase_id: purchaseId,
  role,
  verification_id: uuid(300),
  document_type: "Driver licence",
  document_number: "DL-123",
  expiry_date: "2031-01-01",
  captured_at: "2026-03-01T01:00:00Z",
  photos_replaced: false,
  current_copy_captured_at: null,
  front_object_path: `customers/${C1}/cap/front.jpg`,
  back_object_path: `customers/${C1}/cap/back.jpg`,
  ...extra,
});

const baseTables = () => ({
  "gold.purchases": [
    purchase(P1, { ttr_transaction_id: T1 }),
    purchase(P2, { joint_customer_id: C2, ttr_transaction_id: T2, purchase_type: "bullion" }),
    purchase(P3, { erp_invoice_no: null, cash_10k_or_more: false, cash_band: "under_10k", cash_amount: null }),
  ],
  customers: [
    { id: C1, first_name: "Jane", middle_name: null, last_name: "Citizen", phone: "0400 111 222" },
    { id: C2, first_name: "Joan", middle_name: "Q", last_name: "Smith", phone: "0400 333 444" },
  ],
  "ttr.transactions": [
    { id: T1, status: "complete", transaction_ref: "INV-01" },
    { id: T2, status: "draft", transaction_ref: "INV-02" },
  ],
  "gold.goods_photos": [goods(P1, 1), goods(P1, 2), goods(P2, 1)],
});

const baseIdRows = [
  idRow(P1, "main"),
  idRow(P2, "main"),
  idRow(P2, "joint", { document_number: "DL-JOINT", front_object_path: `customers/${C2}/cap/front.jpg`, back_object_path: null }),
  idRow(P3, "main"),
];

interface Options {
  user?: FakeSpec;
  auditError?: boolean;
  idRows?: Record<string, unknown>[];
}

function scenario(options: Options = {}) {
  const f = fakeContext(
    {
      tables: baseTables(),
      rpcs: {
        "gold.list_purchase_staff": [{ staff_member_id: STAFF_ID, full_name: "Sam Counter" }],
        "gold.export_id_photos": (args: Record<string, unknown>) =>
          (options.idRows ?? baseIdRows).filter((r) => (args.p_ids as string[]).includes(r.purchase_id as string)),
      },
      ...options.user,
    },
    {},
  );
  // The fake has no insert: the audit insert and the signing are recorded in one list, so their order can be asserted.
  const events: string[] = [];
  const audits: Record<string, unknown>[] = [];
  const admin = f.admin.client as { schema: (n: string) => unknown; storage: { from: (b: string) => Record<string, unknown> } };
  const baseSchema = admin.schema;
  admin.schema = (name: string) => ({
    ...(baseSchema(name) as object),
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        events.push(`insert:${name}.${table}`);
        if (table === "export_audit_log" && !options.auditError) audits.push(row);
        return Promise.resolve({ error: options.auditError ? { code: "XX000" } : null });
      },
    }),
  });
  const baseStorage = admin.storage.from;
  admin.storage.from = (bucket: string) => {
    const b = baseStorage(bucket);
    const sign = b.createSignedUrls as (p: string[], t: number) => unknown;
    return { ...b, createSignedUrls: (p: string[], t: number) => (events.push(`sign:${bucket}`), sign(p, t)) };
  };
  const deps: Deps = { authenticate: () => Promise.resolve(f.ctx) };
  return { ...f, deps, events, audits };
}

async function post(s: ReturnType<typeof scenario>, body: unknown) {
  const res = await handleRequest(
    new Request("http://stub.test/functions/v1/gold-export", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }),
    s.deps,
  );
  return { res, body: await res.json() };
}

const zip = (ids: string[], filters: unknown = null) => ({ kind: "zip", filters, purchaseIds: ids });

// ─── Access (the real requireGoldStaff, through the stubbed network) ────────────────────────────────

Deno.test({
  name: "access: flag off is 403 gold_disabled, no Authorization is 401, aal1 is 403 mfa_required",
  ...OPTS,
  fn: async () => {
    Deno.env.set("SUPABASE_URL", "http://stub.test");
    Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    try {
      const body = zip([P1]);
      const off = await run(handleRequest, postJson(body), { role: "manager" }, { enabled: null });
      assertEquals([off.res.status, (await off.res.json()).error], [403, "gold_disabled"]);
      const anon = await run(handleRequest, postJson(body, null), { role: "manager" });
      assertEquals([anon.res.status, (await anon.res.json()).error], [401, "unauthorized"]);
      const aal1 = await run(handleRequest, postJson(body, jwt("aal1")), { role: "manager" });
      assertEquals([aal1.res.status, (await aal1.res.json()).error], [403, "mfa_required"]);
    } finally {
      Deno.env.delete("GOLD_JOURNEY_ENABLED");
    }
  },
});

Deno.test({
  name: "access: staff is refused before anything is read or signed; managers and admins pass the role check",
  ...OPTS,
  fn: async () => {
    Deno.env.set("SUPABASE_URL", "http://stub.test");
    Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    try {
      for (const kind of ["zip", "record"]) {
        const r = await run(handleRequest, postJson({ kind, filters: null, purchaseIds: [P1] }), { role: "staff" });
        assertEquals([r.res.status, (await r.res.json()).error], [403, "forbidden"]);
        assertEquals(r.calls.filter((c) => c.path !== "/user" && c.path !== "/staff_members").length, 0);
      }
      const inactive = await run(
        handleRequest,
        postJson(zip([P1])),
        { staff: { id: STAFF_ID, reporting_entity_id: ENTITY_ID, role: "manager", full_name: "Ian", is_active: false } },
      );
      assertEquals([inactive.res.status, (await inactive.res.json()).error], [403, "forbidden"]);
      for (const role of ["manager", "admin"] as const) {
        // No purchases exist in this stub, so a caller past the role check gets purchase_not_found.
        const r = await run(handleRequest, postJson(zip([P1])), { role });
        assertEquals([r.res.status, (await r.res.json()).error], [404, "purchase_not_found"]);
        assertEquals(storageCalls(r, "POST").length, 0);
      }
    } finally {
      Deno.env.delete("GOLD_JOURNEY_ENABLED");
    }
  },
});

// ─── Request checks ─────────────────────────────────────────────────────────────────────────────────

Deno.test("a malformed request is a 400 naming the field, with no audit row and nothing signed", async () => {
  const cases: [unknown, string][] = [
    [{ ...zip([P1]), kind: "csv" }, "kind"],
    [{ filters: null, purchaseIds: [P1] }, "kind"],
    [{ kind: "zip" }, "purchaseIds"],
    [{ kind: "zip", purchaseIds: P1 }, "purchaseIds"],
    [{ kind: "zip", purchaseIds: [] }, "purchaseIds"],
    [{ kind: "zip", purchaseIds: ["nope"] }, "purchaseIds"],
    [{ kind: "zip", purchaseIds: [5] }, "purchaseIds"],
    [{ kind: "record", purchaseIds: [P1, P2] }, "purchaseIds"],
    [zip([P1], ["q"]), "filters"],
    [zip([P1], "q"), "filters"],
    ["{nope", "body"],
    [[], "body"],
  ];
  for (const [body, field] of cases) {
    const s = scenario();
    const r = await post(s, body);
    assertEquals([r.res.status, r.body.error, r.body.field], [400, "bad_request", field]);
    assertEquals(s.events, []);
  }
});

Deno.test("200 distinct purchases are allowed and 201 are refused before anything is read", async () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => uuid(1000 + i));
  const s = scenario({ user: { tables: { ...baseTables(), "gold.purchases": many(MAX_PURCHASES).map((id) => purchase(id)) } } });
  const ok = await post(s, zip(many(MAX_PURCHASES)));
  assertEquals([ok.res.status, ok.body.purchases.length], [200, MAX_PURCHASES]);
  assertEquals((s.audits[0].purchase_ids as string[]).length, MAX_PURCHASES);

  const s2 = scenario();
  const over = await post(s2, zip(many(MAX_PURCHASES + 1)));
  assertEquals([over.res.status, over.body.error], [400, "too_many_purchases"]);
  assertEquals(s2.events, []);
  assertEquals(s2.user.calls.length, 0);
});

Deno.test("reads of a long list are split so the request URL stays short", async () => {
  const ids = Array.from({ length: 120 }, (_, i) => uuid(2000 + i));
  const s = scenario({ user: { tables: { ...baseTables(), "gold.purchases": ids.map((id) => purchase(id)) } } });
  await post(s, zip(ids));
  const purchaseReads = s.user.calls.filter((c) => c.kind === "select" && c.name === "gold.purchases");
  assertEquals(purchaseReads.length, 3);
});

Deno.test("another business's purchase (RLS hides it) refuses the whole export: 404, no audit row, nothing signed", async () => {
  for (const missing of [OTHER, uuid(98)]) {
    const s = scenario();
    const r = await post(s, zip([P1, missing]));
    assertEquals([r.res.status, r.body], [404, { error: "purchase_not_found" }]);
    assertEquals(s.events, []);
  }
});

Deno.test("duplicate ids count once", async () => {
  const s = scenario();
  const r = await post(s, zip([P1, P1, P2]));
  assertEquals(r.body.purchases.map((p: { id: string }) => p.id), [P1, P2]);
  assertEquals(s.audits[0].purchase_ids, [P1, P2]);
});

// ─── The audit row ─────────────────────────────────────────────────────────────────────────────────

Deno.test("the audit row takes the staff and business from the verified caller and keeps only the known filters", async () => {
  const s = scenario();
  const filters = { q: "Jane", type: "scrap", status: "austrac", cash: "yes", from: "2026-11-01", to: "2026-11-07", recordedBy: STAFF_ID, extra: "x", empty: "" };
  const r = await post(s, { ...zip([P1, P2], filters), staffId: uuid(7), reportingEntityId: uuid(8), staff_member_id: uuid(9) });
  assertEquals(r.res.status, 200);
  assertEquals(s.audits.length, 1);
  assertEquals(s.audits[0], {
    reporting_entity_id: ENTITY_ID,
    staff_member_id: STAFF_ID,
    kind: "zip",
    filters: { q: "Jane", type: "scrap", status: "austrac", cash: "yes", from: "2026-11-01", to: "2026-11-07", recordedBy: STAFF_ID },
    purchase_ids: [P1, P2],
  });
  assertEquals(FILTER_KEYS.length, 7);
});

Deno.test("no filters sent is stored as null; blank and non-string filter values are dropped", async () => {
  const s = scenario();
  await post(s, { kind: "zip", purchaseIds: [P1] });
  assertEquals(s.audits[0].filters, null);
  const s2 = scenario();
  await post(s2, zip([P1], { q: "", type: 5, status: "complete" }));
  assertEquals(s2.audits[0].filters, { status: "complete" });
});

Deno.test("the audit row is written before any URL is signed", async () => {
  const s = scenario();
  await post(s, zip([P1, P2]));
  assertEquals(s.events, ["insert:gold.export_audit_log", "sign:gold-goods", "sign:compliance-media"]);
});

Deno.test("if the audit row cannot be written, nothing is signed and the log carries a code only", async () => {
  const s = scenario({ auditError: true });
  const { result, logged } = await captureLogs(() => post(s, zip([P1])));
  assertEquals([result.res.status, result.body], [500, { error: "server_error" }]);
  assert(!s.events.some((e) => e.startsWith("sign")));
  assertEquals(logged.length, 1);
  assert(!logged[0].includes(P1) && !logged[0].includes("Jane"));
});

Deno.test("a record print writes one audit row, signs nothing and returns ok", async () => {
  const s = scenario();
  const r = await post(s, { kind: "record", filters: null, purchaseIds: [P2] });
  assertEquals([r.res.status, r.body], [200, { ok: true }]);
  assertEquals(s.audits, [{ reporting_entity_id: ENTITY_ID, staff_member_id: STAFF_ID, kind: "record", filters: null, purchase_ids: [P2] }]);
  assertEquals(s.events, ["insert:gold.export_audit_log"]);
});

Deno.test("an export never writes ttr.access_log; the service client only inserts the audit row and signs", async () => {
  const s = scenario();
  await post(s, zip([P1, P2, P3]));
  assert(s.events.every((e) => e === "insert:gold.export_audit_log" || e.startsWith("sign:")));
  assert(s.user.calls.every((c) => c.kind === "select" || c.kind === "rpc"));
});

// ─── The response ──────────────────────────────────────────────────────────────────────────────────

Deno.test("each purchase comes back with its CSV fields and signed photos, in the order asked", async () => {
  const s = scenario();
  const r = await post(s, zip([P2, P1, P3]));
  assertEquals(r.res.status, 200);
  const [two, one, three] = r.body.purchases;
  assertEquals([two.id, one.id, three.id], [P2, P1, P3]);

  assertEquals(one.row.main_seller_name, "Jane Citizen");
  assertEquals(one.row.main_seller_phone, "0400 111 222");
  assertEquals([one.row.main_id_type, one.row.main_id_number, one.row.main_id_expiry], ["Driver licence", "DL-123", "2031-01-01"]);
  assertEquals([one.row.joint_seller_name, one.row.joint_id_number], ["", ""]);
  assertEquals([one.row.created_by, one.row.erp_invoice_no, one.row.cash_10k_or_more], ["Sam Counter", "INV-01", true]);
  assertEquals([one.row.ttr_status, one.row.ttr_reference], ["complete", "INV-01"]);
  assertEquals(one.row.goods_photo_count, 2);
  assertEquals(one.row.id_document_used, "main: Driver licence, captured 2026-03-01");
  assertEquals(one.row.id_photo_copy_taken, "main: original, taken 2026-03-01");

  assertEquals([two.row.joint_seller_name, two.row.joint_id_number], ["Joan Q Smith", "DL-JOINT"]);
  assertEquals([two.row.ttr_status, two.row.ttr_reference], ["draft", "INV-02"]);
  assertEquals(two.row.id_photo_copy_taken, "main: original, taken 2026-03-01; joint: original, taken 2026-03-01");

  assertEquals([three.row.ttr_status, three.row.ttr_reference, three.row.goods_photo_count], ["", "", 0]);
  assertEquals(three.row.erp_invoice_no, "");
});

Deno.test("photos are named for the zip and signed for five minutes", async () => {
  const s = scenario();
  const r = await post(s, zip([P1, P2, P3]));
  const [one, two, three] = r.body.purchases;
  assertEquals(
    one.photos.map((p: { name: string }) => p.name),
    ["main-seller-id-front", "main-seller-id-back", "goods-1", "goods-2"],
  );
  assertEquals(
    two.photos.map((p: { name: string }) => p.name),
    ["main-seller-id-front", "main-seller-id-back", "joint-seller-id-front", "goods-1"],
  );
  assertEquals(three.photos.map((p: { name: string }) => p.name), ["main-seller-id-front", "main-seller-id-back"]);
  assertEquals(one.photos[2].url, `https://signed.test/${P1}/goods-1.jpg?ttl=${SIGNED_URL_TTL_SECONDS}`);
  assertEquals(one.photos[0].url, `https://signed.test/customers/${C1}/cap/front.jpg?ttl=${SIGNED_URL_TTL_SECONDS}`);
  assert(SIGNED_URL_TTL_SECONDS <= 300);
  const signed = s.admin.calls.filter((c) => c.kind === "sign");
  assertEquals(signed.map((c) => c.name), ["gold-goods", "compliance-media"]);
  assert(signed.every((c) => (c.args as { ttl: number }).ttl === 300));
});

Deno.test("C1: a replaced capture exports the newer copy's photos and says so; none left is said too", async () => {
  const newer = `customers/${C1}/new/front.jpg`;
  const s = scenario({
    idRows: [
      idRow(P1, "main", { photos_replaced: true, current_copy_captured_at: "2026-05-20T01:00:00Z", front_object_path: newer, back_object_path: null }),
      idRow(P2, "main", { photos_replaced: true, current_copy_captured_at: null, front_object_path: null, back_object_path: null }),
    ],
  });
  const r = await post(s, zip([P1, P2]));
  const [one, two] = r.body.purchases;
  assertEquals(one.row.id_photo_copy_taken, "main: newer copy, taken 2026-05-20");
  assertEquals(one.row.id_document_used, "main: Driver licence, captured 2026-03-01");
  assertEquals(one.photos[0].url, `https://signed.test/${newer}?ttl=300`);
  assertEquals(two.row.id_photo_copy_taken, "main: replaced, no copy on file");
  assertEquals(two.photos.filter((p: { name: string }) => p.name.includes("-id-")), []);
});

Deno.test("a photo that cannot be signed is left out and the rest are returned", async () => {
  const s = scenario();
  const adminStorage = (s.admin.client as { storage: { from: (b: string) => Record<string, unknown> } }).storage;
  const original = adminStorage.from;
  adminStorage.from = (bucket: string) => ({
    ...original(bucket),
    createSignedUrls: (paths: string[]) =>
      Promise.resolve({ data: paths.map((p, i) => (i === 0 ? { signedUrl: null, error: "x" } : { signedUrl: `https://signed.test/${p}`, error: null })), error: null }),
  });
  const r = await post(s, zip([P1]));
  assertEquals(r.res.status, 200);
  assertEquals(r.body.purchases[0].photos.map((p: { name: string }) => p.name), ["main-seller-id-back", "goods-2"]);
});

Deno.test("a failed read or signing is a 500 that logs a code only", async () => {
  for (const user of [
    { errors: { "gold.purchases": { code: "XX000" } } },
    { errors: { customers: { code: "XX000" } } },
    { errors: { "gold.export_id_photos": { code: "XX000" } } },
    { errors: { "gold.goods_photos": { code: "XX000" } } },
  ] as FakeSpec[]) {
    const s = scenario({ user });
    const { result, logged } = await captureLogs(() => post(s, zip([P1])));
    assertEquals([result.res.status, result.body.error], [500, "server_error"]);
    assertEquals(s.events, []);
    assert(logged.length === 1 && !logged[0].includes(P1));
  }
  const s = scenario();
  (s.admin.client as { storage: { from: (b: string) => Record<string, unknown> } }).storage.from = () => ({
    createSignedUrls: () => Promise.resolve({ data: null, error: { statusCode: "500" } }),
  });
  const { result, logged } = await captureLogs(() => post(s, zip([P1])));
  assertEquals([result.res.status, result.body.error], [500, "server_error"]);
  assert(logged.length === 1 && !logged[0].includes(P1));
});

Deno.test("non-POST is 405 after authenticating, OPTIONS needs no authentication", async () => {
  const s = scenario();
  assertEquals((await handleRequest(new Request("http://stub.test/", { method: "GET" }), s.deps)).status, 405);
  let called = false;
  const res = await handleRequest(new Request("http://stub.test/", { method: "OPTIONS" }), {
    authenticate: () => ((called = true), s.deps.authenticate(new Request("http://x"))),
  });
  assertEquals([res.status, called], [204, false]);
});
