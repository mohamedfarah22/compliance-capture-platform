-- Line items for bullion exchanged in the transaction.
-- line_total_aud is stored (not a generated/computed column) for audit immutability:
-- a computed column would recalculate on every read and could change if inputs are patched.

CREATE TABLE ttr.bullion_items (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id     UUID NOT NULL REFERENCES ttr.transactions(id) ON DELETE CASCADE,
    sort_order         SMALLINT NOT NULL DEFAULT 0,

    direction          bullion_dir NOT NULL,
    metal_type         bullion_metal NOT NULL,
    metal_type_other   TEXT,
    product_type       bullion_product NOT NULL,
    product_type_other TEXT,
    purity             TEXT NOT NULL,
    quantity           NUMERIC(10,4) NOT NULL CHECK (quantity > 0),
    weight             NUMERIC(12,6) NOT NULL CHECK (weight > 0),
    weight_unit        bullion_weight_unit NOT NULL,
    weight_unit_other  TEXT,
    unit_price_aud     NUMERIC(15,2) NOT NULL CHECK (unit_price_aud > 0),
    line_total_aud     NUMERIC(15,2) NOT NULL,
    description        TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_bi_metal_other   CHECK (metal_type   <> 'Other' OR metal_type_other   IS NOT NULL),
    CONSTRAINT chk_bi_product_other CHECK (product_type <> 'Other' OR product_type_other IS NOT NULL),
    CONSTRAINT chk_bi_weight_other  CHECK (weight_unit  <> 'other' OR weight_unit_other  IS NOT NULL)
);

CREATE INDEX idx_bullion_tx ON ttr.bullion_items (transaction_id);

CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON ttr.bullion_items
    FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

ALTER TABLE ttr.bullion_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bi_select" ON ttr.bullion_items FOR SELECT
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions WHERE reporting_entity_id = public.reporting_entity_id()
    ));

CREATE POLICY "bi_insert" ON ttr.bullion_items FOR INSERT
    WITH CHECK (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));

CREATE POLICY "bi_update" ON ttr.bullion_items FOR UPDATE
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ))
    WITH CHECK (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));

CREATE POLICY "bi_delete" ON ttr.bullion_items FOR DELETE
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));
