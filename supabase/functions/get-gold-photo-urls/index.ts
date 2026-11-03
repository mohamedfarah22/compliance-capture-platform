// get-gold-photo-urls: short-lived signed URLs for one purchase's goods photos.
// Spec 4.5 ("Goods photo URLs"), 6.1.
//
// WHO: any active staff member (requireGoldStaff, the first thing this function does).
//
// REQUEST: POST application/json, Authorization: Bearer <aal2 JWT>.   { purchaseId }
//
// RESPONSE
//   200 { urls: [{ id, sortOrder, url }] }     in photo order; url expires after SIGNED_URL_TTL_SECONDS
//   400 { error: "bad_request", field }
//   404 { error: "purchase_not_found" }         not a purchase of the caller's entity (or no such purchase)
//   500 { error: "server_error" }
//   + requireGoldStaff refusals: 403 gold_disabled | mfa_required | forbidden, 401 unauthorized.
//
// The entity check is RLS under the caller's own JWT (the purchase, then its photo rows). The service role only
// signs the object paths those rows name, so a purchase id from another entity never reaches storage.
//
// LOGS: IDs and error codes only (6.1).

import { requireGoldStaff } from "../_shared/goldAuth.ts";
import type { GoldContext } from "../_shared/goldAuth.ts";
import { codeOf, CORS_HEADERS, DbError, GOLD_GOODS_BUCKET, json, UUID_RE } from "../_shared/goldPurchaseShared.ts";
import type { Row } from "../_shared/goldPurchaseShared.ts";

export const SIGNED_URL_TTL_SECONDS = 300;

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
    return await signPhotos(ctx, req);
  } catch (e) {
    console.error("get-gold-photo-urls failed:", codeOf(e));
    return json({ error: "server_error" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}

async function signPhotos(ctx: GoldContext, req: Request): Promise<Response> {
  let purchaseId: unknown;
  try {
    purchaseId = (await req.json())?.purchaseId;
  } catch {
    return json({ error: "bad_request", field: "body" }, 400);
  }
  if (typeof purchaseId !== "string" || !UUID_RE.test(purchaseId)) {
    return json({ error: "bad_request", field: "purchaseId" }, 400);
  }

  const gold = ctx.userClient.schema("gold");
  const purchase = await gold.from("purchases").select("id").eq("id", purchaseId).maybeSingle();
  if (purchase.error) throw new DbError("purchases", String((purchase.error as Row).code ?? "unknown"));
  if (!purchase.data) return json({ error: "purchase_not_found" }, 404);

  const photos = await gold
    .from("goods_photos")
    .select("id, object_path, sort_order")
    .eq("purchase_id", purchaseId)
    .order("sort_order");
  if (photos.error) throw new DbError("goods_photos", String((photos.error as Row).code ?? "unknown"));
  const rows = (photos.data ?? []) as Row[];
  if (rows.length === 0) return json({ urls: [] }, 200);

  const { data: signed, error } = await ctx.adminClient.storage
    .from(GOLD_GOODS_BUCKET)
    .createSignedUrls(rows.map((r) => r.object_path as string), SIGNED_URL_TTL_SECONDS);
  if (error) throw new DbError("createSignedUrls", String((error as Row).statusCode ?? "unknown"));

  // createSignedUrls keeps the input order and reports a failure per path inline. A photo that cannot be signed
  // is left out rather than returned as a broken link.
  const urls = (signed ?? []).flatMap((s: Row, i: number) =>
    s?.signedUrl && !s.error ? [{ id: rows[i].id, sortOrder: rows[i].sort_order, url: s.signedUrl }] : []
  );
  return json({ urls }, 200);
}
