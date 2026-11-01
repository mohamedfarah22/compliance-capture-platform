import { assert, assertEquals } from "std/assert";

// Handler-level tests with a stubbed fetch. Customer linking lives in the SQL function
// ttr.complete_transaction (see 20261101000005_link_transaction_customers.sql and the
// pgTAP file 02b_customer_linking.test.sql, which cover creating, linking, updating and
// auditing customers). What the edge function must guarantee is narrower, and is what
// these tests pin down: completion happens through that one RPC and nothing else writes,
// a failure inside it (linking included) is never reported as complete, and validation
// still stops a bad TTR before the RPC runs.
//
// Separate file from index.test.ts because index.ts reads its environment when imported,
// so the variables must be set before it is.
Deno.env.set("SUPABASE_URL", "http://stub.test");
Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
const { handleRequest } = await import("./index.ts");

const STAFF_ID = "11111111-1111-1111-1111-111111111111";
const TX_ID = "22222222-2222-2222-2222-222222222222";

interface Stub {
  rpcCalls: Record<string, unknown>[];
  writes: string[];
  rpcResponse: { status: number; body: unknown };
  parties: Record<string, unknown>[];
}

function validParty(overrides: Record<string, unknown> = {}) {
  return {
    id: "party-1",
    party_type: "individual",
    first_name: "Jane",
    last_name: "Doe",
    date_of_birth: "1985-06-15",
    res_street: "1 Main St",
    res_suburb: "Coburg",
    res_state: "VIC",
    res_postcode: "3058",
    phone: "0400000000",
    occupation: "Jeweller",
    gender: "F",
    citizenship_country_code: "AU",
    tax_residency_country_code: "AU",
    ...overrides,
  };
}

const VALID_IDV = {
  id: "idv-1",
  party_id: "party-1",
  verification_method: "Sighted original document",
  document_type: "Passport",
  document_number: "P123456",
  verification_description: "Passport sighted in person",
  front_image_id: "img-1",
  id_country_code: "AU",
};

function makeStub(overrides: Partial<Stub> = {}): Stub {
  return {
    rpcCalls: [],
    writes: [],
    rpcResponse: { status: 204, body: null },
    parties: [validParty()],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Answers the PostgREST and GoTrue calls the handler makes. A request for a single row
// (Accept: application/vnd.pgrst.object+json) gets an object; anything else gets an array.
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
    if (path.startsWith("/rest/v1/rpc/")) {
      const name = path.split("/").pop()!;
      stub.rpcCalls.push({ name, body: JSON.parse(String(init?.body ?? "{}")) });
      return jsonResponse(stub.rpcResponse.body, stub.rpcResponse.status);
    }
    if (method !== "GET") {
      stub.writes.push(`${method} ${path}`);
      return jsonResponse([], 200);
    }

    const table = path.replace("/rest/v1/", "");
    const rows: Record<string, unknown>[] = {
      staff_members: [{ is_active: true, reporting_entity_id: "entity-1" }],
      transactions: [{
        id: TX_ID,
        status: "draft",
        scenario: "bullion_sell",
        aud_value: 15000,
        transaction_datetime: "2026-07-04T00:00:00Z",
        transaction_ref: "INV-1",
        designated_service: "Sale of bullion for physical cash",
        reporting_entity_id: "entity-1",
        completed_at: "2026-10-31T00:00:00Z",
      }],
      reporting_entities: [{ austrac_account_number: "123456789" }],
      parties: stub.parties,
      id_verifications: [VALID_IDV],
    }[table] ?? [];
    return jsonResponse(wantsObject ? (rows[0] ?? null) : rows);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function completeRequest() {
  return new Request("http://stub.test/functions/v1/complete-transaction", {
    method: "POST",
    headers: { Authorization: "Bearer test-jwt", "Content-Type": "application/json" },
    body: JSON.stringify({ transactionId: TX_ID }),
  });
}

// The Supabase client starts an auth refresh timer; that is irrelevant to a request/response
// handler, so the leak sanitizers are off for these tests only.
const OPTS = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "a valid TTR completes through the single complete_transaction RPC, which links customers in the same transaction",
  ...OPTS,
  fn: async () => {
    const stub = makeStub();
    const restore = installFetch(stub);
    try {
      const res = await handleRequest(completeRequest());
      const body = await res.json();

      assertEquals(res.status, 200);
      assertEquals(body.completed, true);
      assertEquals(stub.rpcCalls, [{
        name: "complete_transaction",
        body: { p_transaction_id: TX_ID, p_staff_member_id: STAFF_ID },
      }]);
      // Linking is not a second request the function could skip or lose: no other write is sent.
      assertEquals(stub.writes, []);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "if the RPC fails (a customer could not be linked), the response is a 500 and the TTR is not reported complete",
  ...OPTS,
  fn: async () => {
    const stub = makeStub({
      rpcResponse: { status: 400, body: { code: "P0001", message: "boom: customer insert refused", details: null, hint: null } },
    });
    const restore = installFetch(stub);
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await handleRequest(completeRequest());
      const body = await res.json();

      assertEquals(res.status, 500);
      assertEquals(body.error, "Unexpected database error");
      assert(!("completed" in body));
      assertEquals(stub.rpcCalls.length, 1);
    } finally {
      console.error = originalError;
      restore();
    }
  },
});

Deno.test({
  name: "a TTR that fails validation never reaches the RPC, so no customer is created for it",
  ...OPTS,
  fn: async () => {
    const stub = makeStub({ parties: [validParty({ date_of_birth: null })] });
    const restore = installFetch(stub);
    try {
      const res = await handleRequest(completeRequest());
      const body = await res.json();

      assertEquals(res.status, 422);
      assert(body.errors.some((e: { field: string }) => e.field === "date_of_birth"));
      assertEquals(stub.rpcCalls, []);
    } finally {
      restore();
    }
  },
});
