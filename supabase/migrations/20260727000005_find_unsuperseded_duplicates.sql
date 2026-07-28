-- Detection query for reconcile-stored-images: copies of one document that should have
-- been superseded but were not.
--
-- complete-transaction supersedes prior copies when a linked re-capture completes, and is
-- deliberately non-fatal — a storage hiccup must never roll back a completed legal record.
-- The cost of that choice is that a transient failure leaves a duplicate on file
-- permanently, which is a privacy policy §3 breach rather than untidiness. This makes §3
-- self-healing instead of dependent on every write succeeding first time.
--
-- ─── PARTITION BY chain_root, NOT by document number ────────────────────────────────
--
-- This is the whole point of the function, and the mistake worth guarding against.
--
-- The obvious key is (reporting_entity_id, document_type, upper(btrim(document_number))) —
-- what uq_idv_doc_new_capture uses. It is WRONG here. That index answers "may a second
-- unlinked row exist", and it deliberately EXEMPTS new_capture_reason = 'different_person',
-- because document numbers are unique per state and not nationally, so two unrelated people
-- can genuinely hold the same one.
--
-- Using it to decide "may this image be destroyed" therefore sweeps in a different
-- customer's ID. That exact bug shipped in supersedePriorImages (UAT finding #15) and would
-- have deleted an unrelated customer's licence images; here it would have done so across
-- the entire history in a single run.
--
-- chain_root = coalesce(prior_verification_id, id) is person-safe by construction:
--   * a 'different_person' capture is always unlinked, so it is its own root and can never
--     share one with somebody else's chain;
--   * trg_idv_recapture_link (finding #8) rejects any link whose target belongs to a
--     different person, so a chain cannot span two people either.
--
-- It also cannot be chain-FOLLOWING from the newest row. Every linked re-capture points at
-- the unlinked row (that is the only row get_verification_for_document returns), so two
-- re-captures of one document link to the same root rather than to each other — following
-- one row's link would leave the other's images live, which is the duplicate §3 forbids.
--
-- SECURITY INVOKER (the default), deliberately not DEFINER. The service-role caller
-- bypasses RLS and sees every entity; an ordinary authenticated caller sees only their own.
-- A DEFINER function with no entity filter would be a cross-tenant leak.

CREATE OR REPLACE FUNCTION ttr.find_unsuperseded_duplicates()
RETURNS TABLE (
  image_id             uuid,
  object_path          text,
  idv_id               uuid,
  replacement_image_id uuid
)
LANGUAGE sql STABLE
SET search_path = ttr
AS $$
  WITH captures AS (
    SELECT idv.id,
           coalesce(idv.prior_verification_id, idv.id) AS chain_root,
           idv.created_at,
           idv.front_image_id,
           idv.back_image_id
      FROM ttr.id_verifications idv
     WHERE idv.verification_basis = 'new_capture'
       AND (idv.front_image_id IS NOT NULL OR idv.back_image_id IS NOT NULL)
  ),
  ranked AS (
    SELECT c.*,
           row_number() OVER (
             PARTITION BY c.chain_root ORDER BY c.created_at DESC, c.id) AS rn,
           -- The surviving capture's image, recorded as what replaced the others.
           -- coalesce because a passport has a front image and no back.
           first_value(coalesce(c.front_image_id, c.back_image_id)) OVER (
             PARTITION BY c.chain_root ORDER BY c.created_at DESC, c.id) AS keeper
      FROM captures c
  )
  SELECT si.id, si.object_path, r.id, r.keeper
    FROM ranked r
    JOIN ttr.stored_images si
      ON si.id IN (r.front_image_id, r.back_image_id)
   WHERE r.rn > 1                    -- every capture except the newest in its chain
     AND si.superseded_at IS NULL    -- already-handled rows are left alone
     AND si.id IS DISTINCT FROM r.keeper;
$$;

COMMENT ON FUNCTION ttr.find_unsuperseded_duplicates() IS
  'Images that should be superseded but are not, grouped by chain root (never by document '
  'number — see the migration header; that key deletes a different person''s ID).';
