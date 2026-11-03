import { assertEquals } from "std/assert";
import { CUSTOMER_ID, ENTITY_ID, OPTS, STAFF_ID, jwt, postJson, rpcCalls, run } from "../_shared/goldTestKit.ts";
import type { Call, Scenario } from "../_shared/goldTestKit.ts";
import { handleRequest } from "./index.ts";

const BODY = { customerId: CUSTOMER_ID, changes: { firstName: "Janet", residentialAddress: { street: "2 New St", suburb: "Brunswick", state: "VIC", postcode: "3056" } } };

const scenario = (over: Partial<Scenario> & { saved?: unknown } = {}): Scenario => ({
  ...over,
  handler: (c: Call) => (c.path === "/rpc/gold_update_customer" ? (over.saved ?? { changed: ["first_name"] }) : undefined),
});

Deno.test("refuses when the flag is off, without a token, and below aal2", OPTS, async () => {
  const off = await run(handleRequest, postJson(BODY), scenario({ role: "manager" }), { enabled: null });
  assertEquals((await off.res.json()).error, "gold_disabled");
  assertEquals(off.calls.length, 0);
  assertEquals((await run(handleRequest, postJson(BODY, null), scenario({ role: "manager" }))).res.status, 401);
  const aal1 = await run(handleRequest, postJson(BODY, jwt("aal1")), scenario({ role: "manager" }));
  assertEquals(aal1.res.status, 403);
  assertEquals(rpcCalls(aal1, "gold_update_customer").length, 0);
});

Deno.test("an ordinary staff member is forbidden and nothing is written", OPTS, async () => {
  const r = await run(handleRequest, postJson(BODY), scenario({ role: "staff" }));
  assertEquals(r.res.status, 403);
  assertEquals((await r.res.json()).error, "forbidden");
  assertEquals(rpcCalls(r, "gold_update_customer").length, 0);
});

Deno.test("managers and admins may edit", OPTS, async () => {
  for (const role of ["manager", "admin"] as const) {
    const r = await run(handleRequest, postJson(BODY), scenario({ role }));
    assertEquals(r.res.status, 200, role);
    assertEquals(await r.res.json(), { customerId: CUSTOMER_ID, changed: ["first_name"] });
  }
});

Deno.test("sends only the mapped columns, with identity from the server", OPTS, async () => {
  const r = await run(handleRequest, postJson(BODY), scenario({ role: "manager" }));
  const a = rpcCalls(r, "gold_update_customer")[0].body as Record<string, any>;
  assertEquals(a.p_entity_id, ENTITY_ID);
  assertEquals(a.p_staff_id, STAFF_ID);
  assertEquals(a.p_customer_id, CUSTOMER_ID);
  assertEquals(a.p_changes, {
    first_name: "Janet",
    res_street: "2 New St",
    res_suburb: "Brunswick",
    res_state: "VIC",
    res_postcode: "3056",
    res_country: "Australia",
  });
});

Deno.test("ID details and ownership fields are refused before any write", OPTS, async () => {
  const r = await run(
    handleRequest,
    postJson({ customerId: CUSTOMER_ID, changes: { documentNumber: "X", reportingEntityId: "e" } }),
    scenario({ role: "manager" }),
  );
  assertEquals(r.res.status, 400);
  const { error, fields } = await r.res.json();
  assertEquals(error, "validation_failed");
  assertEquals(Object.keys(fields).sort(), ["documentNumber", "reportingEntityId"]);
  assertEquals(rpcCalls(r, "gold_update_customer").length, 0);
});

Deno.test("bad values are refused with the field names", OPTS, async () => {
  const r = await run(handleRequest, postJson({ customerId: "x", changes: { phone: "1234567", firstName: "" } }), scenario({ role: "manager" }));
  assertEquals(r.res.status, 400);
  assertEquals(Object.keys((await r.res.json()).fields).sort(), ["customerId", "firstName", "phone"]);
});

Deno.test("a body that is not JSON is invalid_request", OPTS, async () => {
  const r = await run(
    handleRequest,
    new Request("http://stub.test/fn", { method: "POST", headers: { Authorization: `Bearer ${jwt()}` }, body: "nope" }),
    scenario({ role: "manager" }),
  );
  assertEquals(r.res.status, 400);
  assertEquals((await r.res.json()).error, "invalid_request");
});

Deno.test("an unknown customer, another business's customer or a company is customer_not_found", OPTS, async () => {
  const missing = new Response(JSON.stringify({ code: "P0002", message: "customer_not_found", details: null, hint: null }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
  const r = await run(handleRequest, postJson(BODY), {
    role: "manager",
    handler: (c) => (c.path === "/rpc/gold_update_customer" ? missing : undefined),
  });
  assertEquals(r.res.status, 404);
  assertEquals((await r.res.json()).error, "customer_not_found");
});

Deno.test("other database errors are update_failed and log only a code", OPTS, async () => {
  const boom = new Response(JSON.stringify({ code: "23514", message: "Janet 1990-04-02", details: null, hint: null }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
  const r = await run(handleRequest, postJson(BODY), {
    role: "manager",
    handler: (c) => (c.path === "/rpc/gold_update_customer" ? boom : undefined),
  });
  assertEquals(r.res.status, 500);
  assertEquals((await r.res.json()).error, "update_failed");
  assertEquals(r.logged.join("\n").includes("Janet"), false);
});
