-- Gold Phase 9a, spec 3.5: a later part on an invoice whose TTR for that type is still a draft joins it.
--
-- save_purchase and complete_purchase now end by calling gold._sync_ttr_draft: when a linked part of the same
-- type already has a draft TTR, the new part is linked to it (ttr_transaction_id) and the draft's cash is
-- recalculated from this type's cash across all linked parts. A completed TTR still blocks the part (GD002, in
-- gold._check_invoice, unchanged). Both functions below are create-or-replace of the 20261107000002 versions with
-- one added PERFORM each; signatures, grants and every other line are as they were.
--
-- Cash rule, shared with gold.start_ttr (20261109000004): the sum of this type's amounts over the invoice's linked
-- parts; when that is 0 and some part has no amount entered, the placeholder; when every amount is a known 0 the
-- type was not paid in cash and there is no TTR for it (NULL).

CREATE OR REPLACE FUNCTION gold._ttr_placeholder_cash()
RETURNS NUMERIC
LANGUAGE sql IMMUTABLE
AS $$ SELECT 1::numeric $$;   -- the TTR fast path's placeholder (CustomerSearchPage.jsx), replaced by Transaction Details

-- The parts of one invoice, same day, that belong to the sellers (as main or joint seller), of one type.
CREATE OR REPLACE FUNCTION gold._ttr_type_cash(
    p_entity UUID, p_customer UUID, p_joint UUID, p_invoice TEXT, p_date DATE, p_type TEXT
)
RETURNS NUMERIC
LANGUAGE sql STABLE
SET search_path = gold, public, pg_temp
AS $$
    SELECT CASE
        WHEN coalesce(sum(coalesce(p.cash_amount, 0)), 0) > 0 THEN sum(coalesce(p.cash_amount, 0))
        WHEN bool_or(p.cash_amount IS NULL)                   THEN gold._ttr_placeholder_cash()
        ELSE NULL
    END
    FROM gold.purchases p
    WHERE p.reporting_entity_id = p_entity AND p.erp_invoice_norm = upper(btrim(p_invoice))
      AND p.sale_date = p_date AND p.purchase_type::text = p_type
      AND (p.customer_id IN (p_customer, coalesce(p_joint, p_customer))
           OR coalesce(p.joint_customer_id IN (p_customer, coalesce(p_joint, p_customer)), false))
$$;

-- Links the part to a same-type draft TTR of its invoice and refreshes that draft's cash. No-op when there is none.
CREATE OR REPLACE FUNCTION gold._sync_ttr_draft(
    p_entity UUID, p_customer UUID, p_joint UUID, p_invoice TEXT, p_date DATE, p_type TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = gold, public, ttr, pg_temp
AS $$
DECLARE
    v_tx   UUID;
    v_cash NUMERIC;
BEGIN
    SELECT p.ttr_transaction_id INTO v_tx
    FROM gold.purchases p
    JOIN ttr.transactions t ON t.id = p.ttr_transaction_id AND t.status = 'draft'
    WHERE p.reporting_entity_id = p_entity AND p.erp_invoice_norm = upper(btrim(p_invoice))
      AND p.sale_date = p_date AND p.purchase_type::text = p_type
      AND (p.customer_id IN (p_customer, coalesce(p_joint, p_customer))
           OR coalesce(p.joint_customer_id IN (p_customer, coalesce(p_joint, p_customer)), false))
    ORDER BY p.created_at
    LIMIT 1;
    IF v_tx IS NULL THEN
        RETURN;
    END IF;

    UPDATE gold.purchases p
    SET ttr_transaction_id = v_tx
    WHERE p.reporting_entity_id = p_entity AND p.erp_invoice_norm = upper(btrim(p_invoice))
      AND p.sale_date = p_date AND p.purchase_type::text = p_type AND p.ttr_transaction_id IS NULL
      AND (p.customer_id IN (p_customer, coalesce(p_joint, p_customer))
           OR coalesce(p.joint_customer_id IN (p_customer, coalesce(p_joint, p_customer)), false));

    v_cash := gold._ttr_type_cash(p_entity, p_customer, p_joint, p_invoice, p_date, p_type);
    IF v_cash IS NOT NULL THEN
        UPDATE ttr.transactions SET cash_amount = v_cash, aud_value = v_cash WHERE id = v_tx AND status = 'draft';
    END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION gold._ttr_placeholder_cash() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gold._ttr_type_cash(UUID, UUID, UUID, TEXT, DATE, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gold._sync_ttr_draft(UUID, UUID, UUID, TEXT, DATE, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION gold._ttr_placeholder_cash() TO service_role;
GRANT  EXECUTE ON FUNCTION gold._ttr_type_cash(UUID, UUID, UUID, TEXT, DATE, TEXT) TO service_role;
GRANT  EXECUTE ON FUNCTION gold._sync_ttr_draft(UUID, UUID, UUID, TEXT, DATE, TEXT) TO service_role;

-- ─── Save a purchase (20261107000002, plus the join) ─────────────────────────────────────
--             erp_invoice_no, sale_date, phone, id_sighted, id_expired_at_time,
--             id_outside_window_at_time, ttr_self_conducted, ttr_details_confirmed.
-- p_photos    [{ object_path, content_hash_sha256, byte_size }], in order; at least one. The
--             sort order is the position, so object {id}/goods-{n}.jpg has sort_order n - 1.
-- p_fills     [{ id, cash_amount }] for earlier linked parts that had no amount.
-- Returns the purchase id.
CREATE OR REPLACE FUNCTION gold.save_purchase(
    p_entity   UUID,
    p_staff    UUID,
    p_purchase JSONB,
    p_photos   JSONB,
    p_fills    JSONB
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = gold, public, ttr, pg_temp
AS $$
DECLARE
    v_id       UUID := (p_purchase ->> 'id')::uuid;
    v_customer UUID := (p_purchase ->> 'customer_id')::uuid;
    v_joint    UUID := (p_purchase ->> 'joint_customer_id')::uuid;
    v_main_id  UUID := (p_purchase ->> 'main_id_verification_id')::uuid;
    v_joint_id UUID := (p_purchase ->> 'joint_id_verification_id')::uuid;
    v_sellers  INT;
    v_invoice  TEXT := nullif(btrim(p_purchase ->> 'erp_invoice_no'), '');
    v_date     DATE := (p_purchase ->> 'sale_date')::date;
    ph         JSONB;
    n          INT := 0;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.staff_members
                   WHERE id = p_staff AND reporting_entity_id = p_entity AND is_active) THEN
        RAISE EXCEPTION 'staff member is not active in this entity' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Sellers are individuals of this entity, and each ID is a capture of that seller.
    SELECT count(*) INTO v_sellers FROM public.customers
    WHERE id IN (v_customer, coalesce(v_joint, v_customer))
      AND reporting_entity_id = p_entity AND customer_type = 'individual';
    -- (the one or two distinct sellers; a joint seller equal to the main seller is caught by the CHECK below)
    IF v_sellers <> 1 + (v_joint IS NOT NULL AND v_joint <> v_customer)::int
    OR NOT EXISTS (SELECT 1 FROM ttr.id_verifications
                   WHERE id = v_main_id AND customer_id = v_customer AND reporting_entity_id = p_entity)
    OR (v_joint IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ttr.id_verifications
                   WHERE id = v_joint_id AND customer_id = v_joint AND reporting_entity_id = p_entity))
    THEN
        RAISE EXCEPTION 'a seller or ID is not in this entity' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_photos IS NULL OR jsonb_typeof(p_photos) <> 'array' OR jsonb_array_length(p_photos) = 0 THEN
        RAISE EXCEPTION 'a purchase needs at least one goods photo' USING ERRCODE = 'check_violation';
    END IF;

    PERFORM set_config('app.actor_staff_id', p_staff::text, true);
    PERFORM set_config('app.change_source', 'save_purchase', true);

    -- Duplicate-invoice and completed-TTR rules (spec 3.3, 3.5, 4.3). The edge function checked them on data it
    -- read earlier; two saves on one invoice can both pass that. Serialise on (entity, invoice), then check
    -- again against what is committed now. The lock is held to the end of this transaction.
    IF v_invoice IS NOT NULL THEN
        PERFORM gold._lock_invoice(p_entity, v_invoice);
        PERFORM gold._check_invoice(p_entity, v_invoice, v_date, v_customer, v_joint, null,
            (p_purchase ->> 'purchase_type'), (p_purchase ->> 'cash_10k_or_more')::boolean);
    END IF;

    INSERT INTO gold.purchases (
        id, reporting_entity_id, customer_id, joint_customer_id,
        main_id_verification_id, joint_id_verification_id, purchase_type,
        cash_band, cash_10k_or_more, cash_amount, invoice_cash_total,
        erp_invoice_no, sale_date, phone, id_sighted,
        id_expired_at_time, id_outside_window_at_time,
        ttr_self_conducted, ttr_details_confirmed, created_by_staff_id
    ) VALUES (
        v_id, p_entity, v_customer, v_joint, v_main_id, v_joint_id,
        (p_purchase ->> 'purchase_type')::gold.purchase_type,
        p_purchase ->> 'cash_band', (p_purchase ->> 'cash_10k_or_more')::boolean,
        (p_purchase ->> 'cash_amount')::numeric, (p_purchase ->> 'invoice_cash_total')::numeric,
        nullif(btrim(p_purchase ->> 'erp_invoice_no'), ''), (p_purchase ->> 'sale_date')::date,
        p_purchase ->> 'phone', (p_purchase ->> 'id_sighted')::boolean,
        (p_purchase ->> 'id_expired_at_time')::boolean, (p_purchase ->> 'id_outside_window_at_time')::boolean,
        (p_purchase ->> 'ttr_self_conducted')::boolean, (p_purchase ->> 'ttr_details_confirmed')::boolean,
        p_staff
    );

    FOR ph IN SELECT * FROM jsonb_array_elements(p_photos) LOOP
        INSERT INTO gold.goods_photos (
            purchase_id, reporting_entity_id, object_path, content_hash_sha256,
            byte_size, captured_by_staff_id, sort_order
        ) VALUES (
            v_id, p_entity, ph ->> 'object_path', ph ->> 'content_hash_sha256',
            (ph ->> 'byte_size')::int, p_staff, n
        );
        n := n + 1;
    END LOOP;

    PERFORM gold._fill_linked_amounts(
        p_entity, v_customer, v_joint, p_purchase ->> 'erp_invoice_no', v_date, p_fills);

    -- 3.5: join a same-type draft TTR of this invoice and refresh its cash.
    IF v_invoice IS NOT NULL THEN
        PERFORM gold._sync_ttr_draft(p_entity, v_customer, v_joint, v_invoice, v_date, p_purchase ->> 'purchase_type');
    END IF;

    RETURN v_id;
END;
$$;


-- ─── Complete a purchase ─────────────────────────────────────────────────────────────────
-- Adds the ERP invoice number. erp_invoice_no and completed_at / completed_by_staff_id are set
-- in ONE update, as the immutability trigger requires. When the purchase is linked to earlier
-- parts, p_part_amount fills this purchase's own missing amount and p_fills the earlier parts'.
CREATE OR REPLACE FUNCTION gold.complete_purchase(
    p_entity      UUID,
    p_staff       UUID,
    p_purchase_id UUID,
    p_invoice     TEXT,
    p_part_amount NUMERIC,
    p_fills       JSONB
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = gold, public, ttr, pg_temp
AS $$
DECLARE
    v gold.purchases%ROWTYPE;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.staff_members
                   WHERE id = p_staff AND reporting_entity_id = p_entity AND is_active) THEN
        RAISE EXCEPTION 'staff member is not active in this entity' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT * INTO v FROM gold.purchases
    WHERE id = p_purchase_id AND reporting_entity_id = p_entity
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'purchase not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF v.erp_invoice_no IS NOT NULL THEN
        RAISE EXCEPTION 'the purchase already has an ERP invoice number' USING ERRCODE = 'restrict_violation';
    END IF;
    IF nullif(btrim(p_invoice), '') IS NULL THEN
        RAISE EXCEPTION 'an ERP invoice number is required' USING ERRCODE = 'check_violation';
    END IF;

    PERFORM set_config('app.actor_staff_id', p_staff::text, true);
    PERFORM set_config('app.change_source', 'complete_purchase', true);

    -- Same serialisation as save_purchase. Whether the sale is reportable is not stored for a linked purchase, so
    -- it is the stored flag or an invoice total (this purchase's cash, the linked parts' cash and the fills) of
    -- $10,000 or more, as goldRules.js evaluateCash works it out.
    PERFORM gold._lock_invoice(p_entity, p_invoice);
    PERFORM gold._check_invoice(p_entity, p_invoice, v.sale_date, v.customer_id, v.joint_customer_id, v.id,
        v.purchase_type::text,
        v.cash_10k_or_more OR (
            coalesce(v.cash_amount, p_part_amount, 0) + coalesce((
                SELECT sum(coalesce(l.cash_amount, (SELECT (f ->> 'cash_amount')::numeric
                                                    FROM jsonb_array_elements(coalesce(p_fills, '[]'::jsonb)) f
                                                    WHERE (f ->> 'id')::uuid = l.id), 0))
                FROM gold.purchases l
                WHERE l.reporting_entity_id = p_entity AND l.id <> v.id
                  AND l.erp_invoice_norm = upper(btrim(p_invoice)) AND l.sale_date = v.sale_date
                  AND (l.customer_id IN (v.customer_id, coalesce(v.joint_customer_id, v.customer_id))
                       OR coalesce(l.joint_customer_id IN (v.customer_id, coalesce(v.joint_customer_id, v.customer_id)), false))), 0) >= 10000));

    UPDATE gold.purchases
    SET erp_invoice_no        = btrim(p_invoice),
        completed_at          = now(),
        completed_by_staff_id = p_staff,
        cash_amount           = coalesce(cash_amount, p_part_amount)
    WHERE id = p_purchase_id;

    PERFORM gold._fill_linked_amounts(
        p_entity, v.customer_id, v.joint_customer_id, p_invoice, v.sale_date, p_fills);

    -- 3.5: join a same-type draft TTR of this invoice and refresh its cash.
    PERFORM gold._sync_ttr_draft(p_entity, v.customer_id, v.joint_customer_id, btrim(p_invoice), v.sale_date, v.purchase_type::text);
END;
$$;
