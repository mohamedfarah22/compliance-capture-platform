// UAT rows 9b.1, 9b.13 and 9b.42 (docs/uat-gold-09b-exports.md, spec 2.3, 6.2, 6.4, 9): three things the running local
// stack cannot show, so the real gold-export handler (and the real requireGoldStaff) is driven with the stubbed fetch of
// goldTestKit, as gold06Flag.test.ts does for the Phase 6 functions.
//   9b.1   GOLD_JOURNEY_ENABLED is not exactly "true": 403 gold_disabled, nothing read, written or signed.
//   9b.13  the audit insert fails: 500 server_error, no storage call at all, nothing returned.
//   9b.42  on success the audit row is written before the first storage (signing) call.
import { assert, assertEquals } from "std/assert";
import { handleRequest } from "../gold-export/index.ts";
import { OPTS, postJson, run } from "./goldTestKit.ts";
import type { Call } from "./goldTestKit.ts";

const P1 = "00000000-0000-4000-8000-000000000001";
const C1 = "00000000-0000-4000-8000-000000000101";
const request = () => postJson({ kind: "zip", filters: null, purchaseIds: [P1] });

const withEnv = async (fn: () => Promise<void>) => {
  Deno.env.set("SUPABASE_URL", "http://stub.test");
  Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  try {
    await fn();
  } finally {
    Deno.env.delete("GOLD_JOURNEY_ENABLED");
  }
};

const isAudit = (c: Call) => c.method === "POST" && c.path === "/export_audit_log";

// One purchase with one goods photo and one ID, so signing has something to do.
const answers = (auditFails: boolean) => (c: Call) => {
  if (isAudit(c)) return auditFails ? new Response(JSON.stringify({ code: "XX000", message: "boom" }), { status: 500, headers: { "content-type": "application/json" } }) : new Response(null, { status: 201 });
  if (c.api === "storage") return [{ signedURL: "/object/sign/x/y.jpg?token=t", path: "y.jpg", error: null }];
  switch (c.path) {
    case "/purchases":
      return [{ id: P1, customer_id: C1, joint_customer_id: null, purchase_type: "scrap", cash_band: "under_10k", cash_10k_or_more: false, cash_amount: null, erp_invoice_no: null, phone: "0400", id_sighted: true, id_expired_at_time: false, ttr_transaction_id: null, created_at: "2026-11-05T01:00:00Z", created_by_staff_id: null, completed_at: null, completed_by_staff_id: null }];
    case "/customers":
      return [{ id: C1, first_name: "Jane", middle_name: null, last_name: "Citizen", phone: "0400" }];
    case "/goods_photos":
      return [{ purchase_id: P1, object_path: `${P1}/goods-1.jpg`, sort_order: 0 }];
    case "/rpc/export_id_photos":
      return [{ purchase_id: P1, role: "main", verification_id: C1, document_type: "Driver licence", document_number: "DL1", expiry_date: "2031-01-01", captured_at: "2026-03-01T01:00:00Z", photos_replaced: false, current_copy_captured_at: null, front_object_path: "customers/c/front.jpg", back_object_path: null }];
    default:
      return undefined;
  }
};

for (const value of [null, "", "false", "TRUE", "1", "true ", "yes"]) {
  Deno.test(`9b.1 gold-export with the secret ${JSON.stringify(value)} is 403 gold_disabled and touches nothing`, OPTS, () =>
    withEnv(async () => {
      const { res, calls } = await run(handleRequest, request(), { role: "manager", handler: answers(false) }, { enabled: value });
      assertEquals([res.status, (await res.json()).error], [403, "gold_disabled"]);
      assertEquals(calls.length, 0);
    }));
}

Deno.test("9b.1 gold-export with the secret exactly \"true\" gets past the gate (the success path used by 9b.42)", OPTS, () =>
  withEnv(async () => {
    const r = await run(handleRequest, request(), { role: "manager", handler: answers(false) }, { enabled: "true" });
    assertEquals(r.res.status, 200);
  }));

Deno.test("9b.13 when the audit insert fails the answer is 500 server_error, no storage call is made and nothing is returned", OPTS, () =>
  withEnv(async () => {
    const r = await run(handleRequest, request(), { role: "manager", handler: answers(true) });
    assertEquals([r.res.status, await r.res.json()], [500, { error: "server_error" }]);
    assert(r.calls.some(isAudit), "the audit insert was attempted");
    assertEquals(r.calls.filter((c) => c.api === "storage").length, 0);
  }));

Deno.test("9b.42 (added by UAT, spec 2.3 and 6.2) the audit row is written before the first photo URL is signed", OPTS, () =>
  withEnv(async () => {
    const r = await run(handleRequest, request(), { role: "manager", handler: answers(false) });
    assertEquals(r.res.status, 200);
    const audit = r.calls.findIndex(isAudit);
    const firstSign = r.calls.findIndex((c) => c.api === "storage");
    assert(audit >= 0, "an audit insert was made");
    assert(firstSign >= 0, "something was signed");
    assert(audit < firstSign, `audit at call ${audit}, first signing at call ${firstSign}`);
    assertEquals(r.calls.filter(isAudit).length, 1);
  }));

Deno.test("9b.3 a staff member is refused 403 forbidden by the real role check before anything is read, written or signed", OPTS, () =>
  withEnv(async () => {
    const r = await run(handleRequest, request(), { role: "staff", handler: answers(false) });
    assertEquals([r.res.status, (await r.res.json()).error], [403, "forbidden"]);
    assert(!r.calls.some(isAudit));
    assertEquals(r.calls.filter((c) => c.api === "storage").length, 0);
    assertEquals(r.calls.filter((c) => c.path === "/purchases").length, 0);
  }));
