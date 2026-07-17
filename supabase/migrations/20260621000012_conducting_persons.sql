--0-to-many conducting persons per transaction.
-- A unique partial index enforces at most one primary conducting person per transaction.

CREATE TABLE ttr.conducting_persons (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id       UUID NOT NULL REFERENCES ttr.transactions(id) ON DELETE CASCADE,
    represented_party_id UUID REFERENCES ttr.parties(id),
    is_primary           BOOLEAN NOT NULL DEFAULT FALSE,

    full_name     TEXT NOT NULL,
    dob_known     BOOLEAN NOT NULL DEFAULT FALSE,
    date_of_birth DATE,
    phone         TEXT,
    occupation    TEXT,

    res_street   TEXT NOT NULL,
    res_suburb   TEXT NOT NULL,
    res_state    aus_state NOT NULL,
    res_postcode TEXT NOT NULL,
    res_country  TEXT NOT NULL DEFAULT 'Australia',

    has_postal_address BOOLEAN NOT NULL DEFAULT FALSE,
    post_street        TEXT,
    post_suburb        TEXT,
    post_state         aus_state,
    post_postcode      TEXT,
    post_country       TEXT,

    relationship       cp_relationship NOT NULL,
    relationship_other TEXT,
    authority_to_act   TEXT NOT NULL,
    is_employee        cp_employee_status,
    employee_role      TEXT,

    acting_via_entity BOOLEAN NOT NULL DEFAULT FALSE,
    entity_name       TEXT,
    entity_street     TEXT,
    entity_suburb     TEXT,
    entity_state      aus_state,
    entity_postcode   TEXT,
    entity_country    TEXT,
    entity_reg_type   reg_id_kind,
    entity_reg_number TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_cp_relationship_other CHECK (
        relationship <> 'Other' OR relationship_other IS NOT NULL
    ),
    CONSTRAINT chk_cp_dob CHECK (
        dob_known = FALSE OR date_of_birth IS NOT NULL
    ),
    CONSTRAINT chk_cp_entity CHECK (
        acting_via_entity = FALSE
        OR (entity_name IS NOT NULL AND entity_street IS NOT NULL)
    )
);

CREATE INDEX idx_cp_tx   ON ttr.conducting_persons (transaction_id);
CREATE INDEX idx_cp_fts  ON ttr.conducting_persons USING GIN (to_tsvector('english', full_name));
CREATE INDEX idx_cp_trgm ON ttr.conducting_persons USING GIN (full_name gin_trgm_ops);

-- At most one primary conducting person per transaction (DB-enforced)
CREATE UNIQUE INDEX idx_cp_one_primary
    ON ttr.conducting_persons (transaction_id)
    WHERE is_primary = TRUE;

CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON ttr.conducting_persons
    FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

ALTER TABLE ttr.conducting_persons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cp_select" ON ttr.conducting_persons FOR SELECT
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions WHERE reporting_entity_id = public.reporting_entity_id()
    ));

CREATE POLICY "cp_insert" ON ttr.conducting_persons FOR INSERT
    WITH CHECK (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));

CREATE POLICY "cp_update" ON ttr.conducting_persons FOR UPDATE
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ))
    WITH CHECK (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));

CREATE POLICY "cp_delete" ON ttr.conducting_persons FOR DELETE
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));
