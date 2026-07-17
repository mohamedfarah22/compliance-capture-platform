-- Grant PostgREST roles access to the ttr schema.
-- The public schema gets these automatically; custom schemas need explicit grants.
-- RLS policies on each table still control row-level access.

GRANT USAGE ON SCHEMA ttr TO anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA ttr TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA ttr TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA ttr TO anon, authenticated, service_role;

-- Ensure future tables in ttr inherit the same grants
ALTER DEFAULT PRIVILEGES IN SCHEMA ttr
  GRANT ALL ON TABLES TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA ttr
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA ttr
  GRANT ALL ON ROUTINES TO anon, authenticated, service_role;
