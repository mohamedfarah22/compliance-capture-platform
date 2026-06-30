-- ID verification record for each individual party and each conducting person.
-- Dual nullable FK pattern: exactly one of party_id / conducting_person_id is non-null.
-- A CHECK constraint enforces the XOR — no polymorphic string discriminator needed.

CREATE TABLE ttr.id_verifications (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id           UUID NOT NULL REFERENCES ttr.transactions(id) ON DELETE CASCADE,

    -- exactly one non-null (XOR enforced by chk_idv_person_xor below)
    party_id                 UUID REFERENCES ttr.parties(id) ON DELETE CASCADE,
    conducting_person_id     UUID REFERENCES ttr.conducting_persons(id) ON DELETE CASCADE,

    verification_method       id_verify_method NOT NULL,
    verification_method_other TEXT,
    document_type             id_doc_type NOT NULL,
    document_type_other       TEXT,
    document_number           TEXT NOT NULL,
    issuer                    TEXT,
    has_expiry                BOOLEAN NOT NULL DEFAULT FALSE,
    expiry_date               DATE,
    verification_description  TEXT NOT NULL,

    front_image_id            UUID REFERENCES ttr.stored_images(id),
    back_image_id             UUID REFERENCES ttr.stored_images(id),

    is_complete               BOOLEAN NOT NULL DEFAULT FALSE,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_idv_person_xor CHECK (
        (party_id IS NOT NULL AND conducting_person_id IS NULL)
        OR
        (party_id IS NULL     AND conducting_person_id IS NOT NULL)
    ),
    CONSTRAINT chk_idv_verify_other CHECK (
        verification_method <> 'Other' OR verification_method_other IS NOT NULL
    ),
    CONSTRAINT chk_idv_doc_other CHECK (
        document_type <> 'Other' OR document_type_other IS NOT NULL
    ),
    CONSTRAINT chk_idv_expiry CHECK (
        has_expiry = FALSE OR expiry_date IS NOT NULL
    )
);

CREATE INDEX idx_idv_party      ON ttr.id_verifications (party_id)             WHERE party_id IS NOT NULL;
CREATE INDEX idx_idv_cp         ON ttr.id_verifications (conducting_person_id) WHERE conducting_person_id IS NOT NULL;
CREATE INDEX idx_idv_doc_number ON ttr.id_verifications (document_number);

CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON ttr.id_verifications
    FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- Consistency: party_id, conducting_person_id, and image FKs must all belong
-- to the same transaction_id. A simple FK cannot enforce cross-table consistency.
CREATE OR REPLACE FUNCTION ttr.check_idv_consistency()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = ttr
AS $$
BEGIN
    IF NEW.party_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ttr.parties
        WHERE id = NEW.party_id AND transaction_id = NEW.transaction_id
    ) THEN
        RAISE EXCEPTION 'party_id % does not belong to transaction %',
            NEW.party_id, NEW.transaction_id;
    END IF;

    IF NEW.conducting_person_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ttr.conducting_persons
        WHERE id = NEW.conducting_person_id AND transaction_id = NEW.transaction_id
    ) THEN
        RAISE EXCEPTION 'conducting_person_id % does not belong to transaction %',
            NEW.conducting_person_id, NEW.transaction_id;
    END IF;

    IF NEW.front_image_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ttr.stored_images
        WHERE id = NEW.front_image_id AND transaction_id = NEW.transaction_id
    ) THEN
        RAISE EXCEPTION 'front_image_id % does not belong to transaction %',
            NEW.front_image_id, NEW.transaction_id;
    END IF;

    IF NEW.back_image_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ttr.stored_images
        WHERE id = NEW.back_image_id AND transaction_id = NEW.transaction_id
    ) THEN
        RAISE EXCEPTION 'back_image_id % does not belong to transaction %',
            NEW.back_image_id, NEW.transaction_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_idv_consistency
    BEFORE INSERT OR UPDATE ON ttr.id_verifications
    FOR EACH ROW EXECUTE FUNCTION ttr.check_idv_consistency();

ALTER TABLE ttr.id_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "idv_select" ON ttr.id_verifications FOR SELECT
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions WHERE reporting_entity_id = public.reporting_entity_id()
    ));

CREATE POLICY "idv_insert" ON ttr.id_verifications FOR INSERT
    WITH CHECK (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));

CREATE POLICY "idv_update" ON ttr.id_verifications FOR UPDATE
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ))
    WITH CHECK (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));

CREATE POLICY "idv_delete" ON ttr.id_verifications FOR DELETE
    USING (transaction_id IN (
        SELECT id FROM ttr.transactions
        WHERE reporting_entity_id = public.reporting_entity_id() AND status = 'draft'
    ));
