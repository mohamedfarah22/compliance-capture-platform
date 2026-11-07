// gold-export: the gate for downloading and printing purchase records. Spec 6.2, 2.3, 4.2, 6.1.
// Handover api.js: recordDownload (the browser wrapper in app/src/lib/goldApi.js).
//
// WHO: managers and admins only (requireGoldStaff with minRole "manager", the first thing this function does).
// A staff member is refused with 403 forbidden before anything is read, written or signed.
//
// REQUEST: POST application/json, Authorization: Bearer <aal2 JWT>.
//   { kind: "zip",    filters, purchaseIds }    1 to 200 purchase ids
//   { kind: "record", filters, purchaseIds }    exactly 1 purchase id
// filters is an object (or null). Only the keys q, type, status, cash, from, to and recordedBy are kept, as
// strings, for the audit row. They do not choose the purchases: purchaseIds does. Everything else in the body
// (a staff id, a business id) is ignored: the server takes both from the verified JWT and the staff row.
//
// RESPONSE
//   200 { ok: true }                                         kind "record": the print is audited, nothing is signed
//   200 { purchases: [{ id, row, photos }] }                 kind "zip", in the order of purchaseIds
//         row     the CSV fields as raw values (ISO times, purchase_type, cash_band, booleans, amounts); the
//                 browser formats them. Includes ttr_status, ttr_reference, id_document_used, id_photo_copy_taken.
//         photos  [{ name, url }]: main-seller-id-front, main-seller-id-back, joint-seller-id-front,
//                 joint-seller-id-back, goods-1 ... . url is a signed URL that expires after
//                 SIGNED_URL_TTL_SECONDS. An ID photo is the current copy where the capture's photos were
//                 replaced (spec 1.7 C1); id_photo_copy_taken says which copy it is.
//   400 { error: "bad_request", field }                      kind, purchaseIds, filters or the body is wrong
//   400 { error: "too_many_purchases" }                      more than MAX_PURCHASES distinct ids
//   404 { error: "purchase_not_found" }                      an id is no purchase of the caller's business
//   500 { error: "server_error" }                            incl. the audit row could not be written
//   + requireGoldStaff refusals: 403 gold_disabled | mfa_required | forbidden, 401 unauthorized.
//
// ORDER: every purchase is read with the caller's own JWT client (RLS keeps it to their business, so another
// business's purchase is indistinguishable from one that does not exist and the whole export is refused). Then
// gold.export_audit_log gets its row (service role), and only after that does any photo URL get signed. If the
// audit insert fails nothing is signed.
//
// ttr.access_log: not written here. The export audit row is the record of an export (privacy policy 4, spec 6.4:
// views go to ttr.access_log through get-id-image-urls, exports to gold.export_audit_log).
//
// LOGS: IDs and error codes only (6.1).

import { requireGoldStaff } from "../_shared/goldAuth.ts";
import type { GoldContext } from "../_shared/goldAuth.ts";
import { businessDate } from "../_shared/goldRules.js";
import { codeOf, CORS_HEADERS, DbError, GOLD_GOODS_BUCKET, json, UUID_RE } from "../_shared/goldPurchaseShared.ts";
import type { Row } from "../_shared/goldPurchaseShared.ts";

export const SIGNED_URL_TTL_SECONDS = 300;
export const MAX_PURCHASES = 200;
export const ID_BUCKET = "compliance-media";
export const FILTER_KEYS = ["q", "type", "status", "cash", "from", "to", "recordedBy"];

// PostgREST puts an `in` list in the URL; 200 uuids is about 7 KB, so reads go in smaller chunks.
const CHUNK = 50;
const MAX_FILTER_LENGTH = 200;

export interface Deps {
  authenticate: (req: Request) => Promise<GoldContext | Response>;
}

const DEFAULT_DEPS: Deps = { authenticate: (req) => requireGoldStaff(req, { minRole: "manager" }) };

export async function handleRequest(req: Request, deps: Deps = DEFAULT_DEPS): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const ctx = await deps.authenticate(req);
  if (ctx instanceof Response) return ctx;

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    return await exportPurchases(ctx, req);
  } catch (e) {
    console.error("gold-export failed:", codeOf(e));
    return json({ error: "server_error" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}

const bad = (field: string) => json({ error: "bad_request", field }, 400);

/** The known filter keys with non-empty string values, or null when the client sent no filters. */
function cleanFilters(raw: unknown): Record<string, string> | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const value = (raw as Row)[key];
    if (typeof value === "string" && value !== "") out[key] = value.slice(0, MAX_FILTER_LENGTH);
  }
  return out;
}

async function inChunks(ids: string[], read: (chunk: string[]) => PromiseLike<{ data: unknown; error: unknown }>, what: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await read(ids.slice(i, i + CHUNK));
    if (error) throw new DbError(what, String((error as Row).code ?? "unknown"));
    rows.push(...((data ?? []) as Row[]));
  }
  return rows;
}

const fullName = (c?: Row) => (c ? [c.first_name, c.middle_name, c.last_name].filter(Boolean).join(" ") : "");

async function exportPurchases(ctx: GoldContext, req: Request): Promise<Response> {
  let body: Row;
  try {
    body = await req.json();
  } catch {
    return bad("body");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return bad("body");

  const kind = body.kind;
  if (kind !== "zip" && kind !== "record") return bad("kind");
  if (!Array.isArray(body.purchaseIds) || body.purchaseIds.length === 0) return bad("purchaseIds");
  if (!body.purchaseIds.every((id: unknown) => typeof id === "string" && UUID_RE.test(id))) return bad("purchaseIds");
  const ids = [...new Set((body.purchaseIds as string[]).map((id) => id.toLowerCase()))];
  if (ids.length > MAX_PURCHASES) return json({ error: "too_many_purchases" }, 400);
  if (kind === "record" && ids.length !== 1) return bad("purchaseIds");
  const filters = cleanFilters(body.filters);
  if (filters === undefined) return bad("filters");

  const user = ctx.userClient;
  const gold = user.schema("gold");

  const purchases = await inChunks(
    ids,
    (chunk) =>
      gold
        .from("purchases")
        .select(
          "id, customer_id, joint_customer_id, purchase_type, cash_band, cash_10k_or_more, cash_amount, erp_invoice_no, phone, id_sighted, id_expired_at_time, ttr_transaction_id, created_at, created_by_staff_id, completed_at, completed_by_staff_id",
        )
        .in("id", chunk),
    "purchases",
  );
  const byId = new Map(purchases.map((p) => [p.id as string, p]));
  if (ids.some((id) => !byId.has(id))) return json({ error: "purchase_not_found" }, 404);

  // Everything the zip needs is read before the audit row, so a failed read leaves no row behind.
  let customers = new Map<string, Row>();
  let staffNames = new Map<string, string>();
  let ttrs = new Map<string, Row>();
  let goodsRows: Row[] = [];
  let idRows: Row[] = [];
  if (kind === "zip") {
    const customerIds = [...new Set(purchases.flatMap((p) => [p.customer_id, p.joint_customer_id]).filter(Boolean))] as string[];
    const ttrIds = [...new Set(purchases.map((p) => p.ttr_transaction_id).filter(Boolean))] as string[];
    customers = new Map(
      (
        await inChunks(
          customerIds,
          (chunk) => user.from("customers").select("id, first_name, middle_name, last_name, phone").in("id", chunk),
          "customers",
        )
      ).map((c) => [c.id as string, c]),
    );
    const staff = await gold.rpc("list_purchase_staff");
    if (staff.error) throw new DbError("list_purchase_staff", String((staff.error as Row).code ?? "unknown"));
    staffNames = new Map(((staff.data ?? []) as Row[]).map((s) => [s.staff_member_id as string, s.full_name as string]));
    ttrs = new Map(
      (
        await inChunks(
          ttrIds,
          (chunk) => user.schema("ttr").from("transactions").select("id, status, transaction_ref").in("id", chunk),
          "transactions",
        )
      ).map((t) => [t.id as string, t]),
    );
    goodsRows = await inChunks(
      ids,
      (chunk) =>
        gold.from("goods_photos").select("purchase_id, object_path, sort_order").in("purchase_id", chunk).order("sort_order"),
      "goods_photos",
    );
    const used = await gold.rpc("export_id_photos", { p_ids: ids });
    if (used.error) throw new DbError("export_id_photos", String((used.error as Row).code ?? "unknown"));
    idRows = (used.data ?? []) as Row[];
  }

  // The audit row comes before any URL is signed (spec 6.2). The staff member and business are the verified ones.
  const audit = await ctx.adminClient.schema("gold").from("export_audit_log").insert({
    reporting_entity_id: ctx.staff.reporting_entity_id,
    staff_member_id: ctx.staff.id,
    kind,
    filters,
    purchase_ids: ids,
  });
  if (audit.error) throw new DbError("export_audit_log", String((audit.error as Row).code ?? "unknown"));

  if (kind === "record") return json({ ok: true }, 200);

  // Sign: goods photos from gold-goods, ID photos from compliance-media.
  const goodsByPurchase = new Map<string, Row[]>();
  for (const g of goodsRows) {
    const list = goodsByPurchase.get(g.purchase_id as string) ?? [];
    list.push(g);
    goodsByPurchase.set(g.purchase_id as string, list);
  }
  const goodsList = ids.flatMap((id) =>
    (goodsByPurchase.get(id) ?? []).sort((a, b) => (a.sort_order as number) - (b.sort_order as number)).map((g, i) => ({ purchaseId: id, name: `goods-${i + 1}`, path: g.object_path as string }))
  );
  const idList = idRows.flatMap((r) =>
    (
      [
        ["front", r.front_object_path],
        ["back", r.back_object_path],
      ] as [string, string | null][]
    )
      .filter(([, path]) => Boolean(path))
      .map(([side, path]) => ({ purchaseId: r.purchase_id as string, name: `${r.role}-seller-id-${side}`, path: path as string }))
  );
  const urlOf = new Map<string, string>();
  const sign = async (bucket: string, list: { path: string }[]) => {
    if (list.length === 0) return;
    const { data, error } = await ctx.adminClient.storage.from(bucket).createSignedUrls(list.map((f) => f.path), SIGNED_URL_TTL_SECONDS);
    if (error) throw new DbError("createSignedUrls", String((error as Row).statusCode ?? "unknown"));
    // createSignedUrls keeps the input order. A photo that cannot be signed is left out, not returned as a broken link.
    (data ?? []).forEach((s: Row, i: number) => {
      if (s?.signedUrl && !s.error) urlOf.set(`${bucket}/${list[i].path}`, s.signedUrl);
    });
  };
  await sign(GOLD_GOODS_BUCKET, goodsList);
  await sign(ID_BUCKET, idList);

  const result = ids.map((id) => {
    const p = byId.get(id) as Row;
    const sellerIds = idRows.filter((r) => r.purchase_id === id);
    const idOf = (role: string) => sellerIds.find((r) => r.role === role);
    const main = idOf("main");
    const joint = idOf("joint");
    const customer = (customerId: string | null) => (customerId ? customers.get(customerId) : undefined);
    const ttr = p.ttr_transaction_id ? ttrs.get(p.ttr_transaction_id as string) : undefined;
    const goods = goodsList.filter((g) => g.purchaseId === id);
    const idFiles = idList.filter((f) => f.purchaseId === id);

    const copy = (r?: Row) => {
      if (!r) return "";
      if (!r.photos_replaced) return `original, taken ${businessDate(r.captured_at)}`;
      return r.current_copy_captured_at && (r.front_object_path || r.back_object_path)
        ? `newer copy, taken ${businessDate(r.current_copy_captured_at)}`
        : "replaced, no copy on file";
    };
    const document = (r?: Row) => (r ? `${r.document_type}, captured ${businessDate(r.captured_at)}` : "");
    const perSeller = (text: (r?: Row) => string) =>
      [main ? `main: ${text(main)}` : "", joint ? `joint: ${text(joint)}` : ""].filter(Boolean).join("; ");

    return {
      id,
      row: {
        purchase_id: id,
        created_at: p.created_at,
        created_by: staffNames.get(p.created_by_staff_id as string) ?? "",
        completed_at: p.completed_at ?? null,
        completed_by: staffNames.get(p.completed_by_staff_id as string) ?? "",
        erp_invoice_no: p.erp_invoice_no ?? "",
        purchase_type: p.purchase_type,
        cash_band: p.cash_band,
        cash_10k_or_more: Boolean(p.cash_10k_or_more),
        cash_amount: p.cash_amount ?? null,
        main_seller_name: fullName(customer(p.customer_id)),
        main_seller_phone: customer(p.customer_id)?.phone ?? "",
        main_id_type: main?.document_type ?? "",
        main_id_number: main?.document_number ?? "",
        main_id_expiry: main?.expiry_date ?? "",
        joint_seller_name: fullName(customer(p.joint_customer_id)),
        joint_seller_phone: customer(p.joint_customer_id)?.phone ?? "",
        joint_id_type: joint?.document_type ?? "",
        joint_id_number: joint?.document_number ?? "",
        joint_id_expiry: joint?.expiry_date ?? "",
        phone_at_purchase: p.phone ?? "",
        id_sighted: Boolean(p.id_sighted),
        id_expired_at_time: Boolean(p.id_expired_at_time),
        goods_photo_count: goods.length,
        ttr_status: ttr?.status ?? "",
        ttr_reference: ttr?.transaction_ref ?? "",
        id_document_used: perSeller(document),
        id_photo_copy_taken: perSeller(copy),
      },
      photos: [...idFiles, ...goods].flatMap((f) => {
        const bucket = f.name.startsWith("goods-") ? GOLD_GOODS_BUCKET : ID_BUCKET;
        const url = urlOf.get(`${bucket}/${f.path}`);
        return url ? [{ name: f.name, url }] : [];
      }),
    };
  });
  return json({ purchases: result }, 200);
}
