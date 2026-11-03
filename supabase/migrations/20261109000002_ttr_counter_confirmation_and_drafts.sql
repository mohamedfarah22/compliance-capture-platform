-- Gold Phase 9a, spec 3.2 and 4.4.
--
-- 1. Counter confirmation on a reliance row. gold-start-ttr copies the purchase's C3 confirmation (the ID was
--    sighted at the counter and matches the record on file: who confirmed, and when) onto the TTR's reliance
--    row, and IdVerificationPage then accepts it instead of the "images match the person present" tick.
--    The confirmation belongs to the record relied on, so it is cleared when the row is pointed at another
--    record or stops being a reliance row.
-- 2. cleanup-stale-drafts skips drafts linked to a gold purchase: an old linked draft is an overdue report and
--    shows in To complete. (Exit, i.e. delete-draft-transaction, still deletes it; the gold link is
--    ON DELETE SET NULL.)

ALTER TABLE ttr.id_verifications
    ADD COLUMN counter_confirmed_at          TIMESTAMPTZ,
    ADD COLUMN counter_confirmed_by_staff_id UUID REFERENCES public.staff_members(id),
    ADD CONSTRAINT chk_idv_counter_confirmed_pair
        CHECK ((counter_confirmed_at IS NULL) = (counter_confirmed_by_staff_id IS NULL)),
    ADD CONSTRAINT chk_idv_counter_confirmed_reliance
        CHECK (counter_confirmed_at IS NULL OR verification_basis = 'relied_on_prior_identification');

COMMENT ON COLUMN ttr.id_verifications.counter_confirmed_at IS
    'When staff confirmed at the gold counter that the ID sighted matches the record relied on (copied by gold-start-ttr).';

CREATE OR REPLACE FUNCTION ttr.clear_counter_confirmation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ttr, pg_temp
AS $$
BEGIN
    IF NEW.prior_verification_id IS DISTINCT FROM OLD.prior_verification_id
       OR NEW.verification_basis IS DISTINCT FROM OLD.verification_basis THEN
        NEW.counter_confirmed_at := NULL;
        NEW.counter_confirmed_by_staff_id := NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_idv_clear_counter_confirmation
    BEFORE UPDATE ON ttr.id_verifications
    FOR EACH ROW EXECUTE FUNCTION ttr.clear_counter_confirmation();

CREATE OR REPLACE FUNCTION ttr.get_stale_draft_ids(older_than_days INTEGER DEFAULT 30)
RETURNS TABLE (transaction_id UUID, reporting_entity_id UUID)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ttr
AS $$
    SELECT t.id, t.reporting_entity_id
    FROM ttr.transactions t
    WHERE t.status     = 'draft'
      AND t.created_at < now() - (older_than_days || ' days')::INTERVAL
      AND NOT EXISTS (SELECT 1 FROM gold.purchases p WHERE p.ttr_transaction_id = t.id);
$$;
