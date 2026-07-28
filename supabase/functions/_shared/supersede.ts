// Superseding an ID image: delete the object, keep the metadata row.
//
// Privacy policy §3 tells customers "we keep one copy of your identification on file —
// not a new copy for every visit". AML/CTF requires records of identification procedures
// be retained for seven years. Those pull in opposite directions, and this is where the
// trade is made: the storage OBJECT is deleted, the ttr.stored_images ROW is kept and
// stamped. The row still proves a document was sighted, by whom, when, and what it hashed
// to; the image itself is genuinely gone, which is what §3 actually promises.
//
// Callers decide WHICH images to supersede — that selection is where the danger is (see
// the chain-root note in complete-transaction) and it is deliberately not in here.

export interface FilterBuilder
  extends PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }> {
  eq: (col: string, val: unknown) => FilterBuilder;
  in: (col: string, vals: unknown[]) => FilterBuilder;
  is: (col: string, val: unknown) => FilterBuilder;
}

// from() yields select/update; the filter methods only exist on what those return.
export interface SupabaseSchema {
  from: (table: string) => {
    select: (cols: string) => FilterBuilder;
    update: (values: Record<string, unknown>) => FilterBuilder;
  };
}

export interface StorageOwner {
  storage: {
    from: (bucket: string) => { remove: (paths: string[]) => PromiseLike<{ error: unknown }> };
  };
}

export const STORAGE_BUCKET = "compliance-media";

export interface SupersedeResult {
  superseded: string[];   // image ids whose object was removed and row stamped
  skipped: string[];      // already superseded by an earlier run
  failed: string[];       // attempted, left live — a later run retries
}

/**
 * Removes the objects for `imageIds` and stamps their rows as superseded by
 * `replacementImageId`. Never throws, and never deletes a row.
 *
 * Objects are removed BEFORE rows are stamped, deliberately. Stamping first would leave
 * live images behind a flag claiming they were deleted — a lie in the audit trail, and one
 * that stops any later run from cleaning them up. This order fails safe: an un-superseded
 * image is a duplicate to sweep later; a wrongly-stamped one is invisible.
 */
export async function supersedeImages(
  client: StorageOwner,
  ttr: SupabaseSchema,
  imageIds: string[],
  replacementImageId: string,
): Promise<SupersedeResult> {
  const result: SupersedeResult = { superseded: [], skipped: [], failed: [] };
  const candidates = imageIds.filter(Boolean);
  if (candidates.length === 0) return result;

  try {
    // Skip anything an earlier run already handled — its object is long gone, and
    // re-stamping would overwrite the record of what actually replaced it.
    const { data: live, error: lookupError } = await ttr
      .from("stored_images")
      .select("id, object_path")
      .in("id", candidates)
      .is("superseded_at", null);

    if (lookupError) {
      console.error("supersede: image lookup failed", lookupError);
      result.failed.push(...candidates);
      return result;
    }

    const rows = live ?? [];
    result.skipped.push(...candidates.filter((id) => !rows.some((r) => r.id === id)));
    if (rows.length === 0) return result;

    const ids = rows.map((r) => r.id as string);
    const { error: removeError } = await client.storage
      .from(STORAGE_BUCKET)
      .remove(rows.map((r) => r.object_path as string));

    if (removeError) {
      console.error("supersede: storage remove failed", removeError);
      result.failed.push(...ids);
      return result;
    }

    const { error: markError } = await ttr
      .from("stored_images")
      .update({
        superseded_at: new Date().toISOString(),
        superseded_by_image_id: replacementImageId,
      })
      .in("id", ids);

    if (markError) {
      console.error("supersede: marking rows failed", markError);
      result.failed.push(...ids);
      return result;
    }

    result.superseded.push(...ids);
  } catch (err) {
    console.error("supersede: unexpected error", err);
  }
  return result;
}
