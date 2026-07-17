-- Atomic state transition function for completing a transaction.
-- This is the ONLY mechanism that sets status = 'complete'.
-- The audit log insert and status update happen in one database transaction —
-- either both succeed or neither does.
--
-- Called by the completeTransaction Edge Function after all application-level
-- validation has passed. The function performs its own authorization and
-- race-condition checks using a row-level lock (FOR UPDATE).

CREATE OR REPLACE FUNCTION ttr.complete_transaction(
    p_transaction_id  UUID,
    p_staff_member_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ttr, public, auth
AS $$
DECLARE
    v_entity_id UUID;
BEGIN
    -- Acquire a row-level lock and verify the transaction is still a draft.
    -- FOR UPDATE prevents concurrent completion attempts from racing.
    SELECT reporting_entity_id INTO v_entity_id
    FROM ttr.transactions
    WHERE id = p_transaction_id
      AND status = 'draft'
    FOR UPDATE;

    IF v_entity_id IS NULL THEN
        RAISE EXCEPTION 'Transaction % is not a draft or does not exist', p_transaction_id;
    END IF;

    -- Verify the staff member belongs to the same entity and is active.
    -- Belt-and-suspenders vs. the Edge Function's earlier JWT check.
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_members
        WHERE id                  = p_staff_member_id
          AND reporting_entity_id = v_entity_id
          AND is_active           = TRUE
    ) THEN
        RAISE EXCEPTION 'Staff member % is not authorised to complete transaction %',
            p_staff_member_id, p_transaction_id;
    END IF;

    -- Atomic write: insert audit row first, then update status.
    -- If either fails the whole transaction rolls back.
    INSERT INTO ttr.transaction_audit_log
        (transaction_id, reporting_entity_id, changed_by, old_status, new_status, note)
    VALUES
        (p_transaction_id, v_entity_id, p_staff_member_id, 'draft', 'complete', 'Completed via API');

    UPDATE ttr.transactions
    SET status       = 'complete',
        completed_at = now()
    WHERE id = p_transaction_id;
    -- trg_lock_completed fires here as belt-and-suspenders;
    -- it will raise if status somehow changed between the SELECT FOR UPDATE and this UPDATE.
END;
$$;
