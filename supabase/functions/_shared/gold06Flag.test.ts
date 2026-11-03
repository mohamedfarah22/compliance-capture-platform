// UAT rows 6.1 to 6.3 (docs/uat-gold-06-customer-writes.md, spec 2.2): every gold customer function
// refuses with 403 gold_disabled unless GOLD_JOURNEY_ENABLED is exactly "true", before it reads the
// request or touches the database. The secret cannot be toggled on the shared local runtime, so this
// drives each function's handler with the stubbed fetch of goldTestKit.
import { assert, assertEquals } from "std/assert";
import { handleRequest as createCustomer } from "../gold-create-customer/index.ts";
import { handleRequest as updateCustomerId } from "../gold-update-customer-id/index.ts";
import { handleRequest as updateCustomer } from "../gold-update-customer/index.ts";
import { OPTS, post, postJson, run } from "./goldTestKit.ts";

const FUNCTIONS: [string, (req: Request) => Promise<Response>, () => Request][] = [
  ["gold-create-customer", createCustomer, () => post("--x--", { "Content-Type": "multipart/form-data; boundary=x" })],
  ["gold-update-customer-id", updateCustomerId, () => post("--x--", { "Content-Type": "multipart/form-data; boundary=x" })],
  ["gold-update-customer", updateCustomer, () => postJson({ customerId: "00000000-0000-4000-8000-000000000001", changes: { firstName: "X" } })],
];

for (const [name, handle, request] of FUNCTIONS) {
  Deno.test(`6.1 ${name} with the secret unset is 403 gold_disabled and touches nothing`, OPTS, async () => {
    const { res, calls } = await run(handle, request(), { role: "admin" }, { enabled: null });
    assertEquals(res.status, 403);
    assertEquals(await res.json(), { error: "gold_disabled" });
    assertEquals(calls.length, 0);
  });

  Deno.test(`6.2 ${name} with the secret "false" and a valid admin token is 403 gold_disabled`, OPTS, async () => {
    const { res, calls } = await run(handle, request(), { role: "admin" }, { enabled: "false" });
    assertEquals([res.status, (await res.json()).error], [403, "gold_disabled"]);
    assertEquals(calls.length, 0);
  });

  for (const value of ["TRUE", "1", "True", " true", "yes", ""]) {
    Deno.test(`6.3 ${name} with the secret ${JSON.stringify(value)} is still off`, OPTS, async () => {
      const { res, calls } = await run(handle, request(), { role: "admin" }, { enabled: value });
      assertEquals([res.status, (await res.json()).error], [403, "gold_disabled"]);
      assertEquals(calls.length, 0);
    });
  }

  Deno.test(`6.3 ${name} with the secret exactly "true" gets past the gate (an unauthenticated call is then 401)`, OPTS, async () => {
    const { res } = await run(handle, post("x", {}, null), {}, { enabled: "true" });
    assertEquals(res.status, 401);
    assert((await res.json()).error === "unauthorized");
  });

  Deno.test(`6.58 ${name} answers the CORS preflight with 204, CORS headers and no credentials check`, OPTS, async () => {
    const req = new Request("http://stub.test/fn", { method: "OPTIONS", headers: { Origin: "http://localhost:3000" } });
    const { res, calls } = await run(handle, req, {}, { enabled: "true" });
    assertEquals(res.status, 204);
    assert(res.headers.get("access-control-allow-origin") !== null);
    assert(/authorization/i.test(res.headers.get("access-control-allow-headers") ?? ""));
    assertEquals(calls.length, 0);
  });
}
