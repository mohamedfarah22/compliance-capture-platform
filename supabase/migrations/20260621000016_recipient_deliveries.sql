-- One recipient/delivery record per transaction (enforced by UNIQUE on transaction_id).

CREATE TABLE ttr.recipient_deliveries (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id             UUID NOT NULL UNIQUE REFERENCES ttr.transactions(id) ON DELETE CASCADE,

    recipient_is_party         BOOLEAN NOT NULL,
    selected_party_id          UUID REFERENCES ttr.parties(id),

    -- used when recipient_is_party = FALSE
    recipient_full_name        TEXT,
    dob_known                  BOOLEAN,
    recipient_dob              DATE,
    recip_street               TEXT,
    recip_suburb               TEXT,
    recip_state                aus_state,
    recip_postcode             TEXT,
    recip_country              TEXT DEFAULT 'Australia',

    purpose_of_transfer        TEXT NOT NULL,
    delivery_method            handover_method NOT NULL,
    delivery_method_other      TEXT,

    delivery_address_different BOOLEAN NOT NULL DEFAULT FALSE,
    del_street                 TEXT,
    del_suburb                 TEXT,
    del_state                  aus_state,
    del_postcode               TEXT,
    del_country                TEXT,

    handover_notes TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_rd_recipient CHECK (
        (recipient_is_party = TRUE  AND selected_party_id IS NOT NULL)
        OR
        (recipient_is_party = FALSE AND recipient_full_name IS NOT NULL)
    ),
    CONSTRAINT chk_rd_delivery_other CHECK (
        delivery_method <> 'Other' OR delivery_method_other IS NOT NULL
    ),
    CONSTRAINT chk_rd_del_address CHECK (
        delivery_address_different = FALSE
        OR (del_street IS NOT NULL AND del_suburb IS NOT NULL AND del_postcode IS NOT NULL)
    )
);

CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON ttr.recipient_deliveries
    FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- Consistency: selected_party_id must belong to the same transaction.
CREATE OR REPLACE FUNCTION ttr.check_rd_consistency()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = ttr
AS $$
BEGIN
    IF NEW.selected_party_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ttr.parties
        WHERE id = NEW.selected_party_id AND transaction_id = NEW.transaction_id
    ) THEN
        RAISE EXCEPTION 'selected_party_id % does not belong to transaction %',
            NEW.selected_party_id, NEW.transaction_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_rd_consistency
    BEFORE INSERT OR UPDATE ON ttr.recipient_deliveries
    FOR EACH ROW EXECUTE FUNCTION ttr.check_rd_consistency();

ALTER TABLE ttr.recipient_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rd_select" ON ttr.recipient_deliveries FOR SELECT
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions WHERE reporting_entity_id = public.reporting_entity_id()
    ));

CREATE POLICY "rd_insert" ON ttr.recipient_deliveries FOR INSERT
    WITH CHECK (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));

CREATE POLICY "rd_update" ON ttr.recipient_deliveries FOR UPDATE
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ))
    WITH CHECK (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));

CREATE POLICY "rd_delete" ON ttr.recipient_deliveries FOR DELETE
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));
