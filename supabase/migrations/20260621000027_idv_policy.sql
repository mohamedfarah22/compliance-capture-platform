-- ─── ID Verification Policy ──────────────────────────────────────────────────
--
-- Adds per-entity policy columns to reporting_entities and two SECURITY DEFINER
-- RPCs (in the public schema so PostgREST can call them without .schema('ttr'))
-- that return prior id_verifications for a person by identity match.

ALTER TABLE public.reporting_entities
  ADD COLUMN idv_max_reliance_days INTEGER NOT NULL DEFAULT 730,
  ADD COLUMN idv_block_on_expired  BOOLEAN NOT NULL DEFAULT false;

-- Individual prior verification lookup ─────────────────────────────────────

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
  verified_by_name   text
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
    t.staff_member_name AS verified_by_name
  FROM ttr.id_verifications idv
  JOIN ttr.parties           p  ON p.id = idv.party_id
  JOIN ttr.transactions      t  ON t.id = p.transaction_id
  WHERE t.reporting_entity_id = public.reporting_entity_id()
    AND t.status              = 'complete'
    AND p.party_type          = 'individual'
    AND lower(p.last_name)    = lower(p_last_name)
    AND lower(p.first_name)   = lower(p_first_name)
    AND (p_dob IS NULL OR p.date_of_birth = p_dob)
  ORDER BY idv.document_type::text, idv.document_number, idv.created_at DESC
  LIMIT 10;
$$;

-- ─── Company prior verification lookup ───────────────────────────────────────

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
  verified_by_name   text
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
    t.staff_member_name AS verified_by_name
  FROM ttr.id_verifications idv
  JOIN ttr.parties           p  ON p.id = idv.party_id
  JOIN ttr.transactions      t  ON t.id = p.transaction_id
  WHERE t.reporting_entity_id = public.reporting_entity_id()
    AND t.status              = 'complete'
    AND p.party_type          = 'company'
    AND lower(p.entity_name)  = lower(p_entity_name)
    AND (
      p_reg_identifier IS NULL
      OR replace(p.reg_identifier, ' ', '') = replace(p_reg_identifier, ' ', '')
    )
  ORDER BY idv.document_type::text, idv.document_number, idv.created_at DESC
  LIMIT 10;
$$;
