-- Child table for conducting person aliases (alternate names).
-- No UPDATE policy: aliases are managed via delete-then-insert in the UI.

CREATE TABLE ttr.cp_aliases (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conducting_person_id UUID NOT NULL REFERENCES ttr.conducting_persons(id) ON DELETE CASCADE,
    alias                TEXT NOT NULL,
    sort_order           SMALLINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_cp_alias      ON ttr.cp_aliases (alias);
CREATE INDEX idx_cp_alias_trgm ON ttr.cp_aliases USING GIN (alias gin_trgm_ops);

ALTER TABLE ttr.cp_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cpalias_select" ON ttr.cp_aliases FOR SELECT
    USING (conducting_person_id IN (
        SELECT cp.id FROM ttr.conducting_persons cp
        JOIN ttr.transactions tx ON tx.id = cp.transaction_id
        WHERE tx.reporting_entity_id = public.reporting_entity_id()
    ));

CREATE POLICY "cpalias_insert" ON ttr.cp_aliases FOR INSERT
    WITH CHECK (conducting_person_id IN (
        SELECT cp.id FROM ttr.conducting_persons cp
        JOIN ttr.transactions tx ON tx.id = cp.transaction_id
        WHERE tx.reporting_entity_id = public.reporting_entity_id() AND tx.status = 'draft'
    ));

CREATE POLICY "cpalias_delete" ON ttr.cp_aliases FOR DELETE
    USING (conducting_person_id IN (
        SELECT cp.id FROM ttr.conducting_persons cp
        JOIN ttr.transactions tx ON tx.id = cp.transaction_id
        WHERE tx.reporting_entity_id = public.reporting_entity_id() AND tx.status = 'draft'
    ));
