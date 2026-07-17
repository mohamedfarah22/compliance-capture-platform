-- Child table for party aliases (alternate names).
-- Stored as rows rather than TEXT[] so each alias can be indexed for AML name matching.
-- No UPDATE policy: aliases are managed via delete-then-insert in the UI.

CREATE TABLE ttr.party_aliases (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    party_id   UUID NOT NULL REFERENCES ttr.parties(id) ON DELETE CASCADE,
    alias      TEXT NOT NULL,
    sort_order SMALLINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_party_alias      ON ttr.party_aliases (alias);
CREATE INDEX idx_party_alias_trgm ON ttr.party_aliases USING GIN (alias gin_trgm_ops);

ALTER TABLE ttr.party_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "palias_select" ON ttr.party_aliases FOR SELECT
    USING (party_id IN (
        SELECT p.id FROM ttr.parties p
        JOIN ttr.transactions tx ON tx.id = p.transaction_id
        WHERE tx.reporting_entity_id = public.reporting_entity_id()
    ));

CREATE POLICY "palias_insert" ON ttr.party_aliases FOR INSERT
    WITH CHECK (party_id IN (
        SELECT p.id FROM ttr.parties p
        JOIN ttr.transactions tx ON tx.id = p.transaction_id
        WHERE tx.reporting_entity_id = public.reporting_entity_id() AND tx.status = 'draft'
    ));

CREATE POLICY "palias_delete" ON ttr.party_aliases FOR DELETE
    USING (party_id IN (
        SELECT p.id FROM ttr.parties p
        JOIN ttr.transactions tx ON tx.id = p.transaction_id
        WHERE tx.reporting_entity_id = public.reporting_entity_id() AND tx.status = 'draft'
    ));
