-- Tells the UI WHOSE record a document-number collision hit.
--
-- The problem (UAT finding #8): when staff enter a document number already on file, the
-- "Reason for taking a new copy" dropdown offers 'id_changed', 'stored_copy_unclear' and
-- 'different_person' with nothing distinguishing them by whose record is being collided
-- with. Choosing 'id_changed' links the new capture to the existing record, asserting the
-- two are the same document across a renewal. Confirmed live in UAT R19: a second
-- customer's licence capture was linked to an unrelated customer's record.
--
-- 'different_person' exists precisely to record "licence numbers are unique per state,
-- not nationally, and I sighted both". It cannot be the honest choice if staff are never
-- told they are looking at someone else's record. So the lookup now returns the owner,
-- which lets IdVerificationPage both name them and withhold the linking reasons.
--
-- Two changes to the same function:
--
-- 1. owner_kind / owner_name / owner_dob — the identity behind the matched row. Exactly
--    one of party_id / conducting_person_id is set on any id_verifications row (the rule
--    is role-agnostic and covers the crossover case where the same real person is a
--    customer on one transaction and a conducting person on another), so the two LEFT
--    JOINs never both hit.
--
-- 2. front_image_id / back_image_id now return the SURVIVING images for the document,
--    not this row's own. The row this function returns is by definition the unlinked one
--    — the oldest — and 20260727000001 supersedes exactly those images when a re-capture
--    replaces them. Returning its own ids would show staff a thumbnail whose object has
--    been deleted. `id` still refers to the unlinked row, because that is the correct
--    link target for a re-capture and what uq_idv_doc_new_capture rejects against.
--
-- DROP required: PostgreSQL disallows changing a function's return type via CREATE OR
-- REPLACE. Precedent: 20260630000001_prior_verifications_add_images.sql.

DROP FUNCTION IF EXISTS public.get_verification_for_document(text, text, uuid);

CREATE FUNCTION public.get_verification_for_document(
  p_document_type   text,
  p_document_number text,
  p_exclude_id      uuid DEFAULT NULL
)
RETURNS TABLE (
  id                 uuid,
  document_type      text,
  document_number    text,
  issuer             text,
  has_expiry         boolean,
  expiry_date        date,
  verification_basis text,
  created_at         timestamptz,
  transaction_ref    text,
  verified_by_name   text,
  front_image_id     uuid,
  back_image_id      uuid,
  owner_kind         text,
  owner_name         text,
  owner_dob          date
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH match AS (
    SELECT
      idv.id,
      idv.document_type::text          AS document_type,
      idv.document_number,
      idv.issuer,
      idv.has_expiry,
      idv.expiry_date,
      idv.verification_basis::text     AS verification_basis,
      idv.created_at,
      idv.reporting_entity_id,
      t.transaction_ref,
      t.staff_member_name              AS verified_by_name,
      CASE WHEN idv.party_id IS NOT NULL THEN 'party' ELSE 'conducting_person' END AS owner_kind,
      -- Individuals only: a company party has no ID verification record of its own, so
      -- concat_ws over the name parts is safe here. It also drops NULL middle names
      -- rather than leaving a double space.
      COALESCE(
        NULLIF(btrim(concat_ws(' ', p.first_name, p.middle_name, p.last_name)), ''),
        cp.full_name
      )                                AS owner_name,
      -- cp.date_of_birth is only meaningful when dob_known; chk_cp_dob permits a NULL
      -- date whenever dob_known is false.
      COALESCE(p.date_of_birth, CASE WHEN cp.dob_known THEN cp.date_of_birth END) AS owner_dob
    FROM ttr.id_verifications idv
    JOIN ttr.transactions        t  ON t.id  = idv.transaction_id
    LEFT JOIN ttr.parties            p  ON p.id  = idv.party_id
    LEFT JOIN ttr.conducting_persons cp ON cp.id = idv.conducting_person_id
    WHERE idv.reporting_entity_id = public.reporting_entity_id()
      AND idv.verification_basis  = 'new_capture'
      AND idv.prior_verification_id IS NULL
      AND idv.new_capture_reason IS DISTINCT FROM 'different_person'
      AND idv.document_type::text = p_document_type
      AND upper(btrim(idv.document_number)) = upper(btrim(p_document_number))
      AND (p_exclude_id IS NULL OR idv.id <> p_exclude_id)
    LIMIT 1
  ),
  -- The most recent capture of this same document that still holds live images. After a
  -- re-capture supersedes the original, this is the newer row; before any re-capture it
  -- is the matched row itself.
  live AS (
    SELECT idv.front_image_id, idv.back_image_id
      FROM ttr.id_verifications idv
      JOIN match m ON TRUE
      LEFT JOIN ttr.stored_images fi ON fi.id = idv.front_image_id
     WHERE idv.reporting_entity_id = m.reporting_entity_id
       AND idv.document_type::text = m.document_type
       AND upper(btrim(idv.document_number)) = upper(btrim(m.document_number))
       AND idv.front_image_id IS NOT NULL
       AND fi.superseded_at IS NULL
     ORDER BY idv.created_at DESC
     LIMIT 1
  )
  SELECT
    m.id, m.document_type, m.document_number, m.issuer, m.has_expiry, m.expiry_date,
    m.verification_basis, m.created_at, m.transaction_ref, m.verified_by_name,
    l.front_image_id, l.back_image_id,
    m.owner_kind, m.owner_name, m.owner_dob
  FROM match m
  LEFT JOIN live l ON TRUE;
$$;
