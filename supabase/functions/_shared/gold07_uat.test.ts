// Gold Phase 7 UAT row 7.1 (docs/uat-gold-07-purchase-writes.md): with GOLD_JOURNEY_ENABLED not exactly "true",
// all three purchase functions answer 403 gold_disabled before they look at the token, and touch nothing.
// Runs each function's real handler with its real default access check (no fakes for auth), and fails the test
// if anything tries to reach the network. The stack-level check (anon call answers 401 `unauthorized` locally, so
// the local secret is on) is the first thing every Playwright gold07 call depends on.
import { assertEquals } from "std/assert";
import { handleRequest as completePurchase } from "../gold-complete-purchase/index.ts";
import { handleRequest as savePurchase } from "../gold-save-purchase/index.ts";
import { handleRequest as photoUrls } from "../get-gold-photo-urls/index.ts";

const handlers: Record<string, (req: Request) => Promise<Response>> = {
  "gold-save-purchase": (req) => savePurchase(req),
  "gold-complete-purchase": (req) => completePurchase(req),
  "get-gold-photo-urls": (req) => photoUrls(req),
};

const request = (name: string) =>
  new Request(`http://stub.test/${name}`, {
    method: "POST",
    headers: { Authorization: "Bearer not-even-looked-at", "Content-Type": "application/json" },
    body: JSON.stringify({ purchaseId: "00000000-0000-4000-8000-000000000000", erpInvoiceNo: "INV-X" }),
  });

Deno.test("7.1 ⚠ — every purchase function answers 403 gold_disabled unless GOLD_JOURNEY_ENABLED is exactly true, and does nothing else", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    return Promise.reject(new Error("network is off in this test"));
  }) as typeof fetch;
  const original = Deno.env.get("GOLD_JOURNEY_ENABLED");
  try {
    for (const setting of [null, "", "false", "TRUE", "1", "true "]) {
      if (setting === null) Deno.env.delete("GOLD_JOURNEY_ENABLED");
      else Deno.env.set("GOLD_JOURNEY_ENABLED", setting);
      for (const [name, handle] of Object.entries(handlers)) {
        // A handler that gets past the flag check and throws is a failure of this row, not a setup error.
        const res = await handle(request(name)).catch((e) => new Response(JSON.stringify({ threw: String(e) }), { status: 500 }));
        assertEquals(res.status, 403, `${name} with GOLD_JOURNEY_ENABLED=${JSON.stringify(setting)}`);
        assertEquals(await res.json(), { error: "gold_disabled" }, `${name} with ${JSON.stringify(setting)}`);
      }
    }
    assertEquals(calls, [], "no network call while gold is off");
  } finally {
    globalThis.fetch = realFetch;
    if (original === undefined) Deno.env.delete("GOLD_JOURNEY_ENABLED");
    else Deno.env.set("GOLD_JOURNEY_ENABLED", original);
  }
});
