// Test helper for the gold-* function tests (not a test itself, so Deno does not run it).
// The real supabase-js clients talk to a stubbed fetch: Auth, the staff lookup and the
// default "nothing found" answers are built in, and each test supplies `handler` for the
// calls it cares about (RPCs, tables, storage). No network is touched.

import type { GoldRole } from "./goldAuth.ts";

Deno.env.set("SUPABASE_URL", "http://stub.test");
Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");

export const STAFF_ID = "11111111-1111-1111-1111-111111111111";
export const ENTITY_ID = "e1111111-1111-1111-1111-111111111111";
export const CUSTOMER_ID = "c1111111-1111-1111-1111-111111111111";

// The Supabase client starts an auth refresh timer; irrelevant to request/response code.
export const OPTS = { sanitizeOps: false, sanitizeResources: false };

const b64url = (obj: unknown) => btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** An unsigned JWT with the given assurance level; the stubbed Auth accepts it. */
export const jwt = (aal = "aal2") => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: STAFF_ID, aal })}.sig`;

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export interface Call {
  method: string;
  /** Path after /rest/v1, /storage/v1 or /auth/v1, e.g. "/rpc/gold_create_customer". */
  path: string;
  /** Prefix: "rest", "storage" or "auth". */
  api: string;
  body: unknown;
  query: string;
  schema: string | null;
}

export interface Scenario {
  role?: GoldRole;
  /** null = no staff row. */
  staff?: Record<string, unknown> | null;
  authOk?: boolean;
  /** Answer a call; return undefined to fall through to the default (empty list / empty storage reply). */
  handler?: (call: Call) => Response | unknown | undefined;
}

export interface Run {
  res: Response;
  calls: Call[];
  logged: string[];
}

/** Calls to one RPC, in order. */
export const rpcCalls = (run: Run, name: string) => run.calls.filter((c) => c.path === `/rpc/${name}`);
export const storageCalls = (run: Run, method: string) =>
  run.calls.filter((c) => c.api === "storage" && c.method === method);

export async function run(
  handle: (req: Request) => Promise<Response>,
  req: Request,
  scenario: Scenario = {},
  env: { enabled?: string | null } = {},
): Promise<Run> {
  const enabled = env.enabled === undefined ? "true" : env.enabled;
  if (enabled === null) Deno.env.delete("GOLD_JOURNEY_ENABLED");
  else Deno.env.set("GOLD_JOURNEY_ENABLED", enabled);

  const staff =
    scenario.staff === undefined
      ? {
          id: STAFF_ID,
          reporting_entity_id: ENTITY_ID,
          role: scenario.role ?? "staff",
          full_name: "Test Staff",
          is_active: true,
        }
      : scenario.staff;

  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const api = url.pathname.split("/")[1] === "rest" ? "rest" : url.pathname.split("/")[1] === "storage" ? "storage" : "auth";
    const path = url.pathname.replace(/^\/(rest|storage|auth)\/v1/, "");
    const wantsObject = (request.headers.get("accept") ?? "").includes("pgrst.object");
    let body: unknown = null;
    const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text; // an uploaded file
      }
    }
    const call: Call = { method: request.method, path, api, body, query: decodeURIComponent(url.search), schema: request.headers.get("accept-profile") ?? request.headers.get("content-profile") };
    calls.push(call);

    if (path === "/user") {
      return scenario.authOk === false
        ? jsonResponse({ msg: "invalid JWT" }, 401)
        : jsonResponse({ id: STAFF_ID, aud: "authenticated", email: "staff@example.test" });
    }
    if (path === "/staff_members") {
      return staff
        ? jsonResponse(wantsObject ? staff : [staff])
        : jsonResponse({ code: "PGRST116", message: "no rows", details: null, hint: null }, 406);
    }
    const custom = scenario.handler?.(call);
    if (custom instanceof Response) return custom;
    if (custom !== undefined) return jsonResponse(custom);
    if (api === "storage") return jsonResponse({ Key: path, message: "ok" });
    return jsonResponse(wantsObject ? null : []);
  };

  const logged: string[] = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const k of Object.keys(originals) as (keyof typeof originals)[]) {
    console[k] = (...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  }

  try {
    const res = await handle(req);
    return { res, calls, logged };
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(console, originals);
  }
}

export function post(body: BodyInit | null, headers: Record<string, string> = {}, token: string | null = jwt()): Request {
  const h: Record<string, string> = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  return new Request("http://stub.test/fn", { method: "POST", headers: h, body });
}

export const postJson = (body: unknown, token: string | null = jwt()) =>
  post(JSON.stringify(body), { "Content-Type": "application/json" }, token);

/** A multipart request: `payload` as a JSON string, plus the given image files. */
export function postForm(payload: unknown, files: Record<string, Uint8Array> = {}, token: string | null = jwt()) {
  const form = new FormData();
  form.set("payload", JSON.stringify(payload));
  for (const [name, bytes] of Object.entries(files)) {
    form.set(name, new File([bytes as BlobPart], `${name}.jpg`, { type: "image/jpeg" }));
  }
  return post(form, {}, token);
}

export const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
/** SHA-256 of PHOTO, computed independently with `printf '\xff\xd8\xff\xe0\x01\x02\x03\x04' | sha256sum`. */
export const PHOTO_SHA256 = "73fd127876cb1552466d2c9806524fe33826bf160b0c82092ab5b082f890e132";
