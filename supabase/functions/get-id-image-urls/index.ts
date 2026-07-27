// Mints short-lived signed URLs for ID document images and records the access in
// ttr.access_log in the same call.
//
// Signed URLs are minted server-side, rather than by the client calling
// storage.createSignedUrl() directly, so that viewing an ID image cannot happen
// without the corresponding audit row being written. A client that mints its own
// URL could simply skip logging; here it cannot obtain the URL at all without the
// log insert being attempted.
//
// Authorisation still comes from RLS: the caller's own JWT (anonClient) resolves
// which images they may see. The service-role client is used only to mint URLs
// and write the audit row — it must never be used to look up images by id, or
// tenant isolation would be bypassed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STORAGE_BUCKET = "compliance-media";
const SIGNED_URL_TTL_SECONDS = 3600;
const MAX_IMAGE_IDS = 100;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Row = Record<string, unknown>;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const jwt = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!jwt) return json({ error: "Missing Authorization header" }, 401);

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: { user }, error: userError } = await anonClient.auth.getUser();
  if (userError || !user) return json({ error: "Invalid or expired token" }, 401);

  let imageIds: string[];
  try {
    const body = await req.json();
    imageIds = (body.imageIds ?? []).filter(Boolean);
    if (!Array.isArray(imageIds)) throw new Error("imageIds must be an array");
  } catch {
    return json({ error: "Request body must contain an imageIds array" }, 400);
  }

  if (imageIds.length === 0) return json({ urls: {} }, 200);
  if (imageIds.length > MAX_IMAGE_IDS) {
    return json({ error: `A maximum of ${MAX_IMAGE_IDS} imageIds may be requested at once` }, 400);
  }

  const { data: staff } = await serviceClient
    .from("staff_members")
    .select("is_active, reporting_entity_id")
    .eq("id", user.id)
    .single();

  if (!staff || !(staff as Row).is_active) {
    return json({ error: "No active staff record for this user" }, 403);
  }

  // RLS (img_select) scopes this to images owned by the caller's entity. Ids the
  // caller may not see simply do not come back, and so are never signed or logged.
  //
  // Superseded rows are excluded: their storage object was deleted when a re-capture
  // replaced it (see 20260727000001), so signing one would mint a URL for a file that no
  // longer exists and log a "view" of something nobody can view. Older verification rows
  // still reference these ids, so callers must get back nothing for them and render
  // accordingly rather than a broken image.
  const { data: images, error: imagesError } = await anonClient
    .schema("ttr")
    .from("stored_images")
    .select("id, object_path, transaction_id")
    .in("id", imageIds)
    .is("superseded_at", null);

  if (imagesError) {
    console.error("stored_images lookup failed:", imagesError);
    return json({ error: "Failed to look up images" }, 500);
  }
  if (!images || images.length === 0) return json({ urls: {} }, 200);

  const rows = images as Row[];
  const { data: signedList, error: signError } = await serviceClient.storage
    .from(STORAGE_BUCKET)
    .createSignedUrls(rows.map((r) => r.object_path as string), SIGNED_URL_TTL_SECONDS);

  if (signError) {
    console.error("createSignedUrls failed:", signError);
    return json({ error: "Failed to create signed URLs" }, 500);
  }

  // createSignedUrls preserves input order and reports per-path errors inline.
  const urls: Record<string, string> = {};
  const viewed: Row[] = [];
  (signedList ?? []).forEach((signed, i) => {
    const row = rows[i];
    if (!signed?.signedUrl || signed.error) return;
    urls[row.id as string] = signed.signedUrl;
    viewed.push({
      reporting_entity_id: (staff as Row).reporting_entity_id,
      staff_member_id: user.id,
      action: "view",
      resource_type: "stored_images",
      resource_id: row.id,
      transaction_id: row.transaction_id,
      detail: row.object_path,
    });
  });

  if (viewed.length > 0) {
    const { error: logError } = await serviceClient
      .schema("ttr")
      .from("access_log")
      .insert(viewed);

    // Fail closed: if the access cannot be recorded, do not release the URLs.
    // The policy promises every view is logged, so an unlogged view is a breach
    // of that promise rather than a degraded-but-acceptable outcome.
    if (logError) {
      console.error("access_log insert failed:", logError);
      return json({ error: "Failed to record image access" }, 500);
    }
  }

  return json({ urls }, 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
