-- Gold read RPCs about customers and their IDs (spec 1.5, 1.6 "Current ID", 3.3).
--
-- The browser cannot read customer-level ID rows (ttr.id_verifications is scoped to
-- transactions), so everything about a customer's ID comes through these SECURITY DEFINER
-- functions. Each one scopes itself to public.reporting_entity_id() (NULL below aal2, so a
-- password-only session gets nothing) and returns nothing for another entity's customer.
--
-- EXECUTE: authenticated and service_role. Note service_role has no auth.uid(), so these
-- return nothing when called with the service-role key; edge functions call them with the
-- caller's own JWT client (goldAuth.ts returns it as userClient).

-- ─── ID captures on file ─────────────────────────────────────────────────────────────────
-- One place that says what counts as a customer's ID: a `new_capture` row owned by the
-- customer, either customer-level (no transaction) or from a completed TTR. Reliance rows
-- hold no images and point at a capture, so they are not IDs on file. Draft TTR captures are
-- not on file until their TTR completes.
--
-- captured_at is the capture row's created_at, the same moment IdVerificationPage measures
-- the re-verification window from (evaluateReliance). stored_images.captured_at would be
-- the photograph time, but it is set when the file is uploaded, within the same request, so
-- the two do not differ in practice and TTR and gold must agree on the window.
--
-- Internal: owned by the migration role (reads past RLS), granted to nobody but service_role.
-- The SECURITY DEFINER functions below read it and always filter by entity.

CREATE VIEW gold._id_captures AS
SELECT
    iv.id,
    iv.reporting_entity_id,
    iv.customer_id,
    iv.transaction_id,
    iv.document_type::text            AS document_type,
    iv.document_number,
    iv.number_norm,
    iv.issuer,
    iv.id_country_code::text          AS id_country_code,
    iv.has_expiry,
    iv.expiry_date,
    iv.verification_basis::text       AS verification_basis,
    iv.prior_verification_id,
    iv.created_at                     AS captured_at,
    COALESCE(sm.full_name, t.staff_member_name) AS captured_by_name,
    iv.front_image_id,
    iv.back_image_id,
    fi.superseded_at                  AS front_superseded_at,
    (iv.verification_basis::text = 'new_capture'
        AND iv.customer_id IS NOT NULL
        AND (iv.transaction_id IS NULL OR t.status = 'complete')) AS is_on_file
FROM ttr.id_verifications iv
LEFT JOIN ttr.transactions     t  ON t.id  = iv.transaction_id
LEFT JOIN ttr.stored_images    fi ON fi.id = iv.front_image_id
LEFT JOIN public.staff_members sm ON sm.id = fi.captured_by_staff_id;

REVOKE ALL ON gold._id_captures FROM PUBLIC, anon, authenticated;
GRANT SELECT ON gold._id_captures TO service_role;

-- ─── Shared search core ──────────────────────────────────────────────────────────────────
-- Used by search_customers and the `q` filter of gold.search_gold_purchases, so both follow
-- the same rules (spec 1.5): individuals only, 2+ characters.
--   name   every word of the term is found somewhere in first + middle + last name (or in an
--          alias), case-insensitive. The longest three words go to the trigram index; the
--          rest are checked on the rows it returns.
--   phone  only when the term has 4+ digits; digits only, a leading 61 / +61 read as 0.
--   ID     the term with spaces and dashes removed, upper-cased, found in number_norm of any
--          ID capture on file for the customer.
-- is_exact marks an exact phone or ID-number match, which sorts first.
-- Internal: execute is not granted to the API roles.

CREATE OR REPLACE FUNCTION public._search_customer_ids(p_entity UUID, p_q TEXT)
RETURNS TABLE (customer_id UUID, is_exact BOOLEAN)
LANGUAGE plpgsql STABLE
SET search_path = public, gold, ttr, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_term     TEXT := btrim(coalesce(p_q, ''));
    v_tokens   TEXT[];
    v_p1       TEXT;
    v_p2       TEXT;
    v_p3       TEXT;
    v_digits   TEXT;
    v_phone    TEXT;
    v_idn      TEXT;
    v_idn_like TEXT;
BEGIN
    IF p_entity IS NULL OR char_length(v_term) < 2 THEN
        RETURN;
    END IF;

    -- Words, longest first, with LIKE metacharacters escaped.
    v_tokens := ARRAY(
        SELECT replace(replace(replace(s.t, '\', '\\'), '%', '\%'), '_', '\_')
        FROM regexp_split_to_table(lower(v_term), '\s+') AS s(t)
        WHERE s.t <> ''
        ORDER BY char_length(s.t) DESC, s.t
    );
    v_p1 := '%' || v_tokens[1] || '%';
    v_p2 := coalesce('%' || v_tokens[2] || '%', '%');
    v_p3 := coalesce('%' || v_tokens[3] || '%', '%');

    v_digits := regexp_replace(v_term, '\D', '', 'g');
    IF char_length(v_digits) >= 4 THEN
        v_phone := regexp_replace(v_digits, '^61', '0');
    END IF;

    v_idn := upper(regexp_replace(v_term, '[\s-]', '', 'g'));
    IF char_length(v_idn) >= 2 THEN
        v_idn_like := replace(replace(replace(v_idn, '\', '\\'), '%', '\%'), '_', '\_');
    END IF;

    RETURN QUERY
    WITH cand AS (
        SELECT c.id
        FROM public.customers c
        WHERE c.reporting_entity_id = p_entity
          AND c.customer_type = 'individual'
          AND c.name_search LIKE v_p1
          AND c.name_search LIKE v_p2
          AND c.name_search LIKE v_p3
          AND NOT EXISTS (SELECT 1 FROM unnest(v_tokens) AS k(t) WHERE c.name_search NOT LIKE '%' || k.t || '%')
        UNION
        SELECT c.id
        FROM public.customer_aliases a
        JOIN public.customers c ON c.id = a.customer_id
        WHERE c.reporting_entity_id = p_entity
          AND c.customer_type = 'individual'
          AND a.alias ILIKE v_p1
          AND a.alias ILIKE v_p2
          AND a.alias ILIKE v_p3
          AND NOT EXISTS (SELECT 1 FROM unnest(v_tokens) AS k(t) WHERE a.alias NOT ILIKE '%' || k.t || '%')
        UNION
        SELECT c.id
        FROM public.customers c
        WHERE v_phone IS NOT NULL
          AND c.reporting_entity_id = p_entity
          AND c.customer_type = 'individual'
          AND c.phone_digits LIKE '%' || v_phone || '%'
        UNION
        SELECT c.id
        FROM gold._id_captures x
        JOIN public.customers c ON c.id = x.customer_id
        WHERE v_idn_like IS NOT NULL
          AND x.reporting_entity_id = p_entity
          AND x.is_on_file
          AND c.reporting_entity_id = p_entity
          AND c.customer_type = 'individual'
          AND x.number_norm LIKE '%' || v_idn_like || '%'
    )
    SELECT
        c.id,
        coalesce(
            (v_phone IS NOT NULL AND c.phone_digits = v_phone)
            OR (v_idn_like IS NOT NULL AND EXISTS (
                SELECT 1 FROM gold._id_captures x
                WHERE x.customer_id = c.id AND x.is_on_file AND x.reporting_entity_id = p_entity
                  AND x.number_norm = v_idn
            )),
            FALSE)
    FROM cand
    JOIN public.customers c ON c.id = cand.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public._search_customer_ids(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._search_customer_ids(UUID, TEXT) TO service_role;

-- ─── search_customers ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.search_customers(p_q TEXT)
RETURNS TABLE (
    customer_id                UUID,
    first_name                 TEXT,
    middle_name                TEXT,
    last_name                  TEXT,
    date_of_birth              DATE,
    phone                      TEXT,
    current_id_verification_id UUID,
    current_id_document_type   TEXT,
    current_id_document_number TEXT,
    current_id_expiry_date     DATE,
    current_id_has_expiry      BOOLEAN,
    current_id_captured_at     TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, gold, ttr, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_entity UUID := public.reporting_entity_id();
BEGIN
    IF v_entity IS NULL OR char_length(btrim(coalesce(p_q, ''))) < 2 THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT c.id, c.first_name, c.middle_name, c.last_name, c.date_of_birth, c.phone,
           cur.id, cur.document_type, cur.document_number, cur.expiry_date, cur.has_expiry, cur.captured_at
    FROM public._search_customer_ids(v_entity, p_q) s
    JOIN public.customers c ON c.id = s.customer_id
    LEFT JOIN LATERAL (
        SELECT x.id, x.document_type, x.document_number, x.expiry_date, x.has_expiry, x.captured_at
        FROM gold._id_captures x
        WHERE x.customer_id = c.id AND x.is_on_file
        ORDER BY x.captured_at DESC, x.id DESC
        LIMIT 1
    ) cur ON TRUE
    ORDER BY s.is_exact DESC, lower(c.last_name), lower(c.first_name), c.id
    LIMIT 20;
END;
$$;

-- ─── customer_current_id ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.customer_current_id(p_customer_id UUID)
RETURNS TABLE (
    verification_id   UUID,
    document_type     TEXT,
    document_number   TEXT,
    issuer            TEXT,
    id_country_code   TEXT,
    has_expiry        BOOLEAN,
    expiry_date       DATE,
    captured_at       TIMESTAMPTZ,
    captured_by_name  TEXT,
    front_image_id    UUID,
    back_image_id     UUID
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, gold, ttr, pg_temp
AS $$
    SELECT x.id, x.document_type, x.document_number, x.issuer, x.id_country_code,
           x.has_expiry, x.expiry_date, x.captured_at, x.captured_by_name,
           x.front_image_id, x.back_image_id
    FROM gold._id_captures x
    WHERE x.customer_id = p_customer_id
      AND x.is_on_file
      AND x.reporting_entity_id = public.reporting_entity_id()
    ORDER BY x.captured_at DESC, x.id DESC
    LIMIT 1
$$;

-- ─── find_possible_duplicate_customers ───────────────────────────────────────────────────
-- Prompts only, never blocks: same first + last name (case-insensitive) and date of birth,
-- or the same phone. A phone shorter than 8 digits is not compared, as the rest of gold
-- treats it as not a phone number.
CREATE OR REPLACE FUNCTION public.find_possible_duplicate_customers(
    p_first_name TEXT,
    p_last_name  TEXT,
    p_dob        DATE,
    p_phone      TEXT
)
RETURNS TABLE (
    customer_id   UUID,
    first_name    TEXT,
    last_name     TEXT,
    date_of_birth DATE,
    phone         TEXT,
    match_reason  TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT c.id, c.first_name, c.last_name, c.date_of_birth, c.phone,
           CASE WHEN m.by_name THEN 'name_dob' ELSE 'phone' END
    FROM public.customers c
    CROSS JOIN LATERAL (
        SELECT nullif(regexp_replace(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), '^61', '0'), '') AS digits
    ) pn
    CROSS JOIN LATERAL (
        SELECT (nullif(btrim(p_first_name), '') IS NOT NULL
                AND nullif(btrim(p_last_name), '') IS NOT NULL
                AND p_dob IS NOT NULL
                AND lower(c.last_name)  = lower(btrim(p_last_name))
                AND lower(c.first_name) = lower(btrim(p_first_name))
                AND c.date_of_birth = p_dob) AS by_name,
               (pn.digits IS NOT NULL AND char_length(pn.digits) >= 8
                AND c.phone_digits = pn.digits) AS by_phone
    ) m
    WHERE c.reporting_entity_id = public.reporting_entity_id()
      AND c.customer_type = 'individual'
      AND (m.by_name OR m.by_phone)
    ORDER BY m.by_name DESC, lower(c.last_name), lower(c.first_name), c.id
$$;

-- ─── customer_ttr_ready ──────────────────────────────────────────────────────────────────
-- The fields Party Details requires for an individual (spec 3.3 table) that this customer
-- does not have yet, as a stable list of snake_case names; empty when the customer is ready
-- for case A. NULL when the customer is not an individual of the caller's entity.
--   first_name, last_name, date_of_birth,
--   res_street, res_suburb, res_state, res_postcode, res_country,
--   phone, occupation, gender,
--   citizenship_country_code, tax_residency_country_code,
--   is_sole_trader, abn (only when a sole trader),
--   post_street, post_suburb, post_state, post_postcode, post_country (only when flagged),
--   id_document (no ID on file), id_country_code, id_issuer (of the current ID).
CREATE OR REPLACE FUNCTION public.customer_ttr_ready(p_customer_id UUID)
RETURNS TEXT[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, gold, ttr, pg_temp
AS $$
DECLARE
    c   public.customers%ROWTYPE;
    cur RECORD;
    v   TEXT[] := '{}';
BEGIN
    SELECT * INTO c
    FROM public.customers
    WHERE id = p_customer_id
      AND reporting_entity_id = public.reporting_entity_id()
      AND customer_type = 'individual';
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF coalesce(btrim(c.first_name), '') = '' THEN v := array_append(v, 'first_name'); END IF;
    IF coalesce(btrim(c.last_name), '')  = '' THEN v := array_append(v, 'last_name'); END IF;
    IF c.date_of_birth IS NULL THEN v := array_append(v, 'date_of_birth'); END IF;

    IF coalesce(btrim(c.res_street), '')   = '' THEN v := array_append(v, 'res_street'); END IF;
    IF coalesce(btrim(c.res_suburb), '')   = '' THEN v := array_append(v, 'res_suburb'); END IF;
    IF c.res_state IS NULL                      THEN v := array_append(v, 'res_state'); END IF;
    IF coalesce(btrim(c.res_postcode), '') = '' THEN v := array_append(v, 'res_postcode'); END IF;
    IF coalesce(btrim(c.res_country), '')  = '' THEN v := array_append(v, 'res_country'); END IF;

    IF coalesce(btrim(c.phone), '')      = '' THEN v := array_append(v, 'phone'); END IF;
    IF coalesce(btrim(c.occupation), '') = '' THEN v := array_append(v, 'occupation'); END IF;
    IF c.gender IS NULL THEN v := array_append(v, 'gender'); END IF;

    IF coalesce(btrim(c.citizenship_country_code), '')   = '' THEN v := array_append(v, 'citizenship_country_code'); END IF;
    IF coalesce(btrim(c.tax_residency_country_code), '') = '' THEN v := array_append(v, 'tax_residency_country_code'); END IF;

    IF c.is_sole_trader IS NULL THEN
        v := array_append(v, 'is_sole_trader');
    ELSIF c.is_sole_trader AND coalesce(btrim(c.abn), '') = '' THEN
        v := array_append(v, 'abn');
    END IF;

    IF c.has_postal_address THEN
        IF coalesce(btrim(c.post_street), '')   = '' THEN v := array_append(v, 'post_street'); END IF;
        IF coalesce(btrim(c.post_suburb), '')   = '' THEN v := array_append(v, 'post_suburb'); END IF;
        IF c.post_state IS NULL                      THEN v := array_append(v, 'post_state'); END IF;
        IF coalesce(btrim(c.post_postcode), '') = '' THEN v := array_append(v, 'post_postcode'); END IF;
        IF coalesce(btrim(c.post_country), '')  = '' THEN v := array_append(v, 'post_country'); END IF;
    END IF;

    SELECT x.id_country_code, x.issuer INTO cur
    FROM gold._id_captures x
    WHERE x.customer_id = c.id AND x.is_on_file
    ORDER BY x.captured_at DESC, x.id DESC
    LIMIT 1;

    IF NOT FOUND THEN
        v := array_append(v, 'id_document');
    ELSE
        IF coalesce(btrim(cur.id_country_code), '') = '' THEN v := array_append(v, 'id_country_code'); END IF;
        IF coalesce(btrim(cur.issuer), '')          = '' THEN v := array_append(v, 'id_issuer'); END IF;
    END IF;

    RETURN v;
END;
$$;

-- ─── Grants ──────────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.search_customers(TEXT)                                       FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.customer_current_id(UUID)                                    FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.find_possible_duplicate_customers(TEXT, TEXT, DATE, TEXT)    FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.customer_ttr_ready(UUID)                                     FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.search_customers(TEXT)                                       TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.customer_current_id(UUID)                                    TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.find_possible_duplicate_customers(TEXT, TEXT, DATE, TEXT)    TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.customer_ttr_ready(UUID)                                     TO authenticated, service_role;
