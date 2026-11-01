// gold-save-purchase: records a scrap or bullion purchase with its goods photos.
// Handover api.js: createTransaction. Spec 4.3, 4.5, 3.3, 3.3a, 3.4, 3.5, C2, C3.
//
// WHO: any active staff member (requireGoldStaff, the first thing this function does).
//
// REQUEST: POST multipart/form-data, Authorization: Bearer <aal2 JWT>.
//   customerId         uuid, required. The main seller.
//   jointCustomerId    uuid, optional. A joint seller (never the same person as the main seller).
//   purchaseType       "scrap" | "bullion", required.
//   cash10k            "true" | "false". Scrap: "paid in cash of $10,000 or more?". Required for scrap.
//   bullionBand        "under_5k" | "5k_to_10k" | "10k_plus". Required for bullion.
//   cashAmount         text, optional. The cash amount, when the answer is $10,000 or more.
//   partAmount         text. Cash paid for THIS part. Required when an earlier part is linked (same
//                      invoice, same day, same seller); enter 0 if none was cash.
//   linkedAmounts      JSON object { "<partId>": "<amount>" }. The cash paid on each earlier linked part that
//                      has no amount saved yet ("cash paid on that part").
//   phone              text, required, 8+ digits. Phone given at this purchase.
//   idSighted          "true", required (C3). Anything else is refused.
//   erpInvoiceNo       text, optional, unless the TTR case needs it now (case B).
//   ttrSelfConducted, ttrDetailsConfirmed
//                      "true" | "false". The two counter answers (3.3a). Required exactly when the sale is
//                      reportable, has one seller and the customer has every TTR field on file; otherwise
//                      ignored and stored as null.
//   photos             one or more JPEG files (repeat the field), required. At most MAX_PHOTOS, each at most
//                      MAX_PHOTO_BYTES. The client compresses to 1600 px; the server checks type and size only.
// Everything else a client might send (cash band, reportable flag, totals, dates, ID flags, ID used, who) is
// ignored: the server works all of it out again from data it loads itself (4.3).
//
// RESPONSE
//   201 { purchaseId, ttr: null | "A" | "B", warnings: { duplicateInvoice? } }
//       ttr is the hand-off case (3.3). The TTR itself is started later (gold-start-ttr).
//   422 { error: "validation_failed", errors: { field: message }, warnings, blocked: [{ customerId, role, status }] }
//       Nothing was written. errors is the rules module's field errors (photos, idSighted, phone, partAmount,
//       linked_<partId>, cashAmount, joint, erp_invoice_no) plus ttrSelfConducted / ttrDetailsConfirmed.
//       blocked lists sellers whose ID is expired or outside the re-verification window when a current ID is
//       needed (C2); status is "expired" | "reverify". The customer is at the counter: Update ID now.
//   422 { error: "no_id_on_file", role }                a seller has no ID on file
//   400 { error: "bad_request", field }                  malformed request
//   413 { error: "photo_too_large" } · 415 { error: "photo_not_jpeg" }
//   404 { error: "customer_not_found" }                  not an individual of the caller's entity
//   409 { error: "linked_part_changed" }                 an earlier part's amount changed meanwhile: reload, retry
//   500 { error: "storage_failed" | "save_failed" | "server_error" }
//   + requireGoldStaff refusals: 403 gold_disabled | mfa_required | forbidden, 401 unauthorized.
//
// ATOMICITY. The photo objects are uploaded first, then gold.save_purchase writes the purchase, the goods_photos
// rows and the cash fills on earlier parts in ONE transaction. If any upload fails, or the transaction fails,
// the objects already uploaded are removed straight away. If that removal itself fails the objects are left
// behind, and reconcile-stored-images reports them as orphaned gold-goods objects and sweeps them (after a
// one hour grace). Nothing in the database is ever left half written.
//
// LOGS: IDs and error codes only (6.1).

import { requireGoldStaff } from "../_shared/goldAuth.ts";
import type { GoldContext } from "../_shared/goldAuth.ts";
import { businessDate, evaluateCash, validatePurchase } from "../_shared/goldRules.js";
import {
  codeOf,
  GOLD_GOODS_BUCKET,
  json,
  CORS_HEADERS,
  linkedFills,
  loadCurrentId,
  loadCustomers,
  loadInvoiceContext,
  loadReadiness,
  loadRelianceDays,
  parseBool,
  UUID_RE,
} from "../_shared/goldPurchaseShared.ts";
import type { Row } from "../_shared/goldPurchaseShared.ts";

export const MAX_PHOTOS = 10;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const BULLION_BANDS = ["under_5k", "5k_to_10k", "10k_plus"];

export interface Deps {
  authenticate: (req: Request) => Promise<GoldContext | Response>;
  newId: () => string;
  now: () => Date;
}

const DEFAULT_DEPS: Deps = {
  authenticate: (req) => requireGoldStaff(req),
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
};

export async function handleRequest(req: Request, deps: Deps = DEFAULT_DEPS): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const ctx = await deps.authenticate(req);
  if (ctx instanceof Response) return ctx;

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    return await savePurchase(ctx, req, deps);
  } catch (e) {
    console.error("gold-save-purchase failed:", codeOf(e));
    return json({ error: "server_error" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}

const bad = (field: string) => json({ error: "bad_request", field }, 400);
const text = (form: FormData, key: string): string => {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
};

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function savePurchase(ctx: GoldContext, req: Request, deps: Deps): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "bad_request", field: "body" }, 400);
  }

  // ── The request, parsed. Malformed values are a client bug (400); rule failures are 422 below.
  const customerId = text(form, "customerId");
  const jointCustomerId = text(form, "jointCustomerId");
  if (!UUID_RE.test(customerId)) return bad("customerId");
  if (jointCustomerId && !UUID_RE.test(jointCustomerId)) return bad("jointCustomerId");

  const type = text(form, "purchaseType");
  if (type !== "scrap" && type !== "bullion") return bad("purchaseType");
  const cash10k = parseBool(form.get("cash10k"));
  if (type === "scrap" && cash10k === undefined) return bad("cash10k");
  const bullionBand = text(form, "bullionBand");
  if (type === "bullion" && !BULLION_BANDS.includes(bullionBand)) return bad("bullionBand");

  let linkedAmounts: Row = {};
  const linkedAmountsText = text(form, "linkedAmounts");
  if (linkedAmountsText) {
    try {
      linkedAmounts = JSON.parse(linkedAmountsText);
    } catch {
      return bad("linkedAmounts");
    }
    if (!linkedAmounts || typeof linkedAmounts !== "object" || Array.isArray(linkedAmounts)) return bad("linkedAmounts");
  }

  const files = form.getAll("photos").filter((v): v is File => typeof v !== "string" && v.size > 0);
  if (files.length > MAX_PHOTOS) return bad("photos");
  const photoBytes: ArrayBuffer[] = [];
  for (const file of files) {
    if (file.size > MAX_PHOTO_BYTES) return json({ error: "photo_too_large" }, 413);
    const bytes = await file.arrayBuffer();
    if (file.type !== "image/jpeg" || !isJpeg(new Uint8Array(bytes))) return json({ error: "photo_not_jpeg" }, 415);
    photoBytes.push(bytes);
  }

  const draft = {
    type,
    cash10k: cash10k === true,
    bullionBand,
    cashAmount: text(form, "cashAmount"),
    partAmount: text(form, "partAmount"),
    linkedAmounts,
    photos: files,
    idSighted: parseBool(form.get("idSighted")) === true,
    phone: text(form, "phone"),
    erp_invoice_no: text(form, "erpInvoiceNo"),
  };

  // ── Load everything the rules need, as the caller, under RLS.
  const sellerIds = jointCustomerId ? [customerId, jointCustomerId] : [customerId];
  const customers = await loadCustomers(ctx, [...new Set(sellerIds)]);
  if (sellerIds.some((id) => !customers.has(id))) return json({ error: "customer_not_found" }, 404);

  const sellers: { role: "main" | "joint"; customer: Row }[] = [{ role: "main", customer: customers.get(customerId)! }];
  if (jointCustomerId) sellers.push({ role: "joint", customer: customers.get(jointCustomerId)! });

  const currentIds = new Map<string, Row>();
  for (const { role, customer } of sellers) {
    const current = await loadCurrentId(ctx, customer.id);
    if (!current) return json({ error: "no_id_on_file", role }, 422);
    currentIds.set(role, current);
  }
  const withId = (role: string, customer: Row) => {
    const c = currentIds.get(role)!;
    return { ...customer, current_id: { expiry_date: c.expiry_date, captured_at: c.captured_at } };
  };
  const mainCustomer = withId("main", sellers[0].customer);
  const jointCustomer = sellers[1] ? withId("joint", sellers[1].customer) : undefined;

  const readiness = await loadReadiness(ctx, customerId);
  if (readiness === null) return json({ error: "customer_not_found" }, 404);
  const idvMaxRelianceDays = await loadRelianceDays(ctx);

  const now = deps.now();
  const saleDate = businessDate(now);
  const invoice = draft.erp_invoice_no;
  const { linked, sameInvoice } = await loadInvoiceContext(ctx, { sellerIds, invoice, saleDate });

  // ── The rules, on server-loaded data. The counter answers (3.3a) only count when the form asks them.
  const cash = evaluateCash(draft, linked);
  const asked = cash.reportable && !jointCustomer && readiness.length === 0;
  const selfConducted = parseBool(form.get("ttrSelfConducted"));
  const detailsConfirmed = parseBool(form.get("ttrDetailsConfirmed"));
  const result = validatePurchase(draft, {
    mainCustomer,
    jointCustomer,
    linked,
    sameInvoice,
    readiness,
    answers: asked ? { selfConducted, detailsConfirmed } : undefined,
    idvMaxRelianceDays,
    now,
  });

  const errors: Record<string, string> = { ...result.errors };
  if (!draft.phone.replace(/\D/g, "")) errors.phone = "Enter the customer's phone number (8 or more digits).";
  if (asked && selfConducted === undefined) errors.ttrSelfConducted = "Answer whether the customer is acting on their own behalf.";
  if (asked && detailsConfirmed === undefined) errors.ttrDetailsConfirmed = "Answer whether the customer's details are still correct.";

  if (Object.keys(errors).length > 0 || result.blocked.length > 0) {
    return json(
      {
        error: "validation_failed",
        errors,
        warnings: result.warnings,
        blocked: result.blocked.map((b: Row) => ({ customerId: b.customer.id, role: b.role, status: b.status })),
      },
      422,
    );
  }

  // ── The row, worked out on the server.
  const purchaseId = deps.newId();
  const purchase = {
    id: purchaseId,
    customer_id: customerId,
    joint_customer_id: jointCustomerId || null,
    main_id_verification_id: currentIds.get("main")!.verification_id,
    joint_id_verification_id: jointCustomerId ? currentIds.get("joint")!.verification_id : null,
    purchase_type: type,
    cash_band: cash.band,
    cash_10k_or_more: cash.reportable,
    cash_amount: cash.amount,
    invoice_cash_total: cash.total,
    erp_invoice_no: invoice || null,
    sale_date: saleDate,
    phone: draft.phone,
    id_sighted: true,
    id_expired_at_time: result.expired.length > 0,
    id_outside_window_at_time: result.reverify.length > 0,
    ttr_self_conducted: asked ? selfConducted : null,
    ttr_details_confirmed: asked ? detailsConfirmed : null,
  };

  // ── Photos first, then one transaction for every row.
  const uploaded: string[] = [];
  const removeUploaded = async () => {
    if (uploaded.length === 0) return;
    const { error } = await ctx.adminClient.storage.from(GOLD_GOODS_BUCKET).remove(uploaded);
    if (error) console.error("gold-save-purchase: orphan removal failed:", purchaseId);
  };
  const photos: Row[] = [];
  for (const [i, bytes] of photoBytes.entries()) {
    const objectPath = `${purchaseId}/goods-${i + 1}.jpg`;
    const { error } = await ctx.adminClient.storage
      .from(GOLD_GOODS_BUCKET)
      .upload(objectPath, bytes, { contentType: "image/jpeg", upsert: false });
    if (error) {
      console.error("gold-save-purchase: upload failed:", purchaseId, String((error as Row).statusCode ?? "unknown"));
      await removeUploaded();
      return json({ error: "storage_failed" }, 500);
    }
    uploaded.push(objectPath);
    photos.push({
      object_path: objectPath,
      content_hash_sha256: toHex(await crypto.subtle.digest("SHA-256", bytes)),
      byte_size: bytes.byteLength,
    });
  }

  const { error: saveError } = await ctx.adminClient.schema("gold").rpc("save_purchase", {
    p_entity: ctx.staff.reporting_entity_id,
    p_staff: ctx.staff.id,
    p_purchase: purchase,
    p_photos: photos,
    p_fills: linkedFills(linked, linkedAmounts),
  });
  if (saveError) {
    const code = String((saveError as Row).code ?? "unknown");
    console.error("gold-save-purchase: save failed:", purchaseId, code);
    await removeUploaded();
    return code === "40001" ? json({ error: "linked_part_changed" }, 409) : json({ error: "save_failed" }, 500);
  }

  return json({ purchaseId, ttr: result.ttr.case, warnings: result.warnings }, 201);
}
