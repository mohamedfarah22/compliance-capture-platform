-- Line items for precious metal exchanged in the transaction (PRECIOUS designated
-- service, <pmi>/<pmo> elements) — mirrors ttr.bullion_items (BULSER), but the
-- AUSTRAC PreciousMetal type has no product/purity fields and instead carries a
-- serial number. line_total_aud is stored (not generated) for the same audit
-- immutability reason as bullion_items.

CREATE TABLE ttr.precious_metal_items (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id     UUID NOT NULL REFERENCES ttr.transactions(id) ON DELETE CASCADE,
    sort_order         SMALLINT NOT NULL DEFAULT 0,

    direction          bullion_dir NOT NULL,
    metal_type         precious_metal_type NOT NULL,
    description        TEXT CHECK (char_length(description) <= 500),
    serial_number      TEXT CHECK (char_length(serial_number) <= 100),
    quantity           NUMERIC(10,4) NOT NULL CHECK (quantity > 0),
    weight             NUMERIC(12,6) NOT NULL CHECK (weight > 0),
    weight_unit        bullion_weight_unit NOT NULL,
    weight_unit_other  TEXT,
    unit_price_aud     NUMERIC(15,2) NOT NULL CHECK (unit_price_aud > 0),
    line_total_aud     NUMERIC(15,2) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_pmi_metal_desc   CHECK (metal_type NOT IN ('Alloy', 'Other') OR description IS NOT NULL),
    CONSTRAINT chk_pmi_weight_other CHECK (weight_unit <> 'other' OR weight_unit_other IS NOT NULL)
);

CREATE INDEX idx_precious_metal_tx ON ttr.precious_metal_items (transaction_id);

CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON ttr.precious_metal_items
    FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

ALTER TABLE ttr.precious_metal_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pmi_select" ON ttr.precious_metal_items FOR SELECT
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions WHERE reporting_entity_id = public.reporting_entity_id()
    ));

CREATE POLICY "pmi_insert" ON ttr.precious_metal_items FOR INSERT
    WITH CHECK (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));

CREATE POLICY "pmi_update" ON ttr.precious_metal_items FOR UPDATE
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ))
    WITH CHECK (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));

CREATE POLICY "pmi_delete" ON ttr.precious_metal_items FOR DELETE
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));
