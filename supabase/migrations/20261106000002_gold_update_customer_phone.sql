-- Phone change (handover updateCustomerPhone, spec 4.6): the one customer write the browser
-- makes itself, so it is callable by signed-in staff instead of the service role.
--
-- Like the Phase 5 read functions it identifies the caller by auth.uid() and scopes itself to
-- public.reporting_entity_id(), which is NULL unless the session is aal2 and the staff member
-- is active. A password-only session, an inactive staff member, anon, and a customer of another
-- business all get an error and change nothing. Any active staff role may change a phone.
--
-- The new number needs 8 or more digits (the same rule as gold.purchases.phone). The
-- customers UPDATE trigger writes the customer_audit_log row (old -> new, source phone_change,
-- actor auth.uid()). Setting the number it already has writes nothing and returns false.
-- ttr.parties copies are not touched.
--
-- Errors (message = code): forbidden 42501, invalid_phone 22023, customer_not_found P0002.

CREATE FUNCTION public.update_customer_phone(p_customer_id UUID, p_phone TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_entity UUID := public.reporting_entity_id();
    v_phone  TEXT := btrim(coalesce(p_phone, ''));
    v_old    TEXT;
BEGIN
    IF v_entity IS NULL THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    IF char_length(regexp_replace(v_phone, '\D', '', 'g')) < 8 THEN
        RAISE EXCEPTION 'invalid_phone' USING ERRCODE = '22023';
    END IF;

    SELECT phone INTO v_old
    FROM public.customers
    WHERE id = p_customer_id AND reporting_entity_id = v_entity AND customer_type = 'individual'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'customer_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_old IS NOT DISTINCT FROM v_phone THEN
        RETURN FALSE;
    END IF;

    PERFORM set_config('app.actor_staff_id', auth.uid()::text, true);
    PERFORM set_config('app.change_source', 'phone_change', true);
    UPDATE public.customers SET phone = v_phone WHERE id = p_customer_id;
    PERFORM set_config('app.actor_staff_id', '', true);
    PERFORM set_config('app.change_source', '', true);
    RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_customer_phone(UUID, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.update_customer_phone(UUID, TEXT) TO authenticated;
