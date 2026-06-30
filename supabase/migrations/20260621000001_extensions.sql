-- Extensions required by the compliance platform.
-- pg_cron is not used (stale draft cleanup runs as a scheduled Edge Function).

CREATE EXTENSION IF NOT EXISTS "pg_trgm";       -- trigram similarity for AML name screening
CREATE EXTENSION IF NOT EXISTS "moddatetime";   -- auto updated_at triggers
CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_uuid() (Supabase default, included for completeness)
