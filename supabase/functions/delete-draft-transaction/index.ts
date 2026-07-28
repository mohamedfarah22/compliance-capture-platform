import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deleteRestrictingChildren } from "../_shared/tx-children.ts";
import type { SupabaseSchema } from "../_shared/tx-children.ts";

// Re-exported so the existing test file's imports keep resolving from this module.
export { deleteRestrictingChildren };
export type { SupabaseSchema };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STORAGE_BUCKET = "compliance-media";
const STORAGE_LIST_LIMIT = 100;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Exported so the tests can import the module's helpers without Deno.serve binding a
// port — same pattern as complete-transaction/index.ts.
export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const jwt = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!jwt) return json({ error: "Missing Authorization header" }, 401);

  let transactionId: string;
  try {
    const body = await req.json();
    transactionId = body.transactionId;
    if (!transactionId) throw new Error("missing transactionId");
  } catch {
    return json({ error: "Request body must contain transactionId" }, 400);
  }

  // anonClient enforces RLS — owns/entity check is implicit
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Verify ownership via anonClient (RLS returns nothing if wrong entity).
  // .schema("ttr") required — a bare .from() resolves to public.transactions, which does
  // not exist, so this returned an error and every Cancel reported "Transaction not found".
  const { data: tx, error: txError } = await anonClient
    .schema("ttr")
    .from("transactions")
    .select("id, status")
    .eq("id", transactionId)
    .single();

  if (txError || !tx) {
    // Intentionally indistinct — don't reveal whether the transaction exists for another entity
    return json({ error: "Transaction not found" }, 404);
  }

  // 2. Completed transactions cannot be deleted
  if (tx.status === "complete") {
    return json({ error: "Completed transactions cannot be deleted" }, 409);
  }

  // 3. Remove all Storage objects under {transactionId}/
  const storageError = await removeTransactionStorage(serviceClient, transactionId);
  if (storageError) {
    console.error("Storage removal failed for transaction", transactionId, storageError);
    return json({ error: "Failed to remove associated files. Transaction not deleted." }, 500);
  }

  // 4. Delete the children that do not cascade, in FK order.
  const childError = await deleteRestrictingChildren(
    serviceClient.schema("ttr") as unknown as SupabaseSchema,
    transactionId,
  );
  if (childError) {
    console.error("Child delete failed for transaction", transactionId, childError);
    return json({ error: "Failed to delete transaction record" }, 500);
  }

  // 5. Delete the DB row — Storage and the restricting children are already clean.
  // .schema("ttr") required, as above.
  const { error: deleteError } = await serviceClient
    .schema("ttr")
    .from("transactions")
    .delete()
    .eq("id", transactionId)
    .eq("status", "draft"); // belt-and-suspenders: never delete a completed row

  if (deleteError) {
    console.error("DB delete failed for transaction", transactionId, deleteError);
    return json({ error: "Failed to delete transaction record" }, 500);
  }

  return json({ deleted: true }, 200);
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}

// Typed structurally rather than as ReturnType<typeof createClient>. That alias resolves
// to the client's default generic parameters, which do not match the configured client
// this is actually called with, so it failed type-checking. Harmless while nothing in
// this directory was type-checked, but adding index.test.ts brought it into `deno test`.
interface StorageOwner {
  storage: {
    from: (bucket: string) => {
      list: (
        prefix: string,
        options: { limit: number; offset: number },
      ) => PromiseLike<{ data: { name: string }[] | null; error: { message: string } | null }>;
      remove: (paths: string[]) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

async function removeTransactionStorage(
  client: StorageOwner,
  transactionId: string,
): Promise<Error | null> {
  const prefix = `${transactionId}/`;
  const paths: string[] = [];

  // Paginate until no more objects — flat path convention means one level deep
  let offset = 0;
  while (true) {
    const { data: objects, error } = await client.storage
      .from(STORAGE_BUCKET)
      .list(prefix, { limit: STORAGE_LIST_LIMIT, offset });

    if (error) return new Error(error.message);
    if (!objects || objects.length === 0) break;

    for (const obj of objects) {
      paths.push(`${prefix}${obj.name}`);
    }

    if (objects.length < STORAGE_LIST_LIMIT) break;
    offset += STORAGE_LIST_LIMIT;
  }

  if (paths.length === 0) return null;

  const { error: removeError } = await client.storage
    .from(STORAGE_BUCKET)
    .remove(paths);

  return removeError ? new Error(removeError.message) : null;
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
