-- search_company_customers never returned principal_activity (a required field on
-- Party Details) or the trust fields added in 20260716000001_trust_details.sql
-- (is_express_trust/trust_type_other/trust_name) — reusing an existing company via
-- Customer Search silently came back with these blank, the same bug class already
-- fixed once for aliases in 20260708000001_customer_search_include_aliases.sql.
-- Adding output columns to a RETURNS TABLE function requires dropping it first —
-- Postgres rejects CREATE OR REPLACE FUNCTION if the OUT-parameter row type differs
-- (SQLSTATE 42P13). No parameter (argument) changes, so the signature below is
-- enough to uniquely identify the function to drop. No GRANT statements exist for
-- this function in any prior migration, so it relies on Postgres's default
-- EXECUTE-to-PUBLIC privilege for newly created functions, which is restored
-- automatically by the CREATE FUNCTION below.
DROP FUNCTION public.search_company_customers(text, text, text);

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
  trust_name           text
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
    ),
    m.principal_activity,
    m.is_express_trust,
    m.trust_type_other,
    m.trust_name
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
      p.biz_country,
      p.principal_activity,
      p.is_express_trust,
      p.trust_type_other,
      p.trust_name
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
    ORDER BY lower(p.entity_name), replace(coalesce(p.reg_identifier, ''), ' ', ''),
      EXISTS (SELECT 1 FROM ttr.party_aliases pa WHERE pa.party_id = p.id) DESC,
      p.updated_at DESC,
      p.id
    LIMIT 20
  ) m;
$$;
