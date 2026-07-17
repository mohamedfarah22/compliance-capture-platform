import { assert, assertEquals } from "std/assert";
import { validateParties, validatePreciousMetalItems, validateTransaction } from "./index.ts";
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
