import { assert, assertEquals } from "std/assert";
import {
  ENTITY_ID,
  OPTS,
  PHOTO,
  PHOTO_SHA256,
  STAFF_ID,
  jwt,
  postForm,
  rpcCalls,
  run,
  storageCalls,
} from "../_shared/goldTestKit.ts";
import type { Call, Scenario } from "../_shared/goldTestKit.ts";
import { handleRequest } from "./index.ts";

const PAYLOAD = {
  firstName: "Jane",
  middleName: "Q",
  lastName: "Citizen",
  dateOfBirth: "1990-04-02",
  phone: "0412 345 678",
  email: "jane@example.test",
  aliases: ["Janey"],
  residentialAddress: { street: "1 Test St", suburb: "Coburg", state: "VIC", postcode: "3058" },
  id: {
    documentType: "Driver licence",
    documentNumber: "DL998877",
    issuer: "VIC",
    idCountryCode: "AU",
    hasExpiry: true,
    expiryDate: "2030-01-31",
  },
};
const FILES = { front: PHOTO, back: PHOTO };

const COLLISION_ROW = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  customer_id: "c2222222-2222-2222-2222-222222222222",
  owner_kind: "customer",
  owner_name: "Other Person",
  owner_dob: "1980-01-01",
  document_type: "Driver licence",
  created_at: "2026-10-01T00:00:00Z",
  transaction_ref: null,
};
const DUPE_ROW = {
  customer_id: "c3333333-3333-3333-3333-333333333333",
  first_name: "Jane",
  last_name: "Citizen",
  date_of_birth: "1990-04-02",
  phone: "0412345678",
  match_reason: "name_dob",
};
const CREATED = {
  customer_id: "x",
  verification_id: "y",
  front_image_id: "f",
  back_image_id: "b",
};

/** Answers the lookups and the save; each test overrides only what it needs. */
function scenario(over: { collision?: unknown; dupes?: unknown; save?: Response | unknown; role?: Scenario["role"] } = {}): Scenario {
  return {
    role: over.role,
    handler: (c: Call) => {
      if (c.path === "/rpc/get_verification_for_document") return over.collision ? [over.collision] : [];
      if (c.path === "/rpc/find_possible_duplicate_customers") return over.dupes ? [over.dupes] : [];
      if (c.path === "/rpc/gold_create_customer") return over.save ?? CREATED;
      return undefined;
    },
  };
}

const errorResponse = (code: string, message: string) =>
  new Response(JSON.stringify({ code, message, details: null, hint: null }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });

// ─── Access: requireGoldStaff runs first ───────────────────────────────────────────────────

Deno.test("refuses before reading anything when the gold flag is off", OPTS, async () => {
  const r = await run(handleRequest, postForm(PAYLOAD, FILES), scenario(), { enabled: null });
  assertEquals(r.res.status, 403);
  assertEquals((await r.res.json()).error, "gold_disabled");
  assertEquals(r.calls.length, 0);
});

Deno.test("refuses without a token, below aal2, and for a non-staff user", OPTS, async () => {
  const none = await run(handleRequest, postForm(PAYLOAD, FILES, null), scenario());
  assertEquals(none.res.status, 401);
  const aal1 = await run(handleRequest, postForm(PAYLOAD, FILES, jwt("aal1")), scenario());
  assertEquals(aal1.res.status, 403);
  assertEquals((await aal1.res.json()).error, "mfa_required");
  const stranger = await run(handleRequest, postForm(PAYLOAD, FILES), { ...scenario(), staff: null });
  assertEquals(stranger.res.status, 403);
  for (const r of [none, aal1, stranger]) {
    assertEquals(rpcCalls(r, "gold_create_customer").length, 0);
    assertEquals(storageCalls(r, "POST").length, 0);
  }
});

Deno.test("an ordinary staff member may create a customer", OPTS, async () => {
  const r = await run(handleRequest, postForm(PAYLOAD, FILES), scenario({ role: "staff" }));
  assertEquals(r.res.status, 201);
});

Deno.test("the CORS preflight needs no credentials", OPTS, async () => {
  const r = await run(handleRequest, new Request("http://stub.test/fn", { method: "OPTIONS" }), scenario());
  assertEquals(r.res.status, 204);
});

Deno.test("rejects non-POST after the access check", OPTS, async () => {
  const r = await run(handleRequest, new Request("http://stub.test/fn", { method: "GET", headers: { Authorization: `Bearer ${jwt()}` } }), scenario());
  assertEquals(r.res.status, 405);
});

// ─── Request shape ─────────────────────────────────────────────────────────────────────────

Deno.test("a body that is not multipart with a JSON payload is invalid_request", OPTS, async () => {
  const r = await run(
    handleRequest,
    new Request("http://stub.test/fn", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt()}`, "Content-Type": "application/json" },
      body: "{}",
    }),
    scenario(),
  );
  assertEquals(r.res.status, 400);
  assertEquals((await r.res.json()).error, "invalid_request");
});

Deno.test("validation failures name the fields and store nothing", OPTS, async () => {
  const bad = { ...PAYLOAD, phone: "1234567", id: { ...PAYLOAD.id, documentType: "Passport", hasExpiry: true, expiryDate: "" } };
  const r = await run(handleRequest, postForm(bad, { back: PHOTO }), scenario());
  assertEquals(r.res.status, 400);
  const body = await r.res.json();
  assertEquals(body.error, "validation_failed");
  assertEquals(Object.keys(body.fields).sort(), ["frontImage", "id.expiryDate", "phone"]);
  assertEquals(storageCalls(r, "POST").length, 0);
  assertEquals(rpcCalls(r, "gold_create_customer").length, 0);
});

Deno.test("a driver licence without a back photo is refused; a passport without one is fine", OPTS, async () => {
  const dl = await run(handleRequest, postForm(PAYLOAD, { front: PHOTO }), scenario());
  assertEquals((await dl.res.json()).fields.backImage !== undefined, true);
  const passport = { ...PAYLOAD, id: { ...PAYLOAD.id, documentType: "Passport" } };
  const ok = await run(handleRequest, postForm(passport, { front: PHOTO }), scenario());
  assertEquals(ok.res.status, 201);
  assertEquals(storageCalls(ok, "POST").length, 1);
});

// ─── Collisions and duplicates ─────────────────────────────────────────────────────────────

Deno.test("a document already on file is a 409 id_on_file with its owner, and nothing is stored", OPTS, async () => {
  const r = await run(handleRequest, postForm(PAYLOAD, FILES), scenario({ collision: COLLISION_ROW }));
  assertEquals(r.res.status, 409);
  const body = await r.res.json();
  assertEquals(body.error, "id_on_file");
  assertEquals(body.owner.customerId, COLLISION_ROW.customer_id);
  assertEquals(body.owner.name, "Other Person");
  assertEquals(storageCalls(r, "POST").length, 0);
  assertEquals(rpcCalls(r, "gold_create_customer").length, 0);
});

Deno.test("differentPerson saves the capture as a different person when a collision exists", OPTS, async () => {
  const r = await run(handleRequest, postForm({ ...PAYLOAD, differentPerson: true }, FILES), scenario({ collision: COLLISION_ROW }));
  assertEquals(r.res.status, 201);
  assertEquals((rpcCalls(r, "gold_create_customer")[0].body as Record<string, unknown>).p_different_person, true);
});

Deno.test("differentPerson is ignored when there is no collision", OPTS, async () => {
  const r = await run(handleRequest, postForm({ ...PAYLOAD, differentPerson: true }, FILES), scenario());
  assertEquals(r.res.status, 201);
  assertEquals((rpcCalls(r, "gold_create_customer")[0].body as Record<string, unknown>).p_different_person, false);
});

Deno.test("a name + date of birth or phone match is possible_duplicates unless confirmNew", OPTS, async () => {
  const held = await run(handleRequest, postForm(PAYLOAD, FILES), scenario({ dupes: DUPE_ROW }));
  assertEquals(held.res.status, 409);
  const body = await held.res.json();
  assertEquals(body.error, "possible_duplicates");
  assertEquals(body.duplicates[0].customerId, DUPE_ROW.customer_id);
  assertEquals(body.duplicates[0].matchReason, "name_dob");
  assertEquals(storageCalls(held, "POST").length, 0);

  const confirmed = await run(handleRequest, postForm({ ...PAYLOAD, confirmNew: true }, FILES), scenario({ dupes: DUPE_ROW }));
  assertEquals(confirmed.res.status, 201);
  assertEquals(confirmed.calls.some((c) => c.path === "/rpc/find_possible_duplicate_customers"), false);
});

Deno.test("the duplicate lookup is given the typed name, date of birth and phone", OPTS, async () => {
  const r = await run(handleRequest, postForm(PAYLOAD, FILES), scenario());
  const args = r.calls.find((c) => c.path === "/rpc/find_possible_duplicate_customers")!.body;
  assertEquals(args, { p_first_name: "Jane", p_last_name: "Citizen", p_dob: "1990-04-02", p_phone: "0412 345 678" });
});

// ─── The save ──────────────────────────────────────────────────────────────────────────────

Deno.test("saves in one RPC with server-chosen identity and hashed photos under customers/", OPTS, async () => {
  const hostile = { ...PAYLOAD, createdByStaffId: "evil", reportingEntityId: "evil", source: "ttr" };
  const r = await run(handleRequest, postForm(hostile, FILES), scenario());
  assertEquals(r.res.status, 201);
  assertEquals(await r.res.json(), { customerId: "x", verificationId: "y", frontImageId: "f", backImageId: "b" });

  const calls = rpcCalls(r, "gold_create_customer");
  assertEquals(calls.length, 1);
  const a = calls[0].body as Record<string, any>;
  assertEquals(a.p_entity_id, ENTITY_ID);
  assertEquals(a.p_staff_id, STAFF_ID);
  assertEquals(JSON.stringify(a).includes("evil"), false);
  assertEquals(a.p_customer.res_country, "Australia");
  assertEquals(a.p_aliases, ["Janey"]);
  assertEquals(a.p_id.document_type, "Driver licence");
  assertEquals(a.p_images.length, 2);
  for (const img of a.p_images) {
    assert(img.object_path.startsWith(`customers/${a.p_customer_id}/${a.p_verification_id}/${img.side}-`));
    assertEquals(img.content_hash_sha256, PHOTO_SHA256);
    assertEquals(img.byte_size, PHOTO.length);
  }
  assertEquals(storageCalls(r, "POST").length, 2);
  assertEquals(storageCalls(r, "DELETE").length, 0);
  // The service role makes the write; the lookups use the caller's own client.
  assertEquals(calls[0].api, "rest");
});

Deno.test("a failed save removes the uploaded photos and returns create_failed", OPTS, async () => {
  const r = await run(handleRequest, postForm(PAYLOAD, FILES), scenario({ save: errorResponse("23514", "chk_something") }));
  assertEquals(r.res.status, 500);
  assertEquals((await r.res.json()).error, "create_failed");
  assertEquals(storageCalls(r, "POST").length, 2);
  const removal = storageCalls(r, "DELETE");
  assertEquals(removal.length, 1);
  assertEquals((removal[0].body as { prefixes: string[] }).prefixes.length, 2);
});

Deno.test("losing the race on the document number is reported as id_on_file", OPTS, async () => {
  let lookups = 0;
  const r = await run(handleRequest, postForm(PAYLOAD, FILES), {
    handler: (c) => {
      if (c.path === "/rpc/get_verification_for_document") return ++lookups === 1 ? [] : [COLLISION_ROW];
      if (c.path === "/rpc/gold_create_customer") return errorResponse("23505", 'duplicate key value violates unique constraint "uq_idv_doc_new_capture"');
      return undefined;
    },
  });
  assertEquals(r.res.status, 409);
  assertEquals((await r.res.json()).owner.name, "Other Person");
  assertEquals(storageCalls(r, "DELETE").length, 1);
});

Deno.test("a failed upload stores no row and removes what it had stored", OPTS, async () => {
  let uploads = 0;
  const r = await run(handleRequest, postForm(PAYLOAD, FILES), {
    handler: (c) => {
      if (c.api === "storage" && c.method === "POST" && ++uploads === 2) {
        return new Response(JSON.stringify({ statusCode: "500", error: "boom", message: "boom" }), { status: 500 });
      }
      return undefined;
    },
  });
  assertEquals(r.res.status, 500);
  assertEquals((await r.res.json()).error, "upload_failed");
  assertEquals(rpcCalls(r, "gold_create_customer").length, 0);
  assertEquals(storageCalls(r, "DELETE").length, 1);
});

Deno.test("logs carry IDs and codes only, never names, phones, dates of birth or ID numbers", OPTS, async () => {
  const r = await run(handleRequest, postForm(PAYLOAD, FILES), scenario({ save: errorResponse("23514", "boom") }));
  assert(r.logged.length > 0);
  const log = r.logged.join("\n");
  for (const secret of ["Jane", "Citizen", "0412", "1990-04-02", "DL998877", "jane@example.test", "1 Test St"]) {
    assertEquals(log.includes(secret), false, `log contains ${secret}`);
  }
});
