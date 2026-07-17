-- Read-only helper function used by the cleanup-stale-drafts Edge Function.
-- Returns IDs of draft transactions older than the specified number of days.
-- Does NOT delete anything — deletion is performed by the Edge Function after
-- Supabase Storage objects have been successfully removed for each transaction.
--
-- This separation guarantees: DB rows are never deleted unless Storage cleanup
-- is confirmed by the Edge Function.

CREATE OR REPLACE FUNCTION ttr.get_stale_draft_ids(older_than_days INTEGER DEFAULT 30)
RETURNS TABLE (transaction_id UUID, reporting_entity_id UUID)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ttr
AS $$
    SELECT id, reporting_entity_id
    FROM ttr.transactions
    WHERE status     = 'draft'
      AND created_at < now() - (older_than_days || ' days')::INTERVAL;
$$;
