import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Row = Record<string, unknown>;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

  // Verify authenticated user
  const { data: { user }, error: userError } = await anonClient.auth.getUser();
  if (userError || !user) return json({ error: "Invalid or expired token" }, 401);

  // Verify active admin
  const { data: staff, error: staffError } = await serviceClient
    .from("staff_members")
    .select("is_active, role, reporting_entity_id")
    .eq("id", user.id)
    .single();

  if (staffError || !staff || !(staff as Row).is_active || (staff as Row).role !== "admin") {
    return json({ error: "Admin role required" }, 403);
  }

  // Parse body
  let batchId: string;
  let token: string;
  let action: string;
  try {
    const body = await req.json();
    batchId = body.batchId;
    token = body.token;
    action = body.action;
    if (!batchId || !token || !action) throw new Error("missing fields");
  } catch {
    return json({ error: "Request body must contain batchId, token, and action" }, 400);
  }

  if (!["submit", "reject"].includes(action)) {
    return json({ error: "action must be 'submit' or 'reject'" }, 400);
  }

  // deno-lint-ignore no-explicit-any
  const ttr = (serviceClient as any).schema("ttr");

  // Load and verify batch
  const { data: batch, error: batchErr } = await ttr
    .from("report_batches")
    .select("id, status, approval_token, reporting_entity_id")
    .eq("id", batchId)
    .single();

  if (batchErr || !batch) return json({ error: "Batch not found" }, 404);

  const b = batch as Row;

  if (b.reporting_entity_id !== (staff as Row).reporting_entity_id) {
    return json({ error: "Not authorized for this batch" }, 403);
  }
  if (b.status !== "pending_review") {
    return json({ error: `Batch is already ${b.status}` }, 409);
  }
  if (b.approval_token !== token) {
    return json({ error: "Invalid approval token" }, 403);
  }

  const now = new Date().toISOString();
  const update: Row = action === "submit"
    ? { status: "submitted", submitted_at: now, submitted_by: user.id }
    : { status: "rejected" };

  const { error: updateErr } = await ttr
    .from("report_batches")
    .update(update)
    .eq("id", batchId);

  if (updateErr) {
    console.error("Batch update failed:", updateErr);
    return json({ error: "Failed to update batch" }, 500);
  }

  return json({ ok: true, batchId, action }, 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
