import { assert, assertEquals } from "std/assert";
import { captureLogs, ENTITY_ID, fakeContext, STAFF_ID } from "../_shared/goldFakes.ts";
import type { FakeSpec } from "../_shared/goldFakes.ts";
import { handleRequest } from "./index.ts";
import type { Deps } from "./index.ts";

const PURCHASE_ID = "b1111111-1111-1111-1111-111111111111";
const TTRS = [{ id: "a1111111-1111-1111-1111-111111111111", type: "scrap", scenario: "precious_metal_buy", status: "draft", created: true, case: "A" }];

function scenario(o: { result?: unknown; adminErrors?: FakeSpec["errors"] } = {}) {
  const f = fakeContext({}, { rpcs: { "gold.start_ttr": o.result === undefined ? TTRS : o.result }, errors: o.adminErrors });
  const deps: Deps = { authenticate: () => Promise.resolve(f.ctx) };
  return { ...f, deps };
}

async function post(s: ReturnType<typeof scenario>, body: unknown = { purchaseId: PURCHASE_ID }) {
  const res = await handleRequest(
    new Request("http://stub.test/functions/v1/gold-start-ttr", { method: "POST", body: JSON.stringify(body) }),
    s.deps,
  );
  return { res, body: await res.json() };
}

const startArgs = (s: ReturnType<typeof scenario>) => s.admin.rpcArgs("gold.start_ttr");

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

Deno.test("a malformed request is a 400 and writes nothing", async () => {
  for (const body of [{ purchaseId: "nope" }, {}, []]) {
    const s = scenario();
    const r = await post(s, body);
    assertEquals(r.res.status, 400);
    assertEquals(startArgs(s).length, 0);
  }
  const s = scenario();
  const res = await handleRequest(new Request("http://stub.test/", { method: "POST", body: "{nope" }), s.deps);
  assertEquals(res.status, 400);
});

Deno.test("starts the TTR: one write, business and staff from the session, shared constants passed", async () => {
  const s = scenario();
  const { res, body } = await post(s, { purchaseId: PURCHASE_ID, entity: "evil", staff: "evil", cash: 1 });
  assertEquals(res.status, 200);
  assertEquals(body.ttrs, TTRS);
  assertEquals(startArgs(s).length, 1);
  const args = startArgs(s)[0];
  assertEquals([args.p_entity, args.p_staff, args.p_purchase_id], [ENTITY_ID, STAFF_ID, PURCHASE_ID]);
  assertEquals(args.p_location, "Coburg, VIC");
  assertEquals(args.p_services.bullion_buy, "Purchase of bullion for physical cash");
});

Deno.test("database refusals become the documented errors", async () => {
  for (const [code, status, error] of [
    ["P0002", 404, "purchase_not_found"],
    ["23505", 409, "ttr_reference_in_use"],
    ["GD003", 422, "invoice_required"],
    ["GD004", 422, "not_reportable"],
    ["GD005", 422, "no_cash"],
    ["XX000", 500, "start_failed"],
  ] as const) {
    const s = scenario({ adminErrors: { "gold.start_ttr": { code } } });
    const { res, body } = await captureLogs(() => post(s)).then((r) => r.result);
    assertEquals([res.status, body.error], [status, error], code);
  }
});

Deno.test("logs carry the purchase id and the error code only", async () => {
  const s = scenario({ adminErrors: { "gold.start_ttr": { code: "GD004" } } });
  const { logged } = await captureLogs(() => post(s));
  assert(logged.length > 0);
  for (const line of logged) assert(line.includes(PURCHASE_ID) && line.includes("GD004"), line);
});
