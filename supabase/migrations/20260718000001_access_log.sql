-- Records read/disclosure events (ID image views, report exports) to satisfy the
-- privacy policy commitment that every ID image view and record export is logged.
--
-- Distinct from ttr.transaction_audit_log, which records status transitions
-- (writes). This table records reads — who saw or exported what, and when.
--
-- Intentionally no FKs to the resource tables: resource_type/resource_id are a
-- loose polymorphic reference so future resource kinds (e.g. a subject access
-- request export) need no migration. reporting_entity_id and staff_member_id are
-- data copies for the same reason ttr.transaction_audit_log stores them that way
-- — audit rows must survive deletion of what they describe.
--
-- Inserts are performed ONLY by Edge Functions using the service-role key, from
-- inside the same call that releases the resource. There is deliberately no
-- INSERT policy: a client that could log its own access could also skip doing so.

CREATE TABLE ttr.access_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporting_entity_id UUID NOT NULL,
    staff_member_id     UUID,           -- staff_members.id snapshot at time of access
    action              TEXT NOT NULL CHECK (action IN ('view', 'export')),
    resource_type       TEXT NOT NULL,  -- e.g. 'stored_images', 'report_batches'
    resource_id         UUID,
    transaction_id      UUID,           -- convenience denormalisation; NULL when not tx-scoped
    detail              TEXT,           -- optional context (file name, object path)
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_access_log_entity ON ttr.access_log (reporting_entity_id, occurred_at DESC);
CREATE INDEX idx_access_log_staff  ON ttr.access_log (staff_member_id, occurred_at DESC);
CREATE INDEX idx_access_log_target ON ttr.access_log (resource_type, resource_id);

-- Append-only: reuses the existing trigger function from transaction_audit_log.
CREATE TRIGGER trg_access_log_append_only
    BEFORE UPDATE OR DELETE ON ttr.access_log
    FOR EACH ROW EXECUTE FUNCTION ttr.deny_audit_mutation();

ALTER TABLE ttr.access_log ENABLE ROW LEVEL SECURITY;

-- Admin-only read, mirroring ttr.report_batches. An access log that every staff
-- member can read is itself a disclosure surface.
CREATE POLICY "access_log_select_admin" ON ttr.access_log
    FOR SELECT USING (
        reporting_entity_id = public.reporting_entity_id()
        AND public.has_role('admin')
    );
