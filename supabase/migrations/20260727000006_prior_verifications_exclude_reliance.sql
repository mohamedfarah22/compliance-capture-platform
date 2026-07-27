-- The prior-verification pickers must offer CAPTURES, never reliance rows.
--
-- Found in dev testing (finding #18) immediately after a completed lapsed-window
-- transaction: the driver licence showed no image in the reliance picker while the
-- passport showed one.
--
-- Cause: both lookups take DISTINCT ON (document_type, document_number) ORDER BY
-- created_at DESC with no filter on verification_basis. Once a customer has a COMPLETED
-- reliance transaction for a document, that reliance row is the newest row for it and
-- shadows the actual capture. Reliance rows hold no images by design — they record having
-- reused a copy, not a copy — so two things follow, and the second is worse.
--
-- 1. No image renders, AND the match confirmation is skipped. validateCurrentPerson gates
--    it on the prior having a front image:
--        if (prior?.front_image_id && !currentData.imageApproved) e.imageApproval = …
--    With no image there is no requirement, so Continue succeeds with no attestation.
--    Privacy policy §3 says "We are still legally required to sight your physical ID on
--    every visit and confirm it matches our record" — that checkbox IS the confirmation
--    half, and this state bypassed it silently. Observed in dev: the box was neither shown
--    nor ticked, and the transaction completed.
--
-- 2. The re-verification window silently reset on every reliance. evaluateReliance
--    measures daysSince from prior.created_at. When the row returned is the reliance row,
--    created_at is when staff last relied — not when the document was captured. So a
--    licence photographed four years ago appeared eligible because last month's reliance
--    row was the newest. reporting_entities.idv_max_reliance_days would never have fired
--    for returning customers, which are exactly the customers it exists to catch. This
--    half produced no visible symptom at all.
--
-- Fix: restrict both lookups to verification_basis = 'new_capture'. A reliance row is not
-- something you can rely ON — it is a pointer to a capture, so offering it builds a
-- pointer to a pointer, and it necessarily carries no document copy. With it excluded,
-- DISTINCT ON lands on the newest actual capture, whose images survive (finding #9
-- supersedes older copies but always leaves the newest live), and the window is measured
-- from when the document was photographed. Both are the intended behaviour.
--
-- public.get_verification_for_document already filters this way, which is why the
-- collision path resolved to the right record while the picker did not. The two lookups
-- disagreed; now they agree.
--
-- CREATE OR REPLACE is sufficient — the return type is unchanged.
--
-- Why it went unseen until now: the lookups require t.status = 'complete', and the earlier
-- test run left its lapsed-window transaction as a draft, so no reliance row was ever
-- visible to them.

CREATE OR REPLACE FUNCTION public.get_prior_verifications_individual(
  p_last_name  text,
  p_first_name text,
  p_dob        date DEFAULT NULL
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
    t.staff_member_name AS verified_by_name,
    idv.front_image_id,
    idv.back_image_id
  FROM ttr.id_verifications idv
  JOIN ttr.parties           p  ON p.id = idv.party_id
  JOIN ttr.transactions      t  ON t.id = p.transaction_id
  WHERE t.reporting_entity_id = public.reporting_entity_id()
    AND t.status              = 'complete'
    AND p.party_type          = 'individual'
    -- Captures only. See the header: reliance rows shadow the real capture, hide its
    -- image, skip the match confirmation, and reset the re-verification window.
    AND idv.verification_basis = 'new_capture'
    AND lower(p.last_name)    = lower(p_last_name)
    AND lower(p.first_name)   = lower(p_first_name)
    AND (p_dob IS NULL OR p.date_of_birth = p_dob)
  ORDER BY idv.document_type::text, idv.document_number, idv.created_at DESC
  LIMIT 10;
$$;

CREATE OR REPLACE FUNCTION public.get_prior_verifications_company(
  p_entity_name    text,
  p_reg_identifier text DEFAULT NULL
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
    t.staff_member_name AS verified_by_name,
    idv.front_image_id,
    idv.back_image_id
  FROM ttr.id_verifications idv
  JOIN ttr.parties           p  ON p.id = idv.party_id
  JOIN ttr.transactions      t  ON t.id = p.transaction_id
  WHERE t.reporting_entity_id = public.reporting_entity_id()
    AND t.status              = 'complete'
    AND p.party_type          = 'company'
    AND idv.verification_basis = 'new_capture'   -- captures only; see the header
    AND lower(p.entity_name)  = lower(p_entity_name)
    AND (
      p_reg_identifier IS NULL
      OR replace(p.reg_identifier, ' ', '') = replace(p_reg_identifier, ' ', '')
    )
  ORDER BY idv.document_type::text, idv.document_number, idv.created_at DESC
  LIMIT 10;
$$;
