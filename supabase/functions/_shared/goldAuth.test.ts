import { assert, assertEquals } from "std/assert";
import { goldEnabled, requireGoldStaff } from "./goldAuth.ts";
import type { GoldContext } from "./goldAuth.ts";

// requireGoldStaff reads its environment on every call, so the tests set it per case. The
// Supabase client talks to a stubbed fetch: /auth/v1/user plays Supabase Auth and
// /rest/v1/staff_members plays the service-role staff lookup.
Deno.env.set("SUPABASE_URL", "http://stub.test");
Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");

const STAFF_ID = "11111111-1111-1111-1111-111111111111";
const ENTITY_ID = "e1111111-1111-1111-1111-111111111111";

// The client starts an auth refresh timer; irrelevant to a request/response helper.
const OPTS = { sanitizeOps: false, sanitizeResources: false };

function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An unsigned JWT with the given assurance level; the stubbed Auth accepts it. */
function jwt(aal: string): string {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: STAFF_ID, aal })}.sig`;
}

interface Scenario {
  authOk: boolean;
  staff: Record<string, unknown> | null;
}

interface Run {
  res: Response | GoldContext;
  calls: string[];
  logged: string[];
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function run(
  scenario: Scenario,
  opts: { enabled?: string | null; token?: string | null; minRole?: "staff" | "manager" | "admin" } = {},
): Promise<Run> {
  const enabled = opts.enabled === undefined ? "true" : opts.enabled;
  if (enabled === null) Deno.env.delete("GOLD_JOURNEY_ENABLED");
  else Deno.env.set("GOLD_JOURNEY_ENABLED", enabled);

  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const wantsObject = (headers.get("accept") ?? "").includes("pgrst.object");
    calls.push(url.pathname);
    if (url.pathname === "/auth/v1/user") {
      return Promise.resolve(
        scenario.authOk
          ? jsonResponse({ id: STAFF_ID, aud: "authenticated", email: "staff@example.test" })
          : jsonResponse({ msg: "invalid JWT" }, 401),
      );
    }
    if (url.pathname === "/rest/v1/staff_members") {
      if (!scenario.staff) {
        return Promise.resolve(jsonResponse({ code: "PGRST116", message: "no rows", details: null, hint: null }, 406));
      }
      return Promise.resolve(jsonResponse(wantsObject ? scenario.staff : [scenario.staff]));
    }
    return Promise.resolve(jsonResponse([]));
  };

  const logged: string[] = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const k of Object.keys(originals) as (keyof typeof originals)[]) {
    console[k] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  }

  try {
    const headers: Record<string, string> = {};
    const token = opts.token === undefined ? jwt("aal2") : opts.token;
    if (token !== null) headers["Authorization"] = `Bearer ${token}`;
    const req = new Request("http://stub.test/functions/v1/gold-x", { method: "POST", headers });
    const res = await requireGoldStaff(req, opts.minRole ? { minRole: opts.minRole } : undefined);
    return { res, calls, logged };
  } finally {
    Object.assign(console, originals);
    globalThis.fetch = originalFetch;
  }
}

const staffRow = (role: string, isActive = true) => ({
  id: STAFF_ID,
  reporting_entity_id: ENTITY_ID,
  role,
  full_name: "Sam Staff",
  is_active: isActive,
});

async function refusal(r: Run, status: number, error: string) {
  assert(r.res instanceof Response, "expected a refusal");
  assertEquals(r.res.status, status);
  assertEquals(await r.res.json(), { error });
}

Deno.test("goldEnabled is true only for the exact string 'true'", () => {
  for (const [value, expected] of [["true", true], ["TRUE", false], ["1", false], ["false", false], ["", false], [null, false]] as const) {
    if (value === null) Deno.env.delete("GOLD_JOURNEY_ENABLED");
    else Deno.env.set("GOLD_JOURNEY_ENABLED", value);
    assertEquals(goldEnabled(), expected, `GOLD_JOURNEY_ENABLED=${value}`);
  }
});

Deno.test({
  name: "flag off: 403 gold_disabled, before any token or network check",
  ...OPTS,
  fn: async () => {
    for (const enabled of [null, "false", "TRUE"]) {
      const r = await run({ authOk: true, staff: staffRow("admin") }, { enabled });
      await refusal(r, 403, "gold_disabled");
      assertEquals(r.calls, [], "nothing is contacted while gold is off");
    }
    const noToken = await run({ authOk: true, staff: staffRow("staff") }, { enabled: null, token: null });
    await refusal(noToken, 403, "gold_disabled");
  },
});

Deno.test({
  name: "no Authorization header: 401",
  ...OPTS,
  fn: async () => {
    const r = await run({ authOk: true, staff: staffRow("staff") }, { token: null });
    await refusal(r, 401, "unauthorized");
    assertEquals(r.calls, []);
  },
});

Deno.test({
  name: "a token Supabase Auth rejects: 401",
  ...OPTS,
  fn: async () => {
    const r = await run({ authOk: false, staff: staffRow("staff") });
    await refusal(r, 401, "unauthorized");
    assert(!r.calls.includes("/rest/v1/staff_members"), "the staff row is not read for an invalid token");
  },
});

Deno.test({
  name: "aal1 (password only): 403 mfa_required, and the staff row is not read",
  ...OPTS,
  fn: async () => {
    const r = await run({ authOk: true, staff: staffRow("admin") }, { token: jwt("aal1") });
    await refusal(r, 403, "mfa_required");
    assert(!r.calls.includes("/rest/v1/staff_members"));
  },
});

Deno.test({
  name: "a token with no aal claim, or one that is not a JWT: refused as mfa_required / unauthorized",
  ...OPTS,
  fn: async () => {
    const noClaim = `${b64url({ alg: "HS256" })}.${b64url({ sub: STAFF_ID })}.sig`;
    await refusal(await run({ authOk: true, staff: staffRow("staff") }, { token: noClaim }), 403, "mfa_required");
    await refusal(await run({ authOk: true, staff: staffRow("staff") }, { token: "not-a-jwt" }), 403, "mfa_required");
    await refusal(await run({ authOk: false, staff: staffRow("staff") }, { token: "not-a-jwt" }), 401, "unauthorized");
  },
});

Deno.test({
  name: "no staff row: 403",
  ...OPTS,
  fn: async () => {
    await refusal(await run({ authOk: true, staff: null }), 403, "forbidden");
  },
});

Deno.test({
  name: "inactive staff: 403, whatever the role",
  ...OPTS,
  fn: async () => {
    for (const role of ["staff", "manager", "admin"]) {
      await refusal(await run({ authOk: true, staff: staffRow(role, false) }), 403, "forbidden");
    }
  },
});

Deno.test({
  name: "an active staff member passes with the default minRole, and gets the staff row and both clients",
  ...OPTS,
  fn: async () => {
    const r = await run({ authOk: true, staff: staffRow("staff") });
    assert(!(r.res instanceof Response), "expected a context");
    const ctx = r.res as GoldContext;
    assertEquals(ctx.staff, { id: STAFF_ID, reporting_entity_id: ENTITY_ID, role: "staff", full_name: "Sam Staff" });
    assert(ctx.userClient && ctx.adminClient);
    assert(!("is_active" in ctx.staff), "internal columns are not passed on");
  },
});

Deno.test({
  name: "roles: minRole is 'this role or higher' (admin passes a manager check, unlike has_role('manager'))",
  ...OPTS,
  fn: async () => {
    const cases: [string, "staff" | "manager" | "admin", boolean][] = [
      ["staff", "staff", true],
      ["manager", "staff", true],
      ["admin", "staff", true],
      ["staff", "manager", false],
      ["manager", "manager", true],
      ["admin", "manager", true],
      ["staff", "admin", false],
      ["manager", "admin", false],
      ["admin", "admin", true],
    ];
    for (const [role, minRole, allowed] of cases) {
      const r = await run({ authOk: true, staff: staffRow(role) }, { minRole });
      if (allowed) assert(!(r.res instanceof Response), `${role} should pass minRole ${minRole}`);
      else await refusal(r, 403, "forbidden");
    }
  },
});

Deno.test({
  name: "an unknown role value is refused rather than treated as staff",
  ...OPTS,
  fn: async () => {
    await refusal(await run({ authOk: true, staff: staffRow("owner") }), 403, "forbidden");
  },
});

Deno.test({
  name: "nothing is logged on any path",
  ...OPTS,
  fn: async () => {
    const all: Run[] = [
      await run({ authOk: true, staff: staffRow("staff") }, { enabled: null }),
      await run({ authOk: true, staff: staffRow("staff") }, { token: null }),
      await run({ authOk: false, staff: null }),
      await run({ authOk: true, staff: null }, { token: jwt("aal1") }),
      await run({ authOk: true, staff: staffRow("staff", false) }),
      await run({ authOk: true, staff: staffRow("staff") }),
    ];
    for (const r of all) assertEquals(r.logged, []);
  },
});
