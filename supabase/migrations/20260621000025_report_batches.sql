-- ─── AUSTRAC TTR Report Batches ──────────────────────────────────────────────
--
-- report_batches: one row per COB reporting run.
-- transaction_reports: link table tracking which completed transactions are
--   included in a batch. Kept separate from ttr.transactions to preserve
--   that table's immutability (ttr.lock_completed_transaction trigger).

CREATE TABLE ttr.report_batches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporting_entity_id UUID NOT NULL REFERENCES public.reporting_entities(id),
    report_date         DATE NOT NULL,
    xml_content         TEXT NOT NULL,
    transaction_count   INTEGER NOT NULL DEFAULT 0,
    approval_token      TEXT UNIQUE NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending_review'
        CHECK (status IN ('pending_review', 'submitted', 'rejected')),
    email_sent_at       TIMESTAMPTZ,
    submitted_at        TIMESTAMPTZ,
    submitted_by        UUID REFERENCES public.staff_members(id),
    generated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One batch per entity per day (idempotent re-run protection)
    UNIQUE (reporting_entity_id, report_date)
);

CREATE TABLE ttr.transaction_reports (
    transaction_id  UUID PRIMARY KEY REFERENCES ttr.transactions(id),
    batch_id        UUID NOT NULL REFERENCES ttr.report_batches(id),
    included_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tx_reports_batch ON ttr.transaction_reports (batch_id);

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE ttr.report_batches    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ttr.transaction_reports ENABLE ROW LEVEL SECURITY;

-- Only admins of the matching reporting entity can access batches
CREATE POLICY "batches_admin" ON ttr.report_batches
    FOR ALL USING (
        reporting_entity_id = public.reporting_entity_id()
        AND public.has_role('admin')
    );

CREATE POLICY "tx_reports_admin" ON ttr.transaction_reports
    FOR ALL USING (
        public.has_role('admin')
        AND EXISTS (
            SELECT 1 FROM ttr.report_batches rb
            WHERE rb.id = transaction_reports.batch_id
              AND rb.reporting_entity_id = public.reporting_entity_id()
        )
    );

-- ─── Cron schedule (pg_cron) ──────────────────────────────────────────────────
-- Run at 1 PM UTC Mon–Fri = midnight AEDT / 11 PM AEST, ~3h after 5 PM COB.
-- Requires pg_cron extension and APP_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
-- to be configured as pg_net settings. Uncomment once pg_cron is enabled:
--
-- SELECT cron.schedule(
--   'generate-austrac-report',
--   '0 13 * * 1-5',
--   $$
--   SELECT net.http_post(
--     url    := current_setting('app.edge_functions_url') || '/generate-austrac-report',
--     headers := jsonb_build_object(
--       'Content-Type',   'application/json',
--       'Authorization',  'Bearer ' || current_setting('app.service_role_key')
--     ),
--     body   := '{}'::jsonb
--   )
--   $$
-- );
