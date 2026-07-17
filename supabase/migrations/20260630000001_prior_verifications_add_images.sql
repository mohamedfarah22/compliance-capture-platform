-- Extend prior-verification RPCs to return front_image_id and back_image_id
-- so the UI can fetch and display captured ID photos for reliance decisions.
-- DROP required because PostgreSQL disallows changing a function's return type via CREATE OR REPLACE.

DROP FUNCTION IF EXISTS public.get_prior_verifications_individual(text, text, date);
DROP FUNCTION IF EXISTS public.get_prior_verifications_company(text, text);

CREATE FUNCTION public.get_prior_verifications_individual(
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
    AND lower(p.last_name)    = lower(p_last_name)
    AND lower(p.first_name)   = lower(p_first_name)
    AND (p_dob IS NULL OR p.date_of_birth = p_dob)
  ORDER BY idv.document_type::text, idv.document_number, idv.created_at DESC
  LIMIT 10;
$$;

CREATE FUNCTION public.get_prior_verifications_company(
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
    AND lower(p.entity_name)  = lower(p_entity_name)
    AND (
      p_reg_identifier IS NULL
      OR replace(p.reg_identifier, ' ', '') = replace(p_reg_identifier, ' ', '')
    )
  ORDER BY idv.document_type::text, idv.document_number, idv.created_at DESC
  LIMIT 10;
$$;
