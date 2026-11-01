-- Gold purchase writes (spec 4.2, 4.3, 4.5): the two atomic write functions behind
-- gold-save-purchase and gold-complete-purchase.
--
-- Each is one SQL function, so a purchase, its goods photo rows and any "cash paid on that
-- part" fills on earlier linked parts all commit together or not at all. The edge function has
-- already run the rules (goldRules.js) on server-loaded data and uploaded the photo objects;
-- these functions still re-check what the database can check by itself (the staff member and
-- every customer, ID and linked part belong to the entity), because the service role bypasses
-- RLS and must never act on a client-supplied id alone.
--
-- EXECUTE is granted to service_role only. The browser has no write path into gold.
--
-- Errors the edge functions map to a response (everything else is a 500):
--   22023 invalid_parameter_value  something named in the call is not in the entity
--   40001 serialization_failure    a linked part's amount changed since it was loaded (409)
--   23001 restrict_violation       the purchase already has an invoice number (409)
--   P0002 no_data_found            the purchase does not exist in the entity (404)
-- Messages carry no customer data, so they are safe to surface in logs by code only.

-- ─── Cash fills on earlier linked parts ──────────────────────────────────────────────────
-- Fills a missing amount on a part that is linked to the purchase being written: same entity,
-- same invoice, same sale date, and the part's seller is the purchase's main or joint seller.
-- A part that already has an amount is never overwritten. Audited by trg_gp_audit (the caller
-- sets app.actor_staff_id and app.change_source first).
CREATE OR REPLACE FUNCTION gold._fill_linked_amounts(
    p_entity   UUID,
    p_customer UUID,
    p_joint    UUID,
    p_invoice  TEXT,
    p_sale_date DATE,
    p_fills    JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = gold, public, pg_temp
AS $$
DECLARE
    f JSONB;
BEGIN
    IF p_fills IS NULL OR jsonb_typeof(p_fills) <> 'array' THEN
        RETURN;
    END IF;
    FOR f IN SELECT * FROM jsonb_array_elements(p_fills) LOOP
        UPDATE gold.purchases p
        SET cash_amount = (f ->> 'cash_amount')::numeric
        WHERE p.id = (f ->> 'id')::uuid
          AND p.reporting_entity_id = p_entity
          AND p.cash_amount IS NULL
          AND p.erp_invoice_norm = upper(btrim(p_invoice))
          AND p.sale_date = p_sale_date
          AND (p.customer_id IN (p_customer, p_joint) OR p.joint_customer_id IN (p_customer, p_joint));
        IF NOT FOUND THEN
            RAISE EXCEPTION 'a linked part changed while the purchase was being saved'
                USING ERRCODE = 'serialization_failure';
        END IF;
    END LOOP;
END;
$$;

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
        p_entity, v_customer, v_joint, p_purchase ->> 'erp_invoice_no', (p_purchase ->> 'sale_date')::date, p_fills);

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

REVOKE EXECUTE ON FUNCTION gold._fill_linked_amounts(UUID, UUID, UUID, TEXT, DATE, JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gold.save_purchase(UUID, UUID, JSONB, JSONB, JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gold.complete_purchase(UUID, UUID, UUID, TEXT, NUMERIC, JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION gold._fill_linked_amounts(UUID, UUID, UUID, TEXT, DATE, JSONB) TO service_role;
GRANT  EXECUTE ON FUNCTION gold.save_purchase(UUID, UUID, JSONB, JSONB, JSONB)           TO service_role;
GRANT  EXECUTE ON FUNCTION gold.complete_purchase(UUID, UUID, UUID, TEXT, NUMERIC, JSONB) TO service_role;
