-- Gold Phase 9a, spec 3.2 - 3.4: start the TTR draft(s) for a gold purchase, in one atomic write.
--
-- gold.start_ttr is called only by the gold-start-ttr edge function (service role). For the purchase's invoice it
-- creates, per type with cash (spec 3.4), one ttr.transactions draft with its parties and reliance rows, and links
-- the same-type linked parts to it. Idempotent per invoice + sale date + customer + type: a type whose parts
-- already carry a TTR reuses it (a draft's cash is refreshed; a completed TTR is only reported).
--
-- Refusals (RAISE ERRCODE, turned into HTTP errors by the edge function):
--   GD003  the purchase has no ERP invoice number
--   GD004  the sale is not reportable (no linked part flagged 10k_plus, and linked cash under $10,000)
--   GD005  no type has cash above $0 (a bank-transfer-only sale has no TTR)
--   23505  another TTR already uses this reference and scenario (uq_tx_ref_per_entity)
--   P0002  purchase not found in this business;  22023 staff member not active in this business
--
-- Case A (spec 3.3) is decided from data: one seller, every linked part answered the counter questions Yes / Yes
-- (any No, or none answered, is case B), the customer has every Party Details field, and the ID capture has its
-- issuer and country. In case A the reliance rows are complete with reason customer_confirmed_details_unchanged;
-- otherwise they are incomplete with reason prior_id_reviewed_still_valid, which Party Details / ID verification
-- let staff change. Either way the C3 counter confirmation (the purchase's creator and time) is copied onto the
-- row. No photos are copied.
--
-- p_location and p_services come from supabase/functions/_shared/ttrDefaults.js, the same constants the wizard
-- uses, so the two never drift.

-- Whether an individual customer has everything Party Details requires (the party part of customer_ttr_ready).
CREATE OR REPLACE FUNCTION gold._party_complete(c public.customers)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
    SELECT coalesce(btrim(c.first_name), '') <> '' AND coalesce(btrim(c.last_name), '') <> ''
       AND c.date_of_birth IS NOT NULL
       AND coalesce(btrim(c.res_street), '') <> '' AND coalesce(btrim(c.res_suburb), '') <> ''
       AND c.res_state IS NOT NULL AND coalesce(btrim(c.res_postcode), '') <> ''
       AND coalesce(btrim(c.res_country), '') <> ''
       AND coalesce(btrim(c.phone), '') <> '' AND coalesce(btrim(c.occupation), '') <> ''
       AND c.gender IS NOT NULL
       AND coalesce(btrim(c.citizenship_country_code), '') <> ''
       AND coalesce(btrim(c.tax_residency_country_code), '') <> ''
       AND c.is_sole_trader IS NOT NULL
       AND (NOT c.is_sole_trader OR coalesce(btrim(c.abn), '') <> '')
       AND (NOT c.has_postal_address
            OR (coalesce(btrim(c.post_street), '') <> '' AND coalesce(btrim(c.post_suburb), '') <> ''
                AND c.post_state IS NOT NULL AND coalesce(btrim(c.post_postcode), '') <> ''
                AND coalesce(btrim(c.post_country), '') <> ''))
$$;

-- Copies one seller into the TTR: the party row and its reliance row on the ID capture.
CREATE OR REPLACE FUNCTION gold._ttr_add_seller(
    p_tx UUID, p_entity UUID, p_customer UUID, p_capture UUID,
    p_case_a BOOLEAN, p_confirmed_at TIMESTAMPTZ, p_confirmed_by UUID, p_confirmed_by_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = gold, public, ttr, pg_temp
AS $$
DECLARE
    c        public.customers%ROWTYPE;
    cap      ttr.id_verifications%ROWTYPE;
    v_party  UUID;
BEGIN
    SELECT * INTO c FROM public.customers WHERE id = p_customer AND reporting_entity_id = p_entity;
    SELECT * INTO cap FROM ttr.id_verifications WHERE id = p_capture AND reporting_entity_id = p_entity;

    INSERT INTO ttr.parties (
        transaction_id, party_type, is_complete, first_name, middle_name, last_name, full_name, date_of_birth,
        phone, email, occupation, legal_form, abn, business_trading_name,
        res_street, res_suburb, res_state, res_postcode, res_country,
        has_postal_address, post_street, post_suburb, post_state, post_postcode, post_country,
        gender, citizenship_country_code, tax_residency_country_code, customer_id
    ) VALUES (
        p_tx, 'individual', gold._party_complete(c), c.first_name, c.middle_name, c.last_name,
        nullif(concat_ws(' ', nullif(btrim(c.first_name), ''), nullif(btrim(c.middle_name), ''), nullif(btrim(c.last_name), '')), ''),
        c.date_of_birth, c.phone, c.email, c.occupation,
        CASE WHEN c.is_sole_trader THEN 'Sole trader'::co_legal_form END,
        CASE WHEN c.is_sole_trader THEN nullif(regexp_replace(coalesce(c.abn, ''), '\s', '', 'g'), '') END,
        c.business_trading_name,
        c.res_street, c.res_suburb, c.res_state, c.res_postcode, c.res_country,
        c.has_postal_address, c.post_street, c.post_suburb, c.post_state, c.post_postcode, c.post_country,
        c.gender, c.citizenship_country_code, c.tax_residency_country_code, c.id
    ) RETURNING id INTO v_party;

    INSERT INTO ttr.id_verifications (
        transaction_id, party_id, reporting_entity_id, verification_method, document_type, document_type_other,
        document_number, issuer, has_expiry, expiry_date, id_country_code, verification_description,
        verification_basis, prior_verification_id, reliance_reason, is_complete,
        counter_confirmed_at, counter_confirmed_by_staff_id
    ) VALUES (
        p_tx, v_party, p_entity, 'Relied on prior identification', cap.document_type, cap.document_type_other,
        cap.document_number, cap.issuer, cap.has_expiry, cap.expiry_date, cap.id_country_code,
        format('Relied on prior identification — %s %s verified %s by %s',
               coalesce(cap.document_type_other, cap.document_type::text), cap.document_number,
               to_char(cap.created_at AT TIME ZONE 'Australia/Melbourne', 'DD/MM/YYYY'), p_confirmed_by_name),
        'relied_on_prior_identification', cap.id,
        CASE WHEN p_case_a THEN 'customer_confirmed_details_unchanged' ELSE 'prior_id_reviewed_still_valid' END,
        p_case_a, p_confirmed_at, p_confirmed_by
    );
END;
$$;

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

    SELECT * INTO v FROM gold.purchases WHERE id = p_purchase_id AND reporting_entity_id = p_entity FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'purchase not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF v.erp_invoice_no IS NULL THEN
        RAISE EXCEPTION 'the purchase has no ERP invoice number' USING ERRCODE = 'GD003';
    END IF;

    PERFORM set_config('app.actor_staff_id', p_staff::text, true);
    PERFORM set_config('app.change_source', 'start_ttr', true);

    -- One start per invoice at a time, then everything below reads committed data.
    PERFORM gold._lock_invoice(p_entity, v.erp_invoice_no);

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

REVOKE EXECUTE ON FUNCTION gold._party_complete(public.customers) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gold._ttr_add_seller(UUID, UUID, UUID, UUID, BOOLEAN, TIMESTAMPTZ, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gold.start_ttr(UUID, UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION gold._party_complete(public.customers) TO service_role;
GRANT  EXECUTE ON FUNCTION gold._ttr_add_seller(UUID, UUID, UUID, UUID, BOOLEAN, TIMESTAMPTZ, UUID, TEXT) TO service_role;
GRANT  EXECUTE ON FUNCTION gold.start_ttr(UUID, UUID, UUID, TEXT, JSONB) TO service_role;
