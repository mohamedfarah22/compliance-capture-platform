// Gold due diligence rules. Pure: no imports, no React, no API calls, no Deno or Vite specifics.
// Loaded by the browser (through the @gold-rules alias) and by the Deno edge functions.
// Ported from the client's handover (purchase.js, utils.js, config.js), with the changes in
// docs/gold-due-diligence-spec.md section 5.1.

// ─── Settings ────────────────────────────────────────────────────────────────

/** AUD. Cash of this amount or more (including exactly this amount) must be reported to AUSTRAC. */
export const CASH_REPORT_THRESHOLD = 10000;

/** AUD. Bullion bought with this much cash or more needs the customer's current ID (no report under $10,000). */
export const BULLION_ID_THRESHOLD = 5000;

/** Business days after the purchase to complete it and lodge the AUSTRAC report. */
export const AUSTRAC_REPORT_BUSINESS_DAYS = 10;

/** Business dates (sale date, "today" for ID expiry) are worked out in this time zone, never the server's. */
export const BUSINESS_TIMEZONE = "Australia/Melbourne";

/** Location written onto TTRs started from gold. */
export const LOCATION_SNAPSHOT = "Coburg, VIC";

/** Same default CCP's ID verification uses when the business has no `idv_max_reliance_days`. */
export const DEFAULT_IDV_MAX_RELIANCE_DAYS = 730;

// ─── Dates and amounts (from utils.js) ───────────────────────────────────────

const datePartsFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});

/** The calendar date ("YYYY-MM-DD") of a moment in the business time zone. Used for `sale_date`. */
export const businessDate = (when = new Date()) => {
    const parts = Object.fromEntries(datePartsFormat.formatToParts(new Date(when)).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
};

const dayNumber = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) / 86400000;

/**
 * 'valid' | 'expiring' (30 days or fewer) | 'expired' | 'reverify' | 'unknown'.
 * currentId is { expiry_date, captured_at }. `reverify` = the ID was photographed longer ago than
 * idvMaxRelianceDays (the window CCP's ID verification applies). Expired wins over reverify.
 */
export const idStatus = (currentId, idvMaxRelianceDays, now = new Date()) => {
    if (!currentId) return "unknown";
    const expiryDays = currentId.expiry_date ? dayNumber(currentId.expiry_date) - dayNumber(businessDate(now)) : null;
    if (expiryDays !== null && expiryDays < 0) return "expired";
    if (currentId.captured_at) {
        const elapsedDays = Math.floor((new Date(now) - new Date(currentId.captured_at)) / 86400000);
        if (elapsedDays > (idvMaxRelianceDays ?? DEFAULT_IDV_MAX_RELIANCE_DAYS)) return "reverify";
    }
    if (expiryDays === null) return currentId.captured_at ? "valid" : "unknown";
    return expiryDays <= 30 ? "expiring" : "valid";
};

/** "12,500", "$12500.50" → number. Blank → null. Anything else → NaN. */
export const parseAud = (s) => {
    const t = String(s ?? "").replace(/[$,\s]/g, "");
    if (!t) return null;
    return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : NaN;
};

const isWeekday = (d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;

/**
 * The date n business days (Mon–Fri) after the given moment, counted from its date in the business time zone.
 * Public holidays are not skipped. Returns a Date at 12:00 UTC on that calendar date, so it shows the
 * right date in any browser time zone.
 */
export const addBusinessDays = (from, n) => {
    const d = new Date(`${businessDate(from)}T12:00:00Z`);
    for (let left = n; left > 0;) {
        d.setUTCDate(d.getUTCDate() + 1);
        if (isWeekday(d)) left--;
    }
    return d;
};

// ─── Purchase types and cash bands (from purchase.js) ────────────────────────

export const PURCHASE_TYPES = [
    ["scrap", "Scrap jewellery"],
    ["bullion", "Bullion"],
];
export const typeLabel = (type) => (type === "bullion" ? "Bullion" : "Scrap jewellery");

/** Cash paid for bullion. Only the cash part counts; bank transfers don't. */
export const BULLION_BANDS = [
    ["under_5k", "Under $5,000"],
    ["5k_to_10k", "$5,000 to $9,999"],
    ["10k_plus", "$10,000 or more"],
];

/** Stored cash_band → label. Scrap uses under_10k / 10k_plus. */
export const bandLabel = (band) =>
    ({
        under_5k: "Under $5,000",
        "5k_to_10k": "$5,000 to $9,999",
        "10k_plus": "$10,000 or more",
        under_10k: "Under $10,000",
    })[band] || "—";

/**
 * draft fields used here:
 *   type        'scrap' | 'bullion'
 *   cash10k     scrap: "Paid in cash of $10,000 or more?" Yes/No
 *   bullionBand bullion: 'under_5k' | '5k_to_10k' | '10k_plus'
 *   cashAmount  optional text, shown when the answer is $10,000 or more
 */
export const claimsCash10k = (d) => (d.type === "bullion" ? d.bullionBand === "10k_plus" : !!d.cash10k);

/** Value stored as cash_band: the answer given, or, if a cash amount was entered, the band that amount falls in. */
export const cashBand = (d) => {
    const n = enteredAmount(d);
    if (d.type === "bullion") {
        if (n === null) return d.bullionBand;
        return n >= CASH_REPORT_THRESHOLD ? "10k_plus" : n >= BULLION_ID_THRESHOLD ? "5k_to_10k" : "under_5k";
    }
    if (n === null) return d.cash10k ? "10k_plus" : "under_10k";
    return n >= CASH_REPORT_THRESHOLD ? "10k_plus" : "under_10k";
};

/** A purchase is incomplete until its ERP invoice number is added. */
export const isIncomplete = (t) => !(t.erp_invoice_no || "").trim();

/** Optional cash amount: blank is fine; anything entered must be a valid AUD amount. */
const AMOUNT_ERROR = "Enter an amount like 12,500 or 12500.50.";
export const cashAmountValue = (d) => (claimsCash10k(d) ? parseAud(d.cashAmount) : null);
const enteredAmount = (d) => {
    const n = cashAmountValue(d);
    return n === null || Number.isNaN(n) ? null : n;
};

/**
 * THE AUSTRAC TRIGGER — same for scrap jewellery and bullion.
 * A report is needed only when cash paid is $10,000 or more (exactly $10,000 counts).
 * If a cash amount is entered, the amount decides; otherwise the answer does.
 * e.g. Yes / $10,000 or more + $8,000 → not reportable. + blank → reportable.
 */
export const isReportable = (d) => {
    if (!claimsCash10k(d)) return false;
    const n = enteredAmount(d);
    return n === null ? true : n >= CASH_REPORT_THRESHOLD;
};

/**
 * Needs a CURRENT ID (an expired or out-of-window one blocks saving):
 *   - any reportable purchase (an expired ID can't go into an AUSTRAC report)
 *   - bullion with $5,000 or more in cash, even when under $10,000 (ID must be captured, no report)
 */
export const needsCurrentId = (d) => {
    if (isReportable(d)) return true;
    if (d.type !== "bullion" || d.bullionBand === "under_5k") return false;
    const n = enteredAmount(d);
    return n === null ? true : n >= BULLION_ID_THRESHOLD;
};

const bandForAmount = (type, n) =>
    type === "bullion"
        ? n >= CASH_REPORT_THRESHOLD
            ? "10k_plus"
            : n >= BULLION_ID_THRESHOLD
              ? "5k_to_10k"
              : "under_5k"
        : n >= CASH_REPORT_THRESHOLD
          ? "10k_plus"
          : "under_10k";

const isNum = (n) => typeof n === "number" && !Number.isNaN(n);
const roundCents = (n) => Math.round(n * 100) / 100;

/**
 * SAME-DAY INVOICE RULE. Purchases for the same customer, under the same ERP invoice number,
 * recorded on the same business day (e.g. scrap jewellery + bullion on one invoice) are one sale for AUSTRAC:
 * the cash across the invoice is added up, and the invoice is reportable if the total is $10,000+.
 *
 * linked — earlier parts on the same invoice, same day, same customer (gold.linked_parts). Each part:
 *            { id, purchase_type, cash_amount, ttr_transaction_id, ttr_status }
 * draft.partAmount        — cash paid for this part (required when linked; 0 if none)
 * draft.linkedAmounts[id] — cash for an earlier part that has no amount saved
 *
 * Returns { linked, amount, total, reportable, needsId, band, alreadyReported, ttrCompleted, byType, ttrTypes, errors }.
 *   byType          cash per purchase type across the invoice, e.g. { scrap: 6000, bullion: 6000 }
 *                   (null until every amount is known; in the single-purchase case the amount may be null = cash, no amount entered)
 *   ttrTypes        types that need a TTR: reportable, and cash above $0 for that type (bank transfer only → no TTR)
 *   alreadyReported a linked part of this purchase's type already has a TTR (ttr_transaction_id)
 *   ttrCompleted    a linked part of this purchase's type has a completed TTR (ttr_status 'completed')
 * With no linked purchases it falls back to the single-purchase rules above.
 */
export function evaluateCash(d, linked = []) {
    if (!linked.length) {
        const amount = cashAmountValue(d);
        const reportable = isReportable(d);
        return {
            linked: false,
            amount: isNum(amount) ? amount : null,
            total: null,
            errors: {},
            reportable,
            needsId: needsCurrentId(d),
            band: cashBand(d),
            alreadyReported: false,
            ttrCompleted: false,
            byType: { [d.type]: isNum(amount) ? amount : null },
            ttrTypes: reportable ? [d.type] : [],
        };
    }
    const errors = {};
    const part = parseAud(d.partAmount);
    if (part === null) errors.partAmount = "Enter the cash paid for this part. Enter 0 if none was cash.";
    else if (Number.isNaN(part)) errors.partAmount = AMOUNT_ERROR;
    const earlier = linked.map((t) => {
        if (t.cash_amount != null) return t.cash_amount;
        const n = parseAud(d.linkedAmounts?.[t.id]);
        if (n === null) errors[`linked_${t.id}`] = "Enter the cash paid on that part. Enter 0 if none was cash.";
        else if (Number.isNaN(n)) errors[`linked_${t.id}`] = AMOUNT_ERROR;
        return n;
    });
    const all = [part, ...earlier];
    const known = all.every(isNum);
    const total = known ? roundCents(all.reduce((s, n) => s + n, 0)) : null;
    const amount = isNum(part) ? part : null;
    const reportable = total !== null && total >= CASH_REPORT_THRESHOLD;
    let byType = null;
    if (known) {
        byType = {};
        [d.type, ...linked.map((t) => t.purchase_type)].forEach((type, i) => {
            byType[type] = roundCents((byType[type] ?? 0) + all[i]);
        });
    }
    return {
        linked: true,
        amount,
        total,
        errors,
        reportable,
        // Bullion's $5,000 ID rule applies to the bullion part's own cash.
        needsId: reportable || (d.type === "bullion" && amount !== null && amount >= BULLION_ID_THRESHOLD),
        band: amount === null ? null : bandForAmount(d.type, amount),
        alreadyReported: linked.some((t) => t.purchase_type === d.type && !!t.ttr_transaction_id),
        ttrCompleted: linked.some((t) => t.purchase_type === d.type && t.ttr_status === "completed"),
        byType,
        ttrTypes: reportable && byType ? Object.keys(byType).filter((type) => byType[type] > 0) : [],
    };
}

/** Date an AUSTRAC-pending purchase must be completed and reported by (created_at + 10 business days). */
export const austracDueDate = (t) => addBusinessDays(t.created_at, AUSTRAC_REPORT_BUSINESS_DAYS);

// ─── TTR case (spec 3.3) ─────────────────────────────────────────────────────

const missingFields = (readiness) => (Array.isArray(readiness) ? readiness : readiness?.missing);

/**
 * Which hand-off a purchase gets.
 *   cash       evaluateCash() result
 *   isJoint    a joint seller is on the purchase
 *   readiness  customer_ttr_ready(): the list of missing fields (or { missing: [...] }); unknown counts as not ready
 *   answers    { selfConducted, detailsConfirmed }: the two counter questions
 * Returns { case: null | 'A' | 'B', invoiceRequired }.
 *   null  not reportable
 *   A     single seller, nothing missing on file, both answers Yes: invoice optional, TTR starts when it is added
 *   B     anything else reportable: invoice required, TTR opens at the counter
 *
 * @param {any} input
 */
export function ttrCase({ cash, isJoint, readiness, answers } = /** @type {any} */ ({})) {
    if (!cash?.reportable) return { case: null, invoiceRequired: false };
    const missing = missingFields(readiness);
    const ready = Array.isArray(missing) && missing.length === 0;
    if (!isJoint && ready && answers?.selfConducted === true && answers?.detailsConfirmed === true) {
        return { case: "A", invoiceRequired: false };
    }
    return { case: "B", invoiceRequired: true };
}

// ─── Validation ──────────────────────────────────────────────────────────────

const customerName = (c) =>
    c?.full_name || [c?.first_name, c?.middle_name, c?.last_name].filter(Boolean).join(" ") || "This customer";

const invoiceRequiredMessage = (mainCustomer, readiness) => {
    const name = customerName(mainCustomer);
    const missing = missingFields(readiness);
    if (!Array.isArray(missing) || missing.length > 0) {
        return `Enter the ERP invoice number. ${name}'s AUSTRAC details are incomplete, so the report must be started now.`;
    }
    return `Enter the ERP invoice number. The AUSTRAC report for ${name} must be started now.`;
};

const ID_NOT_SIGHTED = "Doesn't match the record? Update ID first.";

/**
 * Invoice checks shared by validatePurchase and validateCompletion (spec 3.3, 3.5):
 *   - a linked part of this type already has a completed TTR → error
 *   - the invoice is on a purchase that isn't a same-day linked part → error when reportable, otherwise a warning
 */
function checkInvoice({ invoice, cash, linked, sameInvoice, selfId, errors, warnings }) {
    if (!invoice) return;
    if (cash.ttrCompleted) {
        errors.erp_invoice_no = `The AUSTRAC report for ${invoice} is already finished. Use a new ERP invoice number for this purchase.`;
        return;
    }
    const linkedIds = new Set(linked.map((t) => t.id));
    const others = sameInvoice.filter((t) => t.id !== selfId && !linkedIds.has(t.id));
    if (!others.length) return;
    if (cash.reportable) {
        errors.erp_invoice_no = `The ERP invoice number ${invoice} is already used by another purchase. A reportable purchase needs its own invoice number.`;
    } else {
        warnings.duplicateInvoice = `The ERP invoice number ${invoice} is already recorded on another purchase.`;
    }
}

/**
 * At the counter. A goods photo and the sighted tick are required; the invoice number can be added later,
 * except where the TTR case needs it now.
 *
 * context:
 *   mainCustomer, jointCustomer  { id, first_name, middle_name, last_name, current_id: { expiry_date, captured_at } }
 *   linked                       earlier same-day parts on the same invoice (see evaluateCash)
 *   sameInvoice                  every purchase already using this invoice number ({ id }), any customer or day
 *   readiness, answers           see ttrCase
 *   idvMaxRelianceDays           re-verification window; default 730
 *   now                          override "now" (tests)
 *
 * Returns:
 *   errors   — { field: message } shown inline; submit is not allowed while any exist
 *   warnings — { duplicateInvoice } shown but not blocking
 *   blocked  — [{ customer, role, status }] sellers whose expired or out-of-window ID stops the purchase
 *              being saved (only when a current ID is needed; the customer is still at the counter, so Update ID now)
 *   expired  — [{ customer, role }] every seller with an expired ID (saved with an expired-ID flag)
 *   reverify — [{ customer, role }] every seller whose ID is outside the window (saved with an outside-window flag;
 *              amber notice when not blocked)
 *   cash, ttr — evaluateCash() and ttrCase() results
 *
 * @param {any} draft
 * @param {any} [context]
 */
export function validatePurchase(
    draft,
    {
        mainCustomer,
        jointCustomer,
        linked = [],
        sameInvoice = [],
        readiness,
        answers,
        idvMaxRelianceDays = DEFAULT_IDV_MAX_RELIANCE_DAYS,
        now = new Date(),
    } = /** @type {any} */ ({})
) {
    const cash = evaluateCash(draft, linked);
    /** @type {Record<string, string>} */
    const errors = { ...cash.errors };
    /** @type {Record<string, string>} */
    const warnings = {};
    const sellers = [
        [mainCustomer, "main"],
        [jointCustomer, "joint"],
    ]
        .filter(([c]) => c)
        .map(([customer, role]) => ({
            customer,
            role,
            status: idStatus(customer.current_id, idvMaxRelianceDays, now),
        }));
    const expired = sellers.filter((s) => s.status === "expired").map(({ customer, role }) => ({ customer, role }));
    const reverify = sellers.filter((s) => s.status === "reverify").map(({ customer, role }) => ({ customer, role }));
    const blocked = cash.needsId ? sellers.filter((s) => s.status === "expired" || s.status === "reverify") : [];
    const ttr = ttrCase({ cash, isJoint: !!jointCustomer, readiness, answers });

    if (!draft.photos?.length) errors.photos = "Add at least one photo of the items purchased.";
    if (draft.idSighted !== true) {
        errors.idSighted = jointCustomer
            ? `Both people's IDs must be sighted today and match the records on file. ${ID_NOT_SIGHTED}`
            : `ID must be sighted today and match the record on file. ${ID_NOT_SIGHTED}`;
    }
    const phoneDigits = (draft.phone || "").replace(/\D/g, "");
    if (phoneDigits && phoneDigits.length < 8) errors.phone = "Phone number looks too short.";
    if (!cash.linked && Number.isNaN(cashAmountValue(draft))) errors.cashAmount = AMOUNT_ERROR;
    if (jointCustomer && mainCustomer && jointCustomer.id === mainCustomer.id) {
        errors.joint = "The second person must be a different customer.";
    }

    const invoice = (draft.erp_invoice_no || "").trim();
    if (!invoice && ttr.invoiceRequired) errors.erp_invoice_no = invoiceRequiredMessage(mainCustomer, readiness);
    checkInvoice({ invoice, cash, linked, sameInvoice, selfId: null, errors, warnings });

    return { errors, warnings, blocked, expired, reverify, cash, ttr };
}

/**
 * Completing a saved purchase later. The invoice number is required.
 * A reportable purchase is blocked if an ID had expired or was outside the window at the time of purchase
 * (checked against the purchase, not today's ID status).
 *
 * context: { mainCustomer, readiness, linked, sameInvoice }. The sellers' answers (ttr_self_conducted,
 * ttr_details_confirmed) and whether there is a joint seller (joint_customer_id) are read from the saved purchase.
 *
 * @param {any} draft
 * @param {any} transaction
 * @param {any} [context]
 */
export function validateCompletion(draft, transaction, context = {}) {
    const { mainCustomer, readiness, linked = [], sameInvoice = [] } = context;
    const cash = evaluateCash(draft, linked);
    /** @type {Record<string, string>} */
    const errors = { ...cash.errors };
    /** @type {Record<string, string>} */
    const warnings = {};
    const ttr = ttrCase({
        cash,
        isJoint: !!transaction.joint_customer_id,
        readiness,
        answers: { selfConducted: transaction.ttr_self_conducted, detailsConfirmed: transaction.ttr_details_confirmed },
    });
    const invoice = (draft.erp_invoice_no || "").trim();
    if (!invoice) {
        errors.erp_invoice_no = ttr.invoiceRequired
            ? invoiceRequiredMessage(mainCustomer, readiness)
            : "Enter the ERP invoice number for this purchase.";
    }
    if (!cash.linked && Number.isNaN(cashAmountValue(draft))) errors.cashAmount = AMOUNT_ERROR;
    checkInvoice({ invoice, cash, linked, sameInvoice, selfId: transaction.id, errors, warnings });
    const idProblem = !!(transaction.id_expired_at_time || transaction.id_outside_window_at_time);
    return { errors, warnings, blocked: cash.reportable && idProblem, cash, ttr };
}
