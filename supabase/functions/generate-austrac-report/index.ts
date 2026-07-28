import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? null;
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:3000";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") ?? "noreply@example.com";

// ─── TTR-1-0 namespace ────────────────────────────────────────────────────────

const NS = "http://austrac.gov.au/schema/reporting/TTR-1-0";

// ─── AUSTRAC code mappings ────────────────────────────────────────────────────

export const ID_TYPE_MAP: Record<string, string> = {
  "Driver licence": "D",
  "Passport": "P",
  "Proof of age card": "PHOT",
  "National identity card": "PHOT",
  "Medicare card": "BENE",
  "Other government document": "PHOT",
  "Electronic verification source": "OVS",
  "Birth certificate": "BCNO",
};

export const BULLION_TYPE_MAP: Record<string, string> = {
  "Gold": "GOLD",
  "Silver": "SILVER",
  "Platinum": "PLATINUM",
  "Palladium": "PALLADIUM",
};

export const PRECIOUS_METAL_TYPE_MAP: Record<string, string> = {
  "Gold": "GOLD",
  "Iridium": "IRIDIUM",
  "Osmium": "OSMIUM",
  "Palladium": "PALLADIUM",
  "Platinum": "PLATINUM",
  "Rhodium": "RHODIUM",
  "Ruthenium": "RUTHENIUM",
  "Silver": "SILVER",
  "Alloy": "ALLOY",
  "Other": "OTHER",
};

export const DESIGNATED_SERVICE_MAP: Record<string, string> = {
  "bullion_sell": "BULSER",
  "bullion_buy": "BULSER",
  "precious_metal_sell": "PRECIOUS",
  "precious_metal_buy": "PRECIOUS",
};

// ─── XML helpers ─────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function xmlEsc(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function el(tag: string, val: unknown): string {
  return `<${tag}>${xmlEsc(val)}</${tag}>`;
}

function opt(tag: string, val: unknown): string {
  return val ? `<${tag}>${xmlEsc(val)}</${tag}>` : "";
}

function yesNo(val: unknown): string {
  return val ? "Y" : "N";
}

function fmtAmount(n: unknown): string {
  return Number(n ?? 0).toFixed(2);
}

// ─── xs:ID generation ─────────────────────────────────────────────────────────
// Every complex-type element in TTR-1-0 (Address, AudAmount, CurrencyAmount,
// Identification, transaction, moneyReceived/moneyProvided, etc.) requires a unique
// xs:ID attribute — unique across the whole <ttrList> document, not just one <ttr>
// block. One generator instance per <ttr> block, prefixed with the transaction id.

export type IdGen = (prefix: string) => string;

export function makeIdGen(txId: string): IdGen {
  let n = 0;
  return (prefix: string) => `${prefix}-${txId}-${++n}`;
}

// ─── Address (TTR-1-0 Address / PostalAddress / AddressOrLocation types) ─────
// All three real address complex types share the same content sequence
// (addr, suburb, state, postcode, countryCode) and each require a unique id
// attribute — only the wrapping tag name differs by usage.

function buildAddressEl(
  idGen: IdGen,
  tag: string,
  street: unknown,
  suburb: unknown,
  state: unknown,
  postcode: unknown,
  country: unknown,
): string {
  return `<${tag} id="${xmlEsc(idGen("addr"))}">${el("addr", street)}${el("suburb", suburb)}${el("state", state)}${el("postcode", postcode)}${el("countryCode", (country as string ?? "AU").toUpperCase().slice(0, 2))}</${tag}>`;
}

// ─── AudAmount / CurrencyAmount (TTR-1-0 money types) ────────────────────────

function buildAudAmountInner(amount: unknown): string {
  return `${el("currencyCode", "AUD")}${el("amount", fmtAmount(amount))}`;
}

function buildCurrencyAmountInner(currencyCode: unknown, amount: unknown, exchangeRate?: unknown): string {
  return `${el("currencyCode", currencyCode)}${el("amount", fmtAmount(amount))}${exchangeRate ? el("exchangeRate", exchangeRate) : ""}`;
}

// ─── Identification (TTR-1-0 IdentificationType) ─────────────────────────────

export function buildIdElement(idGen: IdGen, idv: Row | null): string {
  if (!idv) return "";
  const rawType = idv.document_type as string;
  const idType = ID_TYPE_MAP[rawType] ?? "PHOT";
  const typeOther = idType === "PHOT" && !ID_TYPE_MAP[rawType] ? rawType : "";
  // countryCode must be entirely absent for OVS (electronic verification source) —
  // the schema forbids it there, unlike every other identification type.
  const countryCodeEl = idType === "OVS" ? "" : opt("countryCode", idv.id_country_code);
  return `<identification id="${xmlEsc(idGen("id"))}">${el("type", idType)}${opt("typeOther", typeOther)}${el("number", idv.document_number)}${opt("issuer", idv.issuer)}${countryCodeEl}</identification>`;
}

// ─── IndividualDetails ────────────────────────────────────────────────────────

function buildIndividualDetails(
  idGen: IdGen,
  person: Row,
  idv: Row | null,
  aliases: Row[],
  hasIdv: boolean,
): string {
  // Combine first/middle/last OR use full_name depending on person type
  const fullName = person.full_name
    ? (person.full_name as string)
    : [person.first_name, person.middle_name, person.last_name]
        .filter(Boolean)
        .join(" ");

  // ttr.party_aliases' column is `alias`, not `alias_name`.
  const altNames = aliases.map((a) => opt("altName", a.alias)).join("");

  const resAddr = person.res_street
    ? buildAddressEl(idGen, "residentialAddress", person.res_street, person.res_suburb, person.res_state, person.res_postcode, person.res_country)
    : "";

  const postAddr = person.post_street
    ? buildAddressEl(idGen, "postalAddress", person.post_street, person.post_suburb, person.post_state, person.post_postcode, person.post_country)
    : "";

  const isAbnHolder = !!(person.abn);
  const isSoleTrader = (person.legal_form as string) === "Sole trader";

  return [
    el("fullName", fullName),
    altNames,
    opt("birthDate", person.date_of_birth ?? person.dob),
    opt("gender", person.gender),
    opt("citizenshipCountryCode", person.citizenship_country_code),
    opt("taxResidencyCountryCode", person.tax_residency_country_code),
    el("isSoleTrader", yesNo(isSoleTrader)),
    // isAbnHolder/abn are only valid when the individual is a sole trader — the schema
    // requires both to be absent entirely otherwise, not just set to "N".
    isSoleTrader ? el("isAbnHolder", yesNo(isAbnHolder)) : "",
    isSoleTrader && isAbnHolder ? el("abn", person.abn) : "",
    resAddr,
    postAddr,
    opt("phone", person.phone ?? person.company_phone),
    opt("email", person.email),
    opt("occupationBusinessActivity", person.occupation ?? person.principal_activity),
    el("isIdentityVerified", yesNo(hasIdv)),
    buildIdElement(idGen, idv),
  ].join("");
}

// ─── OrganisationDetails ──────────────────────────────────────────────────────

// TTR-1-0 BusinessStructure enumeration only defines these codes. "Sole trader" and any
// unmapped legal form have no valid code — those must be reported via businessStructureOther
// instead (see buildOrganisationDetails), never coerced to a codes that doesn't exist.
export const LEGAL_FORM_MAP: Record<string, string> = {
  "Company": "C",
  "Partnership": "P",
  "Trust": "T",
  "Association": "A",
};

// TTR-1-0 BaseOrganisationDetails/OrganisationDetails sequence: fullLegalName, abn/acn,
// businessName*, businessAddress, postalAddress, phone*, occupationBusinessActivity,
// then the businessStructure/businessStructureOther choice LAST, followed (per
// OrganisationDetails) by isIdentityVerified/identification. There is no <entityName>,
// <tradingName>, or <principalActivity> element in the real schema.
export function buildOrganisationDetails(idGen: IdGen, party: Row, idv: Row | null): string {
  const legalForm = party.legal_form as string;
  const bsCode = LEGAL_FORM_MAP[legalForm];
  const businessStructureEl = bsCode
    ? el("businessStructure", bsCode)
    : el("businessStructureOther", legalForm || "Unknown");
  const regTag = (party.reg_id_type as string)?.toUpperCase() === "ABN" ? "abn" : "acn";
  const bizAddr = buildAddressEl(idGen, "businessAddress", party.biz_street, party.biz_suburb, party.biz_state, party.biz_postcode, party.biz_country);
  const postAddr = party.co_post_street
    ? buildAddressEl(idGen, "postalAddress", party.co_post_street, party.co_post_suburb, party.co_post_state, party.co_post_postcode, party.co_post_country)
    : "";
  // isExpressTrust is only valid (and required) when businessStructure='T'. trustDetails
  // is required iff isExpressTrust='Y' — trustParticipant/trustBeneficiary sub-structures
  // are deliberately not modeled (both schema-optional, see 20260716000001_trust_details.sql).
  const isExpressTrustEl = bsCode === "T" ? el("isExpressTrust", yesNo(!!party.is_express_trust)) : "";
  const trustDetailsEl = bsCode === "T" && party.is_express_trust
    ? `<trustDetails id="${xmlEsc(idGen("trust"))}">${opt("trustTypeOther", party.trust_type_other)}${opt("trustName", party.trust_name)}</trustDetails>`
    : "";
  return [
    el("fullLegalName", party.entity_name),
    el(regTag, party.reg_identifier),
    opt("businessName", party.trading_name),
    bizAddr,
    postAddr,
    opt("phone", party.company_phone),
    opt("occupationBusinessActivity", party.principal_activity),
    businessStructureEl,
    isExpressTrustEl,
    trustDetailsEl,
    el("isIdentityVerified", yesNo(!!idv)),
    buildIdElement(idGen, idv),
  ].join("");
}

// ─── Customer element ─────────────────────────────────────────────────────────

// TTR-1-0 <customer> contains <individualDetails>/<organisationDetails> directly —
// there is no wrapping <individual>/<organisation> element in the real schema.
export function buildCustomer(idGen: IdGen, party: Row, idv: Row | null, aliases: Row[], customerId: string): string {
  if (party.party_type === "individual") {
    return `<customer id="${xmlEsc(customerId)}"><individualDetails>${buildIndividualDetails(idGen, party, idv, aliases, !!idv)}</individualDetails></customer>`;
  }
  return `<customer id="${xmlEsc(customerId)}"><organisationDetails>${buildOrganisationDetails(idGen, party, idv)}</organisationDetails></customer>`;
}

// ─── otherPerson element (replaces individualConductingTxn) ──────────────────
// TTR-1-0 §7.1: the <ttr> level has a mandatory choice between the
// (otherPerson, representedOrganisation*) sequence and <methodOfConductingTxn> — this
// function returns both possible outputs so the caller can splice them into <ttr> at
// the right sibling positions (representedOrganisation is a SIBLING of otherPerson,
// never nested inside it).
//
// Within <otherPerson> itself (§7.5), <customerEmployee>/<individualDetails>/
// <isRepresentingOrganisation>/<representsOrganisation>/<isAuthorisationUsed>/
// <agencyAuthorisation> are all flat siblings — <customerEmployee> is an EMPTY
// PartyReference (just a refId attribute); the employee's actual details go in a
// separate sibling <individualDetails> using the same full IndividualDetails type
// as a customer (not a stripped-down shape).

// TTR-1-0's otherPerson type has no dedicated element for employee role or for a
// third-party entity a conducting person acts through, so both are folded into the
// existing agencyAuthorisation free-text description rather than inventing element
// names the schema doesn't define.
function buildAgencyAuthorisationText(cp: Row): string {
  const parts: string[] = [];
  if (cp.authority_to_act) parts.push(cp.authority_to_act as string);
  if (cp.is_employee === "yes" && cp.employee_role) {
    parts.push(`Employee role: ${cp.employee_role as string}`);
  }
  if (cp.acting_via_entity) {
    const entityAddr = cp.entity_street
      ? `, ${[cp.entity_street, cp.entity_suburb, cp.entity_state, cp.entity_postcode, cp.entity_country].filter(Boolean).join(", ")}`
      : "";
    const reg = cp.entity_reg_number ? ` (${(cp.entity_reg_type as string) ?? "reg"} ${cp.entity_reg_number as string})` : "";
    parts.push(`Acting via entity: ${cp.entity_name as string}${entityAddr}${reg}`);
  }
  // Plain ASCII hyphen, not an em-dash — non-ASCII punctuation here has been observed
  // to come out mangled (mojibake) depending on how the response is transported/decoded
  // downstream, and this text goes straight into a legal AUSTRAC filing.
  return parts.join(" - ");
}

// Shapes a conducting_persons row as the Row expected by buildIndividualDetails
// (same full IndividualDetails type the schema uses for a customer).
function cpAsIndividualRow(cp: Row): Row {
  return {
    full_name: cp.full_name,
    date_of_birth: cp.date_of_birth,
    phone: cp.phone,
    occupation: cp.occupation,
    res_street: cp.res_street,
    res_suburb: cp.res_suburb,
    res_state: cp.res_state,
    res_postcode: cp.res_postcode,
    res_country: cp.res_country,
    post_street: cp.has_postal_address ? cp.post_street : null,
    post_suburb: cp.post_suburb,
    post_state: cp.post_state,
    post_postcode: cp.post_postcode,
    post_country: cp.post_country,
  };
}

export function buildOtherPersonBlock(
  idGen: IdGen,
  primaryCP: Row | null,
  cpIdv: Row | null,
  cpAliases: Row[],
  tx: Row,
  parties: Row[],
  partyIdToCustomerId: Record<string, string>,
): { otherPerson: string; representedOrganisation: string } {
  if (!primaryCP) {
    if (tx.method_of_conducting_txn) {
      // <methodOfConductingTxn> is itself a complex type (id attribute + a <method>/
      // <otherMethod> choice child) — not a plain text element.
      return {
        otherPerson: `<methodOfConductingTxn id="${xmlEsc(idGen("mct"))}">${el("method", tx.method_of_conducting_txn)}</methodOfConductingTxn>`,
        representedOrganisation: "",
      };
    }
    const conductedParty = parties.find((p) => p.id === tx.conducted_by_party_id) ?? parties[0];
    const refId = partyIdToCustomerId[conductedParty.id as string];
    return {
      otherPerson: `<otherPerson id="${xmlEsc(idGen("otherPerson"))}"><sameAsCustomer refId="${xmlEsc(refId)}"/></otherPerson>`,
      representedOrganisation: "",
    };
  }

  const representedParty = parties.find((p) => p.id === primaryCP.represented_party_id) ?? null;
  const employerRefId = representedParty ? partyIdToCustomerId[representedParty.id as string] : undefined;
  // agencyAuthorisation's refId is mandatory whenever the element is emitted — fall
  // back to the represented party, else the first customer, so it's never dropped.
  const fallbackRefId = employerRefId ?? partyIdToCustomerId[parties[0]?.id as string];

  const cpIndividualDetails = buildIndividualDetails(idGen, cpAsIndividualRow(primaryCP), cpIdv, cpAliases, !!cpIdv);

  let body: string;
  let representedOrganisation = "";

  if (primaryCP.relationship === "Employee") {
    body = `<customerEmployee${employerRefId ? ` refId="${xmlEsc(employerRefId)}"` : ""}/><individualDetails>${cpIndividualDetails}</individualDetails>`;
  } else {
    const isRepresentingOrg = representedParty?.party_type === "company";
    let representsOrgEl = "";
    if (isRepresentingOrg && representedParty) {
      const orgId = idGen("org");
      representedOrganisation = `<representedOrganisation id="${xmlEsc(orgId)}"><organisationDetails>${buildOrganisationDetails(idGen, representedParty, null)}</organisationDetails></representedOrganisation>`;
      representsOrgEl = `<representsOrganisation refId="${xmlEsc(orgId)}"/>`;
    }
    body = `<individualDetails>${cpIndividualDetails}</individualDetails>${el("isRepresentingOrganisation", yesNo(isRepresentingOrg))}${representsOrgEl}`;
  }

  const agencyAuthText = buildAgencyAuthorisationText(primaryCP);
  const isAuthorisationUsedEl = el("isAuthorisationUsed", yesNo(!!agencyAuthText));
  const agencyAuth = agencyAuthText
    ? `<agencyAuthorisation refId="${xmlEsc(fallbackRefId)}">${xmlEsc(agencyAuthText)}</agencyAuthorisation>`
    : "";

  return {
    otherPerson: `<otherPerson id="${xmlEsc(idGen("otherPerson"))}">${body}${isAuthorisationUsedEl}${agencyAuth}</otherPerson>`,
    representedOrganisation,
  };
}

// ─── Recipient element ────────────────────────────────────────────────────────
// TTR-1-0 §7.7 has no delivery-logistics concept at all — the choices are
// sameAsCustomer / sameAsOtherPerson / sameAsRepresentedOrganisation /
// isSameAsReportingEntity / full details. Returns the content to go inside
// <recipient id="...">; the caller adds the id (mandatory per §7.7).

function buildRecipientInner(idGen: IdGen, rd: Row, parties: Row[], idvByParty: Record<string, Row>, partyIdToCustomerId: Record<string, string>): string {
  if (rd.recipient_is_party) {
    const p = parties.find((x) => x.id === rd.selected_party_id);
    if (p) {
      const refId = partyIdToCustomerId[p.id as string];
      return `<sameAsCustomer refId="${xmlEsc(refId)}"/>`;
    }
  }
  // Non-party recipient — emit minimal individual with what was captured
  const recipRow: Row = {
    full_name: rd.recipient_full_name,
    date_of_birth: rd.recipient_dob ?? null,
    gender: null,
    citizenship_country_code: null,
    tax_residency_country_code: null,
    abn: null,
    legal_form: null,
    phone: null,
    email: null,
    occupation: null,
    res_street: rd.recip_street,
    res_suburb: rd.recip_suburb,
    res_state: rd.recip_state,
    res_postcode: rd.recip_postcode,
    res_country: rd.recip_country,
    post_street: null,
    post_suburb: null,
    post_state: null,
    post_postcode: null,
    post_country: null,
  };
  return `<individualDetails>${buildIndividualDetails(idGen, recipRow, null, [], false)}</individualDetails>`;
}

// ─── Cash element (AudAmount / CurrencyAmount) ───────────────────────────────

function buildCashEl(idGen: IdGen, tx: Row): string {
  if ((tx.cash_currency as string) === "AUD") {
    return `<ausCash id="${xmlEsc(idGen("cash"))}">${buildAudAmountInner(tx.cash_amount)}</ausCash>`;
  }
  return `<foreignCash id="${xmlEsc(idGen("cash"))}">${buildCurrencyAmountInner(tx.fx_currency_code, tx.fx_currency_amount, tx.fx_rate)}</foreignCash>`;
}

// ─── Bullion item elements (<bui> / <buo>) ────────────────────────────────────
// Bullion extends CurrencyAmount (§8.14/§8.15) — currencyCode + amount come before
// the type-specific fields, and the element needs an id.

function buildBullionItem(idGen: IdGen, item: Row, tag: "bui" | "buo"): string {
  const type = BULLION_TYPE_MAP[item.metal_type as string];
  if (!type) throw new Error(`Unmappable bullion metal type: ${item.metal_type}`);
  return `<${tag} id="${xmlEsc(idGen(tag))}">${buildAudAmountInner(item.line_total_aud)}${el("type", type)}${opt("description", item.description)}${opt("serialNumber", item.serial_number)}</${tag}>`;
}

// ─── Precious metal item elements (<pmi> / <pmo>) ─────────────────────────────

function buildPreciousMetalItem(idGen: IdGen, item: Row, tag: "pmi" | "pmo"): string {
  const type = PRECIOUS_METAL_TYPE_MAP[item.metal_type as string];
  if (!type) throw new Error(`Unmappable precious metal type: ${item.metal_type}`);
  return `<${tag} id="${xmlEsc(idGen(tag))}">${buildAudAmountInner(item.line_total_aud)}${el("metal", type)}${opt("description", item.description)}${opt("serialNumber", item.serial_number)}</${tag}>`;
}

function buildMoneyReceived(idGen: IdGen, tx: Row, bullionItems: Row[], preciousMetalItems: Row[]): string {
  const scenario = tx.scenario as string;
  if (scenario === "bullion_buy") {
    // RE buys bullion: receives bullion items
    const buis = bullionItems.map((b) => buildBullionItem(idGen, b, "bui")).join("");
    return `<otherMoneyReceived>${buis}</otherMoneyReceived>`;
  }
  if (scenario === "precious_metal_buy") {
    // RE buys precious metal: receives precious metal items
    const pmis = preciousMetalItems.map((p) => buildPreciousMetalItem(idGen, p, "pmi")).join("");
    return `<otherMoneyReceived>${pmis}</otherMoneyReceived>`;
  }
  // RE sells bullion/precious metal: receives cash
  return `<cash>${buildCashEl(idGen, tx)}</cash>`;
}

function buildMoneyProvided(idGen: IdGen, tx: Row, bullionItems: Row[], preciousMetalItems: Row[]): string {
  const scenario = tx.scenario as string;
  if (scenario === "bullion_sell") {
    // RE sells bullion: provides bullion items
    const buos = bullionItems.map((b) => buildBullionItem(idGen, b, "buo")).join("");
    return `<otherMoneyProvided>${buos}</otherMoneyProvided>`;
  }
  if (scenario === "precious_metal_sell") {
    // RE sells precious metal: provides precious metal items
    const pmos = preciousMetalItems.map((p) => buildPreciousMetalItem(idGen, p, "pmo")).join("");
    return `<otherMoneyProvided>${pmos}</otherMoneyProvided>`;
  }
  // RE buys bullion/precious metal: provides cash
  return `<cash>${buildCashEl(idGen, tx)}</cash>`;
}

// ─── Full TTR block ───────────────────────────────────────────────────────────

export interface EntityRecord {
  id: string;
  legal_name: string;
  trading_name: string | null;
  austrac_account_number: string | null;
  address_street: string | null;
  address_suburb: string | null;
  address_state: string | null;
  address_postcode: string | null;
  address_country: string | null;
}

export function buildTTRBlock(
  tx: Row,
  entity: EntityRecord,
  parties: Row[],
  conductingPersons: Row[],
  idvs: Row[],
  allAliases: Row[],
  recipientDeliveries: Row[],
  bullionItems: Row[],
  preciousMetalItems: Row[],
): string {
  const idGen = makeIdGen(tx.id as string);
  const idvByParty = Object.fromEntries(
    idvs.filter((v) => v.party_id).map((v) => [v.party_id as string, v]),
  );
  const idvByConductingPerson = Object.fromEntries(
    idvs.filter((v) => v.conducting_person_id).map((v) => [v.conducting_person_id as string, v]),
  );
  const aliasesByParty: Record<string, Row[]> = {};
  for (const a of allAliases) {
    const pid = a.party_id as string;
    if (!aliasesByParty[pid]) aliasesByParty[pid] = [];
    aliasesByParty[pid].push(a);
  }

  // 1. lppDetails
  const lppDetails = `<lppDetails>${el("lppFlag", yesNo(tx.lpp_flag))}</lppDetails>`;

  // 2. customer blocks — xs:ID prefixed with the (unique) transaction id so identifiers
  // stay unique across every <ttr> block in a multi-transaction report document.
  const partyIdToCustomerId: Record<string, string> = {};
  parties.forEach((p, i) => {
    partyIdToCustomerId[p.id as string] = `customer-${tx.id as string}-${i + 1}`;
  });
  const customers = parties
    .map((p) => buildCustomer(idGen, p, idvByParty[p.id as string] ?? null, aliasesByParty[p.id as string] ?? [], partyIdToCustomerId[p.id as string]))
    .join("");

  // 3. otherPerson (mandatory 1..*) + its optional representedOrganisation sibling(s):
  // use primary CP if present, else fall back to first party.
  const primaryCP = conductingPersons.find((cp) => cp.is_primary) ?? null;
  const cpIdv = primaryCP ? (idvByConductingPerson[primaryCP.id as string] ?? null) : null;
  const { otherPerson: otherPersonEl, representedOrganisation } = buildOtherPersonBlock(
    idGen,
    primaryCP,
    cpIdv,
    [],
    tx,
    parties,
    partyIdToCustomerId,
  );

  // 4. transaction
  const txDate = (tx.transaction_datetime as string ?? "").slice(0, 10);
  const txTime = (tx.transaction_datetime as string ?? "").slice(11, 19) || "00:00:00";
  const physDir = (tx.scenario as string).endsWith("_sell") ? "RECEIVED" : "PROVIDED";
  const rd = recipientDeliveries[0] ?? null;
  const txnPurpose = rd ? (rd.purpose_of_transfer as string ?? "") : "";
  // Bullion dealers transact at their own counter — txnLocation is the reporting
  // entity's own registered address, not a per-transaction capture.
  const txnLocationEl = buildAddressEl(idGen, "txnLocation", entity.address_street, entity.address_suburb, entity.address_state, entity.address_postcode, entity.address_country);
  const totalAmountEl = `<totalAmount id="${xmlEsc(idGen("total"))}">${buildAudAmountInner(tx.aud_value)}</totalAmount>`;

  const transaction = `<transaction id="${xmlEsc(idGen("txn"))}">${el("designatedService", DESIGNATED_SERVICE_MAP[tx.scenario as string] ?? "BULSER")}${txnLocationEl}${el("txnDate", txDate)}${el("txnTime", txTime)}${el("txnRefNo", tx.transaction_ref)}${opt("txnPurpose", txnPurpose)}${el("physicalCurrencyDirection", physDir)}<moneyReceived id="${xmlEsc(idGen("mrv"))}">${buildMoneyReceived(idGen, tx, bullionItems, preciousMetalItems)}</moneyReceived><moneyProvided id="${xmlEsc(idGen("mpr"))}">${buildMoneyProvided(idGen, tx, bullionItems, preciousMetalItems)}</moneyProvided>${totalAmountEl}</transaction>`;

  // 5. recipient
  const recipientEl = rd ? `<recipient id="${xmlEsc(idGen("recipient"))}">${buildRecipientInner(idGen, rd, parties, idvByParty, partyIdToCustomerId)}</recipient>` : "";

  // 6. isOtherDsProviderInvolved
  const otherDsEl = el("isOtherDsProviderInvolved", yesNo(tx.is_other_ds_provider_involved));

  // xs:ID/NCName values must start with a letter, not a digit — the raw transaction
  // UUID can't be used directly since it's effectively random hex.
  return `<ttr id="${xmlEsc(`ttr-${tx.id}`)}">${lppDetails}${customers}${otherPersonEl}${representedOrganisation}${transaction}${recipientEl}${otherDsEl}</ttr>`;
}

// ─── Root ttrList wrapper ─────────────────────────────────────────────────────

export function buildTTRXML(
  blocks: string[],
  entity: EntityRecord,
  reportDate: string,
  batchSeq: number,
): { xml: string; fileName: string } {
  const datePart = reportDate.replace(/-/g, "");
  const seqPart = String(batchSeq).padStart(8, "0");
  const fileName = `TTR${datePart}${seqPart}.xml`;
  const aan = xmlEsc(entity.austrac_account_number ?? "");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<ttrList xmlns="${NS}">\n${el("reAustracAccountNumber", aan)}\n${el("submitterAustracAccountNumber", aan)}\n${el("fileName", fileName)}\n${el("reportCount", blocks.length)}\n${blocks.join("\n")}\n</ttrList>`;
  return { xml, fileName };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function yesterdayAEST(): string {
  const aestNow = new Date(Date.now() + 10 * 60 * 60 * 1000);
  aestNow.setUTCDate(aestNow.getUTCDate() - 1);
  return aestNow.toISOString().slice(0, 10);
}

// reportDate is interpolated straight into a timestamptz filter and into the
// TTR file name, so anything other than a real ISO calendar date must be
// rejected up front rather than surfacing as a Postgres range error.
export function isISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function dateRangeUTC(aestDate: string): { from: string; to: string } {
  return {
    from: `${aestDate}T00:00:00+10:00`,
    to: `${aestDate}T23:59:59+10:00`,
  };
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function sendApprovalEmail(params: {
  to: string[];
  batchId: string;
  approvalToken: string;
  reportDate: string;
  txnCount: number;
  entityName: string;
}): Promise<void> {
  if (!RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not configured; skipping approval email");
    return;
  }
  const { to, batchId, approvalToken, reportDate, txnCount, entityName } = params;
  const reviewUrl = `${APP_URL}/review-batch/${batchId}?token=${approvalToken}`;
  const plural = txnCount !== 1 ? "s" : "";

  const html = `
    <h2>AUSTRAC TTR Report Ready for Review</h2>
    <p>A threshold transaction report has been generated for <strong>${xmlEsc(entityName)}</strong>.</p>
    <table border="1" cellpadding="8" style="border-collapse:collapse;font-family:sans-serif">
      <tr><th style="text-align:left">Report date</th><td>${reportDate}</td></tr>
      <tr><th style="text-align:left">Transactions</th><td>${txnCount} transaction${plural}</td></tr>
    </table>
    <br>
    <a href="${reviewUrl}" style="display:inline-block;padding:10px 20px;background:#1a56db;color:#fff;text-decoration:none;border-radius:4px;font-family:sans-serif">
      Review &amp; Approve Report
    </a>
    <p style="color:#666;font-size:0.85em;font-family:sans-serif">
      This link is valid until the report is approved or rejected.
      You can also access it from the Reports dashboard after logging in.
    </p>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to,
      subject: `AUSTRAC TTR Report – ${reportDate} (${txnCount} transaction${plural})`,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body}`);
  }
}

// ─── Per-entity data-loading (parties, aliases, etc.) ────────────────────────
// supabase-js query builders resolve (never reject) even when PostgREST returns
// an error response (e.g. 400 for a query against a non-existent column) — the
// `error` field must be checked explicitly, or a broken query silently degrades
// to empty data, which for a legal filing (AUSTRAC TTR) means silently omitting
// data instead of failing loudly. Every query in loadTxnScopedData is routed
// through this helper for that reason.
export function unwrapQuery<T = Row>(
  label: string,
  result: { data: T[] | null; error: { message: string } | null },
): T[] {
  if (result.error) {
    throw new Error(`${label} query failed: ${result.error.message}`);
  }
  return result.data ?? [];
}

// Loads every per-transaction child record needed to build TTR blocks for one
// entity's batch of transactions. party_aliases has no transaction_id column
// of its own (see 20260621000011_party_aliases.sql) — ttr.parties is the
// one-row-per-transaction snapshot party_id belongs to, so aliases must be
// fetched by party_id once the parties query has resolved, not folded into
// the transaction_id-keyed Promise.all below.
export async function loadTxnScopedData(
  // deno-lint-ignore no-explicit-any
  ttr: any,
  allTxnIds: string[],
): Promise<{
  allParties: Row[];
  allCPs: Row[];
  allIDVs: Row[];
  allRDs: Row[];
  allBIs: Row[];
  allPMIs: Row[];
  allAliases: Row[];
}> {
  const [partiesRes, cpsRes, idvsRes, rdsRes, bisRes, pmisRes] = await Promise.all([
    ttr.from("parties").select("*").in("transaction_id", allTxnIds),
    ttr.from("conducting_persons").select("*").in("transaction_id", allTxnIds),
    ttr.from("id_verifications").select("*").in("transaction_id", allTxnIds),
    ttr.from("recipient_deliveries").select("*").in("transaction_id", allTxnIds),
    ttr.from("bullion_items").select("*").in("transaction_id", allTxnIds),
    ttr.from("precious_metal_items").select("*").in("transaction_id", allTxnIds),
  ]);

  const allParties = unwrapQuery("parties", partiesRes);
  const allCPs = unwrapQuery("conducting_persons", cpsRes);
  const allIDVs = unwrapQuery("id_verifications", idvsRes);
  const allRDs = unwrapQuery("recipient_deliveries", rdsRes);
  const allBIs = unwrapQuery("bullion_items", bisRes);
  const allPMIs = unwrapQuery("precious_metal_items", pmisRes);

  const allPartyIds = allParties.map((p) => p.id as string);
  const aliasesRes = allPartyIds.length > 0
    ? await ttr.from("party_aliases").select("*").in("party_id", allPartyIds)
    : { data: [] as Row[], error: null };
  const allAliases = unwrapQuery("party_aliases", aliasesRes);

  return { allParties, allCPs, allIDVs, allRDs, allBIs, allPMIs, allAliases };
}

// party_aliases rows carry party_id only (no transaction_id) — scope a
// transaction's aliases to the party_ids belonging to it (that transaction's
// own filtered `parties` rows). buildTTRBlock's internal aliasesByParty
// grouping (keyed off party_id) needs no changes.
export function aliasesForParties(allAliases: Row[], txParties: Row[]): Row[] {
  const partyIds = new Set(txParties.map((p) => p.id as string));
  return allAliases.filter((a) => partyIds.has(a.party_id as string));
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth || auth !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  // deno-lint-ignore no-explicit-any
  const ttr = (serviceClient as any).schema("ttr");

  let reportDate: string;
  try {
    const body = await req.json();
    reportDate = typeof body.reportDate === "string" ? body.reportDate : yesterdayAEST();
  } catch {
    reportDate = yesterdayAEST();
  }

  if (!isISODate(reportDate)) {
    return json(
      { error: `Invalid reportDate "${reportDate}" — expected YYYY-MM-DD` },
      400,
    );
  }

  const { from, to } = dateRangeUTC(reportDate);

  // 1. Load all complete transactions for the report date
  const { data: allTxns, error: txErr } = await ttr
    .from("transactions")
    .select("*")
    .eq("status", "complete")
    .gte("completed_at", from)
    .lte("completed_at", to);

  if (txErr) return json({ error: txErr.message }, 500);
  if (!allTxns || allTxns.length === 0) {
    return json({ message: "No completed transactions for report date", reportDate }, 200);
  }

  // 2. Exclude transactions already in a batch
  const txnIds = (allTxns as Row[]).map((t) => t.id as string);
  const { data: existing } = await ttr
    .from("transaction_reports")
    .select("transaction_id")
    .in("transaction_id", txnIds);

  const reportedIds = new Set(
    ((existing ?? []) as Row[]).map((r) => r.transaction_id as string),
  );
  const unreported = (allTxns as Row[]).filter((t) => !reportedIds.has(t.id as string));

  if (unreported.length === 0) {
    return json({ message: "All transactions for this date already batched", reportDate }, 200);
  }

  // 3. Group by reporting_entity_id
  const byEntity = new Map<string, Row[]>();
  for (const tx of unreported) {
    const eid = tx.reporting_entity_id as string;
    if (!byEntity.has(eid)) byEntity.set(eid, []);
    byEntity.get(eid)!.push(tx);
  }

  const results: Array<{ entityId: string; batchId: string; txnCount: number; fileName: string }> = [];
  const errors: Array<{ entityId: string; error: string }> = [];

  // 4. Process each entity
  for (const [entityId, txns] of byEntity) {
    try {
      const { data: entity, error: entityErr } = await serviceClient
        .from("reporting_entities")
        .select("id, legal_name, trading_name, austrac_account_number, address_street, address_suburb, address_state, address_postcode, address_country")
        .eq("id", entityId)
        .single();

      if (entityErr || !entity) throw new Error(`Entity not found: ${entityId}`);

      const { data: admins } = await serviceClient
        .from("staff_members")
        .select("email")
        .eq("reporting_entity_id", entityId)
        .eq("role", "admin")
        .eq("is_active", true);

      const adminEmails = ((admins ?? []) as Row[])
        .map((a) => a.email as string)
        .filter(Boolean);

      const allTxnIds = txns.map((t) => t.id as string);

      const { allParties, allCPs, allIDVs, allRDs, allBIs, allPMIs, allAliases } =
        await loadTxnScopedData(ttr, allTxnIds);

      // Determine batch sequence number (1-based count of existing batches for this entity+date)
      const { count: existingBatches } = await ttr
        .from("report_batches")
        .select("id", { count: "exact", head: true })
        .eq("reporting_entity_id", entityId)
        .eq("report_date", reportDate);
      const batchSeq = (existingBatches ?? 0) + 1;

      const ttrBlocks = txns.map((tx) => {
        const txId = tx.id as string;
        const txParties = allParties.filter((p) => p.transaction_id === txId);
        return buildTTRBlock(
          tx,
          entity as EntityRecord,
          txParties,
          allCPs.filter((cp) => cp.transaction_id === txId),
          allIDVs.filter((v) => v.transaction_id === txId),
          aliasesForParties(allAliases, txParties),
          allRDs.filter((r) => r.transaction_id === txId),
          allBIs.filter((b) => b.transaction_id === txId),
          allPMIs.filter((p) => p.transaction_id === txId),
        );
      });

      const { xml: xmlContent, fileName } = buildTTRXML(
        ttrBlocks,
        entity as EntityRecord,
        reportDate,
        batchSeq,
      );

      const approvalToken = crypto.randomUUID();

      const { data: batch, error: batchErr } = await ttr
        .from("report_batches")
        .insert({
          reporting_entity_id: entityId,
          report_date: reportDate,
          xml_content: xmlContent,
          file_name: fileName,
          transaction_count: txns.length,
          approval_token: approvalToken,
          status: "pending_review",
        })
        .select("id")
        .single();

      if (batchErr || !batch) throw new Error(`Batch insert failed: ${batchErr?.message}`);

      const batchId = (batch as Row).id as string;

      const { error: linkErr } = await ttr
        .from("transaction_reports")
        .insert(txns.map((t) => ({ transaction_id: t.id, batch_id: batchId })));

      if (linkErr) throw new Error(`Link insert failed: ${linkErr.message}`);

      let emailSentAt: string | null = null;
      if (adminEmails.length > 0) {
        try {
          await sendApprovalEmail({
            to: adminEmails,
            batchId,
            approvalToken,
            reportDate,
            txnCount: txns.length,
            entityName: (entity as EntityRecord).trading_name ?? (entity as EntityRecord).legal_name,
          });
          emailSentAt = new Date().toISOString();
        } catch (emailErr) {
          console.error("Approval email failed:", emailErr);
        }
      }

      if (emailSentAt) {
        await ttr.from("report_batches").update({ email_sent_at: emailSentAt }).eq("id", batchId);
      }

      results.push({ entityId, batchId, txnCount: txns.length, fileName });
    } catch (err) {
      console.error(`Entity ${entityId} failed:`, err);
      errors.push({ entityId, error: String(err) });
    }
  }

  const status = errors.length > 0 && results.length === 0 ? 500 : 200;
  return json({ reportDate, results, errors }, status);
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
