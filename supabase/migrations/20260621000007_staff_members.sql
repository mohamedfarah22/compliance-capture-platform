-- Profile table over auth.users. staff_members.id = auth.users.id (Supabase pattern).

CREATE TABLE public.staff_members (
    id                  UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    reporting_entity_id UUID NOT NULL REFERENCES public.reporting_entities(id),
    full_name           TEXT NOT NULL,
    email               TEXT NOT NULL,   -- mirrors auth.users.email; kept for fast joins
    job_title           TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_staff_entity ON public.staff_members (reporting_entity_id);

CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON public.staff_members
    FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

ALTER TABLE public.staff_members ENABLE ROW LEVEL SECURITY;

-- RLS helper: returns the reporting_entity_id for the current authenticated user.
-- Returns NULL if the user is deactivated (is_active = FALSE), which causes all
-- downstream RLS policies that reference this function to deny access immediately.
-- SECURITY DEFINER + fixed search_path prevents search-path injection.
-- Defined before any policy that calls it (including in earlier-numbered migrations).
CREATE OR REPLACE FUNCTION public.reporting_entity_id()
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT reporting_entity_id
    FROM   public.staff_members
    WHERE  id = auth.uid()
    AND    is_active = TRUE
$$;

CREATE POLICY "staff_select_self" ON public.staff_members
    FOR SELECT USING (id = auth.uid());

CREATE POLICY "staff_update_self" ON public.staff_members
    FOR UPDATE
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid() AND reporting_entity_id = public.reporting_entity_id());

-- Policies for tables created in earlier migrations, placed here so
-- public.reporting_entity_id() is already defined when they run.
CREATE POLICY "re_select" ON public.reporting_entities
    FOR SELECT USING (id = public.reporting_entity_id());

CREATE POLICY "branch_select" ON public.branches
    FOR SELECT USING (reporting_entity_id = public.reporting_entity_id());
