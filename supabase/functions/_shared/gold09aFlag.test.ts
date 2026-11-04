// UAT row 9.1 (docs/uat-gold-09a-ttr-handoff.md, spec 2.2): gold-start-ttr refuses with 403 gold_disabled unless
// GOLD_JOURNEY_ENABLED is exactly "true", before it reads the token or the request and before it touches the
// database. The secret cannot be toggled on the shared local runtime, so this drives the handler with the stubbed
// fetch of goldTestKit (as gold06Flag.test.ts does for the Phase 6 functions).
import { assert, assertEquals } from "std/assert";
import { handleRequest } from "../gold-start-ttr/index.ts";
import { OPTS, post, postJson, rpcCalls, run } from "./goldTestKit.ts";

const request = () => postJson({ purchaseId: "00000000-0000-4000-8000-000000000001" });

for (const value of [null, "", "false", "TRUE", "1", "true ", " true", "True", "yes"]) {
  Deno.test(`9.1 gold-start-ttr with the secret ${JSON.stringify(value)} is 403 gold_disabled and touches nothing`, OPTS, async () => {
    const { res, calls } = await run(handleRequest, request(), { role: "admin" }, { enabled: value });
    assertEquals([res.status, (await res.json()).error], [403, "gold_disabled"]);
    assertEquals(calls.length, 0);
  });
}

Deno.test("9.1 gold-start-ttr with no token and the secret off is still 403 gold_disabled, not 401 (the gate comes first)", OPTS, async () => {
  const { res, calls } = await run(handleRequest, post("{}", {}, null), {}, { enabled: "false" });
  assertEquals([res.status, (await res.json()).error], [403, "gold_disabled"]);
  assertEquals(calls.length, 0);
});

Deno.test("9.1 gold-start-ttr with the secret exactly \"true\" gets past the gate: no token is 401, a valid request reaches the RPC", OPTS, async () => {
  const noToken = await run(handleRequest, post("{}", {}, null), {}, { enabled: "true" });
  assertEquals(noToken.res.status, 401);
  const ok = await run(handleRequest, request(), { role: "staff", handler: (c) => (c.path === "/rpc/start_ttr" ? [] : undefined) }, { enabled: "true" });
  assertEquals(ok.res.status, 200);
  assert(rpcCalls(ok, "start_ttr").length === 1);
});
