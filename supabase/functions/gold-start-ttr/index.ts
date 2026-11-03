// gold-start-ttr: starts the TTR draft(s) for a gold purchase that has an ERP invoice number.
// Handover api.js: goToAustracForm (the browser then calls openTransaction(id) from wizardApi.js). Spec 3.2 - 3.4.
//
// WHO: any active staff member (requireGoldStaff, the first thing this function does).
//
// REQUEST: POST application/json, Authorization: Bearer <aal2 JWT>.   { purchaseId }
// Everything else (is the sale reportable, which types have cash and how much, the sellers, their IDs, the
// case A / B decision, the staff snapshot) is worked out again on the server from saved data.
//
// RESPONSE
//   200 { ttrs: [{ id, type: "scrap"|"bullion", scenario, status: "draft"|"complete", created: boolean,
//                  case: "A"|"B"|null }] }
//       One entry per type with cash above $0 on the invoice (spec 3.4), this purchase's type first. created is
//       false when the type already had a TTR (idempotent); case is null then. A draft's cash is refreshed.
//   400 { error: "bad_request", field }
//   404 { error: "purchase_not_found" }          not a purchase of the caller's business
//   409 { error: "ttr_reference_in_use" }        another TTR already has this reference and scenario
//   422 { error: "invoice_required" }            the purchase has no ERP invoice number
//   422 { error: "not_reportable" }              cash across the invoice's same-day parts is under $10,000
//   422 { error: "no_cash" }                     no part was paid in cash, so there is no TTR
//   500 { error: "start_failed" | "server_error" }
//   + requireGoldStaff refusals: 403 gold_disabled | mfa_required | forbidden, 401 unauthorized.
//
// WRITE: gold.start_ttr, one SECURITY DEFINER transaction (service role only): the ttr.transactions draft(s),
// ttr.parties for the main and joint seller, reliance rows in ttr.id_verifications (no photos, the C3 counter
// confirmation copied), and ttr_transaction_id on the purchase and its same-type linked parts.
//
// LOGS: IDs and error codes only (6.1).

import { requireGoldStaff } from "../_shared/goldAuth.ts";
import type { GoldContext } from "../_shared/goldAuth.ts";
import { codeOf, CORS_HEADERS, json, UUID_RE } from "../_shared/goldPurchaseShared.ts";
import type { Row } from "../_shared/goldPurchaseShared.ts";
import { LOCATION_SNAPSHOT } from "../_shared/goldRules.js";
import { TTR_DESIGNATED_SERVICES } from "../_shared/ttrDefaults.js";

export interface Deps {
  authenticate: (req: Request) => Promise<GoldContext | Response>;
}

const DEFAULT_DEPS: Deps = { authenticate: (req) => requireGoldStaff(req) };

export async function handleRequest(req: Request, deps: Deps = DEFAULT_DEPS): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const ctx = await deps.authenticate(req);
  if (ctx instanceof Response) return ctx;

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    return await startTtr(ctx, req);
  } catch (e) {
    console.error("gold-start-ttr failed:", codeOf(e));
    return json({ error: "server_error" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}

async function startTtr(ctx: GoldContext, req: Request): Promise<Response> {
  let body: Row;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request", field: "body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_request", field: "body" }, 400);
  const purchaseId = body.purchaseId;
  if (typeof purchaseId !== "string" || !UUID_RE.test(purchaseId)) return json({ error: "bad_request", field: "purchaseId" }, 400);

  // gold.start_ttr looks the purchase up by id AND business, so another business's purchase is "not found".
  const { data, error } = await ctx.adminClient.schema("gold").rpc("start_ttr", {
    p_entity: ctx.staff.reporting_entity_id,
    p_staff: ctx.staff.id,
    p_purchase_id: purchaseId,
    p_location: LOCATION_SNAPSHOT,
    p_services: TTR_DESIGNATED_SERVICES,
  });
  if (error) {
    const code = String((error as Row).code ?? "unknown");
    console.error("gold-start-ttr: start failed:", purchaseId, code);
    if (code === "P0002") return json({ error: "purchase_not_found" }, 404);
    if (code === "23505") return json({ error: "ttr_reference_in_use" }, 409);
    if (code === "GD003") return json({ error: "invoice_required" }, 422);
    if (code === "GD004") return json({ error: "not_reportable" }, 422);
    if (code === "GD005") return json({ error: "no_cash" }, 422);
    return json({ error: "start_failed" }, 500);
  }

  return json({ ttrs: data }, 200);
}
