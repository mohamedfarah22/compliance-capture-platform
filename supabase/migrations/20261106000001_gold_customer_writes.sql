-- Gold customer writes (spec 4.5, 1.6): the SQL behind gold-create-customer,
-- gold-update-customer-id and gold-update-customer.
--
-- Each function is one database transaction, so a customer cannot exist without its ID
-- capture and photo rows, and an ID capture cannot exist without its audit trail. The edge
-- functions call them with the service-role client only: EXECUTE is revoked from PUBLIC,
-- anon and authenticated, so the browser cannot reach them at all.
--
-- Nothing in here trusts the caller. The entity and the staff member are arguments filled in
-- by the edge function from the verified JWT and the staff row, and _gold_assert_staff
-- re-checks that they belong together and the staff member is active. Every row is read and
-- written under that entity.
--
-- The photos are uploaded by the edge function before it calls these (it needs their bytes
-- to hash them). A failed call leaves objects with no row; the function removes them, and
-- reconcile-stored-images sweeps anything it could not.
--
-- Errors are raised with a short code as the message (customer_not_found, invalid_phone, ...)
-- so the edge function can map them without parsing prose.

-- 'gold_create' labels the audit row written when a customer is created in gold.
ALTER TABLE public.customer_audit_log DROP CONSTRAINT customer_audit_log_source_check;
ALTER TABLE public.customer_audit_log
    ADD CONSTRAINT customer_audit_log_source_check
    CHECK (source IN ('gold_create', 'gold_edit', 'phone_change', 'ttr_completion'));

-- ─── Defence in depth: the staff member belongs to the entity and is active ──────────────
CREATE FUNCTION public._gold_assert_staff(p_entity_id UUID, p_staff_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_members
        WHERE id = p_staff_id AND reporting_entity_id = p_entity_id AND is_active
    ) THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
END;
$$;

-- ─── gold_create_customer ────────────────────────────────────────────────────────────────
-- p_customer  { first_name, middle_name, last_name, date_of_birth, phone, email, res_street,
--               res_suburb, res_state, res_postcode, res_country }
-- p_id        { document_type, document_type_other, document_number, issuer, id_country_code,
--               has_expiry, expiry_date }
-- p_images    [{ side: front|back, object_path, content_hash_sha256, content_type, byte_size }]
-- p_different_person  true only when the function found a document-number collision and the
--             operator said "different person": the capture is then saved with that reason,
--             which the uniqueness index exempts.
-- Returns { customer_id, verification_id, front_image_id, back_image_id }.
CREATE FUNCTION public.gold_create_customer(
    p_entity_id        UUID,
    p_staff_id         UUID,
    p_customer_id      UUID,
    p_verification_id  UUID,
    p_customer         JSONB,
    p_aliases          TEXT[],
    p_id               JSONB,
    p_images           JSONB,
    p_different_person BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, ttr, pg_temp
AS $$
DECLARE
    v_img     JSONB;
    v_img_id  UUID;
    v_front   UUID;
    v_back    UUID;
    v_alias   TEXT;
    v_n       SMALLINT := 0;
    v_changes JSONB;
BEGIN
    PERFORM public._gold_assert_staff(p_entity_id, p_staff_id);

    IF char_length(regexp_replace(coalesce(p_customer->>'phone', ''), '\D', '', 'g')) < 8 THEN
        RAISE EXCEPTION 'invalid_phone' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.customers (
        id, reporting_entity_id, customer_type, source, created_by_staff_id,
        first_name, middle_name, last_name, date_of_birth, phone, email,
        res_street, res_suburb, res_state, res_postcode, res_country
    ) VALUES (
        p_customer_id, p_entity_id, 'individual', 'gold', p_staff_id,
        p_customer->>'first_name', p_customer->>'middle_name', p_customer->>'last_name',
        (p_customer->>'date_of_birth')::date, p_customer->>'phone', p_customer->>'email',
        p_customer->>'res_street', p_customer->>'res_suburb',
        (p_customer->>'res_state')::aus_state, p_customer->>'res_postcode',
        coalesce(p_customer->>'res_country', 'Australia')
    );

    FOREACH v_alias IN ARRAY coalesce(p_aliases, '{}') LOOP
        INSERT INTO public.customer_aliases (customer_id, alias, sort_order)
        VALUES (p_customer_id, v_alias, v_n);
        v_n := v_n + 1;
    END LOOP;

    FOR v_img IN SELECT * FROM jsonb_array_elements(p_images) LOOP
        INSERT INTO ttr.stored_images (
            customer_id, storage_bucket, object_path, content_hash_sha256,
            content_type, byte_size, captured_by_staff_id
        ) VALUES (
            p_customer_id, 'compliance-media', v_img->>'object_path', v_img->>'content_hash_sha256',
            v_img->>'content_type', (v_img->>'byte_size')::int, p_staff_id
        ) RETURNING id INTO v_img_id;

        IF v_img->>'side' = 'front' THEN v_front := v_img_id; ELSE v_back := v_img_id; END IF;
    END LOOP;

    IF v_front IS NULL THEN
        RAISE EXCEPTION 'front_image_required' USING ERRCODE = '23514';
    END IF;
    IF p_id->>'document_type' = 'Driver licence' AND v_back IS NULL THEN
        RAISE EXCEPTION 'back_image_required' USING ERRCODE = '23514';
    END IF;

    INSERT INTO ttr.id_verifications (
        id, customer_id, verification_method, document_type, document_type_other,
        document_number, issuer, id_country_code, has_expiry, expiry_date,
        verification_description, front_image_id, back_image_id, is_complete, new_capture_reason
    ) VALUES (
        p_verification_id, p_customer_id, 'Sighted original document',
        (p_id->>'document_type')::id_doc_type, p_id->>'document_type_other',
        p_id->>'document_number', p_id->>'issuer', p_id->>'id_country_code',
        (p_id->>'has_expiry')::boolean, (p_id->>'expiry_date')::date,
        'Original ' || coalesce(nullif(p_id->>'document_type_other', ''), p_id->>'document_type')
            || ' sighted in person',
        v_front, v_back, TRUE,
        CASE WHEN p_different_person THEN 'different_person' END
    );

    -- Audit: every value the customer was created with, as old (null) -> new.
    SELECT jsonb_object_agg(k, jsonb_build_object('old', NULL::jsonb, 'new', v))
    INTO v_changes
    FROM jsonb_each(jsonb_strip_nulls(
        (SELECT to_jsonb(c) - ARRAY['id', 'reporting_entity_id', 'source', 'created_by_staff_id',
                                    'created_at', 'updated_at', 'name_search', 'phone_digits']
         FROM public.customers c WHERE c.id = p_customer_id)
        || CASE WHEN cardinality(coalesce(p_aliases, '{}')) > 0
                THEN jsonb_build_object('aliases', to_jsonb(p_aliases)) ELSE '{}'::jsonb END
    )) AS e(k, v);

    PERFORM set_config('app.actor_staff_id', p_staff_id::text, true);
    PERFORM set_config('app.change_source', 'gold_create', true);
    PERFORM public._write_customer_audit(p_customer_id, p_entity_id, v_changes);
    PERFORM set_config('app.actor_staff_id', '', true);
    PERFORM set_config('app.change_source', '', true);

    RETURN jsonb_build_object(
        'customer_id', p_customer_id, 'verification_id', p_verification_id,
        'front_image_id', v_front, 'back_image_id', v_back
    );
END;
$$;

-- ─── gold_update_customer_id ─────────────────────────────────────────────────────────────
-- Inserts a new customer-level capture and its photos. p_reason is the stored reason:
--   id_changed           (renewed)         linked to p_prior_verification_id when the number is
--                                          the same, otherwise unlinked
--   stored_copy_unclear  (photo unclear)   linked, always
--   different_document                     unlinked
-- p_prior_verification_id is the UNLINKED capture of the same document that the customer
-- holds (what get_verification_for_document returns), or null. The recapture trigger checks
-- it is the same document; this function checks it is this customer's.
--
-- Returns the stale image ids the caller must now supersede (delete the objects, stamp the
-- rows: _shared/supersede.ts). They are every unsuperseded image of the same chain, which is
-- person-safe by construction (see find_unsuperseded_duplicates), so a different document, or
-- a different person who shares the number, is never touched. That step is not done here
-- because deleting storage objects cannot be part of a database transaction.
-- Returns { verification_id, front_image_id, back_image_id, stale_image_ids }.
CREATE FUNCTION public.gold_update_customer_id(
    p_entity_id             UUID,
    p_staff_id              UUID,
    p_customer_id           UUID,
    p_verification_id       UUID,
    p_reason                TEXT,
    p_prior_verification_id UUID,
    p_id                    JSONB,
    p_images                JSONB
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, ttr, pg_temp
AS $$
DECLARE
    v_img    JSONB;
    v_img_id UUID;
    v_front  UUID;
    v_back   UUID;
    v_prior  RECORD;
    v_stale  UUID[];
BEGIN
    PERFORM public._gold_assert_staff(p_entity_id, p_staff_id);

    -- Serialises two updates of the same customer's ID.
    PERFORM 1 FROM public.customers
    WHERE id = p_customer_id AND reporting_entity_id = p_entity_id AND customer_type = 'individual'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'customer_not_found' USING ERRCODE = 'P0002';
    END IF;

    IF p_reason NOT IN ('id_changed', 'stored_copy_unclear', 'different_document') THEN
        RAISE EXCEPTION 'invalid_reason' USING ERRCODE = '22023';
    END IF;

    IF p_prior_verification_id IS NOT NULL THEN
        SELECT customer_id, reporting_entity_id INTO v_prior
        FROM ttr.id_verifications WHERE id = p_prior_verification_id;
        IF NOT FOUND
           OR v_prior.customer_id IS DISTINCT FROM p_customer_id
           OR v_prior.reporting_entity_id <> p_entity_id THEN
            RAISE EXCEPTION 'prior_not_found' USING ERRCODE = 'P0002';
        END IF;
    END IF;

    FOR v_img IN SELECT * FROM jsonb_array_elements(p_images) LOOP
        INSERT INTO ttr.stored_images (
            customer_id, storage_bucket, object_path, content_hash_sha256,
            content_type, byte_size, captured_by_staff_id
        ) VALUES (
            p_customer_id, 'compliance-media', v_img->>'object_path', v_img->>'content_hash_sha256',
            v_img->>'content_type', (v_img->>'byte_size')::int, p_staff_id
        ) RETURNING id INTO v_img_id;

        IF v_img->>'side' = 'front' THEN v_front := v_img_id; ELSE v_back := v_img_id; END IF;
    END LOOP;

    IF v_front IS NULL THEN
        RAISE EXCEPTION 'front_image_required' USING ERRCODE = '23514';
    END IF;
    IF p_id->>'document_type' = 'Driver licence' AND v_back IS NULL THEN
        RAISE EXCEPTION 'back_image_required' USING ERRCODE = '23514';
    END IF;

    INSERT INTO ttr.id_verifications (
        id, customer_id, verification_method, document_type, document_type_other,
        document_number, issuer, id_country_code, has_expiry, expiry_date,
        verification_description, front_image_id, back_image_id, is_complete,
        new_capture_reason, prior_verification_id
    ) VALUES (
        p_verification_id, p_customer_id, 'Sighted original document',
        (p_id->>'document_type')::id_doc_type, p_id->>'document_type_other',
        p_id->>'document_number', p_id->>'issuer', p_id->>'id_country_code',
        (p_id->>'has_expiry')::boolean, (p_id->>'expiry_date')::date,
        'Original ' || coalesce(nullif(p_id->>'document_type_other', ''), p_id->>'document_type')
            || ' sighted in person',
        v_front, v_back, TRUE,
        p_reason, p_prior_verification_id
    );

    IF p_prior_verification_id IS NOT NULL THEN
        SELECT coalesce(array_agg(DISTINCT si.id), '{}') INTO v_stale
        FROM ttr.id_verifications v
        JOIN ttr.stored_images si ON si.id IN (v.front_image_id, v.back_image_id)
        WHERE v.reporting_entity_id = p_entity_id
          AND v.verification_basis = 'new_capture'
          AND v.id <> p_verification_id
          AND coalesce(v.prior_verification_id, v.id) = p_prior_verification_id
          AND v.document_type = (p_id->>'document_type')::id_doc_type
          AND upper(btrim(v.document_number)) = upper(btrim(p_id->>'document_number'))
          AND si.superseded_at IS NULL;
    END IF;

    RETURN jsonb_build_object(
        'verification_id', p_verification_id, 'front_image_id', v_front, 'back_image_id', v_back,
        'stale_image_ids', to_jsonb(coalesce(v_stale, '{}'))
    );
END;
$$;

-- ─── gold_update_customer ────────────────────────────────────────────────────────────────
-- Corrects profile fields of an individual customer. p_changes holds only the columns to
-- set; any key outside the list below is refused (ID details are not profile fields). The
-- customers UPDATE trigger writes one customer_audit_log row with old -> new for every
-- column that really changed, with source gold_edit and p_staff_id as the actor. A request
-- that changes nothing writes nothing. ttr.parties are not touched: a TTR keeps the details
-- as reported.
-- Returns { changed: [column, ...] }.
CREATE FUNCTION public.gold_update_customer(
    p_entity_id   UUID,
    p_staff_id    UUID,
    p_customer_id UUID,
    p_changes     JSONB
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_allowed TEXT[] := ARRAY[
        'first_name', 'middle_name', 'last_name', 'date_of_birth', 'gender', 'phone', 'email',
        'occupation', 'res_street', 'res_suburb', 'res_state', 'res_postcode', 'res_country',
        'citizenship_country_code', 'tax_residency_country_code'
    ];
    v_keys    TEXT[];
    v_cols    TEXT;
    v_old     JSONB;
    v_new     JSONB;
    v_changed TEXT[];
BEGIN
    PERFORM public._gold_assert_staff(p_entity_id, p_staff_id);

    SELECT to_jsonb(c) INTO v_old
    FROM public.customers c
    WHERE c.id = p_customer_id AND c.reporting_entity_id = p_entity_id AND c.customer_type = 'individual'
    FOR UPDATE;
    IF v_old IS NULL THEN
        RAISE EXCEPTION 'customer_not_found' USING ERRCODE = 'P0002';
    END IF;

    SELECT array_agg(k) INTO v_keys FROM jsonb_object_keys(p_changes) AS k;
    IF v_keys IS NULL THEN
        RETURN jsonb_build_object('changed', '[]'::jsonb);
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_keys) AS k WHERE k <> ALL (v_allowed)) THEN
        RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023';
    END IF;
    IF p_changes ? 'phone'
       AND char_length(regexp_replace(coalesce(p_changes->>'phone', ''), '\D', '', 'g')) < 8 THEN
        RAISE EXCEPTION 'invalid_phone' USING ERRCODE = '22023';
    END IF;

    SELECT string_agg(quote_ident(k), ', ') INTO v_cols FROM unnest(v_keys) AS k;

    PERFORM set_config('app.actor_staff_id', p_staff_id::text, true);
    PERFORM set_config('app.change_source', 'gold_edit', true);

    EXECUTE format(
        'UPDATE public.customers SET (%1$s) = (SELECT %1$s FROM jsonb_populate_record(NULL::public.customers, $1)) WHERE id = $2',
        v_cols
    ) USING p_changes, p_customer_id;

    PERFORM set_config('app.actor_staff_id', '', true);
    PERFORM set_config('app.change_source', '', true);

    SELECT to_jsonb(c) INTO v_new FROM public.customers c WHERE c.id = p_customer_id;
    SELECT coalesce(array_agg(k), '{}') INTO v_changed
    FROM unnest(v_keys) AS k
    WHERE v_old->k IS DISTINCT FROM v_new->k;

    RETURN jsonb_build_object('changed', to_jsonb(v_changed));
END;
$$;

-- Service role only. Supabase grants new public functions to anon and authenticated by
-- default, so they are named here.
REVOKE EXECUTE ON FUNCTION public._gold_assert_staff(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gold_create_customer(UUID, UUID, UUID, UUID, JSONB, TEXT[], JSONB, JSONB, BOOLEAN)
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gold_update_customer_id(UUID, UUID, UUID, UUID, TEXT, UUID, JSONB, JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gold_update_customer(UUID, UUID, UUID, JSONB)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public._gold_assert_staff(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.gold_create_customer(UUID, UUID, UUID, UUID, JSONB, TEXT[], JSONB, JSONB, BOOLEAN)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.gold_update_customer_id(UUID, UUID, UUID, UUID, TEXT, UUID, JSONB, JSONB)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.gold_update_customer(UUID, UUID, UUID, JSONB) TO service_role;
