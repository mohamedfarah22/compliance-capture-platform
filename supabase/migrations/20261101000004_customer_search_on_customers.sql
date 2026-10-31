-- TTR customer search now reads public.customers instead of building "customers" at query
-- time from ttr.parties. Customers created by gold have no party at all, so this is what
-- lets a TTR find them.
--
-- Every existing output column keeps its name, type and position; new columns are appended
-- (customer_id, then the fields a returning customer used to retype on every TTR:
-- citizenship, tax residency, sole trader / ABN, postal address).
--
-- party_id is kept for callers that still read it: it is the party copy the old query would
-- have returned (aliases first, then newest, then id), and NULL for a customer with no party.
-- New code should use customer_id.
--
-- Matching is unchanged: case-insensitive prefix on first and last name, exact DOB; company
-- name prefix, reg identifier prefix with spaces removed, suburb or postcode prefix. One
-- deliberate difference: the company suburb filter now tests the customer's current address.
-- It used to test every historical copy, so a company could be found by a suburb it had
-- since left.
--
-- Return types change, so both functions are dropped and recreated. Grants are re-applied:
-- the old functions carried the default EXECUTE to PUBLIC, which let anon call them (they
-- returned nothing without a session, but there is no reason to leave it open).

DROP FUNCTION public.search_individual_customers(text, text, date);
DROP FUNCTION public.search_company_customers(text, text, text);

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
  aliases       text[],
  customer_id   uuid,
  citizenship_country_code   text,
  tax_residency_country_code text,
  is_sole_trader             boolean,
  abn                        text,
  business_trading_name      text,
  has_postal_address         boolean,
  post_street   text,
  post_suburb   text,
  post_state    text,
  post_postcode text,
  post_country  text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    rp.id,
    c.first_name,
    c.middle_name,
    c.last_name,
    c.date_of_birth,
    c.gender,
    c.phone,
    c.email,
    c.occupation,
    c.res_street,
    c.res_suburb,
    c.res_state::text,
    c.res_postcode,
    c.res_country,
    COALESCE(
      (SELECT array_agg(ca.alias ORDER BY ca.sort_order) FROM public.customer_aliases ca WHERE ca.customer_id = c.id),
      ARRAY[]::text[]
    ),
    c.id,
    c.citizenship_country_code,
    c.tax_residency_country_code,
    c.is_sole_trader,
    c.abn,
    c.business_trading_name,
    c.has_postal_address,
    c.post_street,
    c.post_suburb,
    c.post_state::text,
    c.post_postcode,
    c.post_country
  FROM public.customers c
  LEFT JOIN LATERAL (
    SELECT p.id
    FROM ttr.parties p
    JOIN ttr.transactions t ON t.id = p.transaction_id
    WHERE p.customer_id = c.id
      AND p.is_complete = true
      AND t.status = 'complete'
    ORDER BY
      EXISTS (SELECT 1 FROM ttr.party_aliases pa WHERE pa.party_id = p.id) DESC,
      p.updated_at DESC,
      p.id
    LIMIT 1
  ) rp ON true
  WHERE c.reporting_entity_id = public.reporting_entity_id()
    AND c.customer_type       = 'individual'
    AND (p_last_name  IS NULL OR c.last_name  ILIKE p_last_name  || '%')
    AND (p_first_name IS NULL OR c.first_name ILIKE p_first_name || '%')
    AND (p_dob        IS NULL OR c.date_of_birth = p_dob)
  ORDER BY lower(c.last_name), lower(c.first_name), c.date_of_birth, c.id
  LIMIT 20;
$$;

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
  aliases              text[],
  principal_activity   text,
  is_express_trust     boolean,
  trust_type_other     text,
  trust_name           text,
  customer_id          uuid,
  has_company_postal_address boolean,
  co_post_street   text,
  co_post_suburb   text,
  co_post_state    text,
  co_post_postcode text,
  co_post_country  text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    rp.id,
    c.entity_name,
    c.company_trading_name,
    c.legal_form::text,
    c.reg_id_type::text,
    c.reg_identifier,
    c.company_phone,
    c.biz_street,
    c.biz_suburb,
    c.biz_state::text,
    c.biz_postcode,
    c.biz_country,
    COALESCE(
      (SELECT array_agg(ca.alias ORDER BY ca.sort_order) FROM public.customer_aliases ca WHERE ca.customer_id = c.id),
      ARRAY[]::text[]
    ),
    c.principal_activity,
    c.is_express_trust,
    c.trust_type_other,
    c.trust_name,
    c.id,
    c.has_company_postal_address,
    c.co_post_street,
    c.co_post_suburb,
    c.co_post_state::text,
    c.co_post_postcode,
    c.co_post_country
  FROM public.customers c
  LEFT JOIN LATERAL (
    SELECT p.id
    FROM ttr.parties p
    JOIN ttr.transactions t ON t.id = p.transaction_id
    WHERE p.customer_id = c.id
      AND p.is_complete = true
      AND t.status = 'complete'
    ORDER BY
      EXISTS (SELECT 1 FROM ttr.party_aliases pa WHERE pa.party_id = p.id) DESC,
      p.updated_at DESC,
      p.id
    LIMIT 1
  ) rp ON true
  WHERE c.reporting_entity_id = public.reporting_entity_id()
    AND c.customer_type       = 'company'
    AND (
      p_entity_name IS NULL
      OR c.entity_name ILIKE p_entity_name || '%'
    )
    AND (
      p_reg_identifier IS NULL
      OR replace(coalesce(c.reg_identifier, ''), ' ', '') ILIKE replace(p_reg_identifier, ' ', '') || '%'
    )
    AND (
      p_suburb IS NULL
      OR c.biz_suburb   ILIKE p_suburb || '%'
      OR c.biz_postcode ILIKE p_suburb || '%'
    )
  ORDER BY lower(c.entity_name), replace(coalesce(c.reg_identifier, ''), ' ', ''), c.id
  LIMIT 20;
$$;

REVOKE EXECUTE ON FUNCTION public.search_individual_customers(text, text, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.search_company_customers(text, text, text)    FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.search_individual_customers(text, text, date) TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.search_company_customers(text, text, text)    TO authenticated, service_role;
