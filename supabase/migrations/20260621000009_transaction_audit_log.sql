-- Intentionally no FK back to ttr.transactions — audit rows must survive
-- if a transaction is administratively deleted. reporting_entity_id is stored
-- as a data copy (not a FK) to enable RLS scoping without the FK dependency.

CREATE TABLE ttr.transaction_audit_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id      UUID NOT NULL,
    reporting_entity_id UUID NOT NULL,
    changed_by          UUID,           -- staff_members.id snapshot at time of change
    old_status          transaction_status,
    new_status          transaction_status NOT NULL,
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    note                TEXT
);

CREATE INDEX idx_audit_tx     ON ttr.transaction_audit_log (transaction_id, changed_at DESC);
CREATE INDEX idx_audit_entity ON ttr.transaction_audit_log (reporting_entity_id, changed_at DESC);

-- Append-only: UPDATE and DELETE are permanently blocked by trigger.
CREATE OR REPLACE FUNCTION ttr.deny_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = ttr
AS $$
BEGIN
    RAISE EXCEPTION 'Audit log is append-only — % is not permitted', TG_OP;
END;
$$;

CREATE TRIGGER trg_audit_append_only
    BEFORE UPDATE OR DELETE ON ttr.transaction_audit_log
    FOR EACH ROW EXECUTE FUNCTION ttr.deny_audit_mutation();

ALTER TABLE ttr.transaction_audit_log ENABLE ROW LEVEL SECURITY;

-- Read-only for staff of the matching entity.
-- Inserts are performed only by the ttr.complete_transaction() SECURITY DEFINER RPC.
CREATE POLICY "audit_select" ON ttr.transaction_audit_log
    FOR SELECT USING (reporting_entity_id = public.reporting_entity_id());
