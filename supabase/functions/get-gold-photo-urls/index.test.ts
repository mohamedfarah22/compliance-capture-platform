import { assert, assertEquals } from "std/assert";
import { captureLogs, fakeContext } from "../_shared/goldFakes.ts";
import type { FakeSpec } from "../_shared/goldFakes.ts";
import { handleRequest, SIGNED_URL_TTL_SECONDS } from "./index.ts";
import type { Deps } from "./index.ts";

const PURCHASE_ID = "b1111111-1111-1111-1111-111111111111";
const OTHER_PURCHASE_ID = "b2222222-2222-2222-2222-222222222222";

const photo = (purchase: string, n: number) => ({
  id: `f${n}000000-0000-0000-0000-00000000000${n}`,
  purchase_id: purchase,
  object_path: `${purchase}/goods-${n}.jpg`,
  sort_order: n - 1,
});

function scenario(user: FakeSpec = {}, admin: FakeSpec = {}) {
  const f = fakeContext(
    {
      tables: {
        "gold.purchases": [{ id: PURCHASE_ID }],
        "gold.goods_photos": [photo(PURCHASE_ID, 1), photo(PURCHASE_ID, 2), photo(OTHER_PURCHASE_ID, 1)],
      },
      ...user,
    },
    admin,
  );
  const deps: Deps = { authenticate: () => Promise.resolve(f.ctx) };
  return { ...f, deps };
}

async function post(s: ReturnType<typeof scenario>, body: unknown = { purchaseId: PURCHASE_ID }) {
  const res = await handleRequest(
    new Request("http://stub.test/functions/v1/get-gold-photo-urls", { method: "POST", body: JSON.stringify(body) }),
    s.deps,
  );
  return { res, body: await res.json() };
}

Deno.test({
  name: "access: flag off is 403 gold_disabled, no Authorization is 401",
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

Deno.test("signs one purchase's photos in order, with a short expiry", async () => {
  const s = scenario();
  const { res, body } = await post(s);
  assertEquals(res.status, 200);
  assertEquals(body.urls.map((u: Record<string, unknown>) => u.sortOrder), [0, 1]);
  assertEquals(body.urls[0].url, `https://signed.test/${PURCHASE_ID}/goods-1.jpg?ttl=${SIGNED_URL_TTL_SECONDS}`);
  assert(SIGNED_URL_TTL_SECONDS <= 300, "short-lived");
  const signed = s.admin.calls.filter((c) => c.kind === "sign");
  assertEquals(signed.length, 1);
  assertEquals(signed[0].name, "gold-goods");
  assertEquals((signed[0].args as { paths: string[] }).paths, [`${PURCHASE_ID}/goods-1.jpg`, `${PURCHASE_ID}/goods-2.jpg`]);
});

Deno.test("another entity's purchase (RLS hides it) is a 404 and nothing is signed", async () => {
  const s = scenario();
  const { res, body } = await post(s, { purchaseId: OTHER_PURCHASE_ID });
  assertEquals([res.status, body.error], [404, "purchase_not_found"]);
  assertEquals(s.admin.calls.filter((c) => c.kind === "sign").length, 0);
});

Deno.test("a purchase with no photos returns an empty list without calling storage", async () => {
  const s = scenario({ tables: { "gold.purchases": [{ id: PURCHASE_ID }], "gold.goods_photos": [] } });
  const { res, body } = await post(s);
  assertEquals([res.status, body], [200, { urls: [] }]);
  assertEquals(s.admin.calls.length, 0);
});

Deno.test("a malformed request is a 400", async () => {
  for (const body of [{}, { purchaseId: 5 }, { purchaseId: "nope" }]) {
    const s = scenario();
    const r = await post(s, body);
    assertEquals([r.res.status, r.body.field], [400, "purchaseId"]);
  }
  const s = scenario();
  const res = await handleRequest(new Request("http://stub.test/", { method: "POST", body: "{nope" }), s.deps);
  assertEquals(res.status, 400);
});

Deno.test("a failed lookup or signing is a 500 that logs a code only", async () => {
  for (const [user, admin] of [
    [{ errors: { "gold.goods_photos": { code: "XX000" } } }, {}],
    [{ errors: { "gold.purchases": { code: "XX000" } } }, {}],
    [{}, { errors: { "storage.sign": { code: "x" } } }],
  ] as [FakeSpec, FakeSpec][]) {
    const s = scenario(user, admin);
    const { result, logged } = await captureLogs(() => post(s));
    assertEquals([result.res.status, result.body.error], [500, "server_error"]);
    assert(logged.length === 1 && !logged[0].includes(PURCHASE_ID));
  }
});

Deno.test("only the signed-in caller's client reads rows; the service client only signs", async () => {
  const s = scenario();
  await post(s);
  assertEquals(s.admin.calls.map((c) => c.kind), ["sign"]);
  assert(s.user.calls.every((c) => c.kind === "select"));
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
