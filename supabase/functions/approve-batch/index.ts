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

  // Parse body. 'download' is exempt from the approval-token requirement — it is
  // a read of a batch the caller can already read directly under the
  // batches_admin RLS policy, so requiring the token would tighten existing
  // access rather than just adding the audit trail this action exists for.
  let batchId: string;
  let token: string;
  let action: string;
  try {
    const body = await req.json();
    batchId = body.batchId;
    token = body.token;
    action = body.action;
    if (!batchId || !action) throw new Error("missing fields");
    if (action !== "download" && !token) throw new Error("missing fields");
  } catch {
    return json({ error: "Request body must contain batchId, token, and action" }, 400);
  }

  if (!["submit", "reject", "regenerate", "download"].includes(action)) {
    return json({ error: "action must be 'submit', 'reject', 'regenerate', or 'download'" }, 400);
  }

  // deno-lint-ignore no-explicit-any
  const ttr = (serviceClient as any).schema("ttr");

  // Load and verify batch
  const { data: batch, error: batchErr } = await ttr
    .from("report_batches")
    .select("id, status, approval_token, reporting_entity_id, report_date, xml_content")
    .eq("id", batchId)
    .single();

  if (batchErr || !batch) return json({ error: "Batch not found" }, 404);

  const b = batch as Row;

  if (b.reporting_entity_id !== (staff as Row).reporting_entity_id) {
    return json({ error: "Not authorized for this batch" }, 403);
  }

  // Download returns the XML and records the export. Deliberately placed before
  // the status and token checks: a submitted or rejected batch is still
  // downloadable, which is the behaviour this replaces.
  if (action === "download") {
    const fileName = `ttr-fbs-${b.report_date}.xml`;
    const { error: logErr } = await ttr.from("access_log").insert({
      reporting_entity_id: b.reporting_entity_id,
      staff_member_id: user.id,
      action: "export",
      resource_type: "report_batches",
      resource_id: b.id,
      detail: fileName,
    });

    // Fail closed — an unlogged export would contradict the privacy policy's
    // commitment that every export is recorded.
    if (logErr) {
      console.error("access_log insert failed:", logErr);
      return json({ error: "Failed to record export" }, 500);
    }

    return json({ ok: true, xmlContent: b.xml_content, fileName }, 200);
  }

  // regenerate is allowed on pending_review or already-rejected batches — only a
  // submitted batch (a real AUSTRAC filing) must stay permanently untouchable.
  if (action === "regenerate") {
    if (b.status === "submitted") {
      return json({ error: "Cannot regenerate a submitted batch" }, 409);
    }
  } else if (b.status !== "pending_review") {
    return json({ error: `Batch is already ${b.status}` }, 409);
  }
  if (b.approval_token !== token) {
    return json({ error: "Invalid approval token" }, 403);
  }

  if (action === "regenerate") {
    return await regenerateBatch(ttr, b);
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

// Deletes a not-yet-submitted batch and its transaction links, then re-triggers
// generate-austrac-report for the same date so the now-unlinked transactions
// are picked up again — producing a fresh batch reflecting current generator
// code. The two deletes and the regeneration call aren't atomic; if generation
// fails after the deletes succeed, the error below says so explicitly rather
// than claiming success, since that date is left with no batch until retried.
// deno-lint-ignore no-explicit-any
async function regenerateBatch(ttr: any, b: Row): Promise<Response> {
  const batchId = b.id as string;

  const { error: unlinkErr } = await ttr
    .from("transaction_reports")
    .delete()
    .eq("batch_id", batchId);
  if (unlinkErr) {
    console.error("Failed to unlink transactions from batch:", unlinkErr);
    return json({ error: "Failed to unlink transactions from batch — nothing was changed" }, 500);
  }

  const { error: deleteErr } = await ttr
    .from("report_batches")
    .delete()
    .eq("id", batchId);
  if (deleteErr) {
    console.error("Failed to delete batch:", deleteErr);
    return json({
      error: "Batch's transactions were unlinked but the batch row itself failed to delete — inconsistent state, needs manual cleanup",
    }, 500);
  }

  let genResult: Row;
  try {
    const genRes = await fetch(`${SUPABASE_URL}/functions/v1/generate-austrac-report`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reportDate: b.report_date }),
    });
    genResult = await genRes.json();
  } catch (err) {
    console.error("generate-austrac-report call failed:", err);
    return json({
      error: "Old batch was cleared, but the regeneration call failed to reach generate-austrac-report — retry manually",
    }, 502);
  }

  const results = (genResult.results ?? []) as Row[];
  const ourResult = results.find((r) => r.entityId === b.reporting_entity_id);
  if (!ourResult) {
    console.error("generate-austrac-report did not return a result for this entity:", genResult);
    return json({
      error: "Old batch was cleared, but regeneration did not produce a new batch for this entity — retry manually",
      generatorResponse: genResult,
    }, 502);
  }

  const newBatchId = ourResult.batchId as string;
  const { data: newBatch, error: newBatchErr } = await ttr
    .from("report_batches")
    .select("approval_token")
    .eq("id", newBatchId)
    .single();
  if (newBatchErr || !newBatch) {
    console.error("Failed to load new batch's approval token:", newBatchErr);
    return json({
      error: "A new batch was generated, but its approval token could not be loaded",
      newBatchId,
    }, 500);
  }

  return json({
    ok: true,
    action: "regenerate",
    newBatch: {
      id: newBatchId,
      approvalToken: (newBatch as Row).approval_token,
      fileName: ourResult.fileName,
      txnCount: ourResult.txnCount,
    },
  }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
