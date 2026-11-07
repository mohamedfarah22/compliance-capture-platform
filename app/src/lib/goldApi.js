// The gold journey's data layer: the handover's api.js names, implemented against Supabase (spec 4.6).
// Reads go through RPCs and RLS selects; every customer write goes through a gold-* edge function, except the
// phone change, which is an RPC. Errors are GoldApiError, whose message is safe to show to staff.
import { supabase } from "./supabase.js";
import { getIdImageSignedUrls } from "./wizardApi.js";
import { openTtrPath } from "./ttrRoutes.js";

const EDGE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

const MESSAGES = {
    gold_disabled: "Gold due diligence is not switched on for this site.",
    mfa_required: "Sign in again with your authenticator code.",
    unauthorized: "Your session has ended. Sign in again.",
    forbidden: "You do not have permission to do that.",
    customer_not_found: "Customer not found.",
    validation_failed: "Check the highlighted fields.",
    document_not_on_file:
        "That document is not on file for this customer. Choose “Different document” to record a new one.",
    invalid_phone: "Phone number looks too short.",
    purchase_not_found: "Purchase not found.",
    invoice_required: "Enter the ERP invoice number before starting the AUSTRAC report.",
    not_reportable: "This sale is under $10,000 in cash, so there is no AUSTRAC report to start.",
    no_cash: "No part of this sale was paid in cash, so there is no AUSTRAC report to start.",
    ttr_reference_in_use:
        "Another AUSTRAC report already uses this invoice number for this type of sale. Open it from the TTR start page.",
    no_id_on_file: "A seller has no ID on file. Add their ID, then record the purchase.",
    photo_too_large: "A photo is too large. Take it again, or choose a smaller one.",
    photo_not_jpeg: "Photos must be JPEG. Take the photo again.",
    linked_part_changed:
        "An earlier part of this invoice changed while you were working. Reload the page and try again.",
    already_has_invoice: "This purchase already has an invoice number.",
    too_many_purchases: "Too many purchases to download. Narrow the filters to 200 or fewer.",
};
const GENERIC_MESSAGE = "Could not save. Try again.";

export class GoldApiError extends Error {
    constructor({ status = 0, code = "", body = {}, message }) {
        super(message || MESSAGES[code] || GENERIC_MESSAGE);
        this.name = "GoldApiError";
        this.status = status;
        this.code = code;
        this.body = body;
    }
}

const notFound = () => new GoldApiError({ status: 404, code: "customer_not_found" });

const callFunction = async (name, { json, form }) => {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    const headers = { Authorization: `Bearer ${session.access_token}` };
    if (json) headers["Content-Type"] = "application/json";

    let res;
    try {
        res = await fetch(`${EDGE_URL}/${name}`, { method: "POST", headers, body: form ?? JSON.stringify(json) });
    } catch {
        throw new GoldApiError({ message: "Could not reach the server. Check the connection and try again." });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new GoldApiError({ status: res.status, code: body.error ?? "", body });
    return body;
};

const fullName = (c) => [c.first_name, c.middle_name, c.last_name].filter(Boolean).join(" ");

// The server's own phone rule, so the browser and the RPC agree.
export const phoneDigitCount = (phone) => (phone ?? "").replace(/\D/g, "").length;

// ─── Customers: reads ───────────────────────────────────────────────────────────────

/** Name, phone or ID number, 2+ characters. Up to 20 customers, exact phone / ID matches first. */
export async function searchCustomers(q) {
    const { data, error } = await supabase.rpc("search_customers", { p_q: q });
    if (error) throw new GoldApiError({ message: "Search failed. Try again." });
    return data.map((r) => ({
        id: r.customer_id,
        first_name: r.first_name,
        middle_name: r.middle_name,
        last_name: r.last_name,
        full_name: fullName(r),
        date_of_birth: r.date_of_birth,
        phone: r.phone,
        current_id: r.current_id_verification_id
            ? {
                  verification_id: r.current_id_verification_id,
                  document_type: r.current_id_document_type,
                  document_number: r.current_id_document_number,
                  has_expiry: r.current_id_has_expiry,
                  expiry_date: r.current_id_expiry_date,
                  captured_at: r.current_id_captured_at,
              }
            : null,
    }));
}

/** The customer, their aliases and current ID (null when none on file). Throws a 404 GoldApiError if not found. */
export async function getCustomer(id) {
    const [customer, current] = await Promise.all([
        supabase
            .from("customers")
            .select("*, customer_aliases(alias, sort_order)")
            .eq("id", id)
            .eq("customer_type", "individual")
            .maybeSingle(),
        supabase.rpc("customer_current_id", { p_customer_id: id }),
    ]);
    // A malformed id is "not found" too, not a server error.
    if (customer.error?.code === "22P02") throw notFound();
    if (customer.error || current.error) throw new GoldApiError({ message: "Could not load the customer. Try again." });
    if (!customer.data) throw notFound();

    const { customer_aliases: aliases, ...row } = customer.data;
    return {
        ...row,
        full_name: fullName(row),
        aliases: [...aliases].sort((a, b) => a.sort_order - b.sort_order).map((a) => a.alias),
        current_id: current.data?.[0] ?? null,
    };
}

/** Signed URLs for the current ID's photos: { front, back }, each null when there is none to show. */
export async function getCustomerIdImages(currentId) {
    const ids = [currentId?.front_image_id, currentId?.back_image_id];
    const urls = await getIdImageSignedUrls(ids);
    return { front: urls[ids[0]] ?? null, back: urls[ids[1]] ?? null };
}

/** Customers with the same name and date of birth, or the same phone. Prompts only, never a block. */
export async function findPossibleDuplicates({ firstName, lastName, dateOfBirth, phone }) {
    const { data, error } = await supabase.rpc("find_possible_duplicate_customers", {
        p_first_name: firstName,
        p_last_name: lastName,
        p_dob: dateOfBirth || null,
        p_phone: phone,
    });
    if (error) return [];
    return data.map((d) => ({
        customerId: d.customer_id,
        firstName: d.first_name,
        lastName: d.last_name,
        dateOfBirth: d.date_of_birth,
        phone: d.phone,
        matchReason: d.match_reason,
    }));
}

/** Who already has this document on file, as { customerId, name, dateOfBirth, ... }, or null. */
export async function findIdOwner({ documentType, documentNumber }) {
    const { data, error } = await supabase.rpc("get_verification_for_document", {
        p_document_type: documentType,
        p_document_number: documentNumber,
    });
    const hit = error ? null : data?.[0];
    if (!hit) return null;
    return {
        customerId: hit.customer_id ?? null,
        kind: hit.owner_kind,
        name: hit.owner_name ?? null,
        dateOfBirth: hit.owner_dob ?? null,
        documentType: hit.document_type,
    };
}

// ─── Customers: writes ──────────────────────────────────────────────────────────────

const photoForm = (payload, front, back) => {
    const form = new FormData();
    form.append("payload", JSON.stringify(payload));
    form.append("front", front, "front.jpg");
    if (back) form.append("back", back, "back.jpg");
    return form;
};

/**
 * Create a customer with their ID. data: { firstName, middleName, lastName, dateOfBirth, phone,
 * residentialAddress, id, confirmNew, differentPerson, front, back } where front / back are JPEG Blobs.
 * 409 possible_duplicates and id_on_file come back as GoldApiError with the lists in `body`.
 * Returns { customerId, verificationId, frontImageId, backImageId }.
 */
export async function createCustomer({ front, back, ...payload }) {
    return callFunction("gold-create-customer", { form: photoForm(payload, front, back) });
}

/**
 * Record a new ID. data: { reason: 'renewed' | 'different_document' | 'photo_unclear', documentType,
 * documentTypeOther, documentNumber, issuer, idCountryCode, hasExpiry, expiryDate, front, back }.
 */
export async function updateCustomerId(customerId, { front, back, ...document }) {
    return callFunction("gold-update-customer-id", { form: photoForm({ customerId, ...document }, front, back) });
}

/** Managers and admins correct profile fields. changes holds only the fields to change. */
export async function updateCustomerDetails(customerId, changes) {
    return callFunction("gold-update-customer", { json: { customerId, changes } });
}

/** The one customer write the browser makes itself. Resolves true if the number changed. */
export async function updateCustomerPhone(customerId, phone) {
    const { data, error } = await supabase.rpc("update_customer_phone", { p_customer_id: customerId, p_phone: phone });
    // The RPC's message is its error code: invalid_phone, forbidden or customer_not_found.
    if (error) throw new GoldApiError({ code: error.message });
    return data;
}

/**
 * Starts the TTR draft(s) for a purchase that has an ERP invoice number (spec 3.2, 3.4): one per type with cash
 * above $0. Resolves { ttrs, path }: ttrs is [{ id, type, scenario, status, created, case }], this purchase's type
 * first, and path is the route that opens the first one (it warns if another report is in progress, then opens
 * the first step that needs input). Safe to call again: a type that already has a TTR is reused.
 */
export async function goToAustracForm(purchaseId) {
    const { ttrs } = await callFunction("gold-start-ttr", { json: { purchaseId } });
    return { ttrs, path: openTtrPath(ttrs[0].id) };
}

// ─── Purchases: reads ───────────────────────────────────────────────────────────────

const gold = () => supabase.schema("gold");
const readFailed = () => new GoldApiError({ message: "Could not load purchases. Try again." });

// One RPC in the gold schema; rows come back as the function wrote them.
const goldRpc = async (name, args) => {
    const { data, error } = await gold().rpc(name, args);
    if (error) throw readFailed();
    return data;
};

// { [ttr transaction id]: { id, status, transaction_ref, scenario } } for the TTRs the purchases point at.
const loadTtrs = async (purchases) => {
    const ids = [...new Set(purchases.map((p) => p.ttr_transaction_id).filter(Boolean))];
    if (ids.length === 0) return {};
    const { data, error } = await supabase
        .schema("ttr")
        .from("transactions")
        .select("id, status, transaction_ref, scenario")
        .in("id", ids);
    if (error) throw readFailed();
    return Object.fromEntries(data.map((t) => [t.id, t]));
};

const PHOTO_COUNT_CHUNK = 50;

// Adds photo_count to purchase rows that come from an RPC, which does not count their photos.
const withPhotoCounts = async (rows) => {
    const counts = {};
    for (let start = 0; start < rows.length; start += PHOTO_COUNT_CHUNK) {
        const ids = rows.slice(start, start + PHOTO_COUNT_CHUNK).map((row) => row.id);
        const { data, error } = await gold().from("goods_photos").select("purchase_id").in("purchase_id", ids);
        if (error) throw readFailed();
        data.forEach((photo) => {
            counts[photo.purchase_id] = (counts[photo.purchase_id] ?? 0) + 1;
        });
    }
    return rows.map((row) => ({ ...row, photo_count: counts[row.id] ?? 0 }));
};

/** The names of customers by id, as { [id]: "First Last" }. An unknown id is left out. */
export async function getCustomerNames(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return {};
    const { data, error } = await supabase
        .from("customers")
        .select("id, first_name, middle_name, last_name")
        .in("id", unique);
    if (error) throw readFailed();
    return Object.fromEntries(data.map((c) => [c.id, fullName(c)]));
}

/** Staff who recorded or completed purchases, as { [staff id]: full name }. */
export async function getPurchaseStaffNames() {
    const data = await goldRpc("list_purchase_staff");
    return Object.fromEntries(data.map((s) => [s.staff_member_id, s.full_name]));
}

/** Staff who recorded purchases, for the "Recorded by" filter: [{ id, name }]. */
export async function listRecordedBy() {
    const data = await goldRpc("list_recorded_by");
    return data.map((s) => ({ id: s.staff_member_id, name: s.full_name }));
}

/** Purchases where the customer is the main or joint seller, newest first, with photo_count and ttr_status. */
export async function listTransactions(customerId) {
    const { data, error } = await gold()
        .from("purchases")
        .select("*, goods_photos(count)")
        .or(`customer_id.eq.${customerId},joint_customer_id.eq.${customerId}`)
        .order("created_at", { ascending: false });
    if (error) throw readFailed();
    const ttrs = await loadTtrs(data);
    return data.map(({ goods_photos: photos, ...p }) => ({
        ...p,
        photo_count: photos[0]?.count ?? 0,
        ttr_status: ttrs[p.ttr_transaction_id]?.status ?? null,
    }));
}

/**
 * One purchase with its goods photo rows (goods_photos: [{ id, sort_order }]) and its TTR (null, or
 * { id, status, transaction_ref, scenario }). Throws a 404 GoldApiError when it is not found.
 */
export async function getTransaction(id) {
    const { data, error } = await gold()
        .from("purchases")
        .select("*, goods_photos(id, sort_order)")
        .eq("id", id)
        .maybeSingle();
    // A malformed id is "not found" too, not a server error.
    if (error && error.code !== "22P02") throw readFailed();
    if (!data) throw new GoldApiError({ status: 404, code: "purchase_not_found" });
    const ttrs = await loadTtrs([data]);
    return {
        ...data,
        goods_photos: [...data.goods_photos].sort((a, b) => a.sort_order - b.sort_order),
        ttr: ttrs[data.ttr_transaction_id] ?? null,
    };
}

/** The ID capture used for each seller of a purchase, with the newer-copy fields (C1): [{ role, ... }]. */
export async function getPurchaseIdUsed(purchaseId) {
    return goldRpc("purchase_id_used", { p_purchase_id: purchaseId });
}

/** Signed URLs for a purchase's goods photos, in photo order: [{ id, sortOrder, url }]. */
export async function getGoldPhotoUrls(purchaseId) {
    const { urls } = await callFunction("get-gold-photo-urls", { json: { purchaseId } });
    return urls;
}

/** Purchases with no invoice yet, or reportable with a TTR that is not complete. Newest first. */
export async function listIncompleteTransactions() {
    return withPhotoCounts(await goldRpc("list_incomplete_purchases"));
}

/** How many purchases are waiting on To complete (the header count). */
export async function countIncompleteTransactions() {
    return (await goldRpc("list_incomplete_purchases")).length;
}

const ID_PAGE_SIZE = 100;

const searchFilters = (filters) => ({
    q: filters.q ?? "",
    type: filters.type ?? "",
    status: filters.status ?? "",
    cash: filters.cash ?? "",
    date_from: filters.from ?? "",
    date_to: filters.to ?? "",
    recorded_by: filters.recordedBy ?? "",
});

/**
 * One page of purchases. filters: { q, type, status, cash, from, to, recordedBy } (blank = any; status is
 * incomplete | complete | austrac_pending | austrac; cash is yes | no; recordedBy is a staff id).
 * Resolves { rows, total }.
 */
export async function searchTransactions(filters, { page = 1, pageSize = 25 } = {}) {
    const data = await goldRpc("search_gold_purchases", {
        p_filters: searchFilters(filters),
        p_page: page,
        p_page_size: pageSize,
    });
    return { rows: await withPhotoCounts(data), total: Number(data[0]?.total_count ?? 0) };
}

/** The ids of every purchase the filters match (the same filters as searchTransactions), newest first. */
export async function listPurchaseIds(filters) {
    const ids = [];
    let total = 0;
    for (let page = 1; page === 1 || ids.length < total; page += 1) {
        const data = await goldRpc("search_gold_purchases", {
            p_filters: searchFilters(filters),
            p_page: page,
            p_page_size: ID_PAGE_SIZE,
        });
        total = Number(data[0]?.total_count ?? 0);
        if (data.length === 0) break;
        ids.push(...data.map((row) => row.id));
    }
    return ids;
}

const DOWNLOAD_FAILED = "Could not prepare the download. Try again.";

/**
 * Asks gold-export for a download or a print of purchase records (managers and admins only; the server checks).
 * It writes the audit row first. kind "zip" resolves { purchases: [{ id, row, photos: [{ name, url }] }] } with
 * 5-minute signed photo URLs; kind "record" resolves { ok: true }. filters is the Purchases filters (or null).
 */
export async function recordDownload({ kind, filters, purchaseIds }) {
    try {
        return await callFunction("gold-export", { json: { kind, filters, purchaseIds } });
    } catch (err) {
        if (err instanceof GoldApiError && !MESSAGES[err.code]) {
            throw new GoldApiError({ status: err.status, code: err.code, body: err.body, message: DOWNLOAD_FAILED });
        }
        throw err;
    }
}

/** Earlier parts of this invoice for this customer on this day (YYYY-MM-DD): the same-day invoice rule. */
export async function findSameDayInvoicePurchases({ customerId, invoice, date, excludeId }) {
    const data = await goldRpc("linked_parts", {
        p_customer_id: customerId,
        p_invoice_norm: invoice,
        p_sale_date: date,
    });
    return data.filter((p) => p.id !== excludeId);
}

/** Every purchase already using this invoice number (any customer, any day), as [{ id, ... }]. */
export async function findInvoicePurchases(invoice, excludeId) {
    const data = await goldRpc("invoice_purchases", { p_invoice: invoice });
    return data.filter((p) => p.id !== excludeId);
}

/** True when another purchase already uses this ERP invoice number. */
export async function invoiceExists(invoice, excludeId) {
    return (await findInvoicePurchases(invoice, excludeId)).length > 0;
}

/**
 * The TTR fields this customer is missing (spec 3.3): [] means ready for case A. null when it could not be
 * worked out, which the rules treat as not ready.
 */
export async function getTtrReadiness(customerId) {
    const { data, error } = await supabase.rpc("customer_ttr_ready", { p_customer_id: customerId });
    return error ? null : data;
}

// ─── Purchases: writes ──────────────────────────────────────────────────────────────

const flag = (value) => (value === true ? "true" : "false");

/**
 * Record a purchase. data: { customerId, jointCustomerId, purchaseType: 'scrap' | 'bullion', cash10k,
 * bullionBand, cashAmount, partAmount, linkedAmounts, phone, idSighted, erpInvoiceNo, ttrSelfConducted,
 * ttrDetailsConfirmed, photos } where photos are JPEG Blobs. The server works out everything else.
 * 422 validation_failed comes back as GoldApiError with { errors, warnings, blocked } in `body`.
 * Resolves { purchaseId, ttr: null | 'A' | 'B', warnings }; the TTR itself starts with goToAustracForm.
 */
export async function createTransaction(data) {
    const form = new FormData();
    const fields = {
        customerId: data.customerId,
        jointCustomerId: data.jointCustomerId,
        purchaseType: data.purchaseType,
        phone: data.phone,
        idSighted: flag(data.idSighted),
        erpInvoiceNo: data.erpInvoiceNo,
        cashAmount: data.cashAmount,
        partAmount: data.partAmount,
    };
    if (data.purchaseType === "bullion") fields.bullionBand = data.bullionBand;
    else fields.cash10k = flag(data.cash10k);
    if (data.ttrSelfConducted != null) fields.ttrSelfConducted = flag(data.ttrSelfConducted);
    if (data.ttrDetailsConfirmed != null) fields.ttrDetailsConfirmed = flag(data.ttrDetailsConfirmed);
    if (Object.keys(data.linkedAmounts ?? {}).length > 0) fields.linkedAmounts = JSON.stringify(data.linkedAmounts);
    Object.entries(fields).forEach(([key, value]) => {
        if (value != null && value !== "") form.append(key, value);
    });
    data.photos.forEach((blob, index) => form.append("photos", blob, `photo-${index + 1}.jpg`));
    return callFunction("gold-save-purchase", { form });
}

/**
 * Add the ERP invoice number to a saved purchase. changes: { erpInvoiceNo, partAmount, linkedAmounts }.
 * Resolves { purchaseId, ttr: null | 'A' | 'B', warnings }.
 */
export async function updateTransaction(purchaseId, { erpInvoiceNo, partAmount, linkedAmounts }) {
    return callFunction("gold-complete-purchase", { json: { purchaseId, erpInvoiceNo, partAmount, linkedAmounts } });
}
