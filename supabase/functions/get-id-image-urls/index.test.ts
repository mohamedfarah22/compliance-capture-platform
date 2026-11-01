import { assert, assertEquals } from "std/assert";

// Handler-level tests with a stubbed fetch (see complete-transaction/index.handler.test.ts
// for why: index.ts reads its environment when imported).
//
// Authorisation is RLS on ttr.stored_images under the caller's JWT, so the stub plays the
// part of RLS: `visibleImages` is what the database returns to this caller. A customer's
// photo outside their entity is simply absent, and what the function must then do is sign
// nothing and log nothing. For a visible customer photo it must sign it and write the
// ttr.access_log row before releasing the URL.
Deno.env.set("SUPABASE_URL", "http://stub.test");
Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
const { handleRequest } = await import("./index.ts");

const STAFF_ID = "11111111-1111-1111-1111-111111111111";
const ENTITY_ID = "e1111111-1111-1111-1111-111111111111";
const CUSTOMER_ID = "c1000000-0000-0000-0000-000000000001";
const TX_ID = "22222222-2222-2222-2222-222222222222";

const CUSTOMER_IMAGE = {
  id: "img-customer",
  object_path: `customers/${CUSTOMER_ID}/v-1/front-aaaa.jpg`,
  transaction_id: null,
  customer_id: CUSTOMER_ID,
};
const TX_IMAGE = {
  id: "img-tx",
  object_path: `${TX_ID}/party-p1-front.jpg`,
  transaction_id: TX_ID,
  customer_id: null,
};

interface Stub {
  visibleImages: Record<string, unknown>[];
  logFails: boolean;
  imageQueries: string[];
  signed: string[][];
  accessLogRows: Record<string, unknown>[];
}

function makeStub(overrides: Partial<Stub> = {}): Stub {
  return { visibleImages: [], logFails: false, imageQueries: [], signed: [], accessLogRows: [], ...overrides };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(stub: Stub): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const wantsObject = (headers.get("accept") ?? "").includes("pgrst.object");
    const path = url.pathname;

    if (path === "/auth/v1/user") {
      return jsonResponse({ id: STAFF_ID, aud: "authenticated", email: "staff@example.test" });
    }
    if (path === "/rest/v1/staff_members") {
      const row = { is_active: true, reporting_entity_id: ENTITY_ID };
      return jsonResponse(wantsObject ? row : [row]);
    }
    if (path === "/rest/v1/stored_images" && method === "GET") {
      stub.imageQueries.push(url.search);
      return jsonResponse(stub.visibleImages);
    }
    if (path === "/storage/v1/object/sign/compliance-media" && method === "POST") {
      const paths: string[] = JSON.parse(String(init?.body ?? "{}")).paths;
      stub.signed.push(paths);
      return jsonResponse(paths.map((p) => ({ error: null, path: p, signedURL: `/object/sign/compliance-media/${p}?token=t` })));
    }
    if (path === "/rest/v1/access_log" && method === "POST") {
      if (stub.logFails) {
        return jsonResponse({ code: "XX000", message: "db down", details: null, hint: null }, 500);
      }
      stub.accessLogRows.push(...JSON.parse(String(init?.body ?? "[]")));
      return jsonResponse(null, 201);
    }
    return jsonResponse([]);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function request(imageIds: string[]) {
  return new Request("http://stub.test/functions/v1/get-id-image-urls", {
    method: "POST",
    headers: { Authorization: "Bearer test-jwt", "Content-Type": "application/json" },
    body: JSON.stringify({ imageIds }),
  });
}

// The Supabase client starts an auth refresh timer; irrelevant to a request/response handler.
const OPTS = { sanitizeOps: false, sanitizeResources: false };

async function run(stub: Stub, imageIds: string[]) {
  const restore = installFetch(stub);
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await handleRequest(request(imageIds));
    return { res, body: await res.json() };
  } finally {
    console.error = originalError;
    restore();
  }
}

Deno.test({
  name: "a customer photo the caller can see is signed, and the view is logged to ttr.access_log with no transaction",
  ...OPTS,
  fn: async () => {
    const stub = makeStub({ visibleImages: [CUSTOMER_IMAGE] });
    const { res, body } = await run(stub, ["img-customer"]);

    assertEquals(res.status, 200);
    assertEquals(stub.signed, [[CUSTOMER_IMAGE.object_path]]);
    assert(body.urls["img-customer"].includes(CUSTOMER_IMAGE.object_path));

    assertEquals(stub.accessLogRows, [{
      reporting_entity_id: ENTITY_ID,
      staff_member_id: STAFF_ID,
      action: "view",
      resource_type: "stored_images",
      resource_id: "img-customer",
      transaction_id: null,
      // The path names the customer, so the log says whose ID was viewed.
      detail: CUSTOMER_IMAGE.object_path,
    }]);
    // The lookup asks for the customer owner as well as the transaction.
    assert(stub.imageQueries[0].includes("customer_id"));
  },
});

Deno.test({
  name: "a customer photo outside the caller's entity (not returned under their RLS) is neither signed nor logged",
  ...OPTS,
  fn: async () => {
    const stub = makeStub({ visibleImages: [] });
    const { res, body } = await run(stub, ["img-customer"]);

    assertEquals(res.status, 200);
    assertEquals(body.urls, {});
    assertEquals(stub.signed, []);
    assertEquals(stub.accessLogRows, []);
  },
});

Deno.test({
  name: "transaction and customer photos in one request are each signed and each logged; the transaction one keeps its transaction_id",
  ...OPTS,
  fn: async () => {
    const stub = makeStub({ visibleImages: [TX_IMAGE, CUSTOMER_IMAGE] });
    const { res, body } = await run(stub, ["img-tx", "img-customer"]);

    assertEquals(res.status, 200);
    assertEquals(Object.keys(body.urls).sort(), ["img-customer", "img-tx"]);
    assertEquals(stub.accessLogRows.map((r) => [r.resource_id, r.transaction_id]), [
      ["img-tx", TX_ID],
      ["img-customer", null],
    ]);
  },
});

Deno.test({
  name: "if the view cannot be logged, no URL is released (fail closed), for a customer photo as for any other",
  ...OPTS,
  fn: async () => {
    const stub = makeStub({ visibleImages: [CUSTOMER_IMAGE], logFails: true });
    const { res, body } = await run(stub, ["img-customer"]);

    assertEquals(res.status, 500);
    assertEquals(body.error, "Failed to record image access");
    assert(!("urls" in body));
  },
});
