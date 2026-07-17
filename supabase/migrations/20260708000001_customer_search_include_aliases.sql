-- Customer Search never returned a matched party's aliases, so re-adding an
-- existing customer to a new transaction silently dropped their alt names.
-- Wrap each function's existing DISTINCT ON logic in a subquery (unchanged
-- filtering/ordering/limit) and add an aliases column via a correlated
-- subquery against ttr.party_aliases, ordered by its own sort_order.
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
  res_country   text,
  aliases       text[]
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    m.id,
    m.first_name,
    m.middle_name,
    m.last_name,
    m.date_of_birth,
    m.gender,
    m.phone,
    m.email,
    m.occupation,
    m.res_street,
    m.res_suburb,
    m.res_state,
    m.res_postcode,
    m.res_country,
    COALESCE(
      (SELECT array_agg(pa.alias ORDER BY pa.sort_order) FROM ttr.party_aliases pa WHERE pa.party_id = m.id),
      ARRAY[]::text[]
    )
  FROM (
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
      p.res_state::text AS res_state,
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
    LIMIT 20
  ) m;
$$;

DROP FUNCTION IF EXISTS public.search_company_customers(text, text, text);

CREATE FUNCTION public.search_company_customers(
  p_entity_name    text DEFAULT NULL,
  p_reg_identifier text DEFAULT NULL,
  p_suburb         text DEFAULT NULL
)
RETURNS TABLE (
  party_id             uuid,
  entity_name          text,
  company_trading_name text,
  legal_form           text,
  reg_id_type          text,
  reg_identifier       text,
  company_phone        text,
  biz_street           text,
  biz_suburb           text,
  biz_state            text,
  biz_postcode         text,
  biz_country          text,
  aliases              text[]
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    m.id,
    m.entity_name,
    m.company_trading_name,
    m.legal_form,
    m.reg_id_type,
    m.reg_identifier,
    m.company_phone,
    m.biz_street,
    m.biz_suburb,
    m.biz_state,
    m.biz_postcode,
    m.biz_country,
    COALESCE(
      (SELECT array_agg(pa.alias ORDER BY pa.sort_order) FROM ttr.party_aliases pa WHERE pa.party_id = m.id),
      ARRAY[]::text[]
    )
  FROM (
    SELECT DISTINCT ON (lower(p.entity_name), replace(coalesce(p.reg_identifier, ''), ' ', ''))
      p.id,
      p.entity_name,
      p.company_trading_name,
      p.legal_form::text,
      p.reg_id_type::text,
      p.reg_identifier,
      p.company_phone,
      p.biz_street,
      p.biz_suburb,
      p.biz_state::text AS biz_state,
      p.biz_postcode,
      p.biz_country
    FROM ttr.parties p
    JOIN ttr.transactions t ON t.id = p.transaction_id
    WHERE t.reporting_entity_id = public.reporting_entity_id()
      AND p.is_complete          = true
      AND p.party_type           = 'company'
      AND (
        p_entity_name IS NULL
        OR p.entity_name ILIKE p_entity_name || '%'
      )
      AND (
        p_reg_identifier IS NULL
        OR replace(coalesce(p.reg_identifier, ''), ' ', '') ILIKE replace(p_reg_identifier, ' ', '') || '%'
      )
      AND (
        p_suburb IS NULL
        OR p.biz_suburb   ILIKE p_suburb || '%'
        OR p.biz_postcode ILIKE p_suburb || '%'
      )
    ORDER BY lower(p.entity_name), replace(coalesce(p.reg_identifier, ''), ' ', ''), p.updated_at DESC
    LIMIT 20
  ) m;
$$;
