-- gold.purchases: immutability and audit (spec 4.3, assumption A7).
--
-- The immutability trigger is a plain trigger, so it applies to the service role too: the
-- edge functions validate first, but the database refuses a bad update even if one of them
-- has a bug. It does not apply to someone who disables triggers or runs as a superuser
-- with session_replication_role = replica; those are operator actions, not application paths.

CREATE OR REPLACE FUNCTION gold.purchases_enforce_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = gold, pg_temp
AS $$
BEGIN
    IF NEW.reporting_entity_id        IS DISTINCT FROM OLD.reporting_entity_id
    OR NEW.customer_id                IS DISTINCT FROM OLD.customer_id
    OR NEW.joint_customer_id          IS DISTINCT FROM OLD.joint_customer_id
    OR NEW.purchase_type              IS DISTINCT FROM OLD.purchase_type
    OR NEW.main_id_verification_id    IS DISTINCT FROM OLD.main_id_verification_id
    OR NEW.joint_id_verification_id   IS DISTINCT FROM OLD.joint_id_verification_id
    OR NEW.id_sighted                 IS DISTINCT FROM OLD.id_sighted
    OR NEW.id_expired_at_time         IS DISTINCT FROM OLD.id_expired_at_time
    OR NEW.id_outside_window_at_time  IS DISTINCT FROM OLD.id_outside_window_at_time
    OR NEW.ttr_self_conducted         IS DISTINCT FROM OLD.ttr_self_conducted
    OR NEW.ttr_details_confirmed      IS DISTINCT FROM OLD.ttr_details_confirmed
    OR NEW.sale_date                  IS DISTINCT FROM OLD.sale_date
    OR NEW.created_at                 IS DISTINCT FROM OLD.created_at
    OR NEW.created_by_staff_id        IS DISTINCT FROM OLD.created_by_staff_id
    THEN
        RAISE EXCEPTION 'a gold purchase cannot change its sellers, type, ID, counter answers, sale date or creator after it is saved'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- The invoice number is added once and never changed or removed.
    IF OLD.erp_invoice_no IS NOT NULL AND NEW.erp_invoice_no IS DISTINCT FROM OLD.erp_invoice_no THEN
        RAISE EXCEPTION 'the ERP invoice number cannot be changed or removed once it is set'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- completed_* is written once, in the same update that first sets the invoice.
    IF NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.completed_by_staff_id IS DISTINCT FROM OLD.completed_by_staff_id THEN
        IF OLD.completed_at IS NOT NULL THEN
            RAISE EXCEPTION 'completed_at is already set and cannot change'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.erp_invoice_no IS NOT NULL OR NEW.erp_invoice_no IS NULL THEN
            RAISE EXCEPTION 'completed_at can only be set by the update that adds the ERP invoice number'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_gp_immutable
    BEFORE UPDATE ON gold.purchases
    FOR EACH ROW EXECUTE FUNCTION gold.purchases_enforce_immutable();

-- ─── Audit log ───────────────────────────────────────────────────────────────────────────
-- Same shape and actor rule as public.customer_audit_log (20261101000001). Append-only, no FK
-- to purchases, entity copied in for RLS. `changes` is {"column": {"old": ..., "new": ...}}.
-- `source` is whatever the service-role code sets in app.change_source for the transaction
-- (e.g. 'complete_purchase'); it is free text so Phase 7 can name its paths.

CREATE TABLE gold.purchase_audit_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_id         UUID NOT NULL,
    reporting_entity_id UUID NOT NULL,
    changed_by          UUID,
    source              TEXT,
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    changes             JSONB NOT NULL
);

CREATE INDEX idx_gpal_purchase ON gold.purchase_audit_log (purchase_id, changed_at DESC);
CREATE INDEX idx_gpal_entity   ON gold.purchase_audit_log (reporting_entity_id, changed_at DESC);

CREATE TRIGGER trg_audit_append_only
    BEFORE UPDATE OR DELETE ON gold.purchase_audit_log
    FOR EACH ROW EXECUTE FUNCTION ttr.deny_audit_mutation();

ALTER TABLE gold.purchase_audit_log ENABLE ROW LEVEL SECURITY;

-- Actor: app.actor_staff_id when the service-role code sets it, otherwise the signed-in
-- staff member (auth.uid()).
CREATE OR REPLACE FUNCTION gold.purchases_audit_update()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = gold, public, auth, pg_temp
AS $$
DECLARE
    v_changes JSONB;
    v_actor   UUID := nullif(current_setting('app.actor_staff_id', true), '')::uuid;
BEGIN
    SELECT jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value))
    INTO v_changes
    FROM jsonb_each(to_jsonb(NEW)) n
    JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
    WHERE n.value IS DISTINCT FROM o.value
      AND n.key NOT IN ('updated_at', 'erp_invoice_norm');

    IF v_changes IS NOT NULL THEN
        IF v_actor IS NULL THEN
            SELECT id INTO v_actor FROM public.staff_members WHERE id = auth.uid();
        END IF;

        INSERT INTO gold.purchase_audit_log (purchase_id, reporting_entity_id, changed_by, source, changes)
        VALUES (NEW.id, NEW.reporting_entity_id, v_actor,
                nullif(current_setting('app.change_source', true), ''), v_changes);
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_gp_audit
    AFTER UPDATE ON gold.purchases
    FOR EACH ROW EXECUTE FUNCTION gold.purchases_audit_update();

REVOKE EXECUTE ON FUNCTION gold.purchases_enforce_immutable() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gold.purchases_audit_update()      FROM PUBLIC, anon, authenticated;
