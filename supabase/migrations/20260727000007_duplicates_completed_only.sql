-- find_unsuperseded_duplicates must only consider COMPLETED transactions.
--
-- Found in dev testing (finding #20) on the first real run of the reconciliation sweep's
-- detection query. It returned four rows where only two were drift: the extra pair was the
-- LIVE copy of a completed transaction, displaced by an in-progress draft.
--
-- Cause: the captures CTE read every new_capture row regardless of transaction status. A
-- draft holding a fresh photo of a document already on file therefore ranked as the newest
-- capture in its chain (rn = 1) and became the "keeper", demoting the completed
-- transaction's live images to duplicates awaiting supersede.
--
-- Consequence had this run with apply:true: the completed transaction's objects deleted and
-- its rows stamped as superseded by a DRAFT's image. Cancel that draft afterwards —
-- delete-draft-transaction removes its images — and the customer is left with NO live copy
-- at all, while a filed record points at a deleted image. Data loss on a legal record,
-- caused by cleanup.
--
-- A draft is work in progress, not something "on file". Supersede runs on completion, and
-- until then the draft's photo and the existing copy legitimately coexist. Only completed
-- transactions constitute the record that privacy policy §3 makes promises about.
--
-- This is the same omission previously fixed in the standing §3 invariant query, which also
-- counted drafts and so reported false breaches. That one only reported; this one deletes.
-- Any query that decides what is "on file" needs this filter — worth checking for it in
-- anything similar added later.

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
      JOIN ttr.transactions t ON t.id = idv.transaction_id
     WHERE idv.verification_basis = 'new_capture'
       AND (idv.front_image_id IS NOT NULL OR idv.back_image_id IS NOT NULL)
       -- Completed only. A draft's capture has superseded nothing yet and must never
       -- displace the copy already on file — see the migration header.
       AND t.status = 'complete'
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
  'Images that should be superseded but are not. Completed transactions only (a draft must '
  'never displace the copy on file), grouped by chain root (never by document number — that '
  'key deletes a different person''s ID).';
