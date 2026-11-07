-- search_gold_purchases also finds an ERP invoice number (Gold Phase 8b, spec 4.6).
--
-- The handover's search box on Purchases takes "name, phone, licence or ID number, or invoice number". The
-- Phase 6 function matched the customer part only. This redefinition keeps everything else as it was (same
-- arguments, columns, grants, filters, order and paging) and adds: with a search term of 2 or more characters, a
-- purchase also matches when its normalised invoice number contains the term (case-insensitive, no wildcards).
-- A term that matches no customer and no invoice returns no rows, as before.
CREATE OR REPLACE FUNCTION gold.search_gold_purchases(
    p_filters   JSONB,
    p_page      INT,
    p_page_size INT
)
RETURNS TABLE (
    id                       UUID,
    reporting_entity_id      UUID,
    customer_id              UUID,
    joint_customer_id        UUID,
    main_id_verification_id  UUID,
    joint_id_verification_id UUID,
    purchase_type            TEXT,
    cash_band                TEXT,
    cash_10k_or_more         BOOLEAN,
    cash_amount              NUMERIC,
    invoice_cash_total       NUMERIC,
    erp_invoice_no           TEXT,
    erp_invoice_norm         TEXT,
    sale_date                DATE,
    phone                    TEXT,
    id_sighted               BOOLEAN,
    id_expired_at_time       BOOLEAN,
    id_outside_window_at_time BOOLEAN,
    ttr_self_conducted       BOOLEAN,
    ttr_details_confirmed    BOOLEAN,
    ttr_transaction_id       UUID,
    created_at               TIMESTAMPTZ,
    created_by_staff_id      UUID,
    completed_at             TIMESTAMPTZ,
    completed_by_staff_id    UUID,
    updated_at               TIMESTAMPTZ,
    customer_first_name      TEXT,
    customer_last_name       TEXT,
    joint_customer_first_name TEXT,
    joint_customer_last_name TEXT,
    ttr_status               TEXT,
    ttr_transaction_ref      TEXT,
    total_count              BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = gold, public, ttr, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_entity UUID := public.reporting_entity_id();
    v_q      TEXT := nullif(btrim(coalesce(p_filters ->> 'q', '')), '');
    v_status TEXT := nullif(p_filters ->> 'status', '');
    v_type   TEXT := nullif(p_filters ->> 'type', '');
    v_cash   TEXT := nullif(p_filters ->> 'cash', '');
    v_from   DATE := nullif(p_filters ->> 'date_from', '')::date;
    v_to     DATE := nullif(p_filters ->> 'date_to', '')::date;
    v_by     UUID := nullif(p_filters ->> 'recorded_by', '')::uuid;
    v_size   INT  := least(greatest(coalesce(p_page_size, 25), 1), 100);
    v_page   INT  := greatest(coalesce(p_page, 1), 1);
    v_ids    UUID[];
BEGIN
    IF v_entity IS NULL THEN
        RETURN;
    END IF;

    IF v_q IS NOT NULL THEN
        SELECT array_agg(s.customer_id) INTO v_ids FROM public._search_customer_ids(v_entity, v_q) s;
    END IF;

    RETURN QUERY
    SELECT p.id, p.reporting_entity_id, p.customer_id, p.joint_customer_id,
           p.main_id_verification_id, p.joint_id_verification_id, p.purchase_type::text,
           p.cash_band, p.cash_10k_or_more, p.cash_amount, p.invoice_cash_total,
           p.erp_invoice_no, p.erp_invoice_norm, p.sale_date, p.phone, p.id_sighted,
           p.id_expired_at_time, p.id_outside_window_at_time, p.ttr_self_conducted,
           p.ttr_details_confirmed, p.ttr_transaction_id, p.created_at, p.created_by_staff_id,
           p.completed_at, p.completed_by_staff_id, p.updated_at,
           cu.first_name, cu.last_name, ju.first_name, ju.last_name,
           t.status::text, t.transaction_ref,
           count(*) OVER ()
    FROM gold.purchases p
    JOIN public.customers cu ON cu.id = p.customer_id
    LEFT JOIN public.customers ju ON ju.id = p.joint_customer_id
    LEFT JOIN ttr.transactions t ON t.id = p.ttr_transaction_id
    WHERE p.reporting_entity_id = v_entity
      AND (v_q IS NULL
           OR p.customer_id = ANY (v_ids)
           OR p.joint_customer_id = ANY (v_ids)
           OR (length(v_q) >= 2 AND strpos(p.erp_invoice_norm, upper(v_q)) > 0))
      AND (v_type IS NULL OR p.purchase_type::text = v_type)
      AND (v_cash IS NULL OR CASE v_cash
               WHEN 'yes' THEN p.cash_10k_or_more
               WHEN 'no'  THEN NOT p.cash_10k_or_more
               ELSE FALSE END)
      AND (v_from IS NULL OR p.sale_date >= v_from)
      AND (v_to   IS NULL OR p.sale_date <= v_to)
      AND (v_by   IS NULL OR p.created_by_staff_id = v_by)
      AND (v_status IS NULL OR CASE v_status
               WHEN 'incomplete' THEN
                   p.erp_invoice_no IS NULL OR (p.cash_10k_or_more AND t.status IS DISTINCT FROM 'complete')
               WHEN 'complete' THEN
                   p.erp_invoice_no IS NOT NULL AND NOT (p.cash_10k_or_more AND t.status IS DISTINCT FROM 'complete')
               WHEN 'austrac_pending' THEN
                   p.cash_10k_or_more AND t.status IS DISTINCT FROM 'complete'
               WHEN 'austrac' THEN
                   p.cash_10k_or_more AND t.status = 'complete'
               ELSE FALSE END)
    ORDER BY p.created_at DESC, p.id
    LIMIT v_size OFFSET (v_page - 1) * v_size;
END;
$$;
