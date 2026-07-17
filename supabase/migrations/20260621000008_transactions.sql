CREATE TABLE ttr.transactions (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporting_entity_id  UUID NOT NULL REFERENCES public.reporting_entities(id),
    branch_id            UUID REFERENCES public.branches(id),
    created_by_staff_id  UUID REFERENCES public.staff_members(id),

    -- extensible scenario reference (INSERT to add new scenarios, no DDL needed)
    scenario             TEXT NOT NULL REFERENCES ttr.scenario_types(code),

    transaction_ref      TEXT NOT NULL,
    transaction_datetime TIMESTAMPTZ NOT NULL,
    designated_service   TEXT NOT NULL,

    -- filing-time snapshots: immutable record of who/where even if branch/staff change later
    location_snapshot    TEXT NOT NULL,
    staff_member_name    TEXT NOT NULL,
    staff_member_email   TEXT NOT NULL,
    staff_member_role    TEXT,

    -- cash
    cash_currency        cash_currency_type NOT NULL,
    cash_amount          NUMERIC(15,2) NOT NULL CHECK (cash_amount > 0),
    aud_value            NUMERIC(15,2) NOT NULL CHECK (aud_value > 0),

    -- foreign currency (all null when cash_currency = 'AUD')
    fx_currency_code     CHAR(3),
    fx_currency_amount   NUMERIC(15,2),
    fx_rate              NUMERIC(15,6),
    fx_rate_source       fx_rate_src,

    status               transaction_status NOT NULL DEFAULT 'draft',
    completed_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_tx_ref_per_entity UNIQUE (reporting_entity_id, transaction_ref),

    CONSTRAINT chk_tx_fx_fields CHECK (
        (cash_currency = 'AUD'   AND fx_currency_code IS NULL     AND fx_currency_amount IS NULL    AND fx_rate IS NULL)
        OR
        (cash_currency = 'other' AND fx_currency_code IS NOT NULL AND fx_currency_amount IS NOT NULL AND fx_rate IS NOT NULL)
    ),

    -- completed_at must be set iff status is complete
    CONSTRAINT chk_completed_at CHECK (
        (status = 'complete' AND completed_at IS NOT NULL)
        OR
        (status = 'draft'    AND completed_at IS NULL)
    )
);

CREATE INDEX idx_tx_entity_date   ON ttr.transactions (reporting_entity_id, transaction_datetime DESC);
CREATE INDEX idx_tx_entity_status ON ttr.transactions (reporting_entity_id, status);
CREATE INDEX idx_tx_branch        ON ttr.transactions (branch_id);
CREATE INDEX idx_tx_scenario      ON ttr.transactions (scenario);

CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON ttr.transactions
    FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- Tenant consistency: branch and staff must belong to the same reporting entity as the transaction.
-- A CHECK constraint cannot cross tables, so this is enforced by trigger.
CREATE OR REPLACE FUNCTION ttr.check_tx_tenant_consistency()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = public, ttr, auth
AS $$
BEGIN
    IF NEW.branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.branches
        WHERE id = NEW.branch_id
          AND reporting_entity_id = NEW.reporting_entity_id
    ) THEN
        RAISE EXCEPTION 'Branch % does not belong to reporting entity %',
            NEW.branch_id, NEW.reporting_entity_id;
    END IF;

    IF NEW.created_by_staff_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.staff_members
        WHERE id = NEW.created_by_staff_id
          AND reporting_entity_id = NEW.reporting_entity_id
          AND is_active = TRUE
    ) THEN
        RAISE EXCEPTION 'Staff member % does not belong to reporting entity %',
            NEW.created_by_staff_id, NEW.reporting_entity_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tx_tenant_check
    BEFORE INSERT OR UPDATE ON ttr.transactions
    FOR EACH ROW EXECUTE FUNCTION ttr.check_tx_tenant_consistency();

-- Immutability: once a transaction is complete it cannot be updated or deleted.
CREATE OR REPLACE FUNCTION ttr.lock_completed_transaction()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = ttr
AS $$
BEGIN
    IF OLD.status = 'complete' THEN
        RAISE EXCEPTION 'Transaction % is complete and cannot be %', OLD.id, TG_OP;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lock_completed
    BEFORE UPDATE OR DELETE ON ttr.transactions
    FOR EACH ROW EXECUTE FUNCTION ttr.lock_completed_transaction();

ALTER TABLE ttr.transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tx_select" ON ttr.transactions
    FOR SELECT USING (reporting_entity_id = public.reporting_entity_id());

CREATE POLICY "tx_insert" ON ttr.transactions
    FOR INSERT WITH CHECK (reporting_entity_id = public.reporting_entity_id());

-- Update permitted only on drafts; trigger enforces immutability on completed rows
CREATE POLICY "tx_update_draft" ON ttr.transactions
    FOR UPDATE
    USING  (reporting_entity_id = public.reporting_entity_id() AND status = 'draft')
    WITH CHECK (reporting_entity_id = public.reporting_entity_id() AND status = 'draft');

-- No client DELETE policy — draft deletion goes through the deleteDraftTransaction
-- Edge Function (service_role), which cleans up Storage objects first.
