import { assert, assertEquals } from "std/assert";
import { captureLogs, ENTITY_ID, fakeContext, STAFF_ID } from "../_shared/goldFakes.ts";
import type { FakeSpec } from "../_shared/goldFakes.ts";
import { handleRequest } from "./index.ts";
import type { Deps } from "./index.ts";

const MAIN = "c1111111-1111-1111-1111-111111111111";
const JOINT = "c2222222-2222-2222-2222-222222222222";
const PURCHASE_ID = "b1111111-1111-1111-1111-111111111111";
const PART_A = "d1111111-1111-1111-1111-111111111111";

const savedRow = (over: Record<string, unknown> = {}) => ({
  id: PURCHASE_ID,
  customer_id: MAIN,
  joint_customer_id: null,
  purchase_type: "scrap",
  cash_band: "under_10k",
  cash_amount: null,
  sale_date: "2026-10-01",
  erp_invoice_no: null,
  id_expired_at_time: false,
  id_outside_window_at_time: false,
  ttr_self_conducted: null,
  ttr_details_confirmed: null,
  ...over,
});

const part = (over: Record<string, unknown> = {}) => ({
  id: PART_A,
  purchase_type: "scrap",
  cash_amount: 6000,
  ttr_transaction_id: null,
  ttr_status: null,
  customer_id: MAIN,
  joint_customer_id: null,
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});

interface Opts {
  purchase?: Record<string, unknown> | null;
  readiness?: string[] | null;
  linked?: Record<string, unknown>[];
  sameInvoice?: Record<string, unknown>[];
  adminErrors?: FakeSpec["errors"];
  userErrors?: FakeSpec["errors"];
}

function scenario(o: Opts = {}) {
  const purchase = o.purchase === undefined ? savedRow() : o.purchase;
  const f = fakeContext(
    {
      tables: {
        "gold.purchases": purchase ? [purchase] : [],
        customers: [{ id: MAIN, first_name: "Jane", middle_name: null, last_name: "Citizen", customer_type: "individual" }],
      },
      rpcs: {
        customer_ttr_ready: o.readiness === undefined ? [] : o.readiness,
        "gold.linked_parts": o.linked ?? [],
        "gold.invoice_purchases": o.sameInvoice ?? [],
      },
      errors: o.userErrors,
    },
    { rpcs: {}, errors: o.adminErrors },
  );
  const deps: Deps = { authenticate: () => Promise.resolve(f.ctx) };
  return { ...f, deps };
}

async function post(s: ReturnType<typeof scenario>, body: Record<string, unknown> = {}) {
  const req = new Request("http://stub.test/functions/v1/gold-complete-purchase", {
    method: "POST",
    body: JSON.stringify({ purchaseId: PURCHASE_ID, erpInvoiceNo: "INV-100", ...body }),
  });
  const res = await handleRequest(req, s.deps);
  return { res, body: await res.json() };
}

const completeArgs = (s: ReturnType<typeof scenario>) => s.admin.rpcArgs("gold.complete_purchase")[0];
const nothingWritten = (s: ReturnType<typeof scenario>) =>
  assertEquals(s.admin.rpcArgs("gold.complete_purchase").length, 0, "nothing written");

Deno.test({
  name: "access: flag off is 403 gold_disabled and no Authorization is 401",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.set("SUPABASE_URL", "http://stub.test");
    Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    const req = () => new Request("http://stub.test/", { method: "POST", body: "{}" });
    try {
      Deno.env.delete("GOLD_JOURNEY_ENABLED");
      const off = await handleRequest(req());
      assertEquals([off.status, (await off.json()).error], [403, "gold_disabled"]);
      Deno.env.set("GOLD_JOURNEY_ENABLED", "true");
      const anon = await handleRequest(req());
      assertEquals([anon.status, (await anon.json()).error], [401, "unauthorized"]);
    } finally {
      Deno.env.delete("GOLD_JOURNEY_ENABLED");
    }
  },
});

Deno.test("access: another entity's purchase looks like a missing one (404) and nothing is written", async () => {
  const s = scenario({ purchase: null });
  const { res, body } = await post(s);
  assertEquals([res.status, body.error], [404, "purchase_not_found"]);
  nothingWritten(s);
});

Deno.test("a malformed request is a 400", async () => {
  for (const [body, field] of [
    [{ purchaseId: "nope" }, "purchaseId"],
    [{ erpInvoiceNo: 5 }, "erpInvoiceNo"],
    [{ linkedAmounts: [1] }, "linkedAmounts"],
  ] as const) {
    const s = scenario();
    const r = await post(s, body);
    assertEquals([r.res.status, r.body.field], [400, field]);
    nothingWritten(s);
  }
  const s = scenario();
  const res = await handleRequest(new Request("http://stub.test/", { method: "POST", body: "{nope" }), s.deps);
  assertEquals(res.status, 400);
});

Deno.test("completes a purchase: invoice trimmed, one write, staff from the session", async () => {
  const s = scenario();
  const { res, body } = await post(s, { erpInvoiceNo: "  INV-100 " });
  assertEquals([res.status, body], [200, { purchaseId: PURCHASE_ID, ttr: null, warnings: {} }]);
  assertEquals(completeArgs(s), {
    p_entity: ENTITY_ID,
    p_staff: STAFF_ID,
    p_purchase_id: PURCHASE_ID,
    p_invoice: "INV-100",
    p_part_amount: null,
    p_fills: [],
  });
  assertEquals(s.admin.rpcArgs("gold.complete_purchase").length, 1);
});

Deno.test("the invoice is required", async () => {
  for (const erpInvoiceNo of ["", "   ", undefined]) {
    const s = scenario();
    const { res, body } = await post(s, { erpInvoiceNo });
    assertEquals(res.status, 422, String(erpInvoiceNo));
    assert(body.errors.erp_invoice_no);
    nothingWritten(s);
  }
});

Deno.test("a purchase that already has an invoice number is a 409: it is set once", async () => {
  const s = scenario({ purchase: savedRow({ erp_invoice_no: "INV-1" }) });
  const { res, body } = await post(s);
  assertEquals([res.status, body.error], [409, "already_has_invoice"]);
  nothingWritten(s);
});

Deno.test("values a client sends for saved or computed fields are ignored", async () => {
  const s = scenario();
  const { body } = await post(s, {
    cashBand: "10k_plus",
    cash_10k_or_more: true,
    ttrSelfConducted: true,
    ttr_details_confirmed: true,
    idExpiredAtTime: true,
    completedAt: "2020-01-01",
    completedByStaffId: "99999999-9999-9999-9999-999999999999",
    purchaseType: "bullion",
  });
  assertEquals(body.ttr, null);
  assertEquals(Object.keys(completeArgs(s)).sort(), ["p_entity", "p_fills", "p_invoice", "p_part_amount", "p_purchase_id", "p_staff"]);
});

Deno.test("a reportable purchase for a customer with details missing is case B", async () => {
  const s = scenario({ purchase: savedRow({ cash_band: "10k_plus" }), readiness: ["date_of_birth"] });
  const refused = await post(s, { erpInvoiceNo: "" });
  assert(refused.body.errors.erp_invoice_no.includes("Jane Citizen"), "says why the invoice is needed now");
  const ok = await post(s);
  assertEquals([ok.res.status, ok.body.ttr], [200, "B"]);
});

Deno.test("case A: a ready customer who answered Yes and Yes at the counter", async () => {
  const s = scenario({ purchase: savedRow({ cash_band: "10k_plus", ttr_self_conducted: true, ttr_details_confirmed: true }) });
  const ok = await post(s);
  assertEquals([ok.res.status, ok.body.ttr], [200, "A"]);
});

Deno.test("becoming reportable here without counter answers is case B", async () => {
  const s = scenario({ purchase: savedRow({ cash_band: "10k_plus" }) });
  assertEquals((await post(s)).body.ttr, "B");
});

const other = { id: "e0000000-0000-0000-0000-000000000001", customer_id: JOINT, joint_customer_id: null, sale_date: "2026-10-01" };

Deno.test("duplicate invoice: blocks a reportable purchase, only warns on a non-reportable one", async () => {
  const reportable = scenario({
    purchase: savedRow({ cash_band: "10k_plus", ttr_self_conducted: true, ttr_details_confirmed: true }),
    sameInvoice: [other],
  });
  const refused = await post(reportable);
  assertEquals(refused.res.status, 422);
  assert(refused.body.errors.erp_invoice_no.includes("already used"));
  nothingWritten(reportable);

  const plain = scenario({ sameInvoice: [other] });
  const ok = await post(plain);
  assertEquals(ok.res.status, 200);
  assert(ok.body.warnings.duplicateInvoice);
  assertEquals(plain.admin.rpcArgs("gold.complete_purchase").length, 1);
});

Deno.test("completed TTR (3.5): an invoice whose TTR for this type is complete is refused; another type's is not", async () => {
  const done = { ttr_transaction_id: "t1", ttr_status: "complete" };
  const same = scenario({ purchase: savedRow({ cash_amount: 3000 }), linked: [part(done)] });
  const refused = await post(same);
  assertEquals(refused.res.status, 422);
  assert(refused.body.errors.erp_invoice_no.includes("already finished"));
  nothingWritten(same);

  const bullion = scenario({ purchase: savedRow({ cash_amount: 3000 }), linked: [part({ ...done, purchase_type: "bullion" })] });
  assertEquals((await post(bullion)).res.status, 200);
});

Deno.test("reportable with an ID that was expired or outside the window when saved is blocked", async () => {
  for (const flag of ["id_expired_at_time", "id_outside_window_at_time"]) {
    const s = scenario({ purchase: savedRow({ cash_band: "10k_plus", [flag]: true }) });
    const { res, body } = await post(s);
    assertEquals([res.status, body.blocked], [422, true], flag);
    nothingWritten(s);

    const fine = scenario({ purchase: savedRow({ [flag]: true }) });
    assertEquals((await post(fine)).res.status, 200, `${flag} on a non-reportable purchase does not block`);
  }
});

Deno.test("linked parts are found for the saved sale date, not today, and the purchase is not linked to itself", async () => {
  const s = scenario({ purchase: savedRow({ cash_amount: 1000 }), linked: [part({ id: PURCHASE_ID, cash_amount: 1000 })] });
  const { res, body } = await post(s, { erpInvoiceNo: "inv-5" });
  assertEquals([res.status, body.ttr], [200, null]);
  assertEquals(s.user.rpcArgs("gold.linked_parts"), [{ p_customer_id: MAIN, p_invoice_norm: "inv-5", p_sale_date: "2026-10-01" }]);
  assertEquals(completeArgs(s).p_part_amount, null);
});

Deno.test("linking on completion: the part amount and earlier amounts are required, then written with the invoice", async () => {
  const unknown = part({ cash_amount: null });
  const s = scenario({ linked: [unknown] });
  const refused = await post(s);
  assert(refused.body.errors.partAmount && refused.body.errors[`linked_${PART_A}`]);
  nothingWritten(s);

  const ok = await post(s, { partAmount: "6,000", linkedAmounts: { [PART_A]: "4500" } });
  assertEquals(ok.res.status, 200);
  assertEquals(completeArgs(s).p_part_amount, 6000);
  assertEquals(completeArgs(s).p_fills, [{ id: PART_A, cash_amount: 4500 }]);
  assertEquals(ok.body.ttr, "B", "10,500 across the invoice is reportable and no counter answers were taken");
});

Deno.test("an amount already saved is never replaced by the client's", async () => {
  const s = scenario({ purchase: savedRow({ cash_amount: 2000 }), linked: [part()] });
  await post(s, { partAmount: "9999" });
  assertEquals(completeArgs(s).p_part_amount, null);
});

Deno.test("database refusals map to their status", async () => {
  for (const [code, status, error] of [
    ["23001", 409, "already_has_invoice"],
    ["40001", 409, "linked_part_changed"],
    ["P0002", 404, "purchase_not_found"],
    ["XX000", 500, "save_failed"],
  ] as const) {
    const s = scenario({ adminErrors: { "gold.complete_purchase": { code } } });
    const { res, body } = await post(s);
    assertEquals([res.status, body.error], [status, error], code);
  }
});

// Refusals raised inside the write transaction after the invoice lock (migration 20261107000002).
Deno.test("a duplicate or finished-TTR refusal raised after the invoice lock is a 422 field error", async () => {
  for (const [code, text] of [["GD001", "already used by another purchase"], ["GD002", "already finished"]] as const) {
    const s = scenario({ adminErrors: { "gold.complete_purchase": { code } } });
    const { res, body } = await post(s, { erpInvoiceNo: "INV-RACE" });
    assertEquals([res.status, body.error, body.blocked], [422, "validation_failed", false]);
    assert(body.errors.erp_invoice_no.includes(text));
  }
});

Deno.test("a failing read is a 500 and writes nothing", async () => {
  const s = scenario({ userErrors: { customer_ttr_ready: { code: "XX000" } } });
  const { res, body } = await post(s);
  assertEquals([res.status, body.error], [500, "server_error"]);
  nothingWritten(s);
});

Deno.test("logs carry IDs and error codes only", async () => {
  const s = scenario({ adminErrors: { "gold.complete_purchase": { code: "XX000" } } });
  const { logged } = await captureLogs(() => post(s, { erpInvoiceNo: "INV-SECRET-9" }));
  assert(logged.length > 0);
  for (const secret of ["Jane", "Citizen", "INV-SECRET"]) assert(!logged.join("\n").includes(secret), secret);
  const ok = scenario();
  assertEquals((await captureLogs(() => post(ok))).logged, []);
});
