// Scheduled Edge Function — cron: 0 2 * * * (02:00 UTC daily)
// Invoked by Supabase's built-in cron scheduler using the service role.
//
// Guarantee: a transaction's DB row is deleted ONLY after its Storage objects
// are confirmed removed. Any transaction whose Storage cleanup errors is skipped
// and will be retried on the next scheduled run.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STORAGE_BUCKET = "compliance-media";
const STORAGE_LIST_LIMIT = 100;
const STALE_AFTER_DAYS = 30;

interface StaleTransaction {
  transaction_id: string;
  reporting_entity_id: string;
}

Deno.serve(async (_req: Request) => {
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Fetch stale draft IDs from the read-only DB helper
  const { data: stale, error: rpcError } = await serviceClient.rpc(
    "get_stale_draft_ids",
    { older_than_days: STALE_AFTER_DAYS },
  );

  if (rpcError) {
    console.error("get_stale_draft_ids RPC failed:", rpcError);
    return json({ error: "Failed to query stale drafts" }, 500);
  }

  const transactions: StaleTransaction[] = stale ?? [];
  let deleted = 0;
  let skipped = 0;

  for (const { transaction_id } of transactions) {
    // 2a. Collect all Storage paths under {transaction_id}/
    const { paths, error: listError } = await listStoragePaths(serviceClient, transaction_id);
    if (listError) {
      console.error(`Storage list failed for ${transaction_id}:`, listError);
      skipped++;
      continue;
    }

    // 2b. Remove Storage objects — skip the transaction if removal fails
    if (paths.length > 0) {
      const { error: removeError } = await serviceClient.storage
        .from(STORAGE_BUCKET)
        .remove(paths);

      if (removeError) {
        console.error(`Storage removal failed for ${transaction_id}:`, removeError);
        skipped++;
        continue;
      }
    }

    // 2c. Storage clean — safe to delete the DB row
    const { error: deleteError } = await serviceClient
      .from("transactions")
      .delete()
      .eq("id", transaction_id)
      .eq("status", "draft"); // belt-and-suspenders: never delete a completed row

    if (deleteError) {
      console.error(`DB delete failed for ${transaction_id}:`, deleteError);
      skipped++;
      continue;
    }

    deleted++;
  }

  const summary = { processed: transactions.length, deleted, skipped };
  console.log("cleanup-stale-drafts complete:", summary);
  return json(summary, 200);
});

async function listStoragePaths(
  client: ReturnType<typeof createClient>,
  transactionId: string,
): Promise<{ paths: string[]; error: Error | null }> {
  const prefix = `${transactionId}/`;
  const paths: string[] = [];
  let offset = 0;

  while (true) {
    const { data: objects, error } = await client.storage
      .from(STORAGE_BUCKET)
      .list(prefix, { limit: STORAGE_LIST_LIMIT, offset });

    if (error) return { paths: [], error: new Error(error.message) };
    if (!objects || objects.length === 0) break;

    for (const obj of objects) {
      paths.push(`${prefix}${obj.name}`);
    }

    if (objects.length < STORAGE_LIST_LIMIT) break;
    offset += STORAGE_LIST_LIMIT;
  }

  return { paths, error: null };
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
