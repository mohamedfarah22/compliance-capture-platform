// Fake Supabase clients for the gold function tests (no network). Used only by *.test.ts files.
//
// A fake answers the narrow slice of the client surface the gold functions use:
//   from(table).select().eq().in().order()      then single() / maybeSingle() / await
//   rpc(name, args), schema("gold").rpc(...) / .from(...)
//   storage.from(bucket).upload / remove / createSignedUrls
// Tables and RPCs are keyed by name; gold ones are prefixed "gold." (e.g. "gold.purchases",
// "gold.linked_parts"). Every call is appended to `calls`, so a test can assert what was (not) done.

import type { GoldContext } from "./goldAuth.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export interface FakeSpec {
  /** Rows a select returns, before the eq() / in() filters are applied. */
  tables?: Record<string, Row[]>;
  /** What an rpc returns: a value, or a function of its arguments. */
  rpcs?: Record<string, unknown | ((args: Row) => unknown)>;
  /** An rpc, table or storage call that fails, with the code it fails with. */
  errors?: Record<string, { code: string }>;
  /** Fail the nth storage upload (1-based). */
  failUploadAt?: number;
}

export interface Call {
  kind: "select" | "rpc" | "upload" | "remove" | "sign";
  name: string;
  args?: unknown;
}

export interface Fake {
  client: unknown;
  calls: Call[];
  uploads: Map<string, ArrayBuffer>;
  /** Arguments of every call to the named rpc. */
  rpcArgs: (name: string) => Row[];
}

export function fakeClient(spec: FakeSpec = {}): Fake {
  const calls: Call[] = [];
  const uploads = new Map<string, ArrayBuffer>();
  let uploadCount = 0;

  const rpc = (prefix: string) => (name: string, args: Row) => {
    const key = `${prefix}${name}`;
    calls.push({ kind: "rpc", name: key, args });
    if (spec.errors?.[key]) return Promise.resolve({ data: null, error: spec.errors[key] });
    const value = spec.rpcs?.[key];
    return Promise.resolve({ data: typeof value === "function" ? value(args) : (value ?? null), error: null });
  };

  const from = (prefix: string) => (table: string) => {
    const key = `${prefix}${table}`;
    const filters: ((r: Row) => boolean)[] = [];
    const query = {
      select(columns: string) {
        calls.push({ kind: "select", name: key, args: columns });
        return query;
      },
      eq(column: string, value: unknown) {
        filters.push((r) => r[column] === value);
        return query;
      },
      in(column: string, values: unknown[]) {
        filters.push((r) => values.includes(r[column]));
        return query;
      },
      order() {
        return query;
      },
      run() {
        if (spec.errors?.[key]) return { data: null, error: spec.errors[key] };
        return { data: (spec.tables?.[key] ?? []).filter((r) => filters.every((f) => f(r))), error: null };
      },
      single() {
        const { data, error } = query.run();
        return Promise.resolve(error ? { data: null, error } : { data: data![0] ?? null, error: data![0] ? null : { code: "PGRST116" } });
      },
      maybeSingle() {
        const { data, error } = query.run();
        return Promise.resolve({ data: data?.[0] ?? null, error });
      },
      // deno-lint-ignore no-explicit-any
      then(resolve: (v: any) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(query.run()).then(resolve, reject);
      },
    };
    return query;
  };

  const storage = {
    from: (bucket: string) => ({
      upload(path: string, bytes: ArrayBuffer) {
        calls.push({ kind: "upload", name: `${bucket}/${path}` });
        uploadCount++;
        if (spec.failUploadAt === uploadCount) return Promise.resolve({ data: null, error: { statusCode: "500" } });
        uploads.set(`${bucket}/${path}`, bytes);
        return Promise.resolve({ data: { path }, error: null });
      },
      remove(paths: string[]) {
        calls.push({ kind: "remove", name: bucket, args: paths });
        for (const p of paths) uploads.delete(`${bucket}/${p}`);
        return Promise.resolve({ data: null, error: spec.errors?.["storage.remove"] ?? null });
      },
      createSignedUrls(paths: string[], ttl: number) {
        calls.push({ kind: "sign", name: bucket, args: { paths, ttl } });
        if (spec.errors?.["storage.sign"]) return Promise.resolve({ data: null, error: spec.errors["storage.sign"] });
        return Promise.resolve({
          data: paths.map((p) => ({ signedUrl: `https://signed.test/${p}?ttl=${ttl}`, error: null })),
          error: null,
        });
      },
    }),
  };

  const client = {
    from: from(""),
    rpc: rpc(""),
    schema: (name: string) => ({ from: from(`${name}.`), rpc: rpc(`${name}.`) }),
    storage,
  };
  return {
    client,
    calls,
    uploads,
    rpcArgs: (name) => calls.filter((c) => c.kind === "rpc" && c.name === name).map((c) => c.args as Row),
  };
}

export const STAFF_ID = "11111111-1111-1111-1111-111111111111";
export const ENTITY_ID = "e1111111-1111-1111-1111-111111111111";

/** A GoldContext made of two fakes: userClient (reads as the caller) and adminClient (service role). */
export function fakeContext(user: FakeSpec, admin: FakeSpec): { ctx: GoldContext; user: Fake; admin: Fake } {
  const u = fakeClient(user);
  const a = fakeClient(admin);
  return {
    ctx: {
      staff: { id: STAFF_ID, reporting_entity_id: ENTITY_ID, role: "staff", full_name: "Sam Staff" },
      userClient: u.client,
      adminClient: a.client,
    } as unknown as GoldContext,
    user: u,
    admin: a,
  };
}

/** Captures everything logged while fn runs, so a test can assert nothing sensitive was written. */
export async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(originals) as (keyof typeof originals)[]) {
    console[k] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  }
  try {
    return { result: await fn(), logged };
  } finally {
    Object.assign(console, originals);
  }
}
