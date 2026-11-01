import { assertEquals } from "std/assert";
import { supersedeImages } from "./supersede.ts";
import type { StorageOwner, SupabaseSchema } from "./supersede.ts";

// supersede.ts is selection-agnostic: it takes image ids and removes their objects, then
// stamps the rows. Gold's Update ID calls it for a customer's photos (customers/{id}/…),
// so these tests use customer-owned rows (no transaction) to pin down that it neither
// assumes a transaction owner nor a transaction-style path.

interface Row {
  id: string;
  object_path: string;
  superseded_at: string | null;
}

const CUSTOMER_ID = "c1000000-0000-0000-0000-000000000001";
const OLD_FRONT: Row = { id: "img-old-front", object_path: `customers/${CUSTOMER_ID}/v-1/front-a.jpg`, superseded_at: null };
const OLD_BACK: Row = { id: "img-old-back", object_path: `customers/${CUSTOMER_ID}/v-1/back-a.jpg`, superseded_at: null };

function fakes(rows: Row[], opts: { removeFails?: boolean } = {}) {
  const removed: string[][] = [];
  const updates: { values: Record<string, unknown>; ids: unknown[] }[] = [];

  const storage: StorageOwner = {
    storage: {
      from: (bucket: string) => ({
        remove: (paths: string[]) => {
          if (bucket !== "compliance-media") throw new Error(`unexpected bucket ${bucket}`);
          removed.push(paths);
          return Promise.resolve({ error: opts.removeFails ? { message: "storage down" } : null });
        },
      }),
    },
  };

  const schema = {
    from: () => {
      const self: Record<string, unknown> = {};
      let inIds: unknown[] | null = null;
      self.select = () => self;
      self.is = () => self;
      self.eq = () => self;
      self.in = (_c: string, vals: unknown[]) => {
        inIds = vals;
        return self;
      };
      self.update = (values: Record<string, unknown>) => ({
        in: (_c: string, ids: unknown[]) => {
          updates.push({ values, ids });
          return Promise.resolve({ data: null, error: null });
        },
      });
      self.then = (resolve: (v: unknown) => unknown) => {
        const live = rows.filter((r) => r.superseded_at === null && (inIds === null || inIds.includes(r.id)));
        return Promise.resolve({ data: live, error: null }).then(resolve);
      };
      return self;
    },
    // deno-lint-ignore no-explicit-any
  } as any as SupabaseSchema;

  return { storage, schema, removed, updates };
}

Deno.test("supersedes a customer's old photos: removes the objects, then stamps the rows with the replacement", async () => {
  const f = fakes([OLD_FRONT, OLD_BACK]);

  const result = await supersedeImages(f.storage, f.schema, [OLD_FRONT.id, OLD_BACK.id], "img-new-front");

  assertEquals(result.superseded.sort(), ["img-old-back", "img-old-front"]);
  assertEquals(result.failed, []);
  assertEquals(f.removed, [[OLD_FRONT.object_path, OLD_BACK.object_path]]);
  assertEquals(f.updates.length, 1);
  assertEquals(f.updates[0].values.superseded_by_image_id, "img-new-front");
  assertEquals(typeof f.updates[0].values.superseded_at, "string");
});

Deno.test("a customer photo already superseded is skipped, so its record of what replaced it is not overwritten", async () => {
  const f = fakes([{ ...OLD_FRONT, superseded_at: "2026-10-01T00:00:00Z" }, OLD_BACK]);

  const result = await supersedeImages(f.storage, f.schema, [OLD_FRONT.id, OLD_BACK.id], "img-new-front");

  assertEquals(result.skipped, [OLD_FRONT.id]);
  assertEquals(result.superseded, [OLD_BACK.id]);
  assertEquals(f.removed, [[OLD_BACK.object_path]]);
});

Deno.test("if the object cannot be removed, the row is left unstamped (fail safe), and nothing throws", async () => {
  const f = fakes([OLD_FRONT], { removeFails: true });
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await supersedeImages(f.storage, f.schema, [OLD_FRONT.id], "img-new-front");
    assertEquals(result.failed, [OLD_FRONT.id]);
    assertEquals(result.superseded, []);
    assertEquals(f.updates, []);
  } finally {
    console.error = originalError;
  }
});
