-- Single-table inheritance for transaction parties (individual + company).
-- The party_type discriminator determines which fields are required.

CREATE TABLE ttr.parties (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id  UUID NOT NULL REFERENCES ttr.transactions(id) ON DELETE CASCADE,
    party_type      party_kind NOT NULL,
    is_complete     BOOLEAN NOT NULL DEFAULT FALSE,

    -- INDIVIDUAL fields
    first_name            TEXT,
    middle_name           TEXT,
    last_name             TEXT,
    full_name             TEXT,   -- denormalised display copy
    date_of_birth         DATE,
    phone                 TEXT,
    email                 TEXT,
    occupation            TEXT,
    abn                   TEXT,
    business_trading_name TEXT,

    res_street   TEXT,
    res_suburb   TEXT,
    res_state    aus_state,
    res_postcode TEXT,
    res_country  TEXT NOT NULL DEFAULT 'Australia',

    has_postal_address BOOLEAN NOT NULL DEFAULT FALSE,
    post_street        TEXT,
    post_suburb        TEXT,
    post_state         aus_state,
    post_postcode      TEXT,
    post_country       TEXT,

    -- COMPANY fields
    entity_name          TEXT,
    company_trading_name TEXT,
    legal_form           co_legal_form,
    company_phone        TEXT,
    reg_id_type          reg_id_kind,
    reg_identifier       TEXT,
    principal_activity   TEXT,

    biz_street   TEXT,
    biz_suburb   TEXT,
    biz_state    aus_state,
    biz_postcode TEXT,
    biz_country  TEXT NOT NULL DEFAULT 'Australia',

    has_company_postal_address BOOLEAN NOT NULL DEFAULT FALSE,
    co_post_street             TEXT,
    co_post_suburb             TEXT,
    co_post_state              aus_state,
    co_post_postcode           TEXT,
    co_post_country            TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_party_individual CHECK (
        party_type <> 'individual' OR (first_name IS NOT NULL AND last_name IS NOT NULL)
    ),
    CONSTRAINT chk_party_company CHECK (
        party_type <> 'company' OR (entity_name IS NOT NULL AND reg_identifier IS NOT NULL)
    )
);

CREATE INDEX idx_party_tx              ON ttr.parties (transaction_id);
CREATE INDEX idx_party_name_individual ON ttr.parties (last_name, first_name) WHERE party_type = 'individual';
CREATE INDEX idx_party_entity_name     ON ttr.parties (entity_name) WHERE party_type = 'company';

-- Full-text search for AML name screening
CREATE INDEX idx_party_fts ON ttr.parties USING GIN (
    to_tsvector('english', coalesce(full_name, '') || ' ' || coalesce(entity_name, ''))
);

-- Trigram similarity for fuzzy name matching (e.g. similarity(full_name, 'John Smith'))
CREATE INDEX idx_party_trgm ON ttr.parties USING GIN (
    coalesce(full_name, '') gin_trgm_ops,
    coalesce(entity_name, '') gin_trgm_ops
);

CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON ttr.parties
    FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

ALTER TABLE ttr.parties ENABLE ROW LEVEL SECURITY;

CREATE POLICY "party_select" ON ttr.parties FOR SELECT
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions WHERE reporting_entity_id = public.reporting_entity_id()
    ));

CREATE POLICY "party_insert" ON ttr.parties FOR INSERT
    WITH CHECK (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));

CREATE POLICY "party_update" ON ttr.parties FOR UPDATE
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ))
    WITH CHECK (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));

CREATE POLICY "party_delete" ON ttr.parties FOR DELETE
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));
