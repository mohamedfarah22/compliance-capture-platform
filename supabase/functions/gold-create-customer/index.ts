// gold-create-customer: a new gold customer with their ID, photos and audit row in one
// transaction (spec 1.6, 4.5, 5.2). Handover api.js name: createCustomer.
//
// ACCESS  Any active staff member at aal2 (requireGoldStaff, called before anything else
//         except the CORS preflight, which carries no credentials). Refused while the
//         GOLD_JOURNEY_ENABLED secret is not "true".
//
// REQUEST  POST multipart/form-data
//   payload  JSON string:
//     {
//       firstName, middleName?, lastName,          names: first and last required, 100 characters at most
//       dateOfBirth,                               YYYY-MM-DD, 1900-01-01 up to today (Melbourne)
//       phone,                                     8 or more digits
//       email?, aliases?: string[],                blank aliases are dropped
//       residentialAddress: { street, suburb, state, postcode },  state VIC|NSW|QLD|WA|SA|TAS|ACT|NT,
//                                                                 postcode 4 digits; country is Australia
//       id: {
//         documentType,                            Driver licence | Passport | Proof of age card |
//                                                  National identity card | Medicare card |
//                                                  Other government document | Other
//         documentTypeOther?,                      required when documentType is Other
//         documentNumber,                          100 characters at most
//         issuer,                                  the state or authority, e.g. "VIC"
//         idCountryCode,                           2 letters, e.g. "AU"
//         hasExpiry,                               boolean
//         expiryDate?                              YYYY-MM-DD, required when hasExpiry is true
//       },
//       confirmNew?: boolean,                      "yes, this is a new customer" after possible_duplicates
//       differentPerson?: boolean                  "different person" after id_on_file
//     }
//   front    image file (JPEG, PNG or WebP, 10 MB at most): required
//   back     image file: required for a Driver licence (BACK_REQUIRED_TYPES), optional otherwise
//
// RESPONSE
//   201 { customerId, verificationId, frontImageId, backImageId }
//   400 invalid_request                    not multipart, or payload is not JSON
//   400 validation_failed { fields }       fields maps a field name to a message
//   401 unauthorized, 403 gold_disabled | mfa_required | forbidden     (goldAuth.ts)
//   405 method_not_allowed
//   409 id_on_file { owner }               the document number is already on file for someone.
//                                          Resend with differentPerson: true to save it as a
//                                          different person (new_capture_reason 'different_person').
//                                          The flag is ignored when no collision exists.
//   409 possible_duplicates { duplicates } same name + date of birth, or same phone (8+ digits).
//                                          Resend with confirmNew: true to create anyway.
//   500 lookup_failed | upload_failed | create_failed
//
// WRITES  One call to public.gold_create_customer (service role only): public.customers
//   (source 'gold'), customer_aliases, ttr.stored_images, a customer-level ttr.id_verifications
//   row (new_capture, no transaction/party/conducting person), and customer_audit_log. The staff
//   member and the business come from the verified JWT and the staff row, never the request.
//
// ORPHANS  Photos are uploaded first (they have to be hashed). If the database call fails the
//   objects are removed straight away. If that removal fails they have no stored_images row, so
//   reconcile-stored-images deletes them as orphans after its one-hour grace period.
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
  validateNewCustomer,
  validatePhotos,
  validationFailed,
} from "../_shared/goldCustomers.ts";
import type { Fields } from "../_shared/goldCustomers.ts";

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return preflight();

  const ctx = await requireGoldStaff(req);
  if (ctx instanceof Response) return ctx;
  const { staff, userClient, adminClient } = ctx;

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await readMultipart(req);
  if (!body) return json({ error: "invalid_request" }, 400);

  const fields: Fields = {};
  const input = validateNewCustomer(body.payload, fields);
  validatePhotos(fields, input.document.document_type, body.photos);
  if (Object.keys(fields).length > 0) return validationFailed(fields);

  // Document-number collision. Run under the caller's JWT: the lookup scopes itself to their business.
  const lookup = () =>
    userClient.rpc("get_verification_for_document", {
      p_document_type: input.document.document_type,
      p_document_number: input.document.document_number,
    });
  const { data: hits, error: hitError } = await lookup();
  if (hitError) {
    console.error("gold-create-customer: collision lookup failed", { staff: staff.id, code: hitError.code });
    return json({ error: "lookup_failed" }, 500);
  }
  const collision = (hits as Record<string, unknown>[] | null)?.[0] ?? null;
  if (collision && !input.differentPerson) return json({ error: "id_on_file", owner: ownerOf(collision) }, 409);

  if (!input.confirmNew) {
    const { data: dupes, error: dupeError } = await userClient.rpc("find_possible_duplicate_customers", {
      p_first_name: input.customer.first_name,
      p_last_name: input.customer.last_name,
      p_dob: input.customer.date_of_birth,
      p_phone: input.customer.phone,
    });
    if (dupeError) {
      console.error("gold-create-customer: duplicate lookup failed", { staff: staff.id, code: dupeError.code });
      return json({ error: "lookup_failed" }, 500);
    }
    if (dupes && dupes.length > 0) {
      return json(
        {
          error: "possible_duplicates",
          duplicates: (dupes as Record<string, unknown>[]).map((d) => ({
            customerId: d.customer_id,
            firstName: d.first_name,
            lastName: d.last_name,
            dateOfBirth: d.date_of_birth,
            phone: d.phone,
            matchReason: d.match_reason,
          })),
        },
        409,
      );
    }
  }

  const customerId = crypto.randomUUID();
  const verificationId = crypto.randomUUID();
  const photos = await storePhotos(adminClient, customerId, verificationId, body.photos);
  if (!photos) return json({ error: "upload_failed" }, 500);

  const { data, error } = await adminClient.rpc("gold_create_customer", {
    p_entity_id: staff.reporting_entity_id,
    p_staff_id: staff.id,
    p_customer_id: customerId,
    p_verification_id: verificationId,
    p_customer: input.customer,
    p_aliases: input.aliases,
    p_id: input.document,
    p_images: photos,
    p_different_person: collision !== null && input.differentPerson,
  });

  if (error || !data) {
    console.error("gold-create-customer: save failed", { staff: staff.id, customerId, code: error?.code });
    await removePhotos(adminClient, photos);
    // Someone saved the same document between the lookup and the insert.
    if (error?.code === "23505" && /uq_idv_doc_new_capture/.test(error.message ?? "")) {
      const { data: again } = await lookup();
      return json({ error: "id_on_file", owner: ownerOf((again as Record<string, unknown>[] | null)?.[0]) }, 409);
    }
    return json({ error: "create_failed" }, 500);
  }

  return json(
    {
      customerId: data.customer_id,
      verificationId: data.verification_id,
      frontImageId: data.front_image_id,
      backImageId: data.back_image_id,
    },
    201,
  );
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}
