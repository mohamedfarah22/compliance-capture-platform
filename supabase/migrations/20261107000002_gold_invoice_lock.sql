-- Gold: close the duplicate-invoice race (UAT defect D1, spec 3.3 "Duplicate invoices", 3.5, 4.3).
--
-- gold-save-purchase and gold-complete-purchase run the duplicate-invoice and completed-TTR rules on data they
-- read before calling the SQL write functions, so two simultaneous reportable saves on one invoice could both
-- pass. Both functions now take a transaction-scoped advisory lock on (entity, normalised invoice) and re-check
-- those two rules against committed data before writing. The second caller waits for the first to commit, then
-- sees its row and is refused.
--
-- Refusals (the edge functions turn them into the usual 422 errors.erp_invoice_no):
--   GD001  the invoice is on a purchase that is not a same-day linked part, and the sale is reportable
--   GD002  a linked part of the same type already has a completed TTR
-- Create-or-replace of the two Phase 7 functions: signatures and grants are unchanged.

CREATE OR REPLACE FUNCTION gold._lock_invoice(p_entity UUID, p_invoice TEXT)
RETURNS VOID
LANGUAGE sql
AS $$
    SELECT pg_advisory_xact_lock(hashtextextended(p_entity::text || ':' || upper(btrim(p_invoice)), 0))
$$;

-- p_self: the purchase being completed (excluded), or null for a new one.
CREATE OR REPLACE FUNCTION gold._check_invoice(
    p_entity UUID, p_invoice TEXT, p_sale_date DATE, p_customer UUID, p_joint UUID,
    p_self UUID, p_type TEXT, p_reportable BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = gold, public, ttr, pg_temp
AS $$
BEGIN
    -- A same-day part of the sellers (as main or joint) is linked; a completed TTR of this type blocks the part.
    IF EXISTS (
        SELECT 1 FROM gold.purchases p
        LEFT JOIN ttr.transactions t ON t.id = p.ttr_transaction_id
        WHERE p.reporting_entity_id = p_entity AND p.erp_invoice_norm = upper(btrim(p_invoice))
          AND p.sale_date = p_sale_date AND p.id IS DISTINCT FROM p_self
          AND (p.customer_id IN (p_customer, coalesce(p_joint, p_customer)) OR coalesce(p.joint_customer_id IN (p_customer, coalesce(p_joint, p_customer)), false))
          AND p.purchase_type::text = p_type AND t.status::text = 'complete'
    ) THEN
        RAISE EXCEPTION 'the AUSTRAC report for this invoice is already finished' USING ERRCODE = 'GD002';
    END IF;

    IF p_reportable AND EXISTS (
        SELECT 1 FROM gold.purchases p
        WHERE p.reporting_entity_id = p_entity AND p.erp_invoice_norm = upper(btrim(p_invoice))
          AND p.id IS DISTINCT FROM p_self
          AND NOT (p.sale_date = p_sale_date
                   AND (p.customer_id IN (p_customer, coalesce(p_joint, p_customer)) OR coalesce(p.joint_customer_id IN (p_customer, coalesce(p_joint, p_customer)), false)))
    ) THEN
        RAISE EXCEPTION 'the invoice number is already used by another purchase' USING ERRCODE = 'GD001';
    END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION gold._lock_invoice(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gold._check_invoice(UUID, TEXT, DATE, UUID, UUID, UUID, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION gold._lock_invoice(UUID, TEXT) TO service_role;
GRANT  EXECUTE ON FUNCTION gold._check_invoice(UUID, TEXT, DATE, UUID, UUID, UUID, TEXT, BOOLEAN) TO service_role;

-- ─── Save a purchase ─────────────────────────────────────────────────────────────────────
-- p_purchase  the row to insert, as computed by the edge function. Keys: id, customer_id,
--             joint_customer_id, main_id_verification_id, joint_id_verification_id,
--             purchase_type, cash_band, cash_10k_or_more, cash_amount, invoice_cash_total,
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
END;
$$;
