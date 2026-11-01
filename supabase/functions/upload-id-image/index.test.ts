import { assert, assertEquals, assertMatch } from "std/assert";

// Handler-level tests with a stubbed fetch, in the style of
// complete-transaction/index.handler.test.ts: index.ts reads its environment when imported,
// so the variables are set first and the module is imported dynamically.
//
// What these pin down for the customer owner (gold): the customer must belong to the
// caller's entity (proved by RLS, so a customer the stub hides is "not found" and nothing is
// uploaded or written), the object lands under customers/{customer}/{verification}/, the
// SHA-256 is computed server-side, the row is written with customer_id and no transaction,
// and an unrecorded object is cleaned up. The transaction owner (the TTR wizard) must behave
// exactly as before.
Deno.env.set("SUPABASE_URL", "http://stub.test");
Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
const { handleRequest } = await import("./index.ts");

const STAFF_ID = "11111111-1111-1111-1111-111111111111";
const CUSTOMER_ID = "c1000000-0000-0000-0000-000000000001";
const VERIFICATION_ID = "d1000000-0000-0000-0000-000000000001";
const TX_ID = "22222222-2222-2222-2222-222222222222";
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);

interface Stub {
  customerVisible: boolean;
  txStatus: string;
  insertFails: boolean;
  uploads: { path: string; upsert: string | null }[];
  removed: string[][];
  restWrites: { method: string; path: string; search: string; profile: string | null; prefer: string | null; body: Record<string, unknown> }[];
  customerLookups: string[];
}

function makeStub(overrides: Partial<Stub> = {}): Stub {
  return {
    customerVisible: true,
    txStatus: "draft",
    insertFails: false,
    uploads: [],
    removed: [],
    restWrites: [],
    customerLookups: [],
    ...overrides,
  };
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

    if (path.startsWith("/storage/v1/object/compliance-media/") && method === "POST") {
      stub.uploads.push({
        path: decodeURIComponent(path.replace("/storage/v1/object/compliance-media/", "")),
        upsert: headers.get("x-upsert"),
      });
      return jsonResponse({ Key: "compliance-media/x" });
    }
    if (path === "/storage/v1/object/compliance-media" && method === "DELETE") {
      stub.removed.push(JSON.parse(String(init?.body ?? "{}")).prefixes);
      return jsonResponse([]);
    }

    if (path === "/rest/v1/customers" && method === "GET") {
      stub.customerLookups.push(url.search);
      return jsonResponse(stub.customerVisible ? [{ id: CUSTOMER_ID }] : []);
    }
    if (path === "/rest/v1/transactions" && method === "GET") {
      const row = { id: TX_ID, status: stub.txStatus };
      return jsonResponse(wantsObject ? row : [row]);
    }
    if (path === "/rest/v1/stored_images" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      stub.restWrites.push({
        method, path, search: url.search,
        profile: headers.get("content-profile"), prefer: headers.get("prefer"), body,
      });
      if (stub.insertFails) {
        return jsonResponse({ code: "23514", message: "check violation", details: null, hint: null }, 400);
      }
      const row = { id: "img-1", object_path: body.object_path, content_hash_sha256: body.content_hash_sha256 };
      return jsonResponse(wantsObject ? row : [row], 201);
    }
    return jsonResponse([]);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function uploadRequest(fields: Record<string, string | File | null>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== null) form.set(k, v);
  return new Request("http://stub.test/functions/v1/upload-id-image", {
    method: "POST",
    headers: { Authorization: "Bearer test-jwt" },
    body: form,
  });
}

function photo(type = "image/jpeg") {
  return new File([IMAGE_BYTES], "id.jpg", { type });
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const customerFields = (extra: Record<string, string | File | null> = {}) => ({
  customerId: CUSTOMER_ID,
  verificationId: VERIFICATION_ID,
  side: "front",
  file: photo(),
  ...extra,
});

// The Supabase client starts an auth refresh timer; irrelevant to a request/response handler.
const OPTS = { sanitizeOps: false, sanitizeResources: false };

async function run(stub: Stub, req: Request) {
  const restore = installFetch(stub);
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await handleRequest(req);
    return { res, body: await res.json() };
  } finally {
    console.error = originalError;
    restore();
  }
}

// ─── Customer as owner ───────────────────────────────────────────────────────────────────

Deno.test({
  name: "customer owner: uploads under customers/{customer}/{verification}/, hashes server-side, and writes a customer-owned row",
  ...OPTS,
  fn: async () => {
    const stub = makeStub();
    const { res, body } = await run(stub, uploadRequest(customerFields()));

    assertEquals(res.status, 201);
    assertEquals(stub.uploads.length, 1);
    assertMatch(
      stub.uploads[0].path,
      new RegExp(`^customers/${CUSTOMER_ID}/${VERIFICATION_ID}/front-[0-9a-f-]{36}\\.jpg$`),
    );
    // A customer photo is never overwritten: each upload gets a fresh path.
    assertEquals(stub.uploads[0].upsert, "false");

    assertEquals(stub.restWrites.length, 1);
    const write = stub.restWrites[0];
    assertEquals(write.profile, "ttr");
    assertEquals(write.body.customer_id, CUSTOMER_ID);
    assert(!("transaction_id" in write.body), "a customer-owned row carries no transaction_id");
    assertEquals(write.body.object_path, stub.uploads[0].path);
    assertEquals(write.body.content_hash_sha256, await sha256Hex(IMAGE_BYTES));
    assertEquals(write.body.captured_by_staff_id, STAFF_ID);
    assertEquals(write.body.byte_size, IMAGE_BYTES.length);
    // A plain insert, not the draft path's upsert on (bucket, path).
    assert(!(write.prefer ?? "").includes("merge-duplicates"));

    assertEquals(body.id, "img-1");
    assertEquals(body.objectPath, stub.uploads[0].path);
    assertEquals(body.contentHashSha256, await sha256Hex(IMAGE_BYTES));
    assertEquals(stub.removed, []);
  },
});

Deno.test({
  name: "customer owner: a customer outside the caller's entity (hidden by RLS) is refused, with nothing uploaded or written",
  ...OPTS,
  fn: async () => {
    const stub = makeStub({ customerVisible: false });
    const { res, body } = await run(stub, uploadRequest(customerFields()));

    assertEquals(res.status, 404);
    assertEquals(body.error, "Customer not found");
    // The lookup is made with the caller's JWT against public.customers, filtered by the id.
    assertEquals(stub.customerLookups.length, 1);
    assert(stub.customerLookups[0].includes(`id=eq.${CUSTOMER_ID}`));
    assertEquals(stub.uploads, []);
    assertEquals(stub.restWrites, []);
  },
});

Deno.test({
  name: "customer owner: sending both a transaction and a customer is refused",
  ...OPTS,
  fn: async () => {
    const stub = makeStub();
    const { res } = await run(stub, uploadRequest(customerFields({ transactionId: TX_ID })));
    assertEquals(res.status, 400);
    assertEquals(stub.uploads, []);
  },
});

Deno.test({
  name: "customer owner: missing verificationId, malformed ids, a bad side and a bad file type are refused before any lookup",
  ...OPTS,
  fn: async () => {
    for (
      const [fields, status] of [
        [customerFields({ verificationId: null }), 400],
        [customerFields({ verificationId: "../../etc" }), 400],
        [customerFields({ customerId: "not-a-uuid" }), 400],
        [customerFields({ side: "left" }), 400],
        [customerFields({ file: photo("application/pdf") }), 415],
      ] as const
    ) {
      const stub = makeStub();
      const { res } = await run(stub, uploadRequest(fields));
      assertEquals(res.status, status);
      assertEquals(stub.customerLookups, []);
      assertEquals(stub.uploads, []);
    }
  },
});

Deno.test({
  name: "customer owner: if the row cannot be written, the new object is removed so no orphan is left",
  ...OPTS,
  fn: async () => {
    const stub = makeStub({ insertFails: true });
    const { res } = await run(stub, uploadRequest(customerFields()));

    assertEquals(res.status, 500);
    assertEquals(stub.uploads.length, 1);
    assertEquals(stub.removed, [[stub.uploads[0].path]]);
  },
});

// ─── Transaction as owner: unchanged ─────────────────────────────────────────────────────

const txFields = (extra: Record<string, string | File | null> = {}) => ({
  transactionId: TX_ID,
  personType: "party",
  personId: "p1",
  side: "front",
  file: photo(),
  ...extra,
});

Deno.test({
  name: "transaction owner: still uploads to {transaction}/{personType}-{personId}-{side}.jpg with upsert, and upserts the row",
  ...OPTS,
  fn: async () => {
    const stub = makeStub();
    const { res, body } = await run(stub, uploadRequest(txFields()));

    assertEquals(res.status, 201);
    assertEquals(stub.uploads, [{ path: `${TX_ID}/party-p1-front.jpg`, upsert: "true" }]);
    assertEquals(stub.restWrites.length, 1);
    const write = stub.restWrites[0];
    assertEquals(write.body.transaction_id, TX_ID);
    assert(!("customer_id" in write.body));
    assertEquals(write.body.object_path, `${TX_ID}/party-p1-front.jpg`);
    assertEquals(write.body.content_hash_sha256, await sha256Hex(IMAGE_BYTES));
    assert(write.search.includes("on_conflict=storage_bucket%2Cobject_path"));
    assert((write.prefer ?? "").includes("merge-duplicates"));
    assertEquals(body.objectPath, `${TX_ID}/party-p1-front.jpg`);
    assertEquals(stub.customerLookups, []);
  },
});

Deno.test({
  name: "transaction owner: a completed transaction is still refused, and the required-fields rule is unchanged",
  ...OPTS,
  fn: async () => {
    const stub = makeStub({ txStatus: "complete" });
    const { res } = await run(stub, uploadRequest(txFields()));
    assertEquals(res.status, 409);
    assertEquals(stub.uploads, []);

    const stub2 = makeStub();
    const { res: res2, body } = await run(stub2, uploadRequest(txFields({ personId: null })));
    assertEquals(res2.status, 400);
    assertEquals(body.error, "Required fields: transactionId, personType, personId, side, file");
  },
});
