// Access check shared by every gold-* edge function (spec 2.2, 6.1, assumption A6).
//
// SERVER SECRET: GOLD_JOURNEY_ENABLED
//   Gold code is deployed to the client project phase by phase, long before go-live. Every
//   gold function calls requireGoldStaff() first, which refuses with 403 { error:
//   "gold_disabled" } unless this secret is exactly "true". Set it per project:
//     npx supabase secrets set GOLD_JOURNEY_ENABLED=true     (dev only, until go-live)
//   and `npx supabase secrets unset GOLD_JOURNEY_ENABLED` to switch gold off again. Unset
//   or any other value = off. It is read on every request, so changing the secret takes
//   effect on the next call without a redeploy of the code (secrets reach the function on
//   its next cold start, which Supabase triggers on `secrets set`).
//   The browser has its own build flag, VITE_GOLD_JOURNEY_ENABLED; the two are independent.
//
// What requireGoldStaff() checks, in this order:
//   1. the secret above                                  403 gold_disabled
//   2. a Bearer token that Supabase Auth accepts         401 unauthorized
//   3. aal2 in that token (the second factor was done)    403 mfa_required
//   4. an active staff_members row                        403 forbidden
//   5. a role at or above minRole                         403 forbidden
// A caller who is not allowed learns nothing beyond the code. Nothing here logs.
//
// ROLES. public.has_role(r) in the database is an exact match on the role: an admin does NOT
// satisfy has_role('manager'). The gold rule is "managers and admins" (spec 2.3), so this
// helper ranks the roles staff < manager < admin and minRole means "this role or higher".
// RLS that must admit both (gold.export_audit_log) names both roles explicitly.
//
// RETURNS either a Response to return from the handler as it is, or
//   staff        { id, reporting_entity_id, role, full_name } of the caller
//   userClient   a Supabase client carrying the caller's JWT. Use it for reads that RLS and
//                the entity-scoped gold RPCs should decide (they identify the caller by
//                auth.uid(), so they return nothing through the service-role client).
//   adminClient  service-role client. Bypasses RLS and the MFA rule; use it only after this
//                check, always filter by staff.reporting_entity_id, and never look rows up by
//                a client-supplied id alone.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type GoldRole = "staff" | "manager" | "admin";

export interface GoldStaff {
  id: string;
  reporting_entity_id: string;
  role: GoldRole;
  full_name: string;
}

export interface GoldContext {
  staff: GoldStaff;
  userClient: SupabaseClient;
  adminClient: SupabaseClient;
}

export interface RequireGoldStaffOptions {
  /** Lowest role allowed. Defaults to "staff" (any active staff member). */
  minRole?: GoldRole;
}

const ROLE_RANK: Record<GoldRole, number> = { staff: 0, manager: 1, admin: 2 };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** True only when the GOLD_JOURNEY_ENABLED function secret is exactly "true". */
export function goldEnabled(): boolean {
  return Deno.env.get("GOLD_JOURNEY_ENABLED") === "true";
}

function refuse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/** The aal claim of a JWT. Only trusted after auth.getUser() has accepted the token. */
function aalOf(jwt: string): unknown {
  try {
    return JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).aal;
  } catch {
    return null;
  }
}

export async function requireGoldStaff(
  req: Request,
  options: RequireGoldStaffOptions = {},
): Promise<GoldContext | Response> {
  const minRole = options.minRole ?? "staff";

  if (!goldEnabled()) return refuse(403, "gold_disabled");

  const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return refuse(401, "unauthorized");

  const url = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const adminClient = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return refuse(401, "unauthorized");

  if (aalOf(jwt) !== "aal2") return refuse(403, "mfa_required");

  const { data: staff, error: staffError } = await adminClient
    .from("staff_members")
    .select("id, reporting_entity_id, role, full_name, is_active")
    .eq("id", user.id)
    .single();

  const row = staff as (GoldStaff & { is_active: boolean }) | null;
  if (staffError || !row || !row.is_active) return refuse(403, "forbidden");
  if ((ROLE_RANK[row.role] ?? -1) < ROLE_RANK[minRole]) return refuse(403, "forbidden");

  return {
    staff: {
      id: row.id,
      reporting_entity_id: row.reporting_entity_id,
      role: row.role,
      full_name: row.full_name,
    },
    userClient,
    adminClient,
  };
}
