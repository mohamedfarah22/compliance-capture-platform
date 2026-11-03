// gold-update-customer-id: record a new ID for an existing customer (spec 1.6 "Gold Update ID",
// 5.2). Handover api.js name: updateCustomerId.
//
// ACCESS  Any active staff member at aal2 (requireGoldStaff first). Refused while the
//         GOLD_JOURNEY_ENABLED secret is not "true".
//
// REQUEST  POST multipart/form-data
//   payload  JSON string:
//     {
//       customerId,
//       reason,            "renewed" | "different_document" | "photo_unclear"
//       documentType, documentTypeOther?, documentNumber, issuer, idCountryCode, hasExpiry,
//       expiryDate?        the same document fields and rules as gold-create-customer's `id`,
//                          but at the top level of the payload
//     }
//   front    image file, required      back   required for a Driver licence, optional otherwise
//
// WHAT EACH REASON SAVES (a new customer-level new_capture row; the old rows are never changed)
//   renewed             new_capture_reason 'id_changed'. Linked (prior_verification_id) to the
//                       customer's capture of the same document when the number is the same;
//                       otherwise unlinked (a new document number is a new document).
//   photo_unclear       'stored_copy_unclear'. Always linked, so the customer must already have
//                       this document on file (409 document_not_on_file if not).
//   different_document  'different_document'. Unlinked; the number must be new (409 id_on_file if
//                       it is already on file, for this customer or anyone).
//   When the new capture is linked, the older photos of the SAME document are superseded: the
//   objects are deleted and the stored_images rows kept, stamped superseded_at /
//   superseded_by_image_id (_shared/supersede.ts). Unlinked captures leave every earlier photo.
//
// RESPONSE
//   201 { customerId, verificationId, frontImageId, backImageId, superseded: number }
//       superseded counts the old photos removed. If removing some failed they stay and
//       reconcile-stored-images supersedes them later (the save itself still succeeded).
//   400 invalid_request | validation_failed { fields }
//   401 unauthorized, 403 gold_disabled | mfa_required | forbidden     (goldAuth.ts)
//   404 customer_not_found                  also for another business's customer
//   405 method_not_allowed
//   409 id_on_file { owner }                the document number belongs to another capture that
//                                           this save may not link to
//   409 document_not_on_file                reason photo_unclear but no such document on file
//   500 lookup_failed | upload_failed | update_failed
//
// WRITES  One call to public.gold_update_customer_id (service role only): ttr.stored_images and the
//   ttr.id_verifications row in one transaction. Superseding the old photos follows it and is
//   deliberately not part of it: deleting storage objects cannot be rolled back.
//   The customer_audit_log is not written: no customer column changes. The capture row, its
//   photos' captured_by_staff_id and the supersede stamps are the record.
//
// ORPHANS  As in gold-create-customer: new photos are removed if the database call fails, and
//   reconcile-stored-images sweeps any that could not be.
//
// LOGS     IDs and error codes only.

import { requireGoldStaff } from "../_shared/goldAuth.ts";
import {
  json,
  ownerOf,
  preflight,
  readMultipart,
  removePhotos,
  storePhotos,
  UUID_RE,
  validateDocument,
  validatePhotos,
  validationFailed,
} from "../_shared/goldCustomers.ts";
import type { Fields } from "../_shared/goldCustomers.ts";
import { supersedeImages } from "../_shared/supersede.ts";
import type { StorageOwner, SupabaseSchema } from "../_shared/supersede.ts";

const REASONS: Record<string, string> = {
  renewed: "id_changed",
  photo_unclear: "stored_copy_unclear",
  different_document: "different_document",
};

type Plan =
  | { kind: "save"; reason: string; priorId: string | null }
  | { kind: "id_on_file" }
  | { kind: "document_not_on_file" };

/**
 * What to do given the document-number lookup (get_verification_for_document: the unlinked
 * capture of this document in the business, or null).
 */
export function plan(apiReason: string, match: Record<string, unknown> | null, customerId: string): Plan {
  const reason = REASONS[apiReason];
  if (!match) return reason === "stored_copy_unclear" ? { kind: "document_not_on_file" } : { kind: "save", reason, priorId: null };
  const mine = match.customer_id === customerId;
  if (!mine || reason === "different_document") return { kind: "id_on_file" };
  return { kind: "save", reason, priorId: match.id as string };
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return preflight();

  const ctx = await requireGoldStaff(req);
  if (ctx instanceof Response) return ctx;
  const { staff, userClient, adminClient } = ctx;

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await readMultipart(req);
  if (!body) return json({ error: "invalid_request" }, 400);

  const p = (typeof body.payload === "object" && body.payload !== null ? body.payload : {}) as Record<string, unknown>;
  const fields: Fields = {};
  const customerId = typeof p.customerId === "string" ? p.customerId : "";
  if (!UUID_RE.test(customerId)) fields.customerId = "Choose the customer.";
  const apiReason = typeof p.reason === "string" ? p.reason : "";
  if (!Object.hasOwn(REASONS, apiReason)) fields.reason = "Say why the ID is being updated.";
  const document = validateDocument(fields, p, "");
  validatePhotos(fields, document.document_type, body.photos);
  if (Object.keys(fields).length > 0) return validationFailed(fields);

  const { data: customer, error: customerError } = await adminClient
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .eq("reporting_entity_id", staff.reporting_entity_id)
    .eq("customer_type", "individual")
    .maybeSingle();
  if (customerError) {
    console.error("gold-update-customer-id: customer lookup failed", { staff: staff.id, code: customerError.code });
    return json({ error: "lookup_failed" }, 500);
  }
  if (!customer) return json({ error: "customer_not_found" }, 404);

  const { data: hits, error: hitError } = await userClient.rpc("get_verification_for_document", {
    p_document_type: document.document_type,
    p_document_number: document.document_number,
  });
  if (hitError) {
    console.error("gold-update-customer-id: collision lookup failed", { staff: staff.id, code: hitError.code });
    return json({ error: "lookup_failed" }, 500);
  }
  const match = (hits as Record<string, unknown>[] | null)?.[0] ?? null;
  const decision = plan(apiReason, match, customerId);
  if (decision.kind === "id_on_file") return json({ error: "id_on_file", owner: ownerOf(match) }, 409);
  if (decision.kind === "document_not_on_file") return json({ error: "document_not_on_file" }, 409);

  const verificationId = crypto.randomUUID();
  const photos = await storePhotos(adminClient, customerId, verificationId, body.photos);
  if (!photos) return json({ error: "upload_failed" }, 500);

  const { data, error } = await adminClient.rpc("gold_update_customer_id", {
    p_entity_id: staff.reporting_entity_id,
    p_staff_id: staff.id,
    p_customer_id: customerId,
    p_verification_id: verificationId,
    p_reason: decision.reason,
    p_prior_verification_id: decision.priorId,
    p_id: document,
    p_images: photos,
  });

  if (error || !data) {
    console.error("gold-update-customer-id: save failed", { staff: staff.id, customerId, code: error?.code });
    await removePhotos(adminClient, photos);
    if (error?.code === "23505" && /uq_idv_doc_new_capture/.test(error.message ?? "")) {
      return json({ error: "id_on_file", owner: null }, 409);
    }
    return json({ error: "update_failed" }, 500);
  }

  // The new capture is committed. Now delete the replaced photos' objects and stamp their
  // rows. supersedeImages never throws; anything it could not do is retried by reconcile-stored-images.
  const stale = (data.stale_image_ids ?? []) as string[];
  const result = await supersedeImages(
    adminClient as unknown as StorageOwner,
    adminClient.schema("ttr") as unknown as SupabaseSchema,
    stale,
    data.front_image_id,
  );

  return json(
    {
      customerId,
      verificationId: data.verification_id,
      frontImageId: data.front_image_id,
      backImageId: data.back_image_id,
      superseded: result.superseded.length,
    },
    201,
  );
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}
