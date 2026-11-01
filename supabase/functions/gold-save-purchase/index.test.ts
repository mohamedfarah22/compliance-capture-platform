import { assert, assertEquals } from "std/assert";
import { captureLogs, ENTITY_ID, fakeContext, STAFF_ID } from "../_shared/goldFakes.ts";
import type { FakeSpec } from "../_shared/goldFakes.ts";
import { handleRequest, MAX_PHOTO_BYTES, MAX_PHOTOS } from "./index.ts";
import type { Deps } from "./index.ts";

const MAIN = "c1111111-1111-1111-1111-111111111111";
const JOINT = "c2222222-2222-2222-2222-222222222222";
const VER_MAIN = "a1111111-0000-0000-0000-000000000001";
const VER_JOINT = "a1111111-0000-0000-0000-000000000002";
const PURCHASE_ID = "b1111111-1111-1111-1111-111111111111";
const PART_A = "d1111111-1111-1111-1111-111111111111";
const PART_B = "d2222222-2222-2222-2222-222222222222";
// 2026-11-06 14:30 UTC is already 7 November in Melbourne (UTC+11).
const NOW = new Date("2026-11-06T14:30:00Z");

const jpeg = (bytes = 8) => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(bytes).fill(1)])], "g.jpg", { type: "image/jpeg" });

const customer = (id: string, first: string) => ({ id, first_name: first, middle_name: null, last_name: "Citizen", customer_type: "individual" });
const goodId = (verification_id: string) => ({
  verification_id,
  expiry_date: "2030-01-01",
  captured_at: "2026-03-01T00:00:00Z",
});

interface Opts {
  customers?: Record<string, unknown>[];
  currentIds?: Record<string, unknown>;
  readiness?: string[] | null;
  linked?: Record<string, unknown>[];
  sameInvoice?: Record<string, unknown>[];
  relianceDays?: number | null;
  userErrors?: FakeSpec["errors"];
  adminErrors?: FakeSpec["errors"];
  failUploadAt?: number;
}

function scenario(o: Opts = {}) {
  const currentIds = o.currentIds ?? { [MAIN]: goodId(VER_MAIN), [JOINT]: goodId(VER_JOINT) };
  const f = fakeContext(
    {
      tables: { customers: o.customers ?? [customer(MAIN, "Jane"), customer(JOINT, "Joan")] },
      rpcs: {
        customer_current_id: (a: Record<string, string>) => (currentIds[a.p_customer_id] ? [currentIds[a.p_customer_id]] : []),
        customer_ttr_ready: o.readiness === undefined ? [] : o.readiness,
        "gold.linked_parts": o.linked ?? [],
        "gold.invoice_purchases": o.sameInvoice ?? [],
      },
      errors: o.userErrors,
    },
    {
      tables: { reporting_entities: [{ id: ENTITY_ID, idv_max_reliance_days: o.relianceDays === undefined ? 730 : o.relianceDays }] },
      rpcs: { "gold.save_purchase": PURCHASE_ID },
      errors: o.adminErrors,
      failUploadAt: o.failUploadAt,
    },
  );
  const deps: Deps = { authenticate: () => Promise.resolve(f.ctx), newId: () => PURCHASE_ID, now: () => NOW };
  return { ...f, deps };
}

function request(fields: Record<string, string | undefined>, photos: File[] = [jpeg()]): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries({
    customerId: MAIN,
    purchaseType: "scrap",
    cash10k: "false",
    phone: "0412 345 678",
    idSighted: "true",
    ...fields,
  })) {
    if (v !== undefined) form.set(k, v);
  }
  for (const p of photos) form.append("photos", p);
  return new Request("http://stub.test/functions/v1/gold-save-purchase", { method: "POST", body: form });
}

async function post(s: ReturnType<typeof scenario>, fields: Record<string, string | undefined> = {}, photos?: File[]) {
  const res = await handleRequest(request(fields, photos), s.deps);
  return { res, body: await res.json() };
}

const savedPurchase = (s: ReturnType<typeof scenario>) => s.admin.rpcArgs("gold.save_purchase")[0]?.p_purchase;
const nothingWritten = (s: ReturnType<typeof scenario>) => {
  assertEquals(s.admin.rpcArgs("gold.save_purchase").length, 0, "no purchase written");
  assertEquals(s.admin.uploads.size, 0, "no object left in storage");
};

// ─── Access ──────────────────────────────────────────────────────────────────

Deno.test({
  name: "access: flag off is 403 gold_disabled, no Authorization is 401, aal1 is 403 mfa_required; nothing else is touched",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.set("SUPABASE_URL", "http://stub.test");
    Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      urls.push(url.pathname);
      return Promise.resolve(new Response(JSON.stringify({ id: STAFF_ID, aud: "authenticated" }), { status: 200 }));
    };
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "");
    const aal1 = `${b64({ alg: "HS256" })}.${b64({ sub: STAFF_ID, aal: "aal1" })}.sig`;
    try {
      Deno.env.delete("GOLD_JOURNEY_ENABLED");
      const off = await handleRequest(request({}));
      assertEquals([off.status, (await off.json()).error], [403, "gold_disabled"]);
      assertEquals(urls, [], "flag off: nothing contacted");

      Deno.env.set("GOLD_JOURNEY_ENABLED", "true");
      const anon = await handleRequest(request({}));
      assertEquals([anon.status, (await anon.json()).error], [401, "unauthorized"]);

      const req = request({});
      req.headers.set("Authorization", `Bearer ${aal1}`);
      const password = await handleRequest(req);
      assertEquals([password.status, (await password.json()).error], [403, "mfa_required"]);
      assert(!urls.some((u) => u.includes("/rest/v1/")), "no data read for a refused caller");
    } finally {
      Deno.env.delete("GOLD_JOURNEY_ENABLED");
      globalThis.fetch = originalFetch;
    }
  },
});

Deno.test("access: another entity's customer looks like a missing one (404) and nothing is written", async () => {
  const s = scenario({ customers: [] });
  const { res, body } = await post(s);
  assertEquals([res.status, body.error], [404, "customer_not_found"]);
  nothingWritten(s);
});

Deno.test("access: a joint seller from another entity is refused the same way", async () => {
  const s = scenario({ customers: [customer(MAIN, "Jane")] });
  const { res, body } = await post(s, { jointCustomerId: JOINT });
  assertEquals([res.status, body.error], [404, "customer_not_found"]);
  nothingWritten(s);
});

Deno.test("OPTIONS answers the CORS preflight without authenticating; other methods are 405 after authenticating", async () => {
  let authenticated = 0;
  const s = scenario();
  const deps: Deps = { ...s.deps, authenticate: (r) => (authenticated++, s.deps.authenticate(r)) };
  assertEquals((await handleRequest(new Request("http://stub.test/", { method: "OPTIONS" }), deps)).status, 204);
  assertEquals(authenticated, 0);
  assertEquals((await handleRequest(new Request("http://stub.test/", { method: "GET" }), deps)).status, 405);
  assertEquals(authenticated, 1);
});

// ─── The happy path, and what the server computes ────────────────────────────

Deno.test("saves a non-reportable scrap purchase: id, row values and photos come from the server", async () => {
  const s = scenario();
  const { res, body } = await post(s, {}, [jpeg(), jpeg(20)]);
  assertEquals(res.status, 201);
  assertEquals(body, { purchaseId: PURCHASE_ID, ttr: null, warnings: {} });

  const [args] = s.admin.rpcArgs("gold.save_purchase");
  assertEquals(args.p_entity, ENTITY_ID);
  assertEquals(args.p_staff, STAFF_ID, "created_by comes from the session");
  assertEquals(args.p_purchase, {
    id: PURCHASE_ID,
    customer_id: MAIN,
    joint_customer_id: null,
    main_id_verification_id: VER_MAIN,
    joint_id_verification_id: null,
    purchase_type: "scrap",
    cash_band: "under_10k",
    cash_10k_or_more: false,
    cash_amount: null,
    invoice_cash_total: null,
    erp_invoice_no: null,
    sale_date: "2026-11-07",
    phone: "0412 345 678",
    id_sighted: true,
    id_expired_at_time: false,
    id_outside_window_at_time: false,
    ttr_self_conducted: null,
    ttr_details_confirmed: null,
  });
  assertEquals(args.p_photos.map((p: Record<string, unknown>) => p.object_path), [
    `${PURCHASE_ID}/goods-1.jpg`,
    `${PURCHASE_ID}/goods-2.jpg`,
  ]);
  for (const p of args.p_photos) assertEquals(String(p.content_hash_sha256).length, 64);
  assertEquals(args.p_photos[1].byte_size, 24);
  assertEquals([...s.admin.uploads.keys()], [`gold-goods/${PURCHASE_ID}/goods-1.jpg`, `gold-goods/${PURCHASE_ID}/goods-2.jpg`]);
  assertEquals(args.p_fills, []);
});

Deno.test("the photo hash is the SHA-256 of the bytes stored", async () => {
  const s = scenario();
  await post(s);
  const [args] = s.admin.rpcArgs("gold.save_purchase");
  const stored = s.admin.uploads.get(`gold-goods/${PURCHASE_ID}/goods-1.jpg`)!;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", stored));
  assertEquals(args.p_photos[0].content_hash_sha256, Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join(""));
});

Deno.test("values a client sends for server-computed fields are ignored", async () => {
  const s = scenario();
  const { res } = await post(s, {
    cashBand: "10k_plus",
    cash10kOrMore: "true",
    cash_10k_or_more: "true",
    cash_band: "10k_plus",
    saleDate: "2020-01-01",
    sale_date: "2020-01-01",
    createdByStaffId: "99999999-9999-9999-9999-999999999999",
    created_by_staff_id: "99999999-9999-9999-9999-999999999999",
    idExpiredAtTime: "true",
    id_expired_at_time: "true",
    mainIdVerificationId: "99999999-9999-9999-9999-999999999999",
    main_id_verification_id: "99999999-9999-9999-9999-999999999999",
    invoiceCashTotal: "99999",
    invoice_cash_total: "99999",
    ttrSelfConducted: "true",
    ttrDetailsConfirmed: "true",
    reportingEntityId: "99999999-9999-9999-9999-999999999999",
    id: "99999999-9999-9999-9999-999999999999",
  });
  assertEquals(res.status, 201);
  const p = savedPurchase(s);
  assertEquals(p.id, PURCHASE_ID);
  assertEquals(p.cash_band, "under_10k");
  assertEquals(p.cash_10k_or_more, false);
  assertEquals(p.sale_date, "2026-11-07", "business date in Melbourne, not the client's");
  assertEquals(p.main_id_verification_id, VER_MAIN);
  assertEquals(p.id_expired_at_time, false);
  assertEquals(p.invoice_cash_total, null);
  assertEquals([p.ttr_self_conducted, p.ttr_details_confirmed], [null, null], "answers only count when the form asks");
  assertEquals(s.admin.rpcArgs("gold.save_purchase")[0].p_staff, STAFF_ID);
});

// ─── Cash thresholds ─────────────────────────────────────────────────────────

Deno.test("scrap: exactly $10,000 cash is reportable, $9,999.99 is not", async () => {
  const exact = scenario({ readiness: ["date_of_birth"] });
  const a = await post(exact, { cash10k: "true", cashAmount: "10,000", erpInvoiceNo: "INV-1" });
  assertEquals([a.res.status, a.body.ttr], [201, "B"]);
  assertEquals(savedPurchase(exact).cash_10k_or_more, true);
  assertEquals(savedPurchase(exact).cash_band, "10k_plus");
  assertEquals(savedPurchase(exact).cash_amount, 10000);

  const under = scenario();
  const b = await post(under, { cash10k: "true", cashAmount: "9,999.99" });
  assertEquals([b.res.status, b.body.ttr], [201, null]);
  assertEquals(savedPurchase(under).cash_10k_or_more, false);
  assertEquals(savedPurchase(under).cash_band, "under_10k");
  assertEquals(savedPurchase(under).cash_amount, 9999.99);
});

Deno.test("scrap: Yes with no amount is reportable; the amount is ignored when the answer is No", async () => {
  const yes = scenario({ readiness: ["date_of_birth"] });
  await post(yes, { cash10k: "true", erpInvoiceNo: "INV-2" });
  assertEquals(savedPurchase(yes).cash_10k_or_more, true);
  assertEquals(savedPurchase(yes).cash_amount, null);

  const no = scenario();
  await post(no, { cash10k: "false", cashAmount: "50000" });
  assertEquals(savedPurchase(no).cash_10k_or_more, false);
  assertEquals(savedPurchase(no).cash_amount, null);
});

Deno.test("bullion bands: under $5,000 saves; $5,000 to $9,999 needs a current ID; $10,000+ is reportable", async () => {
  const under = scenario();
  await post(under, { purchaseType: "bullion", bullionBand: "under_5k" });
  assertEquals([savedPurchase(under).cash_band, savedPurchase(under).cash_10k_or_more], ["under_5k", false]);

  const expired = { [MAIN]: { ...goodId(VER_MAIN), expiry_date: "2026-01-01" } };
  const mid = scenario({ currentIds: expired });
  const refused = await post(mid, { purchaseType: "bullion", bullionBand: "5k_to_10k" });
  assertEquals([refused.res.status, refused.body.blocked[0].status], [422, "expired"]);
  nothingWritten(mid);

  const mid2 = scenario();
  await post(mid2, { purchaseType: "bullion", bullionBand: "5k_to_10k" });
  assertEquals([savedPurchase(mid2).cash_band, savedPurchase(mid2).cash_10k_or_more], ["5k_to_10k", false]);

  const top = scenario({ readiness: ["date_of_birth"] });
  const t = await post(top, { purchaseType: "bullion", bullionBand: "10k_plus", erpInvoiceNo: "INV-3" });
  assertEquals([t.body.ttr, savedPurchase(top).cash_10k_or_more], ["B", true]);
});

Deno.test("an amount entered decides the band over the answer (bullion Yes + $8,000 is $5,000 to $9,999, not reportable)", async () => {
  const s = scenario();
  const { body } = await post(s, { purchaseType: "bullion", bullionBand: "10k_plus", cashAmount: "8000" });
  assertEquals(body.ttr, null);
  assertEquals([savedPurchase(s).cash_band, savedPurchase(s).cash_amount], ["5k_to_10k", 8000]);
});

Deno.test("a malformed request is a 400 naming the field", async () => {
  for (const [fields, field] of [
    [{ customerId: "nope" }, "customerId"],
    [{ jointCustomerId: "nope" }, "jointCustomerId"],
    [{ purchaseType: "diamonds" }, "purchaseType"],
    [{ cash10k: undefined }, "cash10k"],
    [{ purchaseType: "bullion", bullionBand: "lots" }, "bullionBand"],
    [{ linkedAmounts: "{not json" }, "linkedAmounts"],
    [{ linkedAmounts: "[1]" }, "linkedAmounts"],
  ] as const) {
    const s = scenario();
    const { res, body } = await post(s, fields);
    assertEquals([res.status, body.error, body.field], [400, "bad_request", field]);
    nothingWritten(s);
  }
});

Deno.test("a body that is not multipart is a 400", async () => {
  const s = scenario();
  const res = await handleRequest(new Request("http://stub.test/", { method: "POST", body: "{}" }), s.deps);
  assertEquals(res.status, 400);
});

// ─── Photos ──────────────────────────────────────────────────────────────────

Deno.test("photo required: no photo is a 422 on `photos` and nothing is written", async () => {
  const s = scenario();
  const { res, body } = await post(s, {}, []);
  assertEquals([res.status, body.error], [422, "validation_failed"]);
  assert(body.errors.photos);
  nothingWritten(s);
});

Deno.test("photos: a non-JPEG, a fake JPEG, an oversize file and too many files are refused before any write", async () => {
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "g.png", { type: "image/png" });
  const fake = new File([new Uint8Array([1, 2, 3, 4, 5])], "g.jpg", { type: "image/jpeg" });
  const big = new File([new Uint8Array(MAX_PHOTO_BYTES + 1)], "g.jpg", { type: "image/jpeg" });
  for (const [photos, status, error] of [
    [[png], 415, "photo_not_jpeg"],
    [[fake], 415, "photo_not_jpeg"],
    [[jpeg(), big], 413, "photo_too_large"],
    [Array.from({ length: MAX_PHOTOS + 1 }, () => jpeg()), 400, "bad_request"],
  ] as const) {
    const s = scenario();
    const { res, body } = await post(s, {}, [...photos]);
    assertEquals([res.status, body.error], [status, error]);
    nothingWritten(s);
  }
});

// ─── ID rules (C2, C3) ───────────────────────────────────────────────────────

Deno.test("C3: the sighted box is required on every purchase", async () => {
  for (const idSighted of [undefined, "false", "yes"]) {
    const s = scenario();
    const { res, body } = await post(s, { idSighted });
    assertEquals(res.status, 422);
    assert(body.errors.idSighted);
    nothingWritten(s);
  }
});

Deno.test("C3: a joint sale's message asks about both people", async () => {
  const s = scenario();
  const { body } = await post(s, { jointCustomerId: JOINT, idSighted: undefined });
  assert(body.errors.idSighted.includes("Both people"));
});

Deno.test("C2: a reportable purchase with an expired ID is blocked and names the seller", async () => {
  const s = scenario({ currentIds: { [MAIN]: { ...goodId(VER_MAIN), expiry_date: "2026-11-06" } } });
  const { res, body } = await post(s, { cash10k: "true", erpInvoiceNo: "INV-4" });
  assertEquals(res.status, 422);
  assertEquals(body.blocked, [{ customerId: MAIN, role: "main", status: "expired" }]);
  nothingWritten(s);
});

Deno.test("C2: a reportable purchase with an ID photographed outside the window is blocked as reverify", async () => {
  const s = scenario({ currentIds: { [MAIN]: { ...goodId(VER_MAIN), captured_at: "2024-01-01T00:00:00Z" } } });
  const { res, body } = await post(s, { cash10k: "true", erpInvoiceNo: "INV-5" });
  assertEquals(res.status, 422);
  assertEquals(body.blocked[0].status, "reverify");
  nothingWritten(s);
});

Deno.test("C2: the window is the entity's idv_max_reliance_days", async () => {
  const captured = { [MAIN]: { ...goodId(VER_MAIN), captured_at: "2026-09-01T00:00:00Z" } };
  const fields = { cash10k: "true", erpInvoiceNo: "INV-6", ttrSelfConducted: "true", ttrDetailsConfirmed: "true" };
  const short = scenario({ currentIds: captured, relianceDays: 30 });
  const refused = await post(short, fields);
  assertEquals([refused.res.status, refused.body.blocked[0].status], [422, "reverify"]);
  const none = scenario({ currentIds: captured, relianceDays: null });
  assertEquals((await post(none, fields)).res.status, 201, "no window set: the rules' default of 730 days applies");
});

Deno.test("C2: where no current ID is needed an expired ID saves, with the flag, and an old one saves with the other flag", async () => {
  const expired = scenario({ currentIds: { [MAIN]: { ...goodId(VER_MAIN), expiry_date: "2026-01-01" } } });
  assertEquals((await post(expired)).res.status, 201);
  assertEquals([savedPurchase(expired).id_expired_at_time, savedPurchase(expired).id_outside_window_at_time], [true, false]);

  const old = scenario({ currentIds: { [MAIN]: { ...goodId(VER_MAIN), captured_at: "2024-01-01T00:00:00Z" } } });
  assertEquals((await post(old)).res.status, 201);
  assertEquals([savedPurchase(old).id_expired_at_time, savedPurchase(old).id_outside_window_at_time], [false, true]);
});

Deno.test("C2: a joint seller's ID is checked too", async () => {
  const s = scenario({ currentIds: { [MAIN]: goodId(VER_MAIN), [JOINT]: { ...goodId(VER_JOINT), expiry_date: "2026-01-01" } } });
  const { body } = await post(s, { jointCustomerId: JOINT, cash10k: "true", erpInvoiceNo: "INV-7" });
  assertEquals(body.blocked, [{ customerId: JOINT, role: "joint", status: "expired" }]);
  nothingWritten(s);
});

Deno.test("a seller with no ID on file is refused, naming the role", async () => {
  const main = scenario({ currentIds: {} });
  const a = await post(main);
  assertEquals([a.res.status, a.body.error, a.body.role], [422, "no_id_on_file", "main"]);
  nothingWritten(main);

  const joint = scenario({ currentIds: { [MAIN]: goodId(VER_MAIN) } });
  const b = await post(joint, { jointCustomerId: JOINT });
  assertEquals([b.res.status, b.body.role], [422, "joint"]);
  nothingWritten(joint);
});

// ─── Joint sellers ───────────────────────────────────────────────────────────

Deno.test("a joint seller is saved with their own ID; the same person twice is refused", async () => {
  const s = scenario();
  const { res } = await post(s, { jointCustomerId: JOINT });
  assertEquals(res.status, 201);
  assertEquals(savedPurchase(s).joint_customer_id, JOINT);
  assertEquals(savedPurchase(s).joint_id_verification_id, VER_JOINT);

  const same = scenario();
  const refused = await post(same, { jointCustomerId: MAIN });
  assertEquals(refused.res.status, 422);
  assert(refused.body.errors.joint);
  nothingWritten(same);
});

Deno.test("a reportable joint sale is always case B, needs the invoice, and the counter answers are not stored", async () => {
  const s = scenario();
  const refused = await post(s, { jointCustomerId: JOINT, cash10k: "true", ttrSelfConducted: "true", ttrDetailsConfirmed: "true" });
  assertEquals(refused.res.status, 422);
  assert(refused.body.errors.erp_invoice_no);
  assertEquals(refused.body.errors.ttrSelfConducted, undefined, "not asked of a joint sale");

  const ok = await post(s, { jointCustomerId: JOINT, cash10k: "true", erpInvoiceNo: "INV-8", ttrSelfConducted: "true", ttrDetailsConfirmed: "true" });
  assertEquals([ok.res.status, ok.body.ttr], [201, "B"]);
  assertEquals([savedPurchase(s).ttr_self_conducted, savedPurchase(s).ttr_details_confirmed], [null, null]);
});

// ─── TTR case and counter answers (3.3, 3.3a) ────────────────────────────────

Deno.test("case B: a reportable sale to a customer with details missing needs the invoice, naming the customer", async () => {
  const s = scenario({ readiness: ["date_of_birth", "occupation"] });
  const refused = await post(s, { cash10k: "true" });
  assertEquals(refused.res.status, 422);
  assert(refused.body.errors.erp_invoice_no.includes("Jane Citizen"));
  nothingWritten(s);

  const ok = await post(s, { cash10k: "true", erpInvoiceNo: " INV-9 " });
  assertEquals([ok.res.status, ok.body.ttr], [201, "B"]);
  assertEquals(savedPurchase(s).erp_invoice_no, "INV-9", "the invoice is trimmed");
  assertEquals(savedPurchase(s).ttr_self_conducted, null, "not asked: details are missing");
});

Deno.test("case A: ready customer, both answers Yes: no invoice needed, answers stored", async () => {
  const s = scenario();
  const { res, body } = await post(s, { cash10k: "true", ttrSelfConducted: "true", ttrDetailsConfirmed: "true" });
  assertEquals([res.status, body.ttr], [201, "A"]);
  assertEquals([savedPurchase(s).ttr_self_conducted, savedPurchase(s).ttr_details_confirmed, savedPurchase(s).erp_invoice_no], [true, true, null]);
});

Deno.test("a No answer makes it case B, and the answers are stored as given", async () => {
  const s = scenario();
  const refused = await post(s, { cash10k: "true", ttrSelfConducted: "true", ttrDetailsConfirmed: "false" });
  assert(refused.body.errors.erp_invoice_no);
  const ok = await post(s, { cash10k: "true", ttrSelfConducted: "true", ttrDetailsConfirmed: "false", erpInvoiceNo: "INV-10" });
  assertEquals(ok.body.ttr, "B");
  assertEquals([savedPurchase(s).ttr_self_conducted, savedPurchase(s).ttr_details_confirmed], [true, false]);
});

Deno.test("when the counter questions are asked, both must be answered", async () => {
  const s = scenario();
  const { res, body } = await post(s, { cash10k: "true" });
  assertEquals(res.status, 422);
  assert(body.errors.ttrSelfConducted && body.errors.ttrDetailsConfirmed);
  nothingWritten(s);
});

Deno.test("non-reportable sales are never asked: unanswered is fine and answers sent are not stored", async () => {
  const s = scenario();
  assertEquals((await post(s)).res.status, 201);
  const t = scenario();
  await post(t, { ttrSelfConducted: "false", ttrDetailsConfirmed: "false" });
  assertEquals([savedPurchase(t).ttr_self_conducted, savedPurchase(t).ttr_details_confirmed], [null, null]);
});

Deno.test("an unknown customer readiness (null from the database) is a 404, not case A", async () => {
  const s = scenario({ readiness: null });
  const { res, body } = await post(s);
  assertEquals([res.status, body.error], [404, "customer_not_found"]);
});

// ─── Invoice rules: duplicates, completed TTR ────────────────────────────────

const other = { id: "e0000000-0000-0000-0000-000000000001", customer_id: JOINT, joint_customer_id: null, sale_date: "2026-11-07" };

Deno.test("duplicate invoice: blocks a reportable purchase, only warns on a non-reportable one", async () => {
  const reportable = scenario({ sameInvoice: [other] });
  const refused = await post(reportable, { cash10k: "true", ttrSelfConducted: "true", ttrDetailsConfirmed: "true", erpInvoiceNo: "INV-11" });
  assertEquals(refused.res.status, 422);
  assert(refused.body.errors.erp_invoice_no.includes("already used"));
  nothingWritten(reportable);

  const plain = scenario({ sameInvoice: [other] });
  const ok = await post(plain, { erpInvoiceNo: "INV-11" });
  assertEquals(ok.res.status, 201);
  assert(ok.body.warnings.duplicateInvoice, "the warning is returned");
  assertEquals(plain.admin.rpcArgs("gold.save_purchase").length, 1, "and the purchase is saved");
});

Deno.test("duplicate invoice: the lookup is by the invoice the server read, trimmed", async () => {
  const s = scenario({ sameInvoice: [other] });
  await post(s, { erpInvoiceNo: "  inv-12 " });
  assertEquals(s.user.rpcArgs("gold.invoice_purchases"), [{ p_invoice: "inv-12" }]);
});

const part = (over: Record<string, unknown> = {}) => ({
  id: PART_A,
  purchase_type: "scrap",
  cash_amount: 6000,
  ttr_transaction_id: null,
  ttr_status: null,
  customer_id: MAIN,
  joint_customer_id: null,
  created_at: "2026-11-07T00:00:00Z",
  ...over,
});

Deno.test("completed TTR (3.5): a part of the same type on an invoice whose TTR is complete is blocked", async () => {
  const s = scenario({ linked: [part({ ttr_transaction_id: "t1", ttr_status: "complete" })] });
  const { res, body } = await post(s, { cash10k: "true", partAmount: "3000", erpInvoiceNo: "INV-13", ttrSelfConducted: "true", ttrDetailsConfirmed: "true" });
  assertEquals(res.status, 422);
  assert(body.errors.erp_invoice_no.includes("already finished"));
  nothingWritten(s);
});

Deno.test("completed TTR (3.5): a draft TTR on the invoice does not block, and a completed TTR of the other type does not either", async () => {
  const draft = scenario({ linked: [part({ ttr_transaction_id: "t1", ttr_status: "draft" })] });
  const a = await post(draft, { cash10k: "true", partAmount: "6000", erpInvoiceNo: "INV-14", ttrSelfConducted: "true", ttrDetailsConfirmed: "true" });
  assertEquals(a.res.status, 201);

  const bullion = scenario({ linked: [part({ purchase_type: "bullion", ttr_transaction_id: "t1", ttr_status: "complete" })] });
  const b = await post(bullion, { cash10k: "true", partAmount: "6000", erpInvoiceNo: "INV-14", ttrSelfConducted: "true", ttrDetailsConfirmed: "true" });
  assertEquals(b.res.status, 201);
});

// ─── Linked parts and totals (3.4) ───────────────────────────────────────────

Deno.test("linked parts: the server loads the parts for the sale date it worked out, and totals the invoice", async () => {
  const s = scenario({ linked: [part()] });
  const { res, body } = await post(s, { partAmount: "6000", erpInvoiceNo: "inv-900", ttrSelfConducted: "true", ttrDetailsConfirmed: "true" });
  assertEquals([res.status, body.ttr], [201, "A"]);
  assertEquals(s.user.rpcArgs("gold.linked_parts"), [{ p_customer_id: MAIN, p_invoice_norm: "inv-900", p_sale_date: "2026-11-07" }]);
  const p = savedPurchase(s);
  assertEquals([p.cash_amount, p.invoice_cash_total, p.cash_10k_or_more, p.cash_band], [6000, 12000, true, "under_10k"]);
});

Deno.test("linked parts: a total under $10,000 is not reportable; the part amount is required", async () => {
  const s = scenario({ linked: [part({ cash_amount: 2000 })] });
  const ok = await post(s, { partAmount: "3000", erpInvoiceNo: "INV-15" });
  assertEquals([ok.res.status, ok.body.ttr], [201, null]);
  assertEquals([savedPurchase(s).invoice_cash_total, savedPurchase(s).cash_10k_or_more], [5000, false]);

  const missing = scenario({ linked: [part()] });
  const refused = await post(missing, { erpInvoiceNo: "INV-15" });
  assertEquals(refused.res.status, 422);
  assert(refused.body.errors.partAmount);
});

Deno.test("linked parts: an earlier part with no amount needs one; the fill is passed to the same transaction", async () => {
  const unknown = part({ cash_amount: null });
  const refused = await post(scenario({ linked: [unknown] }), { partAmount: "6000", erpInvoiceNo: "INV-16" });
  assertEquals(refused.res.status, 422);
  assert(refused.body.errors[`linked_${PART_A}`]);

  const s = scenario({ linked: [unknown] });
  const ok = await post(s, {
    partAmount: "6000",
    erpInvoiceNo: "INV-16",
    linkedAmounts: JSON.stringify({ [PART_A]: "4,500", [PART_B]: "999" }),
    ttrSelfConducted: "true",
    ttrDetailsConfirmed: "true",
  });
  assertEquals(ok.res.status, 201);
  const [args] = s.admin.rpcArgs("gold.save_purchase");
  assertEquals(args.p_fills, [{ id: PART_A, cash_amount: 4500 }], "only for the linked part that had no amount; a stray id is dropped");
  assertEquals(args.p_purchase.invoice_cash_total, 10500);
  assertEquals(args.p_purchase.cash_10k_or_more, true);
  // The fill rides in the one save call, not a separate write.
  assertEquals(s.admin.rpcArgs("gold.save_purchase").length, 1);
});

Deno.test("linked parts: an amount already saved on an earlier part is not overwritten by a client value", async () => {
  const s = scenario({ linked: [part()] });
  await post(s, { partAmount: "1000", erpInvoiceNo: "INV-17", linkedAmounts: JSON.stringify({ [PART_A]: "1" }) });
  assertEquals(s.admin.rpcArgs("gold.save_purchase")[0].p_fills, []);
  assertEquals(savedPurchase(s).invoice_cash_total, 7000);
});

Deno.test("mixed scrap + bullion on one invoice: $6,000 + $6,000 is reportable as one sale", async () => {
  const s = scenario({ linked: [part({ purchase_type: "bullion" })] });
  const { res, body } = await post(s, { purchaseType: "scrap", partAmount: "6000", erpInvoiceNo: "INV-900", ttrSelfConducted: "true", ttrDetailsConfirmed: "true" });
  assertEquals([res.status, body.ttr], [201, "A"]);
  assertEquals([savedPurchase(s).cash_10k_or_more, savedPurchase(s).invoice_cash_total, savedPurchase(s).purchase_type], [true, 12000, "scrap"]);

  const bullion = scenario({ linked: [part({ purchase_type: "scrap" })] });
  await post(bullion, { purchaseType: "bullion", bullionBand: "10k_plus", partAmount: "6000", erpInvoiceNo: "INV-900", ttrSelfConducted: "true", ttrDetailsConfirmed: "true" });
  assertEquals([savedPurchase(bullion).cash_band, savedPurchase(bullion).invoice_cash_total], ["5k_to_10k", 12000]);
});

Deno.test("linked parts of a joint sale are loaded for both sellers and merged", async () => {
  const s = scenario({ linked: [part()] });
  await post(s, { jointCustomerId: JOINT, partAmount: "1000", erpInvoiceNo: "INV-18" });
  assertEquals(s.user.rpcArgs("gold.linked_parts").map((a) => a.p_customer_id), [MAIN, JOINT]);
  assertEquals(savedPurchase(s).invoice_cash_total, 7000, "the same part found twice counts once");
});

Deno.test("no invoice, no linking: linked parts and duplicates are not looked up", async () => {
  const s = scenario();
  await post(s);
  assertEquals(s.user.rpcArgs("gold.linked_parts").length + s.user.rpcArgs("gold.invoice_purchases").length, 0);
});

// ─── Other field rules ───────────────────────────────────────────────────────

Deno.test("phone: blank and too-short numbers are refused (the table needs 8+ digits)", async () => {
  for (const phone of ["", "  ", "1234567", "abc"]) {
    const s = scenario();
    const { res, body } = await post(s, { phone });
    assertEquals(res.status, 422, phone);
    assert(body.errors.phone, phone);
    nothingWritten(s);
  }
});

Deno.test("a cash amount that is not an AUD amount is a field error", async () => {
  const s = scenario();
  const { res, body } = await post(s, { cash10k: "true", cashAmount: "ten grand", erpInvoiceNo: "INV-19" });
  assertEquals(res.status, 422);
  assert(body.errors.cashAmount);
});

// ─── Atomicity ───────────────────────────────────────────────────────────────

Deno.test("if the database write fails, every uploaded object is removed", async () => {
  const s = scenario({ adminErrors: { "gold.save_purchase": { code: "23514" } } });
  const { res, body } = await post(s, {}, [jpeg(), jpeg()]);
  assertEquals([res.status, body.error], [500, "save_failed"]);
  assertEquals(s.admin.uploads.size, 0);
  const removed = s.admin.calls.find((c) => c.kind === "remove")!;
  assertEquals(removed.args, [`${PURCHASE_ID}/goods-1.jpg`, `${PURCHASE_ID}/goods-2.jpg`]);
});

Deno.test("if an upload fails part-way, the earlier objects are removed and the database is never called", async () => {
  const s = scenario({ failUploadAt: 2 });
  const { res, body } = await post(s, {}, [jpeg(), jpeg(), jpeg()]);
  assertEquals([res.status, body.error], [500, "storage_failed"]);
  nothingWritten(s);
  assertEquals(s.admin.calls.find((c) => c.kind === "remove")!.args, [`${PURCHASE_ID}/goods-1.jpg`]);
});

Deno.test("a linked part that changed under us is a 409 and leaves no objects", async () => {
  const s = scenario({ adminErrors: { "gold.save_purchase": { code: "40001" } } });
  const { res, body } = await post(s);
  assertEquals([res.status, body.error], [409, "linked_part_changed"]);
  assertEquals(s.admin.uploads.size, 0);
});

Deno.test("if removing the objects also fails the error still comes back, and the objects are left for reconcile-stored-images", async () => {
  const s = scenario({ adminErrors: { "gold.save_purchase": { code: "XX000" }, "storage.remove": { code: "x" } } });
  const { res, body } = await post(s);
  assertEquals([res.status, body.error], [500, "save_failed"]);
  assertEquals(s.admin.uploads.size, 0, "the fake removes regardless; the point is the handler does not crash or retry");
  assertEquals(s.admin.calls.filter((c) => c.kind === "remove").length, 1);
});

Deno.test("a failing read is a 500 and writes nothing", async () => {
  const s = scenario({ userErrors: { customer_ttr_ready: { code: "XX000" } } });
  const { res, body } = await post(s);
  assertEquals([res.status, body.error], [500, "server_error"]);
  nothingWritten(s);
});

Deno.test("the caller's client only reads; every write goes through the service client", async () => {
  const s = scenario();
  await post(s, { erpInvoiceNo: "INV-20" });
  const userWrites = s.user.calls.filter((c) => c.kind === "upload" || c.kind === "remove" || (c.kind === "rpc" && /save|complete/.test(c.name)));
  assertEquals(userWrites, []);
  assertEquals(s.admin.rpcArgs("gold.save_purchase").length, 1);
});

// ─── Logs ────────────────────────────────────────────────────────────────────

Deno.test("logs carry IDs and error codes only, never names, phones, invoice numbers or amounts", async () => {
  const notReady = ["date_of_birth"]; // case B: the invoice sent is enough to pass the rules
  const runs = [
    scenario({ readiness: notReady, adminErrors: { "gold.save_purchase": { code: "23514" } } }),
    scenario({ readiness: notReady, failUploadAt: 1 }),
    scenario({ userErrors: { customer_ttr_ready: { code: "XX000" } } }),
    scenario({ readiness: notReady, adminErrors: { "gold.save_purchase": { code: "XX000" }, "storage.remove": { code: "x" } } }),
  ];
  for (const s of runs) {
    const { logged } = await captureLogs(() =>
      handleRequest(request({ erpInvoiceNo: "INV-SECRET-77", cash10k: "true", cashAmount: "12345.67", phone: "0498 765 432" }), s.deps)
    );
    assert(logged.length > 0, "a failure is logged");
    const text = logged.join("\n");
    for (const secret of ["Jane", "Citizen", "0498", "765", "INV-SECRET", "12345", "12,345"]) {
      assert(!text.includes(secret), `log contains ${secret}: ${text}`);
    }
  }
});

Deno.test("a successful save logs nothing", async () => {
  const s = scenario();
  const { logged } = await captureLogs(() => handleRequest(request({}), s.deps));
  assertEquals(logged, []);
});
