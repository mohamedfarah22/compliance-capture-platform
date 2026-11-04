-- Gold Phase 9a UAT defect D1 (row 9.26): two starts for parts of one invoice at the same time deadlocked.
--
-- gold.start_ttr locked its own purchase row (FOR UPDATE) before taking the invoice advisory lock, then updated
-- every linked part's row. Two starts on two parts each held their own row and waited for the other's, so
-- Postgres aborted one with "deadlock detected" (HTTP 500 start_failed). The invoice lock is now taken first,
-- before any row lock, and the purchase is read again (locked) once it is held. Create-or-replace of the
-- 20261109000004 function: signature, grants and every other line are as they were.

CREATE OR REPLACE FUNCTION gold.start_ttr(
    p_entity      UUID,
    p_staff       UUID,
    p_purchase_id UUID,
    p_location    TEXT,
    p_services    JSONB
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = gold, public, ttr, pg_temp
AS $$
DECLARE
    s          public.staff_members%ROWTYPE;
    v          gold.purchases%ROWTYPE;
    a          gold.purchases%ROWTYPE;      -- the earliest part of the type: its sellers, IDs, time and counter
    c1         public.customers%ROWTYPE;
    cap1       ttr.id_verifications%ROWTYPE;
    v_reportable BOOLEAN;
    v_answered INT;
    v_yes      BOOLEAN;
    v_any_joint BOOLEAN;
    v_type     TEXT;
    v_scenario TEXT;
    v_cash     NUMERIC;
    v_tx       UUID;
    v_status   TEXT;
    v_created  BOOLEAN;
    v_case_a   BOOLEAN;
    v_name     TEXT;
    v_result   JSONB := '[]'::jsonb;
BEGIN
    SELECT * INTO s FROM public.staff_members
    WHERE id = p_staff AND reporting_entity_id = p_entity AND is_active;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'staff member is not active in this entity' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Find the invoice without taking a row lock: the invoice lock must come before any row lock, or two starts
    -- on different parts of one invoice each hold their own part's row while waiting for the other's (deadlock).
    SELECT * INTO v FROM gold.purchases WHERE id = p_purchase_id AND reporting_entity_id = p_entity;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'purchase not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF v.erp_invoice_no IS NULL THEN
        RAISE EXCEPTION 'the purchase has no ERP invoice number' USING ERRCODE = 'GD003';
    END IF;

    PERFORM set_config('app.actor_staff_id', p_staff::text, true);
    PERFORM set_config('app.change_source', 'start_ttr', true);

    -- One start per invoice at a time, then everything below reads committed data (the row is read again, locked,
    -- after the wait, so a change made by the start we waited for is seen).
    PERFORM gold._lock_invoice(p_entity, v.erp_invoice_no);
    SELECT * INTO v FROM gold.purchases WHERE id = p_purchase_id AND reporting_entity_id = p_entity FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'purchase not found' USING ERRCODE = 'no_data_found';
    END IF;

    -- Re-checked here whatever the client believes: the sale is reportable when a part was flagged 10k_plus or the
    -- cash across all same-day linked parts reaches $10,000 (handover 4.0a).
    -- Linked parts: same invoice, same day, belonging to the sellers as main or joint seller.
    SELECT coalesce(bool_or(p.cash_10k_or_more), false) OR coalesce(sum(coalesce(p.cash_amount, 0)), 0) >= 10000,
           count(*) FILTER (WHERE p.ttr_self_conducted IS NOT NULL),
           coalesce(bool_and(coalesce(p.ttr_self_conducted, false) AND coalesce(p.ttr_details_confirmed, false))
                    FILTER (WHERE p.ttr_self_conducted IS NOT NULL), false),
           coalesce(bool_or(p.joint_customer_id IS NOT NULL), false)
    INTO v_reportable, v_answered, v_yes, v_any_joint
    FROM gold.purchases p
    WHERE p.reporting_entity_id = p_entity AND p.erp_invoice_norm = v.erp_invoice_norm AND p.sale_date = v.sale_date
      AND (p.customer_id IN (v.customer_id, coalesce(v.joint_customer_id, v.customer_id))
           OR coalesce(p.joint_customer_id IN (v.customer_id, coalesce(v.joint_customer_id, v.customer_id)), false));
    IF NOT v_reportable THEN
        RAISE EXCEPTION 'the sale is not reportable' USING ERRCODE = 'GD004';
    END IF;

    -- This purchase's type first, so the caller opens its own report first.
    FOREACH v_type IN ARRAY ARRAY[v.purchase_type::text, CASE WHEN v.purchase_type::text = 'scrap' THEN 'bullion' ELSE 'scrap' END]
    LOOP
        v_cash := gold._ttr_type_cash(p_entity, v.customer_id, v.joint_customer_id, v.erp_invoice_no, v.sale_date, v_type);
        CONTINUE WHEN v_cash IS NULL;          -- no part of this type, or none paid in cash
        v_scenario := CASE v_type WHEN 'scrap' THEN 'precious_metal_buy' ELSE 'bullion_buy' END;

        SELECT p.* INTO a
        FROM gold.purchases p
        WHERE p.reporting_entity_id = p_entity AND p.erp_invoice_norm = v.erp_invoice_norm AND p.sale_date = v.sale_date
          AND p.purchase_type::text = v_type
          AND (p.customer_id IN (v.customer_id, coalesce(v.joint_customer_id, v.customer_id))
               OR coalesce(p.joint_customer_id IN (v.customer_id, coalesce(v.joint_customer_id, v.customer_id)), false))
        ORDER BY p.created_at, p.id
        LIMIT 1;

        -- A TTR already linked to a part of this type.
        SELECT t.id, t.status::text INTO v_tx, v_status
        FROM gold.purchases p JOIN ttr.transactions t ON t.id = p.ttr_transaction_id
        WHERE p.reporting_entity_id = p_entity AND p.erp_invoice_norm = v.erp_invoice_norm AND p.sale_date = v.sale_date
          AND p.purchase_type::text = v_type
          AND (p.customer_id IN (v.customer_id, coalesce(v.joint_customer_id, v.customer_id))
               OR coalesce(p.joint_customer_id IN (v.customer_id, coalesce(v.joint_customer_id, v.customer_id)), false))
        ORDER BY p.created_at, p.id
        LIMIT 1;

        v_created := v_tx IS NULL;
        v_case_a := NULL;
        IF v_created THEN
            SELECT * INTO c1 FROM public.customers WHERE id = a.customer_id AND reporting_entity_id = p_entity;
            SELECT * INTO cap1 FROM ttr.id_verifications WHERE id = a.main_id_verification_id AND reporting_entity_id = p_entity;
            v_case_a := v_answered > 0 AND v_yes AND NOT v_any_joint AND a.joint_customer_id IS NULL
                AND gold._party_complete(c1)
                AND coalesce(btrim(cap1.issuer), '') <> '' AND coalesce(btrim(cap1.id_country_code), '') <> '';

            SELECT full_name INTO v_name FROM public.staff_members WHERE id = a.created_by_staff_id;

            INSERT INTO ttr.transactions (
                reporting_entity_id, created_by_staff_id, scenario, transaction_ref, transaction_datetime,
                designated_service, location_snapshot, staff_member_name, staff_member_email, staff_member_role,
                cash_currency, cash_amount, aud_value
            ) VALUES (
                p_entity, p_staff, v_scenario, v.erp_invoice_no, a.created_at,
                p_services ->> v_scenario, p_location, s.full_name, s.email, s.role::text,
                'AUD', v_cash, v_cash
            ) RETURNING id INTO v_tx;
            v_status := 'draft';

            PERFORM gold._ttr_add_seller(v_tx, p_entity, a.customer_id, a.main_id_verification_id,
                                         v_case_a, a.created_at, a.created_by_staff_id, v_name);
            IF a.joint_customer_id IS NOT NULL THEN
                PERFORM gold._ttr_add_seller(v_tx, p_entity, a.joint_customer_id, a.joint_id_verification_id,
                                             false, a.created_at, a.created_by_staff_id, v_name);
            END IF;
        ELSIF v_status = 'draft' THEN
            UPDATE ttr.transactions SET cash_amount = v_cash, aud_value = v_cash WHERE id = v_tx;
        END IF;

        UPDATE gold.purchases p
        SET ttr_transaction_id = v_tx
        WHERE p.reporting_entity_id = p_entity AND p.erp_invoice_norm = v.erp_invoice_norm AND p.sale_date = v.sale_date
          AND p.purchase_type::text = v_type AND p.ttr_transaction_id IS NULL
          AND (p.customer_id IN (v.customer_id, coalesce(v.joint_customer_id, v.customer_id))
               OR coalesce(p.joint_customer_id IN (v.customer_id, coalesce(v.joint_customer_id, v.customer_id)), false));

        v_result := v_result || jsonb_build_object(
            'id', v_tx, 'type', v_type, 'scenario', v_scenario, 'status', v_status,
            'created', v_created, 'case', CASE WHEN v_case_a IS NULL THEN NULL WHEN v_case_a THEN 'A' ELSE 'B' END);
    END LOOP;

    IF jsonb_array_length(v_result) = 0 THEN
        RAISE EXCEPTION 'no part of the sale was paid in cash' USING ERRCODE = 'GD005';
    END IF;
    RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION gold.start_ttr(UUID, UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION gold.start_ttr(UUID, UUID, UUID, TEXT, JSONB) TO service_role;
