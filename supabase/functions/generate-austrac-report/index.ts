import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? null;
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:3000";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") ?? "noreply@example.com";

// ─── TTR-1-0 namespace ────────────────────────────────────────────────────────

const NS = "http://austrac.gov.au/schema/reporting/TTR-1-0";

// ─── AUSTRAC code mappings ────────────────────────────────────────────────────

const ID_TYPE_MAP: Record<string, string> = {
  "Driver licence": "D",
  "Passport": "P",
  "Proof of age card": "PHOT",
  "National identity card": "PHOT",
  "Medicare card": "BENE",
  "Other government document": "PHOT",
  "Electronic verification source": "ELEC",
};

const BULLION_TYPE_MAP: Record<string, string> = {
  "Gold": "GOLD",
  "Silver": "SILVER",
  "Platinum": "PLATINUM",
  "Palladium": "PALLADIUM",
};

const DESIGNATED_SERVICE_MAP: Record<string, string> = {
  "bullion_sell": "BULSER",
  "bullion_buy": "BULSER",
};

// ─── XML helpers ─────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function xmlEsc(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
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

// ─── Address (TTR-1-0 AddressType) ───────────────────────────────────────────
// Elements: <addr>, <suburb>, <state>, <postcode>, <countryCode>

function buildAddress(
  street: unknown,
  suburb: unknown,
  state: unknown,
  postcode: unknown,
  country: unknown,
): string {
  return [
    el("addr", street),
    el("suburb", suburb),
    el("state", state),
    el("postcode", postcode),
    el("countryCode", (country as string ?? "AU").toUpperCase().slice(0, 2)),
  ].join("");
}

// ─── Identification (TTR-1-0 IdentificationType) ─────────────────────────────

function buildIdElement(idv: Row | null): string {
  if (!idv) return "";
  const rawType = idv.document_type as string;
  const idType = ID_TYPE_MAP[rawType] ?? "PHOT";
  const typeOther = idType === "PHOT" && !ID_TYPE_MAP[rawType] ? rawType : "";
  return `<identification>${el("type", idType)}${opt("typeOther", typeOther)}${el("number", idv.document_number)}${opt("issuer", idv.issuer)}${opt("countryCode", idv.id_country_code)}</identification>`;
}

// ─── IndividualDetails ────────────────────────────────────────────────────────

function buildIndividualDetails(
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

  const altNames = aliases.map((a) => opt("altName", a.alias_name)).join("");

  const resAddr = person.res_street
    ? `<residentialAddress>${buildAddress(person.res_street, person.res_suburb, person.res_state, person.res_postcode, person.res_country)}</residentialAddress>`
    : "";

  const postAddr = person.post_street
    ? `<postalAddress>${buildAddress(person.post_street, person.post_suburb, person.post_state, person.post_postcode, person.post_country)}</postalAddress>`
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
    el("isAbnHolder", yesNo(isAbnHolder)),
    isAbnHolder ? el("abn", person.abn) : "",
    resAddr,
    postAddr,
    opt("phone", person.phone ?? person.company_phone),
    opt("email", person.email),
    opt("occupationBusinessActivity", person.occupation ?? person.principal_activity),
    el("isIdentityVerified", yesNo(hasIdv)),
    buildIdElement(idv),
  ].join("");
}

// ─── OrganisationDetails ──────────────────────────────────────────────────────

const LEGAL_FORM_MAP: Record<string, string> = {
  "Company": "C",
  "Partnership": "P",
  "Trust": "T",
  "Sole trader": "I",
  "Association": "A",
};

function buildOrganisationDetails(party: Row): string {
  const bsCode = LEGAL_FORM_MAP[party.legal_form as string] ?? "R";
  const regTag = (party.reg_id_type as string)?.toUpperCase() === "ABN" ? "abn" : "acn";
  const bizAddr = `<businessAddress>${buildAddress(party.biz_street, party.biz_suburb, party.biz_state, party.biz_postcode, party.biz_country)}</businessAddress>`;
  const postAddr = party.post_street
    ? `<postalAddress>${buildAddress(party.post_street, party.post_suburb, party.post_state, party.post_postcode, party.post_country)}</postalAddress>`
    : "";
  return [
    el("entityName", party.entity_name),
    opt("tradingName", party.trading_name),
    el("businessStructure", bsCode),
    el(regTag, party.reg_identifier),
    bizAddr,
    postAddr,
    opt("phone", party.company_phone),
    opt("principalActivity", party.principal_activity),
  ].join("");
}

// ─── Customer element ─────────────────────────────────────────────────────────

function buildCustomer(party: Row, idv: Row | null, aliases: Row[]): string {
  if (party.party_type === "individual") {
    return `<customer><individual>${buildIndividualDetails(party, idv, aliases, !!idv)}</individual></customer>`;
  }
  return `<customer><organisation>${buildOrganisationDetails(party)}</organisation></customer>`;
}

// ─── otherPerson element (replaces individualConductingTxn) ──────────────────
// TTR-1-0: <otherPerson> is 1..* mandatory.
// If a conducting person record exists, use it; otherwise use the first customer party.

function buildOtherPerson(person: Row, idv: Row | null, aliases: Row[]): string {
  return `<otherPerson><individual>${buildIndividualDetails(person, idv, aliases, !!idv)}</individual></otherPerson>`;
}

// Adapts a conducting_person row to the shape expected by buildIndividualDetails
function cpAsRow(cp: Row): Row {
  return {
    full_name: cp.full_name,
    date_of_birth: cp.date_of_birth,
    gender: null,
    citizenship_country_code: null,
    tax_residency_country_code: null,
    abn: null,
    legal_form: null,
    phone: cp.phone,
    email: null,
    occupation: null,
    res_street: cp.res_street,
    res_suburb: cp.res_suburb,
    res_state: cp.res_state,
    res_postcode: cp.res_postcode,
    res_country: cp.res_country,
    post_street: cp.post_street ?? null,
    post_suburb: cp.post_suburb ?? null,
    post_state: cp.post_state ?? null,
    post_postcode: cp.post_postcode ?? null,
    post_country: cp.post_country ?? null,
  };
}

// ─── Recipient element ────────────────────────────────────────────────────────

function buildRecipient(rd: Row, parties: Row[], idvByParty: Record<string, Row>): string {
  if (rd.recipient_is_party) {
    const p = parties.find((x) => x.id === rd.selected_party_id);
    if (p) {
      if (p.party_type === "individual") {
        return `<recipient><individual>${buildIndividualDetails(p, idvByParty[p.id as string] ?? null, [], !!(idvByParty[p.id as string]))}</individual></recipient>`;
      }
      return `<recipient><organisation>${buildOrganisationDetails(p)}</organisation></recipient>`;
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
  return `<recipient><individual>${buildIndividualDetails(recipRow, null, [], false)}</individual></recipient>`;
}

// ─── Cash element ─────────────────────────────────────────────────────────────

function buildCashEl(tx: Row): string {
  if ((tx.cash_currency as string) === "AUD") {
    return `<ausCash>${fmtAmount(tx.cash_amount)}</ausCash>`;
  }
  return `<foreignCash>${el("amount", tx.fx_currency_amount)}${el("currency", tx.fx_currency_code)}${el("audEquivalent", fmtAmount(tx.aud_value))}</foreignCash>`;
}

// ─── Bullion item elements (<bui> / <buo>) ────────────────────────────────────

function buildBullionItem(item: Row, tag: "bui" | "buo"): string {
  const type = BULLION_TYPE_MAP[item.metal_type as string];
  if (!type) throw new Error(`Unmappable bullion metal type: ${item.metal_type}`);
  return `<${tag}>${el("amount", fmtAmount(item.line_total_aud))}${el("type", type)}${opt("description", item.description)}</${tag}>`;
}

function buildMoneyReceived(tx: Row, bullionItems: Row[]): string {
  if ((tx.scenario as string) === "bullion_buy") {
    // RE buys bullion: receives bullion items
    const buis = bullionItems.map((b) => buildBullionItem(b, "bui")).join("");
    return `<otherMoneyReceived>${buis}</otherMoneyReceived>`;
  }
  // RE sells bullion: receives cash
  return `<cash>${buildCashEl(tx)}</cash>`;
}

function buildMoneyProvided(tx: Row, bullionItems: Row[]): string {
  if ((tx.scenario as string) === "bullion_sell") {
    // RE sells bullion: provides bullion items
    const buos = bullionItems.map((b) => buildBullionItem(b, "buo")).join("");
    return `<otherMoneyProvided>${buos}</otherMoneyProvided>`;
  }
  // RE buys bullion: provides cash
  return `<cash>${buildCashEl(tx)}</cash>`;
}

// ─── Full TTR block ───────────────────────────────────────────────────────────

interface EntityRecord {
  id: string;
  legal_name: string;
  trading_name: string | null;
  austrac_re_number: string | null;
  address_street: string | null;
  address_suburb: string | null;
  address_state: string | null;
  address_postcode: string | null;
  address_country: string | null;
}

function buildTTRBlock(
  tx: Row,
  parties: Row[],
  conductingPersons: Row[],
  idvs: Row[],
  allAliases: Row[],
  cpAliases: Row[],
  recipientDeliveries: Row[],
  bullionItems: Row[],
): string {
  const idvByParty = Object.fromEntries(
    idvs.filter((v) => v.party_id).map((v) => [v.party_id as string, v]),
  );
  const idvByCP = Object.fromEntries(
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

  // 2. customer blocks
  const customers = parties
    .map((p) => buildCustomer(p, idvByParty[p.id as string] ?? null, aliasesByParty[p.id as string] ?? []))
    .join("");

  // 3. otherPerson (mandatory 1..*): use primary CP if present, else fall back to first party
  const primaryCP = conductingPersons.find((cp) => cp.is_primary);
  let otherPersonEl: string;
  if (primaryCP) {
    const cpIdv = idvByCP[primaryCP.id as string] ?? null;
    const cpAliasList = cpAliases.filter((a) => a.conducting_person_id === primaryCP.id);
    otherPersonEl = buildOtherPerson(cpAsRow(primaryCP), cpIdv, cpAliasList);
  } else {
    // No separate conducting person — customer conducted transaction themselves
    const p = parties[0];
    otherPersonEl = buildOtherPerson(p, idvByParty[p.id as string] ?? null, aliasesByParty[p.id as string] ?? []);
  }

  // 4. transaction
  const txDate = (tx.transaction_datetime as string ?? "").slice(0, 10);
  const txTime = (tx.transaction_datetime as string ?? "").slice(11, 19) || "00:00:00";
  const physDir = (tx.scenario as string) === "bullion_sell" ? "RECEIVED" : "PROVIDED";
  const rd = recipientDeliveries[0] ?? null;
  const txnPurpose = rd ? (rd.purpose_of_transfer as string ?? "") : "";

  const transaction = `<transaction>${el("designatedService", DESIGNATED_SERVICE_MAP[tx.scenario as string] ?? "BULSER")}${el("txnLocation", tx.transaction_location ?? "")}${el("txnDate", txDate)}${el("txnTime", txTime)}${el("txnRefNo", tx.transaction_ref)}<txnPurpose>${xmlEsc(txnPurpose)}</txnPurpose>${el("physicalCurrencyDirection", physDir)}<moneyReceived>${buildMoneyReceived(tx, bullionItems)}</moneyReceived><moneyProvided>${buildMoneyProvided(tx, bullionItems)}</moneyProvided>${el("totalAmount", fmtAmount(tx.aud_value))}</transaction>`;

  // 5. recipient
  const recipientEl = rd ? buildRecipient(rd, parties, idvByParty) : "";

  // 6. isOtherDsProviderInvolved
  const otherDsEl = el("isOtherDsProviderInvolved", yesNo(tx.is_other_ds_provider_involved));

  return `<ttr id="${xmlEsc(tx.id as string)}">${lppDetails}${customers}${otherPersonEl}${transaction}${recipientEl}${otherDsEl}</ttr>`;
}

// ─── Root ttrList wrapper ─────────────────────────────────────────────────────

function buildTTRXML(
  blocks: string[],
  entity: EntityRecord,
  reportDate: string,
  batchSeq: number,
): { xml: string; fileName: string } {
  const datePart = reportDate.replace(/-/g, "");
  const seqPart = String(batchSeq).padStart(8, "0");
  const fileName = `TTR${datePart}${seqPart}.xml`;
  const aan = xmlEsc(entity.austrac_re_number ?? "");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<ttrList xmlns="${NS}">\n${el("reAustracAccountNumber", aan)}\n${el("submitterAustracAccountNumber", aan)}\n${el("fileName", fileName)}\n${el("reportCount", blocks.length)}\n${blocks.join("\n")}\n</ttrList>`;
  return { xml, fileName };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function yesterdayAEST(): string {
  const aestNow = new Date(Date.now() + 10 * 60 * 60 * 1000);
  aestNow.setUTCDate(aestNow.getUTCDate() - 1);
  return aestNow.toISOString().slice(0, 10);
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

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
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
        .select("id, legal_name, trading_name, austrac_re_number, address_street, address_suburb, address_state, address_postcode, address_country")
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

      const [
        { data: allParties },
        { data: allCPs },
        { data: allIDVs },
        { data: allRDs },
        { data: allBIs },
        { data: allAliases },
        { data: allCPAliases },
      ] = await Promise.all([
        ttr.from("parties").select("*").in("transaction_id", allTxnIds),
        ttr.from("conducting_persons").select("*").in("transaction_id", allTxnIds),
        ttr.from("id_verifications").select("*").in("transaction_id", allTxnIds),
        ttr.from("recipient_deliveries").select("*").in("transaction_id", allTxnIds),
        ttr.from("bullion_items").select("*").in("transaction_id", allTxnIds),
        ttr.from("party_aliases").select("*").in("transaction_id", allTxnIds),
        ttr.from("cp_aliases").select("*").in("transaction_id", allTxnIds),
      ]);

      // Determine batch sequence number (1-based count of existing batches for this entity+date)
      const { count: existingBatches } = await ttr
        .from("report_batches")
        .select("id", { count: "exact", head: true })
        .eq("reporting_entity_id", entityId)
        .eq("report_date", reportDate);
      const batchSeq = (existingBatches ?? 0) + 1;

      const ttrBlocks = txns.map((tx) => {
        const txId = tx.id as string;
        return buildTTRBlock(
          tx,
          ((allParties ?? []) as Row[]).filter((p) => p.transaction_id === txId),
          ((allCPs ?? []) as Row[]).filter((cp) => cp.transaction_id === txId),
          ((allIDVs ?? []) as Row[]).filter((v) => v.transaction_id === txId),
          ((allAliases ?? []) as Row[]).filter((a) => a.transaction_id === txId),
          ((allCPAliases ?? []) as Row[]).filter((a) => a.transaction_id === txId),
          ((allRDs ?? []) as Row[]).filter((r) => r.transaction_id === txId),
          ((allBIs ?? []) as Row[]).filter((b) => b.transaction_id === txId),
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
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
