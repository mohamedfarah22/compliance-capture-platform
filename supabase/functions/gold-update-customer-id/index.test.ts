import { assertEquals } from "std/assert";
import {
  CUSTOMER_ID,
  ENTITY_ID,
  OPTS,
  PHOTO,
  STAFF_ID,
  jwt,
  postForm,
  rpcCalls,
  run,
  storageCalls,
} from "../_shared/goldTestKit.ts";
import type { Call, Scenario } from "../_shared/goldTestKit.ts";
import { handleRequest, plan } from "./index.ts";

const DOC = {
  documentType: "Driver licence",
  documentNumber: "DL998877",
  issuer: "VIC",
  idCountryCode: "AU",
  hasExpiry: true,
  expiryDate: "2032-01-31",
};
const payload = (reason: string, over: Record<string, unknown> = {}) => ({ customerId: CUSTOMER_ID, reason, ...DOC, ...over });
const FILES = { front: PHOTO, back: PHOTO };

const OWN = { id: "aaaaaaaa-0000-0000-0000-000000000001", customer_id: CUSTOMER_ID, owner_kind: "customer" };
const OTHERS = { id: "aaaaaaaa-0000-0000-0000-000000000002", customer_id: "c2222222-2222-2222-2222-222222222222", owner_kind: "customer", owner_name: "Other Person" };
const SAVED = { verification_id: "v", front_image_id: "f", back_image_id: "b", stale_image_ids: [] as string[] };

function scenario(over: { match?: unknown; customer?: boolean; saved?: unknown; role?: Scenario["role"] } = {}): Scenario {
  return {
    role: over.role,
    handler: (c: Call) => {
      if (c.path === "/customers") return over.customer === false ? [] : [{ id: CUSTOMER_ID }];
      if (c.path === "/rpc/get_verification_for_document") return over.match ? [over.match] : [];
      if (c.path === "/rpc/gold_update_customer_id") return over.saved ?? SAVED;
      return undefined;
    },
  };
}

// ─── plan: what each reason does with the lookup result ────────────────────────────────────

Deno.test("renewed links to the customer's own capture of the same number, else saves unlinked", () => {
  assertEquals(plan("renewed", OWN, CUSTOMER_ID), { kind: "save", reason: "id_changed", priorId: OWN.id });
  assertEquals(plan("renewed", null, CUSTOMER_ID), { kind: "save", reason: "id_changed", priorId: null });
});

Deno.test("photo unclear always links, so it needs the document on file", () => {
  assertEquals(plan("photo_unclear", OWN, CUSTOMER_ID), { kind: "save", reason: "stored_copy_unclear", priorId: OWN.id });
  assertEquals(plan("photo_unclear", null, CUSTOMER_ID), { kind: "document_not_on_file" });
});

Deno.test("different document never links, and the number must be new", () => {
  assertEquals(plan("different_document", null, CUSTOMER_ID), { kind: "save", reason: "different_document", priorId: null });
  assertEquals(plan("different_document", OWN, CUSTOMER_ID), { kind: "id_on_file" });
});

Deno.test("a number held by someone else is id_on_file for every reason", () => {
  for (const reason of ["renewed", "photo_unclear", "different_document"]) {
    assertEquals(plan(reason, OTHERS, CUSTOMER_ID), { kind: "id_on_file" });
  }
});

// ─── access ────────────────────────────────────────────────────────────────────────────────

Deno.test("refuses when the flag is off, without a token, and below aal2", OPTS, async () => {
  const off = await run(handleRequest, postForm(payload("renewed"), FILES), scenario(), { enabled: null });
  assertEquals((await off.res.json()).error, "gold_disabled");
  assertEquals(off.calls.length, 0);
  assertEquals((await run(handleRequest, postForm(payload("renewed"), FILES, null), scenario())).res.status, 401);
  const aal1 = await run(handleRequest, postForm(payload("renewed"), FILES, jwt("aal1")), scenario());
  assertEquals(aal1.res.status, 403);
  assertEquals(rpcCalls(aal1, "gold_update_customer_id").length, 0);
});

// ─── request ───────────────────────────────────────────────────────────────────────────────

Deno.test("needs a customer, one of the three reasons, the document fields and photos", OPTS, async () => {
  const r = await run(
    handleRequest,
    postForm({ customerId: "nope", reason: "because", documentType: "Passport", documentNumber: "" }, {}),
    scenario(),
  );
  assertEquals(r.res.status, 400);
  const { fields } = await r.res.json();
  for (const k of ["customerId", "reason", "documentNumber", "issuer", "idCountryCode", "hasExpiry", "frontImage"]) {
    assertEquals(typeof fields[k], "string", k);
  }
  assertEquals(storageCalls(r, "POST").length, 0);
});

Deno.test("a reason that is not one of the three is refused, including inherited object names", OPTS, async () => {
  for (const reason of ["because", "", "id_changed", "toString", "constructor"]) {
    const r = await run(handleRequest, postForm(payload(reason), FILES), scenario({ match: OWN }));
    assertEquals(r.res.status, 400, reason);
    assertEquals(typeof (await r.res.json()).fields.reason, "string", reason);
    assertEquals(rpcCalls(r, "gold_update_customer_id").length, 0);
  }
});

Deno.test("a customer of another business (or none) is customer_not_found", OPTS, async () => {
  const r = await run(handleRequest, postForm(payload("renewed"), FILES), scenario({ customer: false }));
  assertEquals(r.res.status, 404);
  assertEquals((await r.res.json()).error, "customer_not_found");
  assertEquals(storageCalls(r, "POST").length, 0);
});

Deno.test("the customer lookup is scoped to the caller's business and to individuals", OPTS, async () => {
  const r = await run(handleRequest, postForm(payload("renewed"), FILES), scenario());
  const lookup = r.calls.find((c) => c.path === "/customers")!;
  assertEquals(lookup.query.includes(`id=eq.${CUSTOMER_ID}`), true);
  assertEquals(lookup.query.includes(`reporting_entity_id=eq.${ENTITY_ID}`), true);
  assertEquals(lookup.query.includes("customer_type=eq.individual"), true);
});

// ─── save ──────────────────────────────────────────────────────────────────────────────────

Deno.test("renewed with the same number saves id_changed linked to the capture on file", OPTS, async () => {
  const r = await run(handleRequest, postForm(payload("renewed"), FILES), scenario({ match: OWN }));
  assertEquals(r.res.status, 201);
  const a = rpcCalls(r, "gold_update_customer_id")[0].body as Record<string, any>;
  assertEquals(a.p_reason, "id_changed");
  assertEquals(a.p_prior_verification_id, OWN.id);
  assertEquals(a.p_staff_id, STAFF_ID);
  assertEquals(a.p_entity_id, ENTITY_ID);
  assertEquals(a.p_customer_id, CUSTOMER_ID);
  assertEquals(a.p_images.length, 2);
  assertEquals(a.p_images[0].object_path.startsWith(`customers/${CUSTOMER_ID}/${a.p_verification_id}/`), true);
});

Deno.test("photo unclear saves stored_copy_unclear linked", OPTS, async () => {
  const r = await run(handleRequest, postForm(payload("photo_unclear"), FILES), scenario({ match: OWN }));
  assertEquals(r.res.status, 201);
  const a = rpcCalls(r, "gold_update_customer_id")[0].body as Record<string, any>;
  assertEquals([a.p_reason, a.p_prior_verification_id], ["stored_copy_unclear", OWN.id]);
});

Deno.test("photo unclear for a document not on file is document_not_on_file and stores nothing", OPTS, async () => {
  const r = await run(handleRequest, postForm(payload("photo_unclear"), FILES), scenario());
  assertEquals(r.res.status, 409);
  assertEquals((await r.res.json()).error, "document_not_on_file");
  assertEquals(storageCalls(r, "POST").length, 0);
});

Deno.test("a different document saves unlinked and supersedes nothing", OPTS, async () => {
  const r = await run(handleRequest, postForm(payload("different_document", { documentType: "Passport", documentNumber: "PA1" }), { front: PHOTO }), scenario());
  assertEquals(r.res.status, 201);
  assertEquals((await r.res.json()).superseded, 0);
  const a = rpcCalls(r, "gold_update_customer_id")[0].body as Record<string, any>;
  assertEquals([a.p_reason, a.p_prior_verification_id], ["different_document", null]);
  assertEquals(storageCalls(r, "DELETE").length, 0);
});

Deno.test("another customer's number is id_on_file with the owner, and stores nothing", OPTS, async () => {
  const r = await run(handleRequest, postForm(payload("renewed"), FILES), scenario({ match: OTHERS }));
  assertEquals(r.res.status, 409);
  const body = await r.res.json();
  assertEquals([body.error, body.owner.name], ["id_on_file", "Other Person"]);
  assertEquals(storageCalls(r, "POST").length, 0);
});

Deno.test("the old photos of the same document are superseded after the save", OPTS, async () => {
  const stale = ["51111111-1111-1111-1111-111111111111", "52222222-2222-2222-2222-222222222222"];
  const r = await run(handleRequest, postForm(payload("renewed"), FILES), {
    handler: (c) => {
      if (c.path === "/stored_images" && c.method === "GET") {
        return stale.map((id) => ({ id, object_path: `customers/${CUSTOMER_ID}/old/${id}.jpg` }));
      }
      return scenario({ match: OWN, saved: { ...SAVED, stale_image_ids: stale } }).handler!(c);
    },
  });
  assertEquals(r.res.status, 201);
  assertEquals((await r.res.json()).superseded, 2);
  // Objects removed, then the rows stamped, in the ttr schema, replaced by the new front image.
  const removal = storageCalls(r, "DELETE");
  assertEquals((removal[0].body as { prefixes: string[] }).prefixes.length, 2);
  const stamp = r.calls.find((c) => c.path === "/stored_images" && c.method === "PATCH")!;
  assertEquals(stamp.schema, "ttr");
  assertEquals((stamp.body as Record<string, unknown>).superseded_by_image_id, "f");
});

Deno.test("a failed database save removes the new photos and supersedes nothing", OPTS, async () => {
  const r = await run(handleRequest, postForm(payload("renewed"), FILES), {
    handler: (c) =>
      c.path === "/rpc/gold_update_customer_id"
        ? new Response(JSON.stringify({ code: "23514", message: "boom" }), { status: 400, headers: { "Content-Type": "application/json" } })
        : scenario({ match: OWN }).handler!(c),
  });
  assertEquals(r.res.status, 500);
  assertEquals((await r.res.json()).error, "update_failed");
  assertEquals(storageCalls(r, "DELETE").length, 1);
  assertEquals(r.calls.some((c) => c.method === "PATCH"), false);
});

Deno.test("logs carry IDs and codes only", OPTS, async () => {
  const r = await run(handleRequest, postForm(payload("renewed"), FILES), {
    handler: (c) =>
      c.path === "/rpc/gold_update_customer_id"
        ? new Response(JSON.stringify({ code: "23514", message: "DL998877" }), { status: 400, headers: { "Content-Type": "application/json" } })
        : scenario({ match: OWN }).handler!(c),
  });
  assertEquals(r.logged.join("\n").includes("DL998877"), false);
});
