-- Gold read RPCs about purchases (spec 3.3, 4.2 "Linked parts", 4.6, C1).
--
-- All SECURITY DEFINER with a fixed search_path, each scoped to public.reporting_entity_id()
-- (NULL below aal2, so they return nothing to a password-only session), EXECUTE for
-- authenticated and service_role only. Like the customer RPCs, they identify the caller by
-- auth.uid(), so an edge function calls them with the caller's own JWT client.
--
-- ttr_status everywhere is the raw ttr.transactions.status ('draft' | 'complete'), NULL when
-- the purchase has no TTR. Purchase enums come back as text.

-- ─── Linked parts: the one shared query ──────────────────────────────────────────────────
-- Earlier and later parts of the same invoice on the same day where the customer is the main
-- or joint seller. Serves findSameDayInvoicePurchases and the server's re-check on save.
-- p_invoice_norm is normalised here too, so a raw invoice number works as well.
CREATE OR REPLACE FUNCTION gold.linked_parts(
    p_customer_id  UUID,
    p_invoice_norm TEXT,
    p_sale_date    DATE
)
RETURNS TABLE (
    id                 UUID,
    purchase_type      TEXT,
    cash_10k_or_more   BOOLEAN,
    cash_amount        NUMERIC,
    ttr_transaction_id UUID,
    ttr_status         TEXT,
    customer_id        UUID,
    joint_customer_id  UUID,
    erp_invoice_no     TEXT,
    sale_date          DATE,
    created_at         TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = gold, public, ttr, pg_temp
AS $$
    SELECT p.id, p.purchase_type::text, p.cash_10k_or_more, p.cash_amount, p.ttr_transaction_id,
           t.status::text, p.customer_id, p.joint_customer_id, p.erp_invoice_no, p.sale_date, p.created_at
    FROM gold.purchases p
    LEFT JOIN ttr.transactions t ON t.id = p.ttr_transaction_id
    WHERE p.reporting_entity_id = public.reporting_entity_id()
      AND nullif(btrim(p_invoice_norm), '') IS NOT NULL
      AND p.erp_invoice_norm = upper(btrim(p_invoice_norm))
      AND p.sale_date = p_sale_date
      AND (p.customer_id = p_customer_id OR p.joint_customer_id = p_customer_id)
    ORDER BY p.created_at, p.id
$$;

-- ─── Every purchase on an invoice ────────────────────────────────────────────────────────
-- For the duplicate-invoice rule. The caller removes the linked parts itself (goldRules).
CREATE OR REPLACE FUNCTION gold.invoice_purchases(p_invoice TEXT)
RETURNS TABLE (
    id                UUID,
    customer_id       UUID,
    joint_customer_id UUID,
    sale_date         DATE
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = gold, public, pg_temp
AS $$
    SELECT p.id, p.customer_id, p.joint_customer_id, p.sale_date
    FROM gold.purchases p
    WHERE p.reporting_entity_id = public.reporting_entity_id()
      AND nullif(btrim(p_invoice), '') IS NOT NULL
      AND p.erp_invoice_norm = upper(btrim(p_invoice))
    ORDER BY p.created_at, p.id
$$;

-- ─── To complete ─────────────────────────────────────────────────────────────────────────
-- No invoice yet, or reportable (cash_10k_or_more) with a TTR that is not complete (a draft,
-- or none at all). Newest first. Purchase columns plus the seller names and TTR status.
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
           OR (p.cash_10k_or_more AND t.status IS DISTINCT FROM 'complete'))
    ORDER BY p.created_at DESC, p.id
$$;

-- ─── Purchases screen ────────────────────────────────────────────────────────────────────
-- p_filters keys (all optional):
--   q            name / phone / ID number, same rules as search_customers, matched against the
--                main or joint seller. Blank = no filter; under 2 characters = no rows.
--   status       incomplete        no invoice, or reportable with the TTR not complete
--                complete          the opposite of incomplete
--                austrac_pending   reportable, TTR not complete (draft or none)
--                austrac           reportable, TTR complete
--   type         scrap | bullion
--   cash         yes | no          (cash_10k_or_more)
--   date_from, date_to            on sale_date, inclusive
--   recorded_by  staff id of created_by_staff_id
-- An unknown status, type or cash value matches nothing. Newest first. p_page starts at 1;
-- p_page_size is 1..100 (default 25). total_count is the number of matches over all pages,
-- repeated on every row (so it is not available for a page past the end).
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
        IF v_ids IS NULL THEN
            RETURN;
        END IF;
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
      AND (v_ids IS NULL OR p.customer_id = ANY (v_ids) OR p.joint_customer_id = ANY (v_ids))
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

-- ─── Recorded-by filter ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION gold.list_recorded_by()
RETURNS TABLE (
    staff_member_id UUID,
    full_name       TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = gold, public, pg_temp
AS $$
    SELECT DISTINCT sm.id, sm.full_name
    FROM gold.purchases p
    JOIN public.staff_members sm ON sm.id = p.created_by_staff_id
    WHERE p.reporting_entity_id = public.reporting_entity_id()
    ORDER BY sm.full_name, sm.id
$$;

-- ─── ID used for a purchase (C1) ─────────────────────────────────────────────────────────
-- One row for the main seller and one for the joint seller: the ID capture saved with the
-- purchase. If that capture's photos were replaced (a later capture of the same document
-- superseded them), photos_replaced is true and current_copy_* describe the newest
-- capture of the same document that still has its photos, found by following
-- prior_verification_id forward. front_image_id / back_image_id are the images to show: the
-- current copy's when replaced (NULL if somehow none is left), else the capture's own.
-- A different document (unlinked capture) is a separate chain and is never followed.
CREATE OR REPLACE FUNCTION gold.purchase_id_used(p_purchase_id UUID)
RETURNS TABLE (
    role                       TEXT,
    verification_id            UUID,
    document_type              TEXT,
    document_number            TEXT,
    issuer                     TEXT,
    id_country_code            TEXT,
    expiry_date                DATE,
    captured_at                TIMESTAMPTZ,
    captured_by_name           TEXT,
    photos_replaced            BOOLEAN,
    current_copy_verification_id UUID,
    current_copy_captured_at   TIMESTAMPTZ,
    front_image_id             UUID,
    back_image_id              UUID
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = gold, public, ttr, pg_temp
AS $$
    WITH used AS (
        SELECT 'main'::text AS role, 0 AS ord, x.*
        FROM gold.purchases p
        JOIN gold._id_captures x ON x.id = p.main_id_verification_id
        WHERE p.id = p_purchase_id
          AND p.reporting_entity_id = public.reporting_entity_id()
        UNION ALL
        SELECT 'joint'::text, 1, x.*
        FROM gold.purchases p
        JOIN gold._id_captures x ON x.id = p.joint_id_verification_id
        WHERE p.id = p_purchase_id
          AND p.reporting_entity_id = public.reporting_entity_id()
    )
    SELECT u.role, u.id, u.document_type, u.document_number, u.issuer, u.id_country_code,
           u.expiry_date, u.captured_at, u.captured_by_name,
           (u.front_superseded_at IS NOT NULL),
           cc.id, cc.captured_at,
           CASE WHEN u.front_superseded_at IS NOT NULL THEN cc.front_image_id ELSE u.front_image_id END,
           CASE WHEN u.front_superseded_at IS NOT NULL THEN cc.back_image_id  ELSE u.back_image_id  END
    FROM used u
    LEFT JOIN LATERAL (
        WITH RECURSIVE chain(id, depth) AS (
            SELECT u.id, 0
            UNION ALL
            SELECT n.id, ch.depth + 1
            FROM ttr.id_verifications n
            JOIN chain ch ON n.prior_verification_id = ch.id
            WHERE n.verification_basis::text = 'new_capture'
              AND n.reporting_entity_id = u.reporting_entity_id
              AND ch.depth < 20
        )
        SELECT x.id, x.captured_at, x.front_image_id, x.back_image_id
        FROM chain
        JOIN gold._id_captures x ON x.id = chain.id
        WHERE u.front_superseded_at IS NOT NULL
          AND x.id <> u.id
          AND x.front_image_id IS NOT NULL
          AND x.front_superseded_at IS NULL
        ORDER BY x.captured_at DESC, x.id DESC
        LIMIT 1
    ) cc ON TRUE
    ORDER BY u.ord
$$;

-- ─── Grants ──────────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION gold.linked_parts(UUID, TEXT, DATE)            FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION gold.invoice_purchases(TEXT)                   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION gold.list_incomplete_purchases()               FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION gold.search_gold_purchases(JSONB, INT, INT)    FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION gold.list_recorded_by()                        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION gold.purchase_id_used(UUID)                    FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION gold.linked_parts(UUID, TEXT, DATE)            TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION gold.invoice_purchases(TEXT)                   TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION gold.list_incomplete_purchases()               TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION gold.search_gold_purchases(JSONB, INT, INT)    TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION gold.list_recorded_by()                        TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION gold.purchase_id_used(UUID)                    TO authenticated, service_role;
