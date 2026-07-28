import { assert, assertEquals } from "std/assert";
import { supersedePriorImages, validateParties, validatePreciousMetalItems, validateTransaction } from "./index.ts";
import type { ValidationError } from "./index.ts";
import { validateIdVerifications } from "./index.ts";

// deno-lint-ignore no-explicit-any
const dummySchemaClient = {} as any;

function makeIdv(overrides: Record<string, unknown> = {}) {
  return {
    id: "idv-1",
    party_id: "party-1",
    verification_method: "Sighted original document",
    document_type: "Passport",
    document_number: "P123456",
    verification_description: "Passport sighted in person",
    front_image_id: "img-1",
    id_country_code: "AU",
    ...overrides,
  };
}

const INDIVIDUAL_PARTY = { id: "party-1", party_type: "individual" };

// ─── TC-205: document number required, ≤100 characters ─────────────────────

Deno.test("document reference number is required", async () => {
  const errors: ValidationError[] = [];
  await validateIdVerifications([makeIdv({ document_number: "" })], [INDIVIDUAL_PARTY], [], errors, dummySchemaClient, "entity-1");

  assert(errors.some((e) => e.field === "document_number" && e.message.includes("required")));
});

Deno.test("document reference number does not exceed 100 characters (AUSTRAC IdNumber type maxLength)", async () => {
  const errors: ValidationError[] = [];
  await validateIdVerifications(
    [makeIdv({ document_number: "X".repeat(101) })],
    [INDIVIDUAL_PARTY],
    [],
    errors,
    dummySchemaClient,
    "entity-1",
  );

  assert(errors.some((e) => e.field === "document_number" && e.message.includes("100 characters")));
});

Deno.test("a document reference number of exactly 100 characters passes validation", async () => {
  const errors: ValidationError[] = [];
  await validateIdVerifications(
    [makeIdv({ document_number: "X".repeat(100) })],
    [INDIVIDUAL_PARTY],
    [],
    errors,
    dummySchemaClient,
    "entity-1",
  );

  assert(!errors.some((e) => e.field === "document_number"));
});

// ─── TC-212: transaction date must be on/after the AUSTRAC Date type minimum ─

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    aud_value: 15000,
    transaction_datetime: "2026-07-04T00:00:00Z",
    transaction_ref: "INV-1",
    designated_service: "Sale of bullion for physical cash",
    ...overrides,
  };
}

const VALID_ENTITY = { austrac_account_number: "123456789" };

Deno.test("transaction date falls on or after the AUSTRAC Date type minimum 2000-01-01", () => {
  const errors: ValidationError[] = [];
  validateTransaction(makeTx({ transaction_datetime: "1999-12-31T23:59:59Z" }), VALID_ENTITY, errors);

  assert(errors.some((e) => e.field === "transaction_datetime" && e.message.includes("2000-01-01")));
});

Deno.test("a transaction date on or after 2000-01-01 passes the minimum-date validation", () => {
  const errors: ValidationError[] = [];
  validateTransaction(makeTx({ transaction_datetime: "2000-01-01T00:00:00Z" }), VALID_ENTITY, errors);

  assert(!errors.some((e) => e.field === "transaction_datetime"));
});

// ─── TC-242: Alloy/Other precious metal items require a description ───────

Deno.test("Alloy or Other metal items require a description at validation time, independent of the client-side requirement on Precious Metal Details", () => {
  const errors: ValidationError[] = [];
  validatePreciousMetalItems(
    [{
      id: "item-1",
      direction: "Provided to customer",
      metal_type: "Alloy",
      description: "",
      weight_unit: "grams",
      quantity: 1,
      weight: 10,
      unit_price_aud: 100,
      line_total_aud: 1000,
    }],
    errors,
  );

  assert(errors.some((e) => e.field === "description" && e.message.includes("Alloy")));
});

Deno.test("a precious metal item with a non-Alloy/Other metal type does not require a description", () => {
  const errors: ValidationError[] = [];
  validatePreciousMetalItems(
    [{
      id: "item-1",
      direction: "Provided to customer",
      metal_type: "Gold",
      description: "",
      weight_unit: "grams",
      quantity: 1,
      weight: 10,
      unit_price_aud: 100,
      line_total_aud: 1000,
    }],
    errors,
  );

  assertEquals(errors.filter((e) => e.field === "description").length, 0);
});

// ─── TC-252/253: name and suburb length limits (AUSTRAC Name/Address types) ─

function makeIndividualParty(overrides: Record<string, unknown> = {}) {
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

function makeCompanyPartyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "party-2",
    party_type: "company",
    entity_name: "Acme Pty Ltd",
    reg_identifier: "12345678901",
    reg_id_type: "ABN",
    biz_street: "1 Business Rd",
    biz_suburb: "Melbourne",
    biz_state: "VIC",
    biz_postcode: "3000",
    company_phone: "0398765432",
    principal_activity: "Bullion trading",
    ...overrides,
  };
}

Deno.test("TC-252: an individual full_name over 140 characters fails validation with a length error", () => {
  const errors: ValidationError[] = [];
  validateParties([makeIndividualParty({ full_name: "J".repeat(141) })], errors);

  assert(errors.some((e) => e.field === "full_name" && e.message.includes("140 characters")));
});

Deno.test("TC-252: a company entity_name over 140 characters fails validation with a length error", () => {
  const errors: ValidationError[] = [];
  validateParties([makeCompanyPartyRow({ entity_name: "A".repeat(141) })], errors);

  assert(errors.some((e) => e.field === "entity_name" && e.message.includes("140 characters")));
});

Deno.test("TC-253: a suburb over 35 characters fails validation with a length error, for both individual and company parties", () => {
  const longSuburb = "S".repeat(36);

  const individualErrors: ValidationError[] = [];
  validateParties([makeIndividualParty({ res_suburb: longSuburb })], individualErrors);
  assert(individualErrors.some((e) => e.field === "res_suburb" && e.message.includes("35 characters")));

  const companyErrors: ValidationError[] = [];
  validateParties([makeCompanyPartyRow({ biz_suburb: longSuburb })], companyErrors);
  assert(companyErrors.some((e) => e.field === "biz_suburb" && e.message.includes("35 characters")));
});

// ─── One copy of ID on file (UAT finding #9) ────────────────────────────────
//
// uq_idv_doc_new_capture keeps one unlinked ROW per document, but nothing stopped the
// IMAGES accumulating — one licence ended a UAT pass carrying four stored pairs while the
// UI told staff each re-capture "replaces" the copy on file. supersedePriorImages deletes
// the superseded object and leaves the metadata row behind, so §3 becomes true without
// destroying the seven-year identification record.

interface FakeState {
  siblings: Record<string, unknown>[];
  stale: Record<string, unknown>[];
  removed: string[][];
  updated: { values: Record<string, unknown>; ids: unknown[] }[];
  selectError?: unknown;
  removeError?: unknown;
}

function makeFakes(state: FakeState) {
  // Mimics PostgrestFilterBuilder: every method returns the builder, awaiting it yields
  // { data, error }. Which dataset comes back depends on the table being queried.
  //
  // .in() genuinely filters. That matters: the whole point of these tests is which image
  // ids the function SELECTS, and a fake that returned every `stale` row regardless would
  // pass no matter how wrong the selection logic was.
  const builder = (table: string) => {
    const self: Record<string, unknown> = {};
    let inIds: unknown[] | null = null;
    const chain = () => self;
    self.select = chain;
    self.eq = chain;
    self.is = chain;
    self.in = (_col: string, vals: unknown[]) => {
      inIds = vals;
      return self;
    };
    self.then = (resolve: (v: unknown) => unknown) => {
      const rows = table === "id_verifications" ? state.siblings : state.stale;
      const filtered = inIds === null ? rows : rows.filter((r) => inIds!.includes(r.id));
      return Promise.resolve({ data: filtered, error: state.selectError ?? null }).then(resolve);
    };
    return self;
  };

  const ttr = {
    from: (table: string) => ({
      select: () => builder(table),
      update: (values: Record<string, unknown>) => ({
        in: (_col: string, ids: unknown[]) => {
          state.updated.push({ values, ids });
          return Promise.resolve({ error: null });
        },
      }),
    }),
    // deno-lint-ignore no-explicit-any
  } as any;

  const serviceClient = {
    storage: {
      from: () => ({
        remove: (paths: string[]) => {
          state.removed.push(paths);
          return Promise.resolve({ error: state.removeError ?? null });
        },
      }),
    },
    // deno-lint-ignore no-explicit-any
  } as any;

  return { ttr, serviceClient };
}

const RECAPTURE = {
  verification_basis: "new_capture",
  prior_verification_id: "idv-original",
  document_type: "Driver licence",
  document_number: "RGN-111222",
  front_image_id: "img-new-front",
  back_image_id: "img-new-back",
};

// The row the re-capture links to — the chain root. Unlinked by definition, since
// get_verification_for_document only ever returns the unlinked row for a document.
const ROOT = {
  id: "idv-original",
  document_number: "RGN-111222",
  prior_verification_id: null,
  front_image_id: "img-old-front",
  back_image_id: "img-old-back",
};

Deno.test("a linked re-capture deletes the superseded objects and stamps their rows, keeping the metadata", async () => {
  const state: FakeState = {
    siblings: [
      { ...ROOT, document_number: "rgn-111222 " },
      { id: "idv-new", document_number: "RGN-111222", prior_verification_id: "idv-original", front_image_id: "img-new-front", back_image_id: "img-new-back" },
    ],
    stale: [
      { id: "img-old-front", object_path: "tx-1/party-a-front.jpg" },
      { id: "img-old-back", object_path: "tx-1/party-a-back.jpg" },
    ],
    removed: [],
    updated: [],
  };
  const { ttr, serviceClient } = makeFakes(state);

  await supersedePriorImages(serviceClient, ttr, [RECAPTURE], "entity-1");

  // The objects go — that is what makes "one copy on file" literally true.
  assertEquals(state.removed, [["tx-1/party-a-front.jpg", "tx-1/party-a-back.jpg"]]);
  // The rows stay, stamped with what replaced them.
  assertEquals(state.updated.length, 1);
  assertEquals(state.updated[0].ids, ["img-old-front", "img-old-back"]);
  assertEquals(state.updated[0].values.superseded_by_image_id, "img-new-front");
  assert(state.updated[0].values.superseded_at);
});

Deno.test("document numbers are matched case- and whitespace-insensitively, exactly as the uniqueness index does", async () => {
  const state: FakeState = {
    // Differs from the re-capture only by case and a trailing space. A bare equality
    // check would miss it and leave a duplicate image on file.
    siblings: [{ ...ROOT, document_number: "  rgn-111222 ", back_image_id: null }],
    stale: [{ id: "img-old-front", object_path: "tx-1/party-a-front.jpg" }],
    removed: [],
    updated: [],
  };
  const { ttr, serviceClient } = makeFakes(state);

  await supersedePriorImages(serviceClient, ttr, [RECAPTURE], "entity-1");

  assertEquals(state.removed, [["tx-1/party-a-front.jpg"]]);
});

// ─── Never destroy a different person's ID (regression) ─────────────────────
//
// Document numbers are unique per state, not nationally, so two unrelated people can hold
// the same one — which is what the 'different_person' reason records. The first version of
// this function grouped by document number alone (the key uq_idv_doc_new_capture uses), so
// completing one customer's renewal DELETED a different customer's licence images. That key
// answers "may a second unlinked row exist"; it must never decide "may this image be
// destroyed", because the index deliberately exempts 'different_person'.

Deno.test("never supersedes a different person's capture of the same document number", async () => {
  const state: FakeState = {
    siblings: [
      ROOT,
      { id: "idv-new", document_number: "RGN-111222", prior_verification_id: "idv-original", front_image_id: "img-new-front", back_image_id: "img-new-back" },
      // Same entity, same document type, same number — a different human being.
      // Unlinked, so it is its own chain root and shares one with nobody.
      {
        id: "idv-other-person",
        document_number: "RGN-111222",
        prior_verification_id: null,
        new_capture_reason: "different_person",
        front_image_id: "img-barry-front",
        back_image_id: "img-barry-back",
      },
    ],
    // If the grouping is wrong, these get selected and their objects deleted.
    stale: [
      { id: "img-old-front", object_path: "tx-1/party-a-front.jpg" },
      { id: "img-old-back", object_path: "tx-1/party-a-back.jpg" },
      { id: "img-barry-front", object_path: "tx-9/party-b-front.jpg" },
      { id: "img-barry-back", object_path: "tx-9/party-b-back.jpg" },
    ],
    removed: [],
    updated: [],
  };
  const { ttr, serviceClient } = makeFakes(state);

  await supersedePriorImages(serviceClient, ttr, [RECAPTURE], "entity-1");

  // Only the chain root's images. Barry's must be untouched in BOTH storage and metadata.
  assertEquals(state.removed, [["tx-1/party-a-front.jpg", "tx-1/party-a-back.jpg"]]);
  assertEquals(state.updated[0].ids, ["img-old-front", "img-old-back"]);
});

Deno.test("supersedes every earlier link in the chain, not just the row it points at", async () => {
  const state: FakeState = {
    siblings: [
      ROOT,
      // An earlier re-capture. It links to the same ROOT rather than to the newest row, so
      // chain-FOLLOWING from the new row would miss it and leave two copies on file.
      { id: "idv-earlier", document_number: "RGN-111222", prior_verification_id: "idv-original", front_image_id: "img-mid-front", back_image_id: null },
      { id: "idv-new", document_number: "RGN-111222", prior_verification_id: "idv-original", front_image_id: "img-new-front", back_image_id: "img-new-back" },
    ],
    stale: [
      { id: "img-old-front", object_path: "tx-1/party-a-front.jpg" },
      { id: "img-old-back", object_path: "tx-1/party-a-back.jpg" },
      { id: "img-mid-front", object_path: "tx-2/party-a-front.jpg" },
    ],
    removed: [],
    updated: [],
  };
  const { ttr, serviceClient } = makeFakes(state);

  await supersedePriorImages(serviceClient, ttr, [RECAPTURE], "entity-1");

  assertEquals(state.removed[0].length, 3);
  assertEquals(state.updated[0].ids, ["img-old-front", "img-old-back", "img-mid-front"]);
});

Deno.test("an unlinked capture supersedes nothing — only a re-capture replaces a copy on file", async () => {
  const state: FakeState = {
    siblings: [{ id: "idv-other", document_number: "RGN-111222", front_image_id: "img-old-front", back_image_id: null }],
    stale: [{ id: "img-old-front", object_path: "tx-1/party-a-front.jpg" }],
    removed: [],
    updated: [],
  };
  const { ttr, serviceClient } = makeFakes(state);

  await supersedePriorImages(
    serviceClient,
    ttr,
    [{ ...RECAPTURE, prior_verification_id: null }],
    "entity-1",
  );

  assertEquals(state.removed, []);
  assertEquals(state.updated, []);
});

Deno.test("the re-capture never deletes its own images", async () => {
  const state: FakeState = {
    siblings: [{ id: "idv-new", document_number: "RGN-111222", prior_verification_id: "idv-original", front_image_id: "img-new-front", back_image_id: "img-new-back" }],
    stale: [],
    removed: [],
    updated: [],
  };
  const { ttr, serviceClient } = makeFakes(state);

  await supersedePriorImages(serviceClient, ttr, [RECAPTURE], "entity-1");

  assertEquals(state.removed, []);
  assertEquals(state.updated, []);
});

Deno.test("a storage failure leaves the rows unstamped rather than claiming images were deleted", async () => {
  const state: FakeState = {
    siblings: [{ ...ROOT, back_image_id: null }],
    stale: [{ id: "img-old-front", object_path: "tx-1/party-a-front.jpg" }],
    removed: [],
    updated: [],
    removeError: { message: "bucket unavailable" },
  };
  const { ttr, serviceClient } = makeFakes(state);

  // Must not throw: the transaction is already complete and a storage hiccup cannot be
  // allowed to undo a completed legal record. A later run retries.
  await supersedePriorImages(serviceClient, ttr, [RECAPTURE], "entity-1");

  // Stamping rows as superseded while their objects still exist would be a lie in the
  // audit trail, and would stop any later run from cleaning them up.
  assertEquals(state.updated, []);
});

Deno.test("a failed lookup is swallowed so completion is never rolled back by cleanup", async () => {
  const state: FakeState = {
    siblings: [],
    stale: [],
    removed: [],
    updated: [],
    selectError: { message: "connection reset" },
  };
  const { ttr, serviceClient } = makeFakes(state);

  await supersedePriorImages(serviceClient, ttr, [RECAPTURE], "entity-1");

  assertEquals(state.removed, []);
  assertEquals(state.updated, []);
});
