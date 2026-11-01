-- Completing a TTR links each party to a shared customer, creating one if needed, and
-- writes the party's details back to that customer so the next TTR (or gold sale) starts
-- from them. The party copies are never touched except for customer_id: a TTR keeps the
-- details as reported.
--
-- This runs INSIDE ttr.complete_transaction, in the same database transaction as the status
-- change. The alternative, linking in the edge function before or after the RPC, leaves a
-- window where a TTR is complete and unlinked (or linked and still a draft) if the function
-- dies in between, and gives two requests no shared lock. Here a failure rolls the
-- completion back, so a TTR cannot complete unlinked.
--
-- Concurrency: two staff completing TTRs for the same new person at once would otherwise
-- both find no customer and both create one. A transaction-scoped advisory lock on
-- entity + key makes the second wait until the first commits, then link to its customer.
-- Parties are processed in key order so two completions cannot lock in opposite orders.
--
-- Update rule (assumption A2): a filled party field overwrites the customer's; a blank one
-- does not erase it; aliases are replaced when the party has any. Three refinements:
--   * is_sole_trader follows the party's legal form (an explicit Yes or No: the party form
--     always asks, so its answer is the truth);
--   * the postal address is one unit, for the same reason: when the party says it has
--     none, the customer's postal address is cleared; when it has one, filled fields
--     overwrite;
--   * a name that differs only in capitalisation keeps the customer's spelling, so
--     "JANE" typed at the counter does not rewrite and audit every returning customer.
-- Audit rows (source ttr_completion) come from the customers UPDATE trigger; an alias
-- replacement is not a customers column, so it is written here.

CREATE OR REPLACE FUNCTION public._link_transaction_customers(
    p_transaction_id  UUID,
    p_actor_staff_id  UUID
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, ttr, auth
AS $$
DECLARE
    v_entity       UUID;
    v_prev_actor   TEXT := coalesce(current_setting('app.actor_staff_id', true), '');
    v_prev_source  TEXT := coalesce(current_setting('app.change_source', true), '');
    r              RECORD;
    v_customer     UUID;
    v_created      BOOLEAN;
    v_old_aliases  TEXT[];
    v_new_aliases  TEXT[];
BEGIN
    SELECT reporting_entity_id INTO v_entity FROM ttr.transactions WHERE id = p_transaction_id;
    IF v_entity IS NULL THEN
        RAISE EXCEPTION 'Transaction % does not exist', p_transaction_id;
    END IF;

    PERFORM set_config('app.actor_staff_id', coalesce(p_actor_staff_id::text, ''), true);
    PERFORM set_config('app.change_source', 'ttr_completion', true);

    FOR r IN
        SELECT
            p.*,
            CASE WHEN p.party_type = 'individual'
                 THEN 'i' || chr(31) || lower(p.last_name) || chr(31) || lower(p.first_name)
                          || chr(31) || coalesce(p.date_of_birth::text, '')
                 ELSE 'c' || chr(31) || lower(p.entity_name) || chr(31)
                          || replace(coalesce(p.reg_identifier, ''), ' ', '')
            END AS lock_key
        FROM ttr.parties p
        WHERE p.transaction_id = p_transaction_id
        ORDER BY lock_key, p.id
    LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(v_entity::text || chr(31) || r.lock_key, 0));

        v_customer := r.customer_id;
        v_created  := FALSE;

        IF v_customer IS NULL THEN
            SELECT c.id INTO v_customer
            FROM public.customers c
            WHERE c.reporting_entity_id = v_entity
              AND c.customer_type = r.party_type
              AND (
                  (r.party_type = 'individual'
                      AND lower(c.last_name) = lower(r.last_name)
                      AND lower(c.first_name) = lower(r.first_name)
                      AND c.date_of_birth IS NOT DISTINCT FROM r.date_of_birth)
                  OR
                  (r.party_type = 'company'
                      AND lower(c.entity_name) = lower(r.entity_name)
                      AND replace(coalesce(c.reg_identifier, ''), ' ', '')
                          = replace(coalesce(r.reg_identifier, ''), ' ', ''))
              )
            ORDER BY c.created_at, c.id
            LIMIT 1;

            IF v_customer IS NULL THEN
                INSERT INTO public.customers (
                    reporting_entity_id, customer_type, source, created_by_staff_id,
                    first_name, middle_name, last_name, date_of_birth, gender, phone, email, occupation,
                    res_street, res_suburb, res_state, res_postcode, res_country,
                    has_postal_address, post_street, post_suburb, post_state, post_postcode, post_country,
                    citizenship_country_code, tax_residency_country_code, is_sole_trader, abn, business_trading_name,
                    entity_name, company_trading_name, legal_form, reg_id_type, reg_identifier, company_phone, principal_activity,
                    biz_street, biz_suburb, biz_state, biz_postcode, biz_country,
                    has_company_postal_address, co_post_street, co_post_suburb, co_post_state, co_post_postcode, co_post_country,
                    is_express_trust, trust_type_other, trust_name
                ) VALUES (
                    v_entity, r.party_type, 'ttr', p_actor_staff_id,
                    r.first_name, r.middle_name, r.last_name, r.date_of_birth, r.gender, r.phone, r.email, r.occupation,
                    r.res_street, r.res_suburb, r.res_state, r.res_postcode, r.res_country,
                    r.has_postal_address, r.post_street, r.post_suburb, r.post_state, r.post_postcode, r.post_country,
                    r.citizenship_country_code, r.tax_residency_country_code,
                    CASE WHEN r.party_type = 'individual' THEN coalesce(r.legal_form = 'Sole trader', FALSE) END,
                    r.abn, r.business_trading_name,
                    r.entity_name, r.company_trading_name,
                    CASE WHEN r.party_type = 'company' THEN r.legal_form END,
                    r.reg_id_type, r.reg_identifier, r.company_phone, r.principal_activity,
                    r.biz_street, r.biz_suburb, r.biz_state, r.biz_postcode, r.biz_country,
                    r.has_company_postal_address, r.co_post_street, r.co_post_suburb, r.co_post_state,
                    r.co_post_postcode, r.co_post_country,
                    r.is_express_trust, r.trust_type_other, r.trust_name
                )
                RETURNING id INTO v_customer;
                v_created := TRUE;

                INSERT INTO public.customer_aliases (customer_id, alias, sort_order)
                SELECT v_customer, pa.alias, pa.sort_order
                FROM ttr.party_aliases pa WHERE pa.party_id = r.id;
            END IF;

            UPDATE ttr.parties SET customer_id = v_customer WHERE id = r.id;
        END IF;

        -- A customer created just now already holds this party's details.
        CONTINUE WHEN v_created;

        IF r.party_type = 'individual' THEN
            UPDATE public.customers c SET
                first_name    = CASE WHEN lower(c.first_name) = lower(r.first_name) THEN c.first_name ELSE r.first_name END,
                last_name     = CASE WHEN lower(c.last_name)  = lower(r.last_name)  THEN c.last_name  ELSE r.last_name  END,
                middle_name   = coalesce(nullif(r.middle_name, ''), c.middle_name),
                date_of_birth = coalesce(r.date_of_birth, c.date_of_birth),
                gender        = coalesce(r.gender, c.gender),
                phone         = coalesce(nullif(r.phone, ''), c.phone),
                email         = coalesce(nullif(r.email, ''), c.email),
                occupation    = coalesce(nullif(r.occupation, ''), c.occupation),
                res_street    = coalesce(nullif(r.res_street, ''), c.res_street),
                res_suburb    = coalesce(nullif(r.res_suburb, ''), c.res_suburb),
                res_state     = coalesce(r.res_state, c.res_state),
                res_postcode  = coalesce(nullif(r.res_postcode, ''), c.res_postcode),
                res_country   = coalesce(nullif(r.res_country, ''), c.res_country),
                has_postal_address = r.has_postal_address,
                post_street   = CASE WHEN r.has_postal_address THEN coalesce(nullif(r.post_street, ''), c.post_street) END,
                post_suburb   = CASE WHEN r.has_postal_address THEN coalesce(nullif(r.post_suburb, ''), c.post_suburb) END,
                post_state    = CASE WHEN r.has_postal_address THEN coalesce(r.post_state, c.post_state) END,
                post_postcode = CASE WHEN r.has_postal_address THEN coalesce(nullif(r.post_postcode, ''), c.post_postcode) END,
                post_country  = CASE WHEN r.has_postal_address THEN coalesce(nullif(r.post_country, ''), c.post_country) END,
                citizenship_country_code   = coalesce(r.citizenship_country_code, c.citizenship_country_code),
                tax_residency_country_code = coalesce(r.tax_residency_country_code, c.tax_residency_country_code),
                is_sole_trader        = coalesce(r.legal_form = 'Sole trader', FALSE),
                abn                   = coalesce(nullif(r.abn, ''), c.abn),
                business_trading_name = coalesce(nullif(r.business_trading_name, ''), c.business_trading_name)
            WHERE c.id = v_customer;
        ELSE
            UPDATE public.customers c SET
                entity_name          = CASE WHEN lower(c.entity_name) = lower(r.entity_name) THEN c.entity_name ELSE r.entity_name END,
                company_trading_name = coalesce(nullif(r.company_trading_name, ''), c.company_trading_name),
                legal_form           = coalesce(r.legal_form, c.legal_form),
                reg_id_type          = coalesce(r.reg_id_type, c.reg_id_type),
                reg_identifier       = r.reg_identifier,
                company_phone        = coalesce(nullif(r.company_phone, ''), c.company_phone),
                principal_activity   = coalesce(nullif(r.principal_activity, ''), c.principal_activity),
                biz_street           = coalesce(nullif(r.biz_street, ''), c.biz_street),
                biz_suburb           = coalesce(nullif(r.biz_suburb, ''), c.biz_suburb),
                biz_state            = coalesce(r.biz_state, c.biz_state),
                biz_postcode         = coalesce(nullif(r.biz_postcode, ''), c.biz_postcode),
                biz_country          = coalesce(nullif(r.biz_country, ''), c.biz_country),
                has_company_postal_address = r.has_company_postal_address,
                co_post_street   = CASE WHEN r.has_company_postal_address THEN coalesce(nullif(r.co_post_street, ''), c.co_post_street) END,
                co_post_suburb   = CASE WHEN r.has_company_postal_address THEN coalesce(nullif(r.co_post_suburb, ''), c.co_post_suburb) END,
                co_post_state    = CASE WHEN r.has_company_postal_address THEN coalesce(r.co_post_state, c.co_post_state) END,
                co_post_postcode = CASE WHEN r.has_company_postal_address THEN coalesce(nullif(r.co_post_postcode, ''), c.co_post_postcode) END,
                co_post_country  = CASE WHEN r.has_company_postal_address THEN coalesce(nullif(r.co_post_country, ''), c.co_post_country) END,
                is_express_trust = coalesce(r.is_express_trust, c.is_express_trust),
                trust_type_other = coalesce(nullif(r.trust_type_other, ''), c.trust_type_other),
                trust_name       = coalesce(nullif(r.trust_name, ''), c.trust_name)
            WHERE c.id = v_customer;
        END IF;

        -- Aliases: replaced only when the party carries any.
        SELECT array_agg(pa.alias ORDER BY pa.sort_order, pa.id) INTO v_new_aliases
        FROM ttr.party_aliases pa WHERE pa.party_id = r.id;

        IF v_new_aliases IS NOT NULL THEN
            SELECT coalesce(array_agg(ca.alias ORDER BY ca.sort_order, ca.id), ARRAY[]::TEXT[]) INTO v_old_aliases
            FROM public.customer_aliases ca WHERE ca.customer_id = v_customer;

            IF v_old_aliases IS DISTINCT FROM v_new_aliases THEN
                DELETE FROM public.customer_aliases WHERE customer_id = v_customer;
                INSERT INTO public.customer_aliases (customer_id, alias, sort_order)
                SELECT v_customer, pa.alias, pa.sort_order
                FROM ttr.party_aliases pa WHERE pa.party_id = r.id;

                PERFORM public._write_customer_audit(
                    v_customer, v_entity,
                    jsonb_build_object('aliases', jsonb_build_object('old', to_jsonb(v_old_aliases), 'new', to_jsonb(v_new_aliases)))
                );
            END IF;
        END IF;
    END LOOP;

    PERFORM set_config('app.actor_staff_id', v_prev_actor, true);
    PERFORM set_config('app.change_source', v_prev_source, true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public._link_transaction_customers(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._link_transaction_customers(UUID, UUID) TO service_role;

-- ─── ttr.complete_transaction: link before the status flips ──────────────────
-- Body as in 20260621000018, plus the link call. CREATE OR REPLACE keeps the grants set in
-- 20261030000001 (service_role only).

CREATE OR REPLACE FUNCTION ttr.complete_transaction(
    p_transaction_id  UUID,
    p_staff_member_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ttr, public, auth
AS $$
DECLARE
    v_entity_id UUID;
BEGIN
    -- Acquire a row-level lock and verify the transaction is still a draft.
    -- FOR UPDATE prevents concurrent completion attempts from racing.
    SELECT reporting_entity_id INTO v_entity_id
    FROM ttr.transactions
    WHERE id = p_transaction_id
      AND status = 'draft'
    FOR UPDATE;

    IF v_entity_id IS NULL THEN
        RAISE EXCEPTION 'Transaction % is not a draft or does not exist', p_transaction_id;
    END IF;

    -- Verify the staff member belongs to the same entity and is active.
    -- Belt-and-suspenders vs. the Edge Function's earlier JWT check.
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_members
        WHERE id                  = p_staff_member_id
          AND reporting_entity_id = v_entity_id
          AND is_active           = TRUE
    ) THEN
        RAISE EXCEPTION 'Staff member % is not authorised to complete transaction %',
            p_staff_member_id, p_transaction_id;
    END IF;

    -- Link every party to a shared customer (creating or updating it). Inside this function
    -- so a TTR can never be complete and unlinked: if linking fails, nothing below happens
    -- and nothing above is kept.
    PERFORM public._link_transaction_customers(p_transaction_id, p_staff_member_id);

    -- Atomic write: insert audit row first, then update status.
    -- If either fails the whole transaction rolls back.
    INSERT INTO ttr.transaction_audit_log
        (transaction_id, reporting_entity_id, changed_by, old_status, new_status, note)
    VALUES
        (p_transaction_id, v_entity_id, p_staff_member_id, 'draft', 'complete', 'Completed via API');

    UPDATE ttr.transactions
    SET status       = 'complete',
        completed_at = now()
    WHERE id = p_transaction_id;
    -- trg_lock_completed fires here as belt-and-suspenders;
    -- it will raise if status somehow changed between the SELECT FOR UPDATE and this UPDATE.
END;
$$;
