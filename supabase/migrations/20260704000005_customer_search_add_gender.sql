-- Add gender to search_individual_customers so re-adding a known customer
-- pre-populates the Gender field on Party Details from their prior record.
-- CREATE OR REPLACE cannot change RETURNS TABLE columns, so drop first.

DROP FUNCTION IF EXISTS public.search_individual_customers(text, text, date);

CREATE FUNCTION public.search_individual_customers(
  p_first_name text DEFAULT NULL,
  p_last_name  text DEFAULT NULL,
  p_dob        date DEFAULT NULL
)
RETURNS TABLE (
  party_id      uuid,
  first_name    text,
  middle_name   text,
  last_name     text,
  date_of_birth date,
  gender        text,
  phone         text,
  email         text,
  occupation    text,
  res_street    text,
  res_suburb    text,
  res_state     text,
  res_postcode  text,
  res_country   text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT ON (lower(p.last_name), lower(p.first_name), p.date_of_birth)
    p.id,
    p.first_name,
    p.middle_name,
    p.last_name,
    p.date_of_birth,
    p.gender,
    p.phone,
    p.email,
    p.occupation,
    p.res_street,
    p.res_suburb,
    p.res_state::text,
    p.res_postcode,
    p.res_country
  FROM ttr.parties p
  JOIN ttr.transactions t ON t.id = p.transaction_id
  WHERE t.reporting_entity_id = public.reporting_entity_id()
    AND p.is_complete          = true
    AND p.party_type           = 'individual'
    AND (p_last_name  IS NULL OR p.last_name  ILIKE p_last_name  || '%')
    AND (p_first_name IS NULL OR p.first_name ILIKE p_first_name || '%')
    AND (p_dob        IS NULL OR p.date_of_birth = p_dob)
  ORDER BY lower(p.last_name), lower(p.first_name), p.date_of_birth, p.updated_at DESC
  LIMIT 20;
$$;
