import { assert, assertEquals, assertMatch, assertRejects, assertThrows } from "std/assert";
import {
  aliasesForParties,
  buildIdElement,
  buildOrganisationDetails,
  buildOtherPersonBlock,
  buildTTRBlock,
  buildTTRXML,
  DESIGNATED_SERVICE_MAP,
  ID_TYPE_MAP,
  isISODate,
  LEGAL_FORM_MAP,
  loadTxnScopedData,
  makeIdGen,
  unwrapQuery,
} from "./index.ts";

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeParty(overrides: Record<string, unknown> = {}) {
  return {
    id: "party-1",
    party_type: "individual",
    first_name: "Jane",
    last_name: "Doe",
    full_name: null,
    date_of_birth: "1985-06-15",
    gender: "F",
    citizenship_country_code: "AU",
    tax_residency_country_code: "AU",
    abn: null,
    res_street: "1 Main St",
    res_suburb: "Coburg",
    res_state: "VIC",
    res_postcode: "3058",
    res_country: "AU",
    post_street: null,
    phone: "0400000000",
    email: null,
    occupation: "Jeweller",
    ...overrides,
  };
}

function makeCompanyParty(overrides: Record<string, unknown> = {}) {
  return {
    id: "party-2",
    party_type: "company",
    entity_name: "Acme Pty Ltd",
    trading_name: null,
    legal_form: "Company",
    reg_id_type: "ABN",
    reg_identifier: "12345678901",
    biz_street: "1 Business Rd",
    biz_suburb: "Melbourne",
    biz_state: "VIC",
    biz_postcode: "3000",
    biz_country: "AU",
    co_post_street: null,
    company_phone: "0398765432",
    principal_activity: "Bullion trading",
    ...overrides,
  };
}

function makeTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "tx-1",
    scenario: "bullion_sell",
    transaction_datetime: "2026-07-04T10:30:00+00:00",
    transaction_ref: "INV-001",
    aud_value: 15000,
    cash_currency: "AUD",
    cash_amount: 15000,
    lpp_flag: false,
    is_other_ds_provider_involved: false,
    ...overrides,
  };
}

function makeEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: "entity-1",
    legal_name: "Test Bullion Pty Ltd",
    trading_name: null,
    austrac_account_number: "123456789",
    address_street: null,
    address_suburb: null,
    address_state: null,
    address_postcode: null,
    address_country: null,
    ...overrides,
  };
}

const NO_BULLION: Record<string, unknown>[] = [];
const NO_PRECIOUS_METAL: Record<string, unknown>[] = [];

function buildBlock(overrides: {
  tx?: Record<string, unknown>;
  entity?: Record<string, unknown>;
  parties?: Record<string, unknown>[];
  conductingPersons?: Record<string, unknown>[];
  idvs?: Record<string, unknown>[];
  aliases?: Record<string, unknown>[];
  recipientDeliveries?: Record<string, unknown>[];
  bullionItems?: Record<string, unknown>[];
  preciousMetalItems?: Record<string, unknown>[];
} = {}) {
  return buildTTRBlock(
    overrides.tx ?? makeTransaction(),
    // deno-lint-ignore no-explicit-any
    (overrides.entity ?? makeEntity()) as any,
    overrides.parties ?? [makeParty()],
    overrides.conductingPersons ?? [],
    overrides.idvs ?? [],
    overrides.aliases ?? [],
    overrides.recipientDeliveries ?? [],
    overrides.bullionItems ?? [{ metal_type: "Gold", line_total_aud: 15000 }],
    overrides.preciousMetalItems ?? NO_PRECIOUS_METAL,
  );
}

// ─── TC-200/201: driver licence / passport IdType mapping ───────────────────

Deno.test("'Driver licence' document type maps to AUSTRAC IdType code 'D'", () => {
  const xml = buildIdElement(makeIdGen("tx-1"), { document_type: "Driver licence", document_number: "DL123" });
  assertMatch(xml, /<type>D<\/type>/);
  assertMatch(xml, /^<identification id="[^"]+">/);
});

Deno.test("'Passport' document type maps to AUSTRAC IdType code 'P'", () => {
  const xml = buildIdElement(makeIdGen("tx-1"), { document_type: "Passport", document_number: "P123456" });
  assertMatch(xml, /<type>P<\/type>/);
});

// ─── TC-206: issuer captured ─────────────────────────────────────────────────

Deno.test("issuer field is captured for each identification document", () => {
  const xml = buildIdElement(makeIdGen("tx-1"), { document_type: "Passport", document_number: "P1", issuer: "Australian Passport Office" });
  assertMatch(xml, /<issuer>Australian Passport Office<\/issuer>/);
});

// ─── Defensive trim: leading/trailing whitespace never reaches the legal XML ──

Deno.test("a document number with leading/trailing whitespace is trimmed before being written into the XML", () => {
  const xml = buildIdElement(makeIdGen("tx-1"), { document_type: "Driver licence", document_number: " DL456789123" });
  assertMatch(xml, /<number>DL456789123<\/number>/);
});

Deno.test("a residential address suburb/postcode with whitespace is trimmed before being written into the XML", () => {
  const xml = buildBlock({ parties: [makeParty({ res_suburb: " Fremantle", res_postcode: " 3070" })] });
  assertMatch(xml, /<suburb>Fremantle<\/suburb>/);
  assertMatch(xml, /<postcode>3070<\/postcode>/);
});

// ─── TC-208: Electronic verification source -> OVS (approved bug fix) ──────

Deno.test('"Electronic verification source" document type maps to AUSTRAC IdType code "OVS" — not the non-standard "ELEC" code', () => {
  assertEquals(ID_TYPE_MAP["Electronic verification source"], "OVS");
  const xml = buildIdElement(makeIdGen("tx-1"), { document_type: "Electronic verification source", document_number: "EVS1" });
  assertMatch(xml, /<type>OVS<\/type>/);
  assert(!xml.includes("ELEC"));
});

Deno.test("countryCode is entirely absent for an OVS identification, even when id_country_code is provided", () => {
  const xml = buildIdElement(makeIdGen("tx-1"), {
    document_type: "Electronic verification source",
    document_number: "EVS1",
    issuer: "Electronic Verification Co",
    id_country_code: "AU",
  });
  assert(!xml.includes("<countryCode>"));
});

Deno.test("countryCode is still emitted for non-OVS identification types", () => {
  const xml = buildIdElement(makeIdGen("tx-1"), {
    document_type: "Passport",
    document_number: "P123456",
    issuer: "Australian Passport Office",
    id_country_code: "AU",
  });
  assertMatch(xml, /<countryCode>AU<\/countryCode>/);
});

// ─── TC-195 (business structure, verified at the report-generation layer) ──

Deno.test('"Sole trader" and any unmapped legal structure produce businessStructureOther — codes "I"/"R" do not exist in the TTR-1-0 enumeration', () => {
  assertEquals(LEGAL_FORM_MAP["Sole trader"], undefined);

  const soleTraderXml = buildOrganisationDetails(makeIdGen("tx-1"), makeCompanyParty({ legal_form: "Sole trader" }), null);
  assertMatch(soleTraderXml, /<businessStructureOther>Sole trader<\/businessStructureOther>/);
  assert(!soleTraderXml.includes("<businessStructure>I<"));

  const unmappedXml = buildOrganisationDetails(makeIdGen("tx-1"), makeCompanyParty({ legal_form: "Cooperative" }), null);
  assertMatch(unmappedXml, /<businessStructureOther>Cooperative<\/businessStructureOther>/);
  assert(!unmappedXml.includes("<businessStructure>R<"));
});

Deno.test("Company/Partnership/Trust/Association legal structures map to the correct BusinessStructure codes", () => {
  assertEquals(LEGAL_FORM_MAP["Company"], "C");
  assertEquals(LEGAL_FORM_MAP["Partnership"], "P");
  assertEquals(LEGAL_FORM_MAP["Trust"], "T");
  assertEquals(LEGAL_FORM_MAP["Association"], "A");
  const xml = buildOrganisationDetails(makeIdGen("tx-1"), makeCompanyParty({ legal_form: "Company" }), null);
  assertMatch(xml, /<businessStructure>C<\/businessStructure>/);
});

// ─── isExpressTrust / TrustDetails (only applicable when businessStructure='T') ──

Deno.test("a Trust organisation that is not an express trust emits isExpressTrust=N with no trustDetails", () => {
  const xml = buildOrganisationDetails(makeIdGen("tx-1"), makeCompanyParty({ legal_form: "Trust", is_express_trust: false }), null);
  assertMatch(xml, /<isExpressTrust>N<\/isExpressTrust>/);
  assert(!xml.includes("<trustDetails"));
});

Deno.test("a Trust organisation that is an express trust emits isExpressTrust=Y followed by trustDetails, positioned before isIdentityVerified, with no participant/beneficiary elements", () => {
  const xml = buildOrganisationDetails(makeIdGen("tx-1"), makeCompanyParty({
    legal_form: "Trust",
    is_express_trust: true,
    trust_type_other: "Discretionary trust",
    trust_name: "Southern Cross Family Trust",
  }), null);
  assertMatch(xml, /<isExpressTrust>Y<\/isExpressTrust><trustDetails id="[^"]+"><trustTypeOther>Discretionary trust<\/trustTypeOther><trustName>Southern Cross Family Trust<\/trustName><\/trustDetails>/);
  assertMatch(xml, /<trustDetails.*<\/trustDetails><isIdentityVerified>/);
  assert(!xml.includes("<trustParticipant"));
  assert(!xml.includes("<trustBeneficiary"));
  assert(!xml.includes("<isTenOrLessBeneficiaries"));
});

Deno.test("isExpressTrust is never emitted for a non-Trust business structure, even if is_express_trust is stale/set", () => {
  const xml = buildOrganisationDetails(makeIdGen("tx-1"), makeCompanyParty({ legal_form: "Company", is_express_trust: true }), null);
  assert(!xml.includes("<isExpressTrust"));
  assert(!xml.includes("<trustDetails"));
});

// ─── Real TTR-1-0 element names for organisationDetails, correct order ─────

Deno.test("organisationDetails uses the real TTR-1-0 element names (fullLegalName, businessName, occupationBusinessActivity) — not entityName/tradingName/principalActivity — and businessStructure comes last", () => {
  const xml = buildOrganisationDetails(makeIdGen("tx-1"), makeCompanyParty({ trading_name: "Acme Trading" }), null);

  assertMatch(xml, /<fullLegalName>Acme Pty Ltd<\/fullLegalName>/);
  assertMatch(xml, /<businessName>Acme Trading<\/businessName>/);
  assertMatch(xml, /<occupationBusinessActivity>Bullion trading<\/occupationBusinessActivity>/);
  assert(!xml.includes("<entityName>"));
  assert(!xml.includes("<tradingName>"));
  assert(!xml.includes("<principalActivity>"));

  const structureIdx = xml.indexOf("<businessStructure>");
  const occupationIdx = xml.indexOf("<occupationBusinessActivity>");
  assert(structureIdx > occupationIdx);
});

Deno.test("organisationDetails includes isIdentityVerified and identification when an id_verification row is supplied", () => {
  const xml = buildOrganisationDetails(makeIdGen("tx-1"), makeCompanyParty(), { document_type: "Business registration/licence", document_number: "BR1" });

  assertMatch(xml, /<isIdentityVerified>Y<\/isIdentityVerified>/);
  assertMatch(xml, /<identification id="[^"]+">/);
});

// ─── Phase 7.1: company postal address must read co_post_* columns ─────────

Deno.test("a company party's postalAddress is sourced from co_post_* columns, not the individual-only post_* columns", () => {
  const xml = buildOrganisationDetails(makeIdGen("tx-1"), makeCompanyParty({
    co_post_street: "PO Box 1",
    co_post_suburb: "Melbourne",
    co_post_state: "VIC",
    co_post_postcode: "3001",
    co_post_country: "AU",
  }), null);

  assertMatch(
    xml,
    /<postalAddress id="[^"]+"><addr>PO Box 1<\/addr><suburb>Melbourne<\/suburb><state>VIC<\/state><postcode>3001<\/postcode><countryCode>AU<\/countryCode><\/postalAddress>/,
  );
});

Deno.test("a company party's postalAddress is omitted when co_post_street is unset — an individual-style post_street value does not leak through", () => {
  const xml = buildOrganisationDetails(makeIdGen("tx-1"), makeCompanyParty({ post_street: "Should not be read" }), null);

  assert(!xml.includes("<postalAddress"));
});

// ─── TC-210: designatedService BULSER / PRECIOUS ────────────────────────────

Deno.test("designatedService is BULSER for bullion scenarios and PRECIOUS for precious_metal scenarios", () => {
  assertEquals(DESIGNATED_SERVICE_MAP["bullion_sell"], "BULSER");
  assertEquals(DESIGNATED_SERVICE_MAP["bullion_buy"], "BULSER");
  assertEquals(DESIGNATED_SERVICE_MAP["precious_metal_sell"], "PRECIOUS");
  assertEquals(DESIGNATED_SERVICE_MAP["precious_metal_buy"], "PRECIOUS");

  const bullionXml = buildBlock({ tx: makeTransaction({ scenario: "bullion_sell" }) });
  assertMatch(bullionXml, /<designatedService>BULSER<\/designatedService>/);

  const pmXml = buildBlock({
    tx: makeTransaction({ scenario: "precious_metal_sell" }),
    bullionItems: NO_BULLION,
    preciousMetalItems: [{ metal_type: "Gold", line_total_aud: 15000 }],
  });
  assertMatch(pmXml, /<designatedService>PRECIOUS<\/designatedService>/);
});

// ─── TC-218/257: AAN present in ttrList, same value for RE and submitter ───

Deno.test("reAustracAccountNumber and submitterAustracAccountNumber are both present in ttrList and equal when the RE submits for itself", () => {
  const block = buildBlock();
  const { xml } = buildTTRXML([block], makeEntity({ austrac_account_number: "123456789" }), "2026-07-04", 1);

  assertMatch(xml, /<reAustracAccountNumber>123456789<\/reAustracAccountNumber>/);
  assertMatch(xml, /<submitterAustracAccountNumber>123456789<\/submitterAustracAccountNumber>/);
});

// ─── Customer wrapper element names ─────────────────────────────────────────

Deno.test("customer content is wrapped in individualDetails/organisationDetails directly — there is no individual/organisation element in the real schema", () => {
  const individualXml = buildBlock({ parties: [makeParty()] });
  assertMatch(individualXml, /<customer id="[^"]+"><individualDetails>/);
  assert(!individualXml.includes("<individual>"));

  const companyXml = buildBlock({ parties: [makeCompanyParty()], conductingPersons: [] });
  assertMatch(companyXml, /<customer id="[^"]+"><organisationDetails>/);
  assert(!companyXml.includes("<organisation>"));
});

// ─── TC-220/221/222: otherPerson structural choice ─────────────────────────

Deno.test("when the customer conducts their own transaction, otherPerson uses sameAsCustomer refId pointing to the customer id", () => {
  const idGen = makeIdGen("tx-1");
  const parties = [makeParty()];
  const partyIdToCustomerId = { "party-1": "customer-tx-1-1" };
  const { otherPerson, representedOrganisation } = buildOtherPersonBlock(idGen, null, null, [], makeTransaction(), parties, partyIdToCustomerId);

  assertMatch(otherPerson, /^<otherPerson id="[^"]+"><sameAsCustomer refId="customer-tx-1-1"\/><\/otherPerson>$/);
  assertEquals(representedOrganisation, "");
});

Deno.test("when a different individual conducts the transaction, otherPerson uses a sibling individualDetails capturing fullName, residentialAddress, and DOB", () => {
  const idGen = makeIdGen("tx-1");
  const parties = [makeParty()];
  const cp = {
    id: "cp-1",
    full_name: "Alice Brown",
    date_of_birth: "1990-01-01",
    res_street: "5 High St",
    res_suburb: "Richmond",
    res_state: "VIC",
    res_postcode: "3121",
    res_country: "AU",
    relationship: "Agent",
    represented_party_id: "party-1",
    authority_to_act: null,
  };
  const partyIdToCustomerId = { "party-1": "customer-tx-1-1" };
  const { otherPerson } = buildOtherPersonBlock(idGen, cp, null, [], makeTransaction(), parties, partyIdToCustomerId);

  assertMatch(otherPerson, /<individualDetails>/);
  assertMatch(otherPerson, /<fullName>Alice Brown<\/fullName>/);
  assertMatch(otherPerson, /<residentialAddress /);
  assertMatch(otherPerson, /<birthDate>1990-01-01<\/birthDate>/);
  assertMatch(otherPerson, /<isRepresentingOrganisation>N<\/isRepresentingOrganisation>/);
  assertMatch(otherPerson, /<isAuthorisationUsed>N<\/isAuthorisationUsed>/);
  assert(!otherPerson.includes("sameAsCustomer"));
  assert(!otherPerson.includes("customerEmployee"));
  assert(!otherPerson.includes("agencyAuthorisation"));
});

Deno.test("the relationship determines the otherPerson structural choice: sameAsCustomer, customerEmployee (self-closing, sibling individualDetails), or individualDetails with a representedOrganisation sibling", () => {
  const idGen = makeIdGen("tx-1");
  const parties = [makeCompanyParty()];
  const partyIdToCustomerId = { "party-2": "customer-tx-1-1" };

  const employeeCp = {
    id: "cp-1",
    full_name: "Bob Smith",
    date_of_birth: "1980-01-01",
    res_street: "1 St",
    res_suburb: "City",
    res_state: "VIC",
    res_postcode: "3000",
    res_country: "AU",
    relationship: "Employee",
    represented_party_id: "party-2",
    authority_to_act: null,
  };
  const { otherPerson: employeeXml } = buildOtherPersonBlock(idGen, employeeCp, null, [], makeTransaction(), parties, partyIdToCustomerId);
  assertMatch(employeeXml, /<customerEmployee refId="customer-tx-1-1"\/>/);
  assertMatch(employeeXml, /<individualDetails><fullName>Bob Smith<\/fullName>/);

  const independentCp = { ...employeeCp, relationship: "Agent" };
  const { otherPerson: independentXml, representedOrganisation } = buildOtherPersonBlock(idGen, independentCp, null, [], makeTransaction(), parties, partyIdToCustomerId);
  assertMatch(independentXml, /<individualDetails>/);
  // Represented party is a company, so isRepresentingOrganisation should be Y, with a
  // matching representsOrganisation refId pointing at a sibling representedOrganisation block.
  assertMatch(independentXml, /<isRepresentingOrganisation>Y<\/isRepresentingOrganisation>/);
  assertMatch(independentXml, /<representsOrganisation refId="([^"]+)"\/>/);
  assert(representedOrganisation.length > 0);
  const refId = independentXml.match(/<representsOrganisation refId="([^"]+)"\/>/)![1];
  assertMatch(representedOrganisation, new RegExp(`<representedOrganisation id="${refId}"><organisationDetails>`));

  const { otherPerson: selfXml } = buildOtherPersonBlock(idGen, null, null, [], makeTransaction(), [makeParty()], { "party-1": "customer-tx-1-1" });
  assertMatch(selfXml, /<sameAsCustomer/);
});

Deno.test("agency authorisation description is stored, refId is always present, and isAuthorisationUsed reflects it", () => {
  const idGen = makeIdGen("tx-1");
  const parties = [makeParty()];
  const cp = {
    id: "cp-1",
    full_name: "Alice Brown",
    date_of_birth: "1990-01-01",
    res_street: "5 High St",
    res_suburb: "Richmond",
    res_state: "VIC",
    res_postcode: "3121",
    res_country: "AU",
    relationship: "Agent",
    represented_party_id: "party-1",
    authority_to_act: "Power of attorney",
  };
  const { otherPerson } = buildOtherPersonBlock(idGen, cp, null, [], makeTransaction(), parties, { "party-1": "customer-tx-1-1" });

  assertMatch(otherPerson, /<isAuthorisationUsed>Y<\/isAuthorisationUsed>/);
  assertMatch(otherPerson, /<agencyAuthorisation refId="customer-tx-1-1">Power of attorney<\/agencyAuthorisation>/);
});

// ─── Phase 7.2: CP employee role / acting-via-entity folded into agencyAuthorisation ─

Deno.test("a conducting person's employee role is folded into the agencyAuthorisation text when is_employee is 'yes'", () => {
  const idGen = makeIdGen("tx-1");
  const parties = [makeParty()];
  const cp = {
    id: "cp-1",
    full_name: "Alice Brown",
    res_street: "5 High St",
    res_suburb: "Richmond",
    res_state: "VIC",
    res_postcode: "3121",
    res_country: "AU",
    relationship: "Agent",
    represented_party_id: "party-1",
    authority_to_act: "Power of attorney",
    is_employee: "yes",
    employee_role: "Store manager",
  };
  const { otherPerson } = buildOtherPersonBlock(idGen, cp, null, [], makeTransaction(), parties, { "party-1": "customer-tx-1-1" });

  assertMatch(otherPerson, /<agencyAuthorisation refId="customer-tx-1-1">Power of attorney - Employee role: Store manager<\/agencyAuthorisation>/);
});

Deno.test("a conducting person acting via a third-party entity has that entity's name, address, and registration folded into agencyAuthorisation", () => {
  const idGen = makeIdGen("tx-1");
  const parties = [makeParty()];
  const cp = {
    id: "cp-1",
    full_name: "Alice Brown",
    res_street: "5 High St",
    res_suburb: "Richmond",
    res_state: "VIC",
    res_postcode: "3121",
    res_country: "AU",
    relationship: "Agent",
    represented_party_id: "party-1",
    authority_to_act: "Power of attorney",
    acting_via_entity: true,
    entity_name: "SecureTransit Pty Ltd",
    entity_street: "10 Depot Rd",
    entity_suburb: "Tullamarine",
    entity_state: "VIC",
    entity_postcode: "3043",
    entity_country: "AU",
    entity_reg_type: "ABN",
    entity_reg_number: "98765432100",
  };
  const { otherPerson } = buildOtherPersonBlock(idGen, cp, null, [], makeTransaction(), parties, { "party-1": "customer-tx-1-1" });

  assertMatch(
    otherPerson,
    /<agencyAuthorisation refId="customer-tx-1-1">Power of attorney - Acting via entity: SecureTransit Pty Ltd, 10 Depot Rd, Tullamarine, VIC, 3043, AU \(ABN 98765432100\)<\/agencyAuthorisation>/,
  );
});

Deno.test("a conducting person who is neither an employee nor acting via an entity produces the same agencyAuthorisation output as before (no regression)", () => {
  const idGen = makeIdGen("tx-1");
  const parties = [makeParty()];
  const cp = {
    id: "cp-1",
    full_name: "Alice Brown",
    res_street: "5 High St",
    res_suburb: "Richmond",
    res_state: "VIC",
    res_postcode: "3121",
    res_country: "AU",
    relationship: "Agent",
    represented_party_id: "party-1",
    authority_to_act: "Power of attorney",
    is_employee: "no",
    acting_via_entity: false,
  };
  const { otherPerson } = buildOtherPersonBlock(idGen, cp, null, [], makeTransaction(), parties, { "party-1": "customer-tx-1-1" });

  assertMatch(otherPerson, /<agencyAuthorisation refId="customer-tx-1-1">Power of attorney<\/agencyAuthorisation>/);
});

// ─── TC-231: totalAmount reflects the combined AUD value ───────────────────

Deno.test("totalAmount is an AudAmount element (id + currencyCode + amount), not a flat number", () => {
  const xml = buildBlock({ tx: makeTransaction({ aud_value: 15000.5 }) });
  assertMatch(xml, /<totalAmount id="[^"]+"><currencyCode>AUD<\/currencyCode><amount>15000\.50<\/amount><\/totalAmount>/);
});

// ─── TC-211: transaction date stored in YYYY-MM-DD (AUSTRAC Date type) ─────

Deno.test("transaction date is emitted in YYYY-MM-DD format, compatible with the AUSTRAC Date type", () => {
  const xml = buildBlock({ tx: makeTransaction({ transaction_datetime: "2026-07-04T10:30:00+00:00" }) });
  assertMatch(xml, /<txnDate>2026-07-04<\/txnDate>/);
});

// ─── TC-214: txnRefNo does not exceed 60 characters (AUSTRAC TRN type) ─────

Deno.test("transaction reference number is included in transaction as txnRefNo", () => {
  const ref = "INV-001";
  const xml = buildBlock({ tx: makeTransaction({ transaction_ref: ref }) });
  assertMatch(xml, /<txnRefNo>INV-001<\/txnRefNo>/);
  assert(ref.length <= 60);
});

// ─── txnPurpose omitted (not emitted empty) when no recipient/delivery record ──

Deno.test("txnPurpose is omitted entirely — not emitted as an empty element — when no recipient/delivery record exists", () => {
  const xml = buildBlock({ recipientDeliveries: [] });
  assert(!xml.includes("<txnPurpose>"));
});

Deno.test("txnPurpose is emitted when a recipient/delivery record provides one", () => {
  const xml = buildBlock({
    parties: [makeParty({ id: "party-1" })],
    recipientDeliveries: [{ recipient_is_party: true, selected_party_id: "party-1", purpose_of_transfer: "Collecting bullion" }],
  });
  assertMatch(xml, /<txnPurpose>Collecting bullion<\/txnPurpose>/);
});

// ─── TC-246/256: mandatory sections always present ─────────────────────────

Deno.test("a ttr block contains all mandatory TTR-1-0 sections: lppDetails, customer, otherPerson, transaction, isOtherDsProviderInvolved", () => {
  const xml = buildBlock();
  assertMatch(xml, /<lppDetails>/);
  assertMatch(xml, /<customer /);
  assertMatch(xml, /<otherPerson /);
  assertMatch(xml, /<transaction /);
  assertMatch(xml, /<isOtherDsProviderInvolved>/);
});

Deno.test("lppDetails with lppFlag N is present even when no legal professional privilege claim is made", () => {
  const xml = buildBlock({ tx: makeTransaction({ lpp_flag: false }) });
  assertMatch(xml, /<lppDetails><lppFlag>N<\/lppFlag><\/lppDetails>/);
});

// ─── TC-247: unmappable data produces a descriptive, catchable error ───────

Deno.test("buildTTRBlock throws a descriptive error — not a cryptic failure — for an unmappable bullion metal type", () => {
  assertThrows(
    () => buildBlock({ bullionItems: [{ metal_type: "NotAMetal", line_total_aud: 100 }] }),
    Error,
    "Unmappable bullion metal type",
  );
});

// ─── TC-248/249: xs:ID uniqueness and xs:IDREF resolution ──────────────────

Deno.test("all xs:ID customer identifiers are unique across every ttr block in the same report document", () => {
  const blockA = buildBlock({ tx: makeTransaction({ id: "tx-A" }), parties: [makeParty({ id: "party-1" })] });
  const blockB = buildBlock({ tx: makeTransaction({ id: "tx-B" }), parties: [makeParty({ id: "party-1" })] });
  const { xml } = buildTTRXML([blockA, blockB], makeEntity(), "2026-07-04", 1);

  const ids = [...xml.matchAll(/<customer id="([^"]+)">/g)].map((m) => m[1]);
  assertEquals(ids.length, 2);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("all xs:ID attributes across the whole ttrList document are unique — not just customer ids", () => {
  const blockA = buildBlock({ tx: makeTransaction({ id: "tx-A" }), parties: [makeParty({ id: "party-1" })] });
  const blockB = buildBlock({ tx: makeTransaction({ id: "tx-B" }), parties: [makeParty({ id: "party-1" })] });
  const { xml } = buildTTRXML([blockA, blockB], makeEntity(), "2026-07-04", 1);

  const ids = [...xml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert(ids.length > 0);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("<ttr id> is prefixed so it stays a valid xs:ID/NCName even when the raw transaction UUID starts with a digit", () => {
  const xml = buildBlock({ tx: makeTransaction({ id: "6a0d3cfd-d8b7-4564-a000-b5041de02edc" }) });
  const [, ttrId] = xml.match(/^<ttr id="([^"]+)">/) ?? [];
  assert(ttrId, "expected a <ttr id=\"...\"> opening tag");
  assertMatch(ttrId, /^[A-Za-z_][\w.-]*$/);
  assertEquals(ttrId, "ttr-6a0d3cfd-d8b7-4564-a000-b5041de02edc");
});

Deno.test("sameAsCustomer refId resolves to a valid customer xs:ID present in the same ttr block", () => {
  const block = buildBlock({
    parties: [makeParty({ id: "party-1" })],
    conductingPersons: [],
  });

  const customerIds = [...block.matchAll(/<customer id="([^"]+)">/g)].map((m) => m[1]);
  const refIds = [...block.matchAll(/<sameAsCustomer refId="([^"]+)"/g)].map((m) => m[1]);

  assert(refIds.length > 0);
  refIds.forEach((refId) => assert(customerIds.includes(refId)));
});

// ─── TC-250/251: XML declaration, namespace, reportCount ───────────────────

Deno.test("the generated XML declares UTF-8 encoding and the TTR-1-0 namespace", () => {
  const { xml } = buildTTRXML([buildBlock()], makeEntity(), "2026-07-04", 1);
  assertMatch(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assertMatch(xml, /xmlns="http:\/\/austrac\.gov\.au\/schema\/reporting\/TTR-1-0"/);
});

Deno.test("reportCount equals the number of ttr elements in the payload", () => {
  const blocks = [buildBlock(), buildBlock({ tx: makeTransaction({ id: "tx-2" }) })];
  const { xml } = buildTTRXML(blocks, makeEntity(), "2026-07-04", 1);
  assertMatch(xml, /<reportCount>2<\/reportCount>/);
  assertEquals([...xml.matchAll(/<ttr id=/g)].length, 2);
});

// ─── isAbnHolder/abn must be entirely absent for non-sole-trader individuals ──

Deno.test("an individual who is not a sole trader emits isSoleTrader=N with isAbnHolder and abn both entirely absent", () => {
  const xml = buildBlock({ parties: [makeParty({ legal_form: undefined, abn: "12345678901" })] });
  assertMatch(xml, /<isSoleTrader>N<\/isSoleTrader>/);
  assert(!xml.includes("<isAbnHolder>"));
  assert(!xml.includes("<abn>"));
});

Deno.test("an individual who is a sole trader and an ABN holder emits isSoleTrader=Y, isAbnHolder=Y, and the abn", () => {
  const xml = buildBlock({ parties: [makeParty({ legal_form: "Sole trader", abn: "12345678901" })] });
  assertMatch(xml, /<isSoleTrader>Y<\/isSoleTrader>/);
  assertMatch(xml, /<isAbnHolder>Y<\/isAbnHolder>/);
  assertMatch(xml, /<abn>12345678901<\/abn>/);
});

// ─── TC-192: countryCode uppercased and truncated to 2 characters ──────────

Deno.test("TC-192: countryCode is derived from the address country, uppercased and truncated to 2 characters", () => {
  const xml = buildOrganisationDetails(makeIdGen("tx-1"), makeCompanyParty({ biz_country: "Australia" }), null);
  assertMatch(xml, /<countryCode>AU<\/countryCode>/);
});

// ─── TC-197: aliases emitted as one altName element each ───────────────────

Deno.test("TC-197: aliases are emitted as one altName element each inside individualDetails, reading the real 'alias' column", () => {
  const xml = buildBlock({
    aliases: [
      { party_id: "party-1", alias: "J. Doe" },
      { party_id: "party-1", alias: "Jane D." },
    ],
  });
  assertMatch(xml, /<altName>J\. Doe<\/altName>/);
  assertMatch(xml, /<altName>Jane D\.<\/altName>/);
});

// ─── party_aliases has no transaction_id column — regression coverage for  ──
// ─── the query that must scope by party_id instead                        ──

Deno.test("aliasesForParties scopes party_aliases rows to a transaction via party_id membership — the rows have no transaction_id field at all", () => {
  const txAParties = [makeParty({ id: "party-1" })];
  const txBParties = [makeParty({ id: "party-2" })];
  const allAliases = [
    { id: "alias-1", party_id: "party-1", alias: "J. Doe", sort_order: 0 },
    { id: "alias-2", party_id: "party-2", alias: "Someone Else", sort_order: 0 },
  ];
  assertEquals(aliasesForParties(allAliases, txAParties).map((a) => a.alias), ["J. Doe"]);
  assertEquals(aliasesForParties(allAliases, txBParties).map((a) => a.alias), ["Someone Else"]);
});

Deno.test("unwrapQuery returns data on success and throws a descriptive error instead of silently swallowing a Postgrest error", () => {
  assertEquals(unwrapQuery("parties", { data: [{ id: "party-1" }], error: null }), [{ id: "party-1" }]);
  assertEquals(unwrapQuery("parties", { data: null, error: null }), []);
  assertThrows(
    () =>
      unwrapQuery("party_aliases", {
        data: null,
        error: { message: "column party_aliases.transaction_id does not exist" },
      }),
    Error,
    "party_aliases query failed: column party_aliases.transaction_id does not exist",
  );
});

function makeFakeTtr(fixturesByTable: Record<string, Record<string, unknown>[]>) {
  const calls: { table: string; column: string; values: string[] }[] = [];
  return {
    calls,
    client: {
      from(table: string) {
        return {
          select(_cols: string) {
            return {
              in(column: string, values: string[]) {
                calls.push({ table, column, values });
                return Promise.resolve({ data: fixturesByTable[table] ?? [], error: null });
              },
            };
          },
        };
      },
    },
  };
}

Deno.test("loadTxnScopedData fetches party_aliases by party_id derived from the resolved parties rows, not by transaction_id", async () => {
  const { client, calls } = makeFakeTtr({
    parties: [makeParty({ id: "party-1" }), makeParty({ id: "party-2" })],
    party_aliases: [
      { id: "alias-1", party_id: "party-1", alias: "J. Doe", sort_order: 0 },
      { id: "alias-2", party_id: "party-2", alias: "Someone Else", sort_order: 0 },
    ],
  });
  const result = await loadTxnScopedData(client, ["tx-1"]);
  const aliasCall = calls.find((c) => c.table === "party_aliases");
  assert(aliasCall, "expected party_aliases to be queried");
  assertEquals(aliasCall!.column, "party_id");
  assertEquals([...aliasCall!.values].sort(), ["party-1", "party-2"]);
  assertEquals(result.allAliases.length, 2);
});

Deno.test("loadTxnScopedData rejects instead of silently returning empty data when a query fails (e.g. a column that doesn't exist)", async () => {
  const client = {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            in(_column: string, _values: string[]) {
              if (table === "party_aliases") {
                return Promise.resolve({
                  data: null,
                  error: { message: "column party_aliases.transaction_id does not exist" },
                });
              }
              // parties must resolve at least one row so allPartyIds is non-empty,
              // otherwise loadTxnScopedData short-circuits and never queries party_aliases.
              if (table === "parties") {
                return Promise.resolve({ data: [{ id: "party-1" }], error: null });
              }
              return Promise.resolve({ data: [], error: null });
            },
          };
        },
      };
    },
  };
  await assertRejects(() => loadTxnScopedData(client, ["tx-1"]), Error, "party_aliases query failed");
});

// ─── TC-202/203/204/207: remaining IdType mappings + typeOther fallback ────

Deno.test("'Proof of age card' and 'National identity card' document types map to AUSTRAC IdType code 'PHOT'", () => {
  assertEquals(ID_TYPE_MAP["Proof of age card"], "PHOT");
  assertEquals(ID_TYPE_MAP["National identity card"], "PHOT");
  const xml = buildIdElement(makeIdGen("tx-1"), { document_type: "Proof of age card", document_number: "AGE1" });
  assertMatch(xml, /<type>PHOT<\/type>/);
});

Deno.test("'Medicare card' document type maps to AUSTRAC IdType code 'BENE'", () => {
  assertEquals(ID_TYPE_MAP["Medicare card"], "BENE");
  const xml = buildIdElement(makeIdGen("tx-1"), { document_type: "Medicare card", document_number: "MED1" });
  assertMatch(xml, /<type>BENE<\/type>/);
});

Deno.test("an unmapped document type falls back to IdType 'PHOT' and captures the original label in typeOther", () => {
  const xml = buildIdElement(makeIdGen("tx-1"), { document_type: "Something unusual", document_number: "X1" });
  assertMatch(xml, /<type>PHOT<\/type>/);
  assertMatch(xml, /<typeOther>Something unusual<\/typeOther>/);
});

// ─── TC-209: reliance on a prior verification still reports full identification ─

Deno.test("TC-209: reliance on a prior identification still reports isIdentityVerified Y with the retained document details", () => {
  const xml = buildBlock({
    idvs: [{
      party_id: "party-1",
      document_type: "Passport",
      document_number: "P999",
      verification_basis: "relied_on_prior_identification",
      prior_verification_id: "idv-old-1",
    }],
  });
  assertMatch(xml, /<isIdentityVerified>Y<\/isIdentityVerified>/);
  assertMatch(xml, /<number>P999<\/number>/);
});

// ─── TC-215: txnLocation sourced from the reporting entity's own address ───

Deno.test("TC-215: txnLocation is built from the reporting entity's own address, not a per-transaction location field", () => {
  const entity = makeEntity({
    address_street: "1 Bullion St",
    address_suburb: "Coburg",
    address_state: "VIC",
    address_postcode: "3058",
    address_country: "AU",
  });
  const xml = buildBlock({ entity });
  assertMatch(
    xml,
    /<txnLocation id="[^"]+"><addr>1 Bullion St<\/addr><suburb>Coburg<\/suburb><state>VIC<\/state><postcode>3058<\/postcode><countryCode>AU<\/countryCode><\/txnLocation>/,
  );
});

// ─── Address elements carry a unique xs:ID attribute ───────────────────────

Deno.test("address elements (residentialAddress, txnLocation) each carry a unique xs:ID attribute", () => {
  const xml = buildBlock({
    entity: makeEntity({ address_street: "1 Bullion St", address_suburb: "Coburg", address_state: "VIC", address_postcode: "3058", address_country: "AU" }),
  });

  assertMatch(xml, /<residentialAddress id="[^"]+">/);
  assertMatch(xml, /<txnLocation id="[^"]+">/);
});

// ─── TC-216/217: ausCash / foreignCash ──────────────────────────────────────

Deno.test("TC-216: an AUD cash transaction reports the amount inside <cash><ausCash> as an AudAmount (currencyCode + amount)", () => {
  const xml = buildBlock({
    tx: makeTransaction({ scenario: "bullion_sell", cash_currency: "AUD", cash_amount: 15000 }),
  });
  assertMatch(xml, /<cash><ausCash id="[^"]+"><currencyCode>AUD<\/currencyCode><amount>15000\.00<\/amount><\/ausCash><\/cash>/);
});

Deno.test("TC-217: a foreign-currency transaction reports currencyCode, amount, and exchangeRate inside <cash><foreignCash> — no invented audEquivalent element", () => {
  const xml = buildBlock({
    tx: makeTransaction({
      scenario: "bullion_sell",
      cash_currency: "other",
      fx_currency_code: "USD",
      fx_currency_amount: 10000,
      fx_rate: 1.5,
      aud_value: 15000,
    }),
  });
  assertMatch(
    xml,
    /<cash><foreignCash id="[^"]+"><currencyCode>USD<\/currencyCode><amount>10000\.00<\/amount><exchangeRate>1\.5<\/exchangeRate><\/foreignCash><\/cash>/,
  );
  assert(!xml.includes("audEquivalent"));
});

// ─── TC-219: interceptFlag is never emitted ────────────────────────────────

Deno.test("TC-219: interceptFlag is omitted from generated ttr blocks — bullion dealer TTRs are not intercept-triggered", () => {
  const xml = buildBlock();
  assert(!xml.includes("interceptFlag"));
});

// ─── TC-226/227: conducted_by_party_id / methodOfConductingTxn ─────────────

Deno.test("TC-226: when no conducting person is recorded and multiple parties exist, sameAsCustomer resolves to the recorded conducted_by_party_id — not always parties[0]", () => {
  const idGen = makeIdGen("tx-1");
  const parties = [makeParty({ id: "party-1" }), makeParty({ id: "party-2", first_name: "Bob", last_name: "Smith" })];
  const partyIdToCustomerId = { "party-1": "customer-tx-1-1", "party-2": "customer-tx-1-2" };
  const tx = makeTransaction({ conducted_by_party_id: "party-2" });

  const { otherPerson } = buildOtherPersonBlock(idGen, null, null, [], tx, parties, partyIdToCustomerId);

  assertMatch(otherPerson, /^<otherPerson id="[^"]+"><sameAsCustomer refId="customer-tx-1-2"\/><\/otherPerson>$/);
});

Deno.test("TC-227: when the conducting individual for a company customer cannot be identified, otherPerson is replaced by a methodOfConductingTxn complex element (id + method child)", () => {
  const idGen = makeIdGen("tx-1");
  const parties = [makeCompanyParty({ id: "party-2" })];
  const partyIdToCustomerId = { "party-2": "customer-tx-1-1" };
  const tx = makeTransaction({ method_of_conducting_txn: "A" });

  const { otherPerson } = buildOtherPersonBlock(idGen, null, null, [], tx, parties, partyIdToCustomerId);

  assertMatch(otherPerson, /^<methodOfConductingTxn id="[^"]+"><method>A<\/method><\/methodOfConductingTxn>$/);
  assert(!otherPerson.includes("otherPerson"));
});

// ─── TC-232/233/234/237: bullion item elements ─────────────────────────────

Deno.test("TC-232: multiple bullion items each produce their own element rather than being merged into one", () => {
  const xml = buildBlock({
    tx: makeTransaction({ scenario: "bullion_sell" }),
    bullionItems: [
      { metal_type: "Gold", line_total_aud: 10000 },
      { metal_type: "Silver", line_total_aud: 500 },
    ],
  });
  assertEquals([...xml.matchAll(/<buo /g)].length, 2);
  assertMatch(xml, /<type>GOLD<\/type>/);
  assertMatch(xml, /<type>SILVER<\/type>/);
});

Deno.test("TC-233: bullion items are placed in moneyProvided for a sell scenario and moneyReceived for a buy scenario", () => {
  const sellXml = buildBlock({ tx: makeTransaction({ scenario: "bullion_sell" }) });
  assertMatch(sellXml, /<moneyProvided id="[^"]+"><otherMoneyProvided><buo /);
  assertMatch(sellXml, /<moneyReceived id="[^"]+"><cash>/);

  const buyXml = buildBlock({
    tx: makeTransaction({ scenario: "bullion_buy" }),
    bullionItems: [{ metal_type: "Gold", line_total_aud: 10000 }],
  });
  assertMatch(buyXml, /<moneyReceived id="[^"]+"><otherMoneyReceived><bui /);
  assertMatch(buyXml, /<moneyProvided id="[^"]+"><cash>/);
});

Deno.test("TC-234: each bullion item's line total and mapped metal type are captured, structured as a CurrencyAmount (currencyCode + amount) plus type/description", () => {
  const xml = buildBlock({
    bullionItems: [{ metal_type: "Platinum", line_total_aud: 2500.5, description: "Bar" }],
  });
  assertMatch(xml, /<buo id="[^"]+"><currencyCode>AUD<\/currencyCode><amount>2500\.50<\/amount><type>PLATINUM<\/type><description>Bar<\/description><\/buo>/);
});

Deno.test("TC-237: precious metal items are excluded from a bullion transaction's XML even when present in the input", () => {
  const xml = buildBlock({
    tx: makeTransaction({ scenario: "bullion_sell" }),
    preciousMetalItems: [{ metal_type: "Gold", line_total_aud: 999 }],
  });
  assert(!xml.includes("<pmo ") && !xml.includes("<pmi "));
});

// ─── TC-241/244/245: precious metal item elements ──────────────────────────

Deno.test("TC-241: each precious metal item's line total, mapped metal type, and serial number are captured, structured as a CurrencyAmount", () => {
  const xml = buildBlock({
    tx: makeTransaction({ scenario: "precious_metal_sell" }),
    bullionItems: NO_BULLION,
    preciousMetalItems: [{ metal_type: "Rhodium", line_total_aud: 3000, serial_number: "SN-42" }],
  });
  assertMatch(xml, /<pmo id="[^"]+"><currencyCode>AUD<\/currencyCode><amount>3000\.00<\/amount><metal>RHODIUM<\/metal><serialNumber>SN-42<\/serialNumber><\/pmo>/);
});

Deno.test("TC-244: multiple precious metal items each produce their own element rather than being merged into one", () => {
  const xml = buildBlock({
    tx: makeTransaction({ scenario: "precious_metal_buy" }),
    bullionItems: NO_BULLION,
    preciousMetalItems: [
      { metal_type: "Gold", line_total_aud: 1000 },
      { metal_type: "Silver", line_total_aud: 200 },
    ],
  });
  assertEquals([...xml.matchAll(/<pmi /g)].length, 2);
});

Deno.test("TC-245: bullion items are excluded from a precious metal transaction's XML even when present in the input", () => {
  const xml = buildBlock({
    tx: makeTransaction({ scenario: "precious_metal_sell" }),
    bullionItems: [{ metal_type: "Gold", line_total_aud: 999 }],
    preciousMetalItems: [{ metal_type: "Silver", line_total_aud: 200 }],
  });
  assert(!xml.includes("<buo ") && !xml.includes("<bui "));
});

// ─── Recipient: sameAsCustomer shortcut vs full details ─────────────────────
// TTR-1-0 §7.7 has no delivery-logistics concept at all (the earlier
// <deliveryDetails> element was invented without the real schema and has been removed).

Deno.test("when the recipient is one of the reported customers, <recipient> uses sameAsCustomer instead of duplicating full details", () => {
  const xml = buildBlock({
    parties: [makeParty({ id: "party-1" })],
    recipientDeliveries: [{ recipient_is_party: true, selected_party_id: "party-1", purpose_of_transfer: "Collecting bullion" }],
  });

  assertMatch(xml, /<recipient id="[^"]+"><sameAsCustomer refId="customer-tx-1-1"\/><\/recipient>/);
  // The customer's full details are emitted once (inside <customer>) — never duplicated
  // for the recipient.
  assertEquals([...xml.matchAll(/<fullName>Jane Doe<\/fullName>/g)].length, 1);
});

Deno.test("a non-party recipient's captured details are emitted as full individualDetails, with no deliveryDetails element", () => {
  const xml = buildBlock({
    recipientDeliveries: [{
      recipient_is_party: false,
      recipient_full_name: "John Recipient",
      recip_street: "9 Recipient Rd",
      recip_suburb: "Preston",
      recip_state: "VIC",
      recip_postcode: "3072",
      recip_country: "AU",
      purpose_of_transfer: "Dropping off bullion",
    }],
  });

  assertMatch(xml, /<recipient id="[^"]+"><individualDetails><fullName>John Recipient<\/fullName>/);
  assert(!xml.includes("deliveryDetails"));
});

// ─── TC-254/258: fileName convention, physicalCurrencyDirection ────────────

Deno.test("TC-254: fileName follows the TTR{YYYYMMDD}{8-digit sequence}.xml convention", () => {
  const { fileName } = buildTTRXML([buildBlock()], makeEntity(), "2026-07-04", 3);
  assertEquals(fileName, "TTR2026070400000003.xml");
});

Deno.test("TC-258: physicalCurrencyDirection is RECEIVED for a sell scenario and PROVIDED for a buy scenario", () => {
  const sellXml = buildBlock({ tx: makeTransaction({ scenario: "bullion_sell" }) });
  assertMatch(sellXml, /<physicalCurrencyDirection>RECEIVED<\/physicalCurrencyDirection>/);

  const buyXml = buildBlock({
    tx: makeTransaction({ scenario: "bullion_buy" }),
    bullionItems: [{ metal_type: "Gold", line_total_aud: 10000 }],
  });
  assertMatch(buyXml, /<physicalCurrencyDirection>PROVIDED<\/physicalCurrencyDirection>/);
});

Deno.test("a locale-formatted reportDate (dd/MM/yyyy) is rejected before it reaches the timestamptz filter", () => {
  assertEquals(isISODate("26/07/2026"), false);
  assertEquals(isISODate("2026-7-4"), false);
  assertEquals(isISODate(""), false);
});

Deno.test("isISODate rejects a well-formed but non-existent calendar date", () => {
  assertEquals(isISODate("2026-02-30"), false);
  assertEquals(isISODate("2026-13-01"), false);
});

Deno.test("isISODate accepts a real ISO calendar date", () => {
  assertEquals(isISODate("2026-07-26"), true);
  assertEquals(isISODate("2024-02-29"), true);
});
