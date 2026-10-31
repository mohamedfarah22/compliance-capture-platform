-- Security hardening from the 2026-10-30 data-leak review. Each section closes one path
-- by which customer data or ID images could be read, or reports altered, by someone who
-- should not be able to.

-- ─── 1. Staff can no longer edit their own staff record ──────────────────────────────
--
-- staff_update_self allowed an UPDATE of any column on the caller's own row, role
-- included, so a single PATCH made any staff member an admin: every report batch (full
-- customer details), the access log and batch approval. The app never writes to this
-- table; staff records are managed by service-role tooling only.

DROP POLICY "staff_update_self" ON public.staff_members;

-- ─── 2. MFA is enforced by the database, not only by the browser ─────────────────────
--
-- ProtectedRoute signs out sessions that have not cleared MFA, but nothing server-side
-- checked the assurance level, so a password alone (aal1) could query every table
-- straight through the API. Every RLS policy, storage policy and SECURITY DEFINER search
-- function resolves access through these two helpers, so requiring aal2 here enforces MFA
-- everywhere at once. staff_select_self (id = auth.uid()) deliberately does not use them:
-- the app reads its own staff row before the second factor to route the user.

CREATE OR REPLACE FUNCTION public.reporting_entity_id()
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT reporting_entity_id
    FROM   public.staff_members
    WHERE  id = auth.uid()
    AND    is_active = TRUE
    AND    (auth.jwt() ->> 'aal') = 'aal2'
$$;

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
    AND    (auth.jwt() ->> 'aal') = 'aal2'
  )
$$;

-- ─── 3. The anonymous role has no access to the ttr schema ───────────────────────────
--
-- 20260621000026 granted ALL on every ttr table, sequence and routine to anon, leaving RLS
-- as the only barrier. That exposed the two SECURITY DEFINER functions below to anyone
-- holding the public key: get_stale_draft_ids returned every entity's draft ids (pass 0
-- days for all of them), and complete_transaction trusted a caller-supplied staff id,
-- skipping the complete-transaction Edge Function's validation and forging the audit
-- trail. Nothing legitimate reaches ttr without signing in.

REVOKE ALL   ON ALL TABLES    IN SCHEMA ttr FROM anon;
REVOKE ALL   ON ALL SEQUENCES IN SCHEMA ttr FROM anon;
REVOKE ALL   ON ALL ROUTINES  IN SCHEMA ttr FROM anon;
REVOKE USAGE ON SCHEMA ttr FROM anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA ttr REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA ttr REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA ttr REVOKE ALL ON ROUTINES  FROM anon;

-- Both are called only by Edge Functions holding the service-role key.
REVOKE EXECUTE ON FUNCTION ttr.complete_transaction(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ttr.get_stale_draft_ids(INTEGER)     FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION ttr.complete_transaction(UUID, UUID) TO service_role;
GRANT  EXECUTE ON FUNCTION ttr.get_stale_draft_ids(INTEGER)     TO service_role;

-- ─── 4. ID images and report exports can only be reached through logged paths ────────
--
-- The privacy policy promises every ID-image view and every report export is recorded in
-- ttr.access_log. get-id-image-urls and approve-batch (download) write that row and fail
-- closed, but two direct routes skipped them.

-- img_download let staff download or sign ID images straight from storage. The app only
-- obtains image URLs from get-id-image-urls, which signs with the service role.
DROP POLICY "img_download" ON storage.objects;

-- batches_admin was FOR ALL, so admins could read xml_content directly (an unlogged
-- export) and also UPDATE or DELETE a batch, rewriting a report before it is filed.
-- Admins keep read access to the batch summary the Reports pages use; the XML is
-- reachable only via approve-batch's logged download, and every change goes through
-- approve-batch with the service role.
DROP POLICY "batches_admin" ON ttr.report_batches;

CREATE POLICY "batches_admin_select" ON ttr.report_batches
    FOR SELECT USING (
        reporting_entity_id = public.reporting_entity_id()
        AND public.has_role('admin')
    );

REVOKE ALL ON ttr.report_batches FROM authenticated;
GRANT SELECT (
    id, reporting_entity_id, report_date, transaction_count, approval_token, status,
    email_sent_at, submitted_at, submitted_by, generated_at, created_at, file_name
) ON ttr.report_batches TO authenticated;

-- Same FOR ALL problem: an admin could unlink transactions from a batch. Read-only now;
-- regenerate in approve-batch does the unlinking with the service role.
DROP POLICY "tx_reports_admin" ON ttr.transaction_reports;

CREATE POLICY "tx_reports_admin_select" ON ttr.transaction_reports
    FOR SELECT USING (
        public.has_role('admin')
        AND EXISTS (
            SELECT 1 FROM ttr.report_batches rb
            WHERE rb.id = transaction_reports.batch_id
              AND rb.reporting_entity_id = public.reporting_entity_id()
        )
    );
