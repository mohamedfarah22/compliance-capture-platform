-- Names of the staff who recorded or completed purchases (Gold Phase 8b, spec 4.6).
--
-- Purchase screens show "Recorded by X" and "Completed by Y". A browser can read only its own staff row
-- (staff_select_self), and gold.list_recorded_by() lists recorders only, so a person who only ever completed
-- purchases had no name to show. Same shape and access as list_recorded_by: SECURITY DEFINER, scoped to the
-- caller's business (NULL below aal2, so a password-only session gets nothing), authenticated and service_role.
CREATE OR REPLACE FUNCTION gold.list_purchase_staff()
RETURNS TABLE (
    staff_member_id UUID,
    full_name       TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = gold, public, pg_temp
AS $$
    SELECT DISTINCT sm.id, sm.full_name
    FROM gold.purchases p
    JOIN public.staff_members sm ON sm.id IN (p.created_by_staff_id, p.completed_by_staff_id)
    WHERE p.reporting_entity_id = public.reporting_entity_id()
    ORDER BY sm.full_name, sm.id
$$;

REVOKE EXECUTE ON FUNCTION gold.list_purchase_staff() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION gold.list_purchase_staff() TO authenticated, service_role;
