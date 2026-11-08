-- To complete: a part linked to a TTR that is not complete stays listed even when its own
-- cash_10k_or_more flag is false. gold-save-purchase flags only the part that tips the invoice
-- total over the threshold, so the earlier part of a mixed invoice (spec 3.4) is linked to a
-- draft TTR but unflagged, and was missing. Listed now when: no invoice yet, or flagged or
-- linked to a TTR, with that TTR not complete. The flag's meaning is unchanged.
CREATE OR REPLACE FUNCTION gold.list_incomplete_purchases()
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
    ttr_transaction_ref      TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = gold, public, ttr, pg_temp
AS $$
    SELECT p.id, p.reporting_entity_id, p.customer_id, p.joint_customer_id,
           p.main_id_verification_id, p.joint_id_verification_id, p.purchase_type::text,
           p.cash_band, p.cash_10k_or_more, p.cash_amount, p.invoice_cash_total,
           p.erp_invoice_no, p.erp_invoice_norm, p.sale_date, p.phone, p.id_sighted,
           p.id_expired_at_time, p.id_outside_window_at_time, p.ttr_self_conducted,
           p.ttr_details_confirmed, p.ttr_transaction_id, p.created_at, p.created_by_staff_id,
           p.completed_at, p.completed_by_staff_id, p.updated_at,
           cu.first_name, cu.last_name, ju.first_name, ju.last_name,
           t.status::text, t.transaction_ref
    FROM gold.purchases p
    JOIN public.customers cu ON cu.id = p.customer_id
    LEFT JOIN public.customers ju ON ju.id = p.joint_customer_id
    LEFT JOIN ttr.transactions t ON t.id = p.ttr_transaction_id
    WHERE p.reporting_entity_id = public.reporting_entity_id()
      AND (p.erp_invoice_no IS NULL
           OR ((p.cash_10k_or_more OR p.ttr_transaction_id IS NOT NULL)
               AND t.status IS DISTINCT FROM 'complete'))
    ORDER BY p.created_at DESC, p.id
$$;
