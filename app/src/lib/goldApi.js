// The gold journey's data layer: the handover's api.js names, implemented against Supabase (spec 4.6).
// Reads go through RPCs and RLS selects; every customer write goes through a gold-* edge function, except the
// phone change, which is an RPC. Errors are GoldApiError, whose message is safe to show to staff.
import { supabase } from "./supabase.js";
import { getIdImageSignedUrls } from "./wizardApi.js";

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
