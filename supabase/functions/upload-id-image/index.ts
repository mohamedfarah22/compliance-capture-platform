// Optional Edge Function for server-side SHA-256 hashing before Storage upload.
// Use this when you need non-repudiation guarantees that the hash was computed
// independently of the client (client-provided hashes can be manipulated).
//
// If client-side direct upload is acceptable, skip this function and have the
// client upload directly to Supabase Storage, then INSERT into ttr.stored_images.
//
// The owner of the image is either a transaction (the TTR wizard: transactionId,
// personType, personId) or a customer (gold, no TTR: customerId, verificationId). Customer
// photos go under customers/{customerId}/{verificationId}/{side}-{uuid}.{ext} and the
// stored_images row is written here with the SERVICE ROLE, not the caller's JWT, so there is
// no browser insert policy for customer photos. The caller's JWT is used only to prove, under
// RLS, that the customer belongs to their reporting entity.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STORAGE_BUCKET = "compliance-media";
const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB — matches storage bucket limit
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const jwt = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!jwt) return json({ error: "Missing Authorization header" }, 401);

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Verify JWT
  const { data: { user }, error: userError } = await anonClient.auth.getUser();
  if (userError || !user) return json({ error: "Invalid or expired token" }, 401);

  // Parse multipart form
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return json({ error: "Request must be multipart/form-data" }, 400);
  }

  const transactionId = formData.get("transactionId") as string | null;
  const personType    = formData.get("personType")    as string | null; // "party" or "conducting-person"
  const personId      = formData.get("personId")      as string | null;
  const side          = formData.get("side")          as string | null; // "front" or "back"
  const file          = formData.get("file")          as File   | null;

  // Customer-owned image (gold). The transaction path below is unchanged.
  const customerId     = formData.get("customerId")     as string | null;
  const verificationId = formData.get("verificationId") as string | null;
  if (customerId) {
    if (transactionId) return json({ error: "Send either transactionId or customerId, not both" }, 400);
    return await uploadForCustomer(anonClient, serviceClient, user.id, {
      customerId, verificationId, side, file,
    });
  }

  if (!transactionId || !personType || !personId || !side || !file) {
    return json({ error: "Required fields: transactionId, personType, personId, side, file" }, 400);
  }
  if (!["party", "conducting-person"].includes(personType)) {
    return json({ error: "personType must be 'party' or 'conducting-person'" }, 400);
  }
  if (!["front", "back"].includes(side)) {
    return json({ error: "side must be 'front' or 'back'" }, 400);
  }
  if (!ALLOWED_CONTENT_TYPES.has(file.type)) {
    return json({ error: "File type must be image/jpeg, image/png, or image/webp" }, 415);
  }
  if (file.size > MAX_BYTES) {
    return json({ error: "File exceeds 10 MiB limit" }, 413);
  }

  // Verify the transaction is a draft and belongs to the caller's entity
  const { data: tx, error: txError } = await anonClient
    .schema("ttr")
    .from("transactions")
    .select("id, status")
    .eq("id", transactionId)
    .single();

  if (txError || !tx) return json({ error: "Transaction not found" }, 404);
  if (tx.status !== "draft") return json({ error: "Transaction is not a draft" }, 409);

  // Read image bytes and compute SHA-256 server-side
  const imageBytes = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", imageBytes);
  const sha256Hex  = arrayBufferToHex(hashBuffer);

  // Upload to Storage — path: {transactionId}/{personType}-{personId}-{side}.ext
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const objectPath = `${transactionId}/${personType}-${personId}-${side}.${ext}`;

  // Re-capturing the same person/side within a draft REPLACES the previous attempt.
  //
  // Object paths are deterministic, so a retry always targets the path the first attempt
  // wrote. Refusing that (the previous `upsert: false`) meant any failure downstream of a
  // successful upload — a rejected save, a dropped connection — left the operator unable
  // to continue and, because delete-draft-transaction was also broken, unable to cancel.
  //
  // The non-overwrite guarantee still holds where it matters. This is unreachable unless
  // status = 'draft' (checked above), so nothing that has been filed with AUSTRAC can be
  // altered: the boundary is "drafts are mutable, completed transactions are not", not
  // "images are never replaced".
  const { error: uploadError } = await serviceClient.storage
    .from(STORAGE_BUCKET)
    .upload(objectPath, imageBytes, {
      contentType: file.type,
      upsert: true,
    });

  if (uploadError) {
    console.error("Storage upload failed:", uploadError);
    return json({ error: "Storage upload failed" }, 500);
  }

  // Mirror the upsert in the metadata. Keying on (storage_bucket, object_path) — the
  // table's own unique constraint — means a replaced image keeps its existing row id, so
  // anything already referencing it stays valid rather than being orphaned.
  const metadata = {
    transaction_id:       transactionId,
    storage_bucket:       STORAGE_BUCKET,
    object_path:          objectPath,
    content_hash_sha256:  sha256Hex,
    content_type:         file.type,
    byte_size:            file.size,
    captured_by_staff_id: user.id,
    // Set explicitly: the DEFAULT only applies on insert, so a replaced image would
    // otherwise keep the superseded attempt's timestamp while describing a new photo.
    // The row must describe the object that actually exists.
    captured_at:          new Date().toISOString(),
  };

  const { data: img, error: insertError } = await serviceClient
    .schema("ttr")
    .from("stored_images")
    .upsert(metadata, { onConflict: "storage_bucket,object_path" })
    .select("id, object_path, content_hash_sha256")
    .single();

  if (insertError) {
    // No rollback here, deliberately. The upload may have replaced an existing object
    // that other rows still reference, so removing it could destroy a live capture — a
    // worse outcome than an orphaned object, which the next retry simply overwrites.
    console.error("stored_images upsert failed:", insertError);
    return json({ error: "Failed to record image metadata" }, 500);
  }

  return json({
    id:                 img.id,
    objectPath:         img.object_path,
    contentHashSha256:  img.content_hash_sha256,
  }, 201);
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}

// Loosely typed: the real client's generics differ between createClient's default and the
// instances built above, and this helper only uses from/schema/storage.
// deno-lint-ignore no-explicit-any
type Client = any;

// ─── Customer-owned image ─────────────────────────────────────────────────────────────────
// Path: customers/{customerId}/{verificationId}/{side}-{uuid}.{ext}. Every upload gets a
// fresh path (the uuid), so unlike the draft-transaction path nothing is ever replaced: an
// ID photo that belongs to a customer is never overwritten, only superseded by a later
// capture (see _shared/supersede.ts). verificationId is the id the caller will give the
// customer-level ttr.id_verifications row that references these photos.
async function uploadForCustomer(
  anonClient: Client,
  serviceClient: Client,
  staffId: string,
  input: {
    customerId: string;
    verificationId: string | null;
    side: string | null;
    file: File | null;
  },
): Promise<Response> {
  const { customerId, verificationId, side, file } = input;

  if (!verificationId || !side || !file) {
    return json({ error: "Required fields: customerId, verificationId, side, file" }, 400);
  }
  if (!UUID_RE.test(customerId) || !UUID_RE.test(verificationId)) {
    return json({ error: "customerId and verificationId must be UUIDs" }, 400);
  }
  if (!["front", "back"].includes(side)) {
    return json({ error: "side must be 'front' or 'back'" }, 400);
  }
  if (!ALLOWED_CONTENT_TYPES.has(file.type)) {
    return json({ error: "File type must be image/jpeg, image/png, or image/webp" }, 415);
  }
  if (file.size > MAX_BYTES) {
    return json({ error: "File exceeds 10 MiB limit" }, 413);
  }

  // Entity check, under the caller's own JWT: RLS on public.customers only returns
  // customers of the caller's reporting entity (and none at all below aal2), so a customer
  // of another entity is indistinguishable from one that does not exist.
  const { data: customer, error: customerError } = await anonClient
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .maybeSingle();

  if (customerError || !customer) return json({ error: "Customer not found" }, 404);

  const imageBytes = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", imageBytes);
  const sha256Hex = arrayBufferToHex(hashBuffer);

  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const objectPath = `customers/${customerId}/${verificationId}/${side}-${crypto.randomUUID()}.${ext}`;

  const { error: uploadError } = await serviceClient.storage
    .from(STORAGE_BUCKET)
    .upload(objectPath, imageBytes, { contentType: file.type, upsert: false });

  if (uploadError) {
    console.error("Storage upload failed:", uploadError);
    return json({ error: "Storage upload failed" }, 500);
  }

  const { data: img, error: insertError } = await serviceClient
    .schema("ttr")
    .from("stored_images")
    .insert({
      customer_id:          customerId,
      storage_bucket:       STORAGE_BUCKET,
      object_path:          objectPath,
      content_hash_sha256:  sha256Hex,
      content_type:         file.type,
      byte_size:            file.size,
      captured_by_staff_id: staffId,
      captured_at:          new Date().toISOString(),
    })
    .select("id, object_path, content_hash_sha256")
    .single();

  if (insertError || !img) {
    // Safe to remove here, unlike the draft-transaction path: the path is brand new, so
    // nothing can reference this object, and leaving it would only make an orphan.
    console.error("stored_images insert failed:", insertError);
    const { error: removeError } = await serviceClient.storage.from(STORAGE_BUCKET).remove([objectPath]);
    if (removeError) console.error("orphan removal failed:", removeError);
    return json({ error: "Failed to record image metadata" }, 500);
  }

  return json({
    id:                 img.id,
    objectPath:         img.object_path,
    contentHashSha256:  img.content_hash_sha256,
  }, 201);
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
