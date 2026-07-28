// Deleting a draft transaction's non-cascading children, in the order the FKs require.

export interface SupabaseSchema {
  from: (table: string) => {
    delete: () => { eq: (col: string, val: unknown) => PromiseLike<{ error: unknown }> };
  };
}

// Most of a transaction's children are ON DELETE CASCADE (parties, conducting_persons,
// recipient_deliveries, bullion_items, precious_metal_items) and need no help. Two do not,
// and the ORDER between them is load-bearing:
//
//   1. id_verifications — would cascade with the transaction, but its front_image_id /
//      back_image_id reference stored_images with no cascade of their own, so it has to go
//      before the images rather than with the transaction.
//   2. stored_images — ON DELETE RESTRICT on transaction_id, which is what blocks the
//      transaction delete itself.
//
// Getting this wrong is not a subtle failure. Before this existed, cancelling ANY draft
// that had ID photos captured failed outright (UAT finding #13), leaving the operator with
// a transaction they could neither complete nor discard and no way out short of SQL — and
// cleanup-stale-drafts silently skipped the same drafts forever, so their ID images
// accumulated with nothing accounting for them.
export async function deleteRestrictingChildren(
  ttr: SupabaseSchema,
  transactionId: string,
): Promise<unknown | null> {
  for (const table of ["id_verifications", "stored_images"]) {
    const { error } = await ttr.from(table).delete().eq("transaction_id", transactionId);
    if (error) return error;
  }
  return null;
}
