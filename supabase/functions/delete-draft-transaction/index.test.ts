import { assertEquals } from "std/assert";
import { deleteRestrictingChildren } from "./index.ts";
import type { SupabaseSchema } from "./index.ts";

// Cancelling a draft that had ID photos captured used to fail outright (UAT finding #13):
// ttr.stored_images.transaction_id is ON DELETE RESTRICT, and nothing removed those rows
// before deleting the transaction. The operator was left with a draft they could neither
// complete nor discard — no forward path, no backward path.
//
// The order between the two tables is load-bearing, so that is what these lock down.

function makeFake(state: { order: string[]; failOn?: string }) {
  return {
    from: (table: string) => ({
      delete: () => ({
        eq: (_col: string, _val: unknown) => {
          state.order.push(table);
          return Promise.resolve({
            error: state.failOn === table ? { message: `${table} exploded` } : null,
          });
        },
      }),
    }),
  } as SupabaseSchema;
}

Deno.test("deletes id_verifications before stored_images — the images FK points the other way", async () => {
  const state = { order: [] as string[] };

  const error = await deleteRestrictingChildren(makeFake(state), "tx-1");

  assertEquals(error, null);
  // Reversing these fails: id_verifications.front_image_id / back_image_id reference
  // stored_images with no cascade, so the images cannot go first.
  assertEquals(state.order, ["id_verifications", "stored_images"]);
});

Deno.test("stops at the first failure rather than pressing on to delete the transaction", async () => {
  const state = { order: [] as string[], failOn: "id_verifications" };

  const error = await deleteRestrictingChildren(makeFake(state), "tx-1");

  assertEquals((error as { message: string }).message, "id_verifications exploded");
  // stored_images must NOT have been attempted — the caller aborts on a non-null return,
  // so a partial delete never reaches the transaction row.
  assertEquals(state.order, ["id_verifications"]);
});

Deno.test("surfaces a stored_images failure so the transaction delete is not attempted", async () => {
  const state = { order: [] as string[], failOn: "stored_images" };

  const error = await deleteRestrictingChildren(makeFake(state), "tx-1");

  assertEquals((error as { message: string }).message, "stored_images exploded");
  assertEquals(state.order, ["id_verifications", "stored_images"]);
});
