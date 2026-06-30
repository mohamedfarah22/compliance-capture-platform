-- Staff role controls access to the AUSTRAC report batch approval flow.
-- Only 'admin' users can view, approve, and download generated TTR-FBS XML batches.
CREATE TYPE staff_role AS ENUM ('staff', 'manager', 'admin');

ALTER TABLE public.staff_members
  ADD COLUMN role staff_role NOT NULL DEFAULT 'staff';

-- RLS helper: returns TRUE when the current user has the required role and is active.
CREATE OR REPLACE FUNCTION public.has_role(required_role staff_role)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.staff_members
    WHERE  id = auth.uid()
    AND    is_active = TRUE
    AND    role = required_role
  )
$$;
