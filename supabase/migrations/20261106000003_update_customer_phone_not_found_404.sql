-- update_customer_phone: answer an unknown customer with HTTP 404, not 500.
--
-- 20261106000002 raised customer_not_found with SQLSTATE P0002. PostgREST maps every P0*
-- SQLSTATE except P0001 to HTTP 500, so a customer of another business, a made-up id and a
-- company customer all came back as a server error. The contract (code P0002, message
-- customer_not_found) is kept; only the status changes, using PostgREST's custom error:
-- SQLSTATE 'PGRST', MESSAGE = the JSON body, DETAIL = the status and headers. The other two
-- errors (forbidden 42501 -> 403, invalid_phone 22023 -> 400) already map correctly.
--
-- Body as in 20261106000002 apart from that one RAISE.

CREATE OR REPLACE FUNCTION public.update_customer_phone(p_customer_id UUID, p_phone TEXT)
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
        RAISE EXCEPTION USING
            ERRCODE = 'PGRST',
            MESSAGE = '{"code":"P0002","message":"customer_not_found","details":null,"hint":null}',
            DETAIL  = '{"status":404,"headers":{}}';
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
