-- The three ID lookups learn about customer-level captures.
--
-- A customer-level capture (20261102000002) has no transaction, party or conducting person,
-- so every lookup that reached an ID through `JOIN ttr.transactions` or `JOIN ttr.parties`
-- silently skipped it. That would let a TTR capture a document gold already holds (the
-- collision prompt would not fire and Postgres would raise 23505 instead), hide a gold
-- customer's ID from a TTR for the same person, and leave a replaced customer photo
-- unsuperseded. Each is fixed below.

-- ─── 1. Collision lookup ─────────────────────────────────────────────────────────────────
-- Body as in 20260727000002, with:
--   * transactions joined with LEFT JOIN, so a customer-level row (no transaction) matches;
--   * owner_kind 'customer' and the customer's name / DOB for such a row;
--   * verified_by_name falls back to the staff member who took the photo (a customer-level
--     capture has no transaction to carry the staff name);
--   * a new last column, customer_id, so callers can open the customer that holds the ID.
-- Still mirrors uq_idv_doc_new_capture's predicate exactly. DROP required: the return type
-- changes. Grants are re-applied; the old function carried the default EXECUTE to PUBLIC.

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
  owner_dob          date,
  customer_id        uuid
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
      idv.customer_id,
      t.transaction_ref,
      COALESCE(t.staff_member_name, sm.full_name) AS verified_by_name,
      CASE
        WHEN idv.party_id IS NOT NULL             THEN 'party'
        WHEN idv.conducting_person_id IS NOT NULL THEN 'conducting_person'
        ELSE 'customer'
      END                              AS owner_kind,
      -- Individuals only: a company party has no ID verification record of its own, so
      -- concat_ws over the name parts is safe here. It also drops NULL middle names
      -- rather than leaving a double space.
      COALESCE(
        NULLIF(btrim(concat_ws(' ', p.first_name, p.middle_name, p.last_name)), ''),
        cp.full_name,
        NULLIF(btrim(concat_ws(' ', cu.first_name, cu.middle_name, cu.last_name)), '')
      )                                AS owner_name,
      -- cp.date_of_birth is only meaningful when dob_known; chk_cp_dob permits a NULL
      -- date whenever dob_known is false.
      COALESCE(p.date_of_birth, CASE WHEN cp.dob_known THEN cp.date_of_birth END, cu.date_of_birth) AS owner_dob
    FROM ttr.id_verifications idv
    LEFT JOIN ttr.transactions       t  ON t.id  = idv.transaction_id
    LEFT JOIN ttr.parties            p  ON p.id  = idv.party_id
    LEFT JOIN ttr.conducting_persons cp ON cp.id = idv.conducting_person_id
    -- Only a customer-level row names its owner through the customer; a party row already
    -- has the party's own details.
    LEFT JOIN public.customers       cu ON cu.id = idv.customer_id
                                       AND idv.party_id IS NULL AND idv.conducting_person_id IS NULL
    LEFT JOIN ttr.stored_images      si ON si.id = COALESCE(idv.front_image_id, idv.back_image_id)
    LEFT JOIN public.staff_members   sm ON sm.id = si.captured_by_staff_id
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
    m.owner_kind, m.owner_name, m.owner_dob, m.customer_id
  FROM match m
  LEFT JOIN live l ON TRUE;
$$;

REVOKE EXECUTE ON FUNCTION public.get_verification_for_document(text, text, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_verification_for_document(text, text, uuid) TO authenticated, service_role;

-- ─── 2. Prior verifications for an individual ────────────────────────────────────────────
-- Body as in 20260727000006 (captures only, newest per document, completed TTRs only), plus:
--   * p_customer_id: when given, returns every capture held for that customer, which is
--     the customer-level captures (no transaction) and the captures from their completed
--     TTRs (id_verifications.customer_id is filled on completion and backfilled). Names are
--     then ignored, so a namesake's ID can never be offered.
--   * name + DOB stays as the fallback when no customer_id is given (a person typed in by
--     hand). It now also matches customer-level captures through the customer's name and
--     DOB, so a hand-typed party still finds an ID gold took.
--   * transactions are LEFT JOINed: a customer-level capture is "on file" as soon as it
--     exists (there is no draft stage for it), a TTR capture only once its TTR is complete.
-- The signature gains a parameter, so the old three-argument function is dropped (leaving
-- it would make a call with named arguments ambiguous). Same columns as before. The only
-- caller is wizardApi.fetchPriorVerifications; it passes names by name and is updated to
-- pass p_customer_id. Names get defaults so a caller holding only a customer can omit them.
-- Everything stays scoped to the caller's reporting entity.

DROP FUNCTION IF EXISTS public.get_prior_verifications_individual(text, text, date);

CREATE FUNCTION public.get_prior_verifications_individual(
  p_last_name   text DEFAULT NULL,
  p_first_name  text DEFAULT NULL,
  p_dob         date DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL
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
  back_image_id      uuid
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT ON (idv.document_type::text, idv.document_number)
    idv.id,
    idv.document_type::text,
    idv.document_number,
    idv.issuer,
    idv.has_expiry,
    idv.expiry_date,
    idv.verification_basis::text,
    idv.created_at,
    t.transaction_ref,
    COALESCE(t.staff_member_name, sm.full_name) AS verified_by_name,
    idv.front_image_id,
    idv.back_image_id
  FROM ttr.id_verifications idv
  LEFT JOIN ttr.transactions     t  ON t.id  = idv.transaction_id
  LEFT JOIN ttr.parties          p  ON p.id  = idv.party_id
  LEFT JOIN public.customers     cu ON cu.id = idv.customer_id
                                   AND idv.party_id IS NULL AND idv.conducting_person_id IS NULL
  LEFT JOIN ttr.stored_images    si ON si.id = COALESCE(idv.front_image_id, idv.back_image_id)
  LEFT JOIN public.staff_members sm ON sm.id = si.captured_by_staff_id
  WHERE idv.reporting_entity_id = public.reporting_entity_id()
    -- Captures only. See 20260727000006: reliance rows shadow the real capture, hide its
    -- image, skip the match confirmation, and reset the re-verification window.
    AND idv.verification_basis = 'new_capture'
    -- A conducting person is never looked up this way.
    AND idv.conducting_person_id IS NULL
    -- Customer-level (no transaction), or from a completed TTR.
    AND (idv.transaction_id IS NULL OR t.status = 'complete')
    AND (
      (p_customer_id IS NOT NULL AND idv.customer_id = p_customer_id)
      OR
      (p_customer_id IS NULL AND (
        (p.party_type = 'individual'
           AND lower(p.last_name)  = lower(p_last_name)
           AND lower(p.first_name) = lower(p_first_name)
           AND (p_dob IS NULL OR p.date_of_birth = p_dob))
        OR
        (cu.customer_type = 'individual'
           AND lower(cu.last_name)  = lower(p_last_name)
           AND lower(cu.first_name) = lower(p_first_name)
           AND (p_dob IS NULL OR cu.date_of_birth = p_dob))
      ))
    )
  ORDER BY idv.document_type::text, idv.document_number, idv.created_at DESC
  LIMIT 10;
$$;

REVOKE EXECUTE ON FUNCTION public.get_prior_verifications_individual(text, text, date, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_prior_verifications_individual(text, text, date, uuid) TO authenticated, service_role;

-- ─── 3. Unsuperseded duplicates (the reconcile sweep's detection query) ──────────────────
-- Body as in 20260727000007, with the transactions join relaxed. That join dropped every
-- customer-level capture, so a chain whose oldest link was captured by gold looked like a
-- chain of one: the old customer photo was never reported as a duplicate once a TTR
-- re-captured the same document, and a renewal inside gold would not have been either.
-- "Complete" means: a customer-level capture (it has no draft stage) or one from a
-- completed TTR. A draft still never displaces the copy on file.
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
      LEFT JOIN ttr.transactions t ON t.id = idv.transaction_id
     WHERE idv.verification_basis = 'new_capture'
       AND (idv.front_image_id IS NOT NULL OR idv.back_image_id IS NOT NULL)
       -- Completed only: a customer-level capture (no transaction) or a completed TTR's.
       -- A draft's capture has superseded nothing yet and must never displace the copy
       -- already on file — see 20260727000007.
       AND (idv.transaction_id IS NULL OR t.status = 'complete')
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
