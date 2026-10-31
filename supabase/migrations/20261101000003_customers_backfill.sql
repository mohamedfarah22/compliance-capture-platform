-- One-off backfill: build public.customers from the completed parties already on file and
-- set ttr.parties.customer_id on every one of them.
--
-- Grouping is exactly what customer search does today, so search results do not change:
--   individuals  entity + lower(last_name), lower(first_name), date_of_birth
--   companies    entity + lower(entity_name), reg_identifier without spaces
-- The customer's fields come from the copy search would show: the one with aliases, then
-- the newest updated_at, then id. Its aliases are copied too.
--
-- "Completed" = is_complete party on a complete transaction. Parties on drafts are left
-- alone: abandoned drafts must not leave customers behind, and a draft is linked when it
-- completes (20261101000005).
--
-- Kept (service role only) so pgTAP can test it. Safe to call again: a group that already
-- matches a customer is linked to it instead of creating another.

CREATE OR REPLACE FUNCTION public._backfill_customers()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, ttr
AS $$
DECLARE
    v_created INTEGER;
BEGIN
    DROP TABLE IF EXISTS pg_temp._bf_members;
    DROP TABLE IF EXISTS pg_temp._bf_map;

    -- Every unlinked completed party, with the id of the copy that represents its group.
    CREATE TEMP TABLE _bf_members ON COMMIT DROP AS
    WITH cand AS (
        SELECT
            p.id,
            p.party_type,
            t.reporting_entity_id AS entity_id,
            t.created_by_staff_id AS tx_staff,
            p.created_at,
            p.updated_at,
            EXISTS (SELECT 1 FROM ttr.party_aliases pa WHERE pa.party_id = p.id) AS has_alias,
            CASE WHEN p.party_type = 'individual' THEN lower(p.last_name)
                 ELSE lower(p.entity_name) END AS k1,
            CASE WHEN p.party_type = 'individual' THEN lower(p.first_name)
                 ELSE replace(coalesce(p.reg_identifier, ''), ' ', '') END AS k2,
            CASE WHEN p.party_type = 'individual' THEN p.date_of_birth END AS k3
        FROM ttr.parties p
        JOIN ttr.transactions t ON t.id = p.transaction_id
        WHERE t.status = 'complete'
          AND p.is_complete
          AND p.customer_id IS NULL
    )
    SELECT
        cand.id,
        cand.party_type,
        cand.entity_id, cand.k1, cand.k2, cand.k3,
        first_value(cand.id) OVER w AS rep_id,
        first_value(cand.tx_staff) OVER w AS rep_staff,
        min(cand.created_at) OVER (PARTITION BY cand.entity_id, cand.party_type, cand.k1, cand.k2, cand.k3) AS first_seen
    FROM cand
    WINDOW w AS (
        PARTITION BY cand.entity_id, cand.party_type, cand.k1, cand.k2, cand.k3
        ORDER BY cand.has_alias DESC, cand.updated_at DESC, cand.id
    );

    -- One row per group: the customer it will end up on (an existing match, or a new id).
    CREATE TEMP TABLE _bf_map ON COMMIT DROP AS
    SELECT
        m.rep_id, m.rep_staff, m.first_seen, m.entity_id, m.party_type,
        ex.id AS existing_id,
        coalesce(ex.id, gen_random_uuid()) AS customer_id
    FROM (SELECT DISTINCT rep_id, rep_staff, first_seen, entity_id, party_type, k1, k2, k3 FROM _bf_members) m
    LEFT JOIN LATERAL (
        SELECT c.id
        FROM public.customers c
        WHERE c.reporting_entity_id = m.entity_id
          AND c.customer_type = m.party_type
          AND (
              (m.party_type = 'individual'
                  AND lower(c.last_name) = m.k1
                  AND lower(c.first_name) = m.k2
                  AND c.date_of_birth IS NOT DISTINCT FROM m.k3)
              OR
              (m.party_type = 'company'
                  AND lower(c.entity_name) = m.k1
                  AND replace(coalesce(c.reg_identifier, ''), ' ', '') = m.k2)
          )
        ORDER BY c.created_at, c.id
        LIMIT 1
    ) ex ON TRUE;

    INSERT INTO public.customers (
        id, reporting_entity_id, customer_type, source, created_by_staff_id, created_at, updated_at,
        first_name, middle_name, last_name, date_of_birth, gender, phone, email, occupation,
        res_street, res_suburb, res_state, res_postcode, res_country,
        has_postal_address, post_street, post_suburb, post_state, post_postcode, post_country,
        citizenship_country_code, tax_residency_country_code, is_sole_trader, abn, business_trading_name,
        entity_name, company_trading_name, legal_form, reg_id_type, reg_identifier, company_phone, principal_activity,
        biz_street, biz_suburb, biz_state, biz_postcode, biz_country,
        has_company_postal_address, co_post_street, co_post_suburb, co_post_state, co_post_postcode, co_post_country,
        is_express_trust, trust_type_other, trust_name
    )
    SELECT
        m.customer_id, m.entity_id, m.party_type, 'ttr', m.rep_staff, m.first_seen, p.updated_at,
        p.first_name, p.middle_name, p.last_name, p.date_of_birth, p.gender, p.phone, p.email, p.occupation,
        p.res_street, p.res_suburb, p.res_state, p.res_postcode, p.res_country,
        p.has_postal_address, p.post_street, p.post_suburb, p.post_state, p.post_postcode, p.post_country,
        p.citizenship_country_code, p.tax_residency_country_code,
        CASE WHEN p.party_type = 'individual' THEN p.legal_form = 'Sole trader' END,
        p.abn, p.business_trading_name,
        p.entity_name, p.company_trading_name,
        CASE WHEN p.party_type = 'company' THEN p.legal_form END,
        p.reg_id_type, p.reg_identifier, p.company_phone, p.principal_activity,
        p.biz_street, p.biz_suburb, p.biz_state, p.biz_postcode, p.biz_country,
        p.has_company_postal_address, p.co_post_street, p.co_post_suburb, p.co_post_state, p.co_post_postcode, p.co_post_country,
        p.is_express_trust, p.trust_type_other, p.trust_name
    FROM _bf_map m
    JOIN ttr.parties p ON p.id = m.rep_id
    WHERE m.existing_id IS NULL;

    GET DIAGNOSTICS v_created = ROW_COUNT;

    INSERT INTO public.customer_aliases (customer_id, alias, sort_order)
    SELECT m.customer_id, pa.alias, pa.sort_order
    FROM _bf_map m
    JOIN ttr.party_aliases pa ON pa.party_id = m.rep_id
    WHERE m.existing_id IS NULL;

    UPDATE ttr.parties p
    SET customer_id = m.customer_id
    FROM _bf_members b
    JOIN _bf_map m ON m.rep_id = b.rep_id
    WHERE p.id = b.id;

    RETURN v_created;
END;
$$;

REVOKE EXECUTE ON FUNCTION public._backfill_customers() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._backfill_customers() TO service_role;

-- Linking only sets customer_id; it must not restamp the historical parties' updated_at,
-- which search tiebreaks and the audit trail both rely on.
ALTER TABLE ttr.parties DISABLE TRIGGER handle_updated_at;
SELECT public._backfill_customers();
ALTER TABLE ttr.parties ENABLE TRIGGER handle_updated_at;
