-- Prerequisite for the "one copy of ID on file" rule (privacy policy §3), which is
-- itself defined in the next migration.
--
-- Denormalises reporting_entity_id onto id_verifications so uniqueness can be
-- scoped per business without a join, and so triggers can compare entities
-- without re-querying the parent transaction. Populated by the existing
-- consistency trigger, which already reconciles the row against that transaction.

ALTER TABLE ttr.id_verifications
    ADD COLUMN reporting_entity_id UUID REFERENCES public.reporting_entities(id);

-- Backfill from the owning transaction. handle_updated_at is suspended so this
-- does not overwrite updated_at on every historical row — that column records
-- genuine edits to the verification, not this migration.
ALTER TABLE ttr.id_verifications DISABLE TRIGGER handle_updated_at;

UPDATE ttr.id_verifications idv
   SET reporting_entity_id = t.reporting_entity_id
  FROM ttr.transactions t
 WHERE t.id = idv.transaction_id
   AND idv.reporting_entity_id IS NULL;

ALTER TABLE ttr.id_verifications ENABLE TRIGGER handle_updated_at;

ALTER TABLE ttr.id_verifications ALTER COLUMN reporting_entity_id SET NOT NULL;

-- Populate going forward inside the existing consistency trigger rather than in a
-- new one: this function already exists to keep the row consistent with its
-- parent transaction, and deriving the value here means a client cannot supply a
-- reporting_entity_id that disagrees with the transaction's.
CREATE OR REPLACE FUNCTION ttr.check_idv_consistency()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = ttr
AS $$
BEGIN
    SELECT t.reporting_entity_id INTO NEW.reporting_entity_id
    FROM ttr.transactions t
    WHERE t.id = NEW.transaction_id;

    IF NEW.reporting_entity_id IS NULL THEN
        RAISE EXCEPTION 'transaction % does not exist', NEW.transaction_id;
    END IF;

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

-- The uniqueness index itself lives in the next migration: its predicate depends
-- on new_capture_reason, which that migration adds.
