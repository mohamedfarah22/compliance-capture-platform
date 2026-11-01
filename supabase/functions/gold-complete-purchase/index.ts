// gold-complete-purchase: adds the ERP invoice number to a saved purchase.
// Handover api.js: updateTransaction. Spec 4.3, 3.3, 3.5, C2.
//
// WHO: any active staff member (requireGoldStaff, the first thing this function does).
//
// REQUEST: POST application/json, Authorization: Bearer <aal2 JWT>.
//   { purchaseId, erpInvoiceNo, partAmount?, linkedAmounts? }
//   purchaseId     uuid, required.
//   erpInvoiceNo   text, required.
//   partAmount     text. Cash paid for THIS part, needed only when the purchase links to earlier parts through
//                  this invoice and has no amount saved. Enter 0 if none was cash.
//   linkedAmounts  { "<partId>": "<amount>" } for each earlier linked part that has no amount saved yet.
// The rules (what is reportable, the TTR case, linked parts, the ID flags saved with the purchase) are all
// worked out again from the saved purchase and data the server loads; nothing else is read from the client.
//
// RESPONSE
//   200 { purchaseId, ttr: null | "A" | "B", warnings: { duplicateInvoice? } }
//   422 { error: "validation_failed", errors: { field: message }, warnings, blocked: boolean }
//       Nothing was written. errors: erp_invoice_no (missing; a reportable purchase whose invoice is used by
//       another purchase that is not a same-day linked part; a linked part of this type whose TTR is already
//       completed: "use a new ERP invoice number"), partAmount, linked_<partId>, cashAmount.
//       blocked is true when the sale is reportable and an ID had expired or was outside the re-verification
//       window when the purchase was saved (C2).
//   400 { error: "bad_request", field }
//   404 { error: "purchase_not_found" }          not a purchase of the caller's entity
//   409 { error: "already_has_invoice" }          the invoice number is set once and never changed
//   409 { error: "linked_part_changed" }          an earlier part's amount changed meanwhile: reload, retry
//   500 { error: "save_failed" | "server_error" }
//   + requireGoldStaff refusals: 403 gold_disabled | mfa_required | forbidden, 401 unauthorized.
//
// WRITE. gold.complete_purchase sets erp_invoice_no and completed_at / completed_by_staff_id in ONE update (the
// immutability trigger requires it), plus any amount fills, in one transaction, and the audit trigger records it.
//
// LOGS: IDs and error codes only (6.1).

import { requireGoldStaff } from "../_shared/goldAuth.ts";
import type { GoldContext } from "../_shared/goldAuth.ts";
import { parseAud, validateCompletion } from "../_shared/goldRules.js";
import {
  codeOf,
  CORS_HEADERS,
  json,
  linkedFills,
  loadCustomers,
  loadInvoiceContext,
  loadReadiness,
  UUID_RE,
} from "../_shared/goldPurchaseShared.ts";
import type { Row } from "../_shared/goldPurchaseShared.ts";

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
    return await completePurchase(ctx, req);
  } catch (e) {
    console.error("gold-complete-purchase failed:", codeOf(e));
    return json({ error: "server_error" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}

const bad = (field: string) => json({ error: "bad_request", field }, 400);

async function completePurchase(ctx: GoldContext, req: Request): Promise<Response> {
  let body: Row;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request", field: "body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_request", field: "body" }, 400);

  const purchaseId = body.purchaseId;
  if (typeof purchaseId !== "string" || !UUID_RE.test(purchaseId)) return bad("purchaseId");
  if (body.erpInvoiceNo != null && typeof body.erpInvoiceNo !== "string") return bad("erpInvoiceNo");
  const linkedAmounts = body.linkedAmounts ?? {};
  if (typeof linkedAmounts !== "object" || Array.isArray(linkedAmounts)) return bad("linkedAmounts");
  const invoice = String(body.erpInvoiceNo ?? "").trim();

  // The purchase, as the caller: RLS hides another entity's purchase, which looks like one that does not exist.
  const { data, error } = await ctx.userClient
    .schema("gold")
    .from("purchases")
    .select(
      "id, customer_id, joint_customer_id, purchase_type, cash_band, cash_amount, sale_date, erp_invoice_no, " +
        "id_expired_at_time, id_outside_window_at_time, ttr_self_conducted, ttr_details_confirmed",
    )
    .eq("id", purchaseId)
    .maybeSingle();
  if (error) {
    console.error("gold-complete-purchase: purchase lookup failed:", String((error as Row).code ?? "unknown"));
    return json({ error: "server_error" }, 500);
  }
  const purchase = data as Row | null;
  if (!purchase) return json({ error: "purchase_not_found" }, 404);
  if (purchase.erp_invoice_no != null) return json({ error: "already_has_invoice" }, 409);

  const sellerIds = [purchase.customer_id, purchase.joint_customer_id].filter(Boolean) as string[];
  const mainCustomer = (await loadCustomers(ctx, [purchase.customer_id])).get(purchase.customer_id);
  // Unknown readiness counts as not ready (case B), the safe side.
  const readiness = await loadReadiness(ctx, purchase.customer_id);
  const { linked, sameInvoice } = await loadInvoiceContext(ctx, {
    sellerIds,
    invoice,
    saleDate: purchase.sale_date,
    excludeId: purchase.id,
  });

  // The saved answers stand in for the draft's cash questions. An amount already saved is the part amount.
  const savedAmount = purchase.cash_amount;
  const draft = {
    type: purchase.purchase_type,
    cash10k: purchase.cash_band === "10k_plus",
    bullionBand: purchase.cash_band,
    cashAmount: savedAmount == null ? "" : String(savedAmount),
    partAmount: savedAmount == null ? body.partAmount : String(savedAmount),
    linkedAmounts,
    erp_invoice_no: invoice,
  };
  const result = validateCompletion(draft, purchase, { mainCustomer, readiness, linked, sameInvoice });

  if (Object.keys(result.errors).length > 0 || result.blocked) {
    return json({ error: "validation_failed", errors: result.errors, warnings: result.warnings, blocked: result.blocked }, 422);
  }

  const { error: completeError } = await ctx.adminClient.schema("gold").rpc("complete_purchase", {
    p_entity: ctx.staff.reporting_entity_id,
    p_staff: ctx.staff.id,
    p_purchase_id: purchase.id,
    p_invoice: invoice,
    p_part_amount: savedAmount == null && linked.length > 0 ? parseAud(body.partAmount) : null,
    p_fills: linkedFills(linked, linkedAmounts),
  });
  if (completeError) {
    const code = String((completeError as Row).code ?? "unknown");
    console.error("gold-complete-purchase: complete failed:", purchase.id, code);
    if (code === "23001") return json({ error: "already_has_invoice" }, 409);
    if (code === "40001") return json({ error: "linked_part_changed" }, 409);
    if (code === "P0002") return json({ error: "purchase_not_found" }, 404);
    return json({ error: "save_failed" }, 500);
  }

  return json({ purchaseId: purchase.id, ttr: result.ttr.case, warnings: result.warnings }, 200);
}
