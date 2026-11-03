// gold-update-customer: a manager corrects a customer's profile fields (spec 4.5, 5.2 "Edit
// rows"). Handover api.js name: updateCustomerDetails.
//
// ACCESS  minRole "manager": managers and admins. A staff member gets 403 forbidden.
//         Otherwise as every gold function: requireGoldStaff first, aal2, GOLD_JOURNEY_ENABLED.
//
// REQUEST  POST application/json
//   {
//     customerId,
//     changes: {                       only the fields to change, at least one
//       firstName, middleName, lastName,     first and last cannot be blank
//       dateOfBirth,                         YYYY-MM-DD, 1900-01-01 up to today (Melbourne)
//       gender,                              "M" | "F" | "U"; "" clears it
//       phone,                               8 or more digits
//       email, occupation,                   "" clears them
//       residentialAddress: { street, suburb, state, postcode },   replaces the whole address
//       citizenshipCountryCode, taxResidencyCountryCode            2 letters; "" clears them
//     }
//   }
//   Any other key in `changes` (ID details, source, business) is refused as validation_failed.
//   ID details change only through gold-update-customer-id.
//
// RESPONSE
//   200 { customerId, changed: string[] }   changed lists the columns whose value really changed
//                                           (first_name, res_street, ...). Values sent equal to
//                                           the current ones change nothing and write no audit row.
//   400 invalid_request | validation_failed { fields }
//   401 unauthorized, 403 gold_disabled | mfa_required | forbidden     (goldAuth.ts)
//   404 customer_not_found                  also for another business's customer, or a company
//   405 method_not_allowed
//   500 update_failed
//
// WRITES  One call to public.gold_update_customer (service role only). The customers UPDATE trigger
//   writes one customer_audit_log row (source 'gold_edit', changed_by = this staff member) holding
//   old -> new for every changed column. ttr.parties copies are never touched: a TTR keeps the
//   details as reported.
//
// LOGS     IDs and error codes only.

import { requireGoldStaff } from "../_shared/goldAuth.ts";
import { json, preflight, UUID_RE, validateChanges, validationFailed } from "../_shared/goldCustomers.ts";
import type { Fields } from "../_shared/goldCustomers.ts";

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return preflight();

  const ctx = await requireGoldStaff(req, { minRole: "manager" });
  if (ctx instanceof Response) return ctx;
  const { staff, adminClient } = ctx;

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
    if (typeof body !== "object" || body === null) throw new Error("not an object");
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const fields: Fields = {};
  const customerId = typeof body.customerId === "string" ? body.customerId : "";
  if (!UUID_RE.test(customerId)) fields.customerId = "Choose the customer.";
  const changes = validateChanges(body.changes, fields);
  if (Object.keys(fields).length > 0) return validationFailed(fields);

  const { data, error } = await adminClient.rpc("gold_update_customer", {
    p_entity_id: staff.reporting_entity_id,
    p_staff_id: staff.id,
    p_customer_id: customerId,
    p_changes: changes,
  });

  if (error) {
    if (error.message === "customer_not_found") return json({ error: "customer_not_found" }, 404);
    console.error("gold-update-customer: update failed", { staff: staff.id, customerId, code: error.code });
    return json({ error: "update_failed" }, 500);
  }

  return json({ customerId, changed: data.changed }, 200);
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}
