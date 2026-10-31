-- Sets id_verifications.customer_id from the party's customer_id for existing captures.
--
-- Phase 1 (20261101000003) linked every completed party to a customer; this carries the same
-- link to each party's ID captures. Conducting-person captures stay null: a conducting
-- person is not a customer. Reliance rows are party rows too and are stamped the same way.
--
-- The function is kept (service role only) so pgTAP can run it against fixtures.
-- It is idempotent: a second run changes nothing.

CREATE OR REPLACE FUNCTION public._backfill_idv_customer_ids()
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, ttr
AS $$
DECLARE
    v_rows BIGINT;
BEGIN
    UPDATE ttr.id_verifications idv
    SET customer_id = p.customer_id
    FROM ttr.parties p
    WHERE idv.party_id = p.id
      AND p.customer_id IS NOT NULL
      AND idv.customer_id IS DISTINCT FROM p.customer_id;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
END;
$$;

REVOKE EXECUTE ON FUNCTION public._backfill_idv_customer_ids() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._backfill_idv_customer_ids() TO service_role;

-- One-time run. The row triggers are suspended for it: updated_at records genuine edits to
-- a verification, not this migration, and the consistency and re-capture checks re-validate
-- data that was already accepted when it was written (so a historical oddity must not stop
-- the migration). They are re-enabled straight after, and run normally on every later write.
ALTER TABLE ttr.id_verifications DISABLE TRIGGER handle_updated_at;
ALTER TABLE ttr.id_verifications DISABLE TRIGGER trg_idv_consistency;
ALTER TABLE ttr.id_verifications DISABLE TRIGGER trg_idv_recapture_link;

SELECT public._backfill_idv_customer_ids();

ALTER TABLE ttr.id_verifications ENABLE TRIGGER handle_updated_at;
ALTER TABLE ttr.id_verifications ENABLE TRIGGER trg_idv_consistency;
ALTER TABLE ttr.id_verifications ENABLE TRIGGER trg_idv_recapture_link;
