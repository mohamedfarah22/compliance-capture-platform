-- ID captures can belong to a customer without a TTR (the shared ID store).
--
-- Today every ttr.id_verifications row hangs off a transaction and exactly one of a party or
-- a conducting person. Gold records a customer's ID before any TTR exists, so a row may now
-- be owned by a customer alone:
--
--   transaction-bound:  transaction_id set, exactly one of party_id / conducting_person_id.
--                       customer_id is optional: null, or the party's own customer (it is
--                       filled when the TTR completes, see _link_transaction_customers).
--                       A conducting person is not a customer, so those rows never have one.
--   customer-level:     transaction_id, party_id and conducting_person_id all null,
--                       customer_id set, verification_basis = 'new_capture'.
--
-- A customer-level reliance row is refused: reliance means "this transaction relied on a
-- capture", and with no transaction there is nothing relying on anything.
--
-- Values a customer-level capture must supply for the NOT NULL columns (the caller, e.g. the
-- gold create-customer function, chooses them; nothing here invents them):
--   verification_method       id_verify_method, no default. 'Sighted original document'.
--   document_type, number     the document itself.
--   verification_description  NOT NULL, default ''. The same sentence the wizard generates.
-- Defaults cover the rest: has_expiry false, verification_basis 'new_capture', is_complete
-- false (set true for a finished capture). reporting_entity_id is NOT NULL but is derived
-- from the customer by trg_idv_consistency.

ALTER TABLE ttr.id_verifications
    ALTER COLUMN transaction_id DROP NOT NULL;

ALTER TABLE ttr.id_verifications
    ADD COLUMN customer_id UUID REFERENCES public.customers(id);

CREATE INDEX idx_idv_customer ON ttr.id_verifications (customer_id) WHERE customer_id IS NOT NULL;

ALTER TABLE ttr.id_verifications DROP CONSTRAINT chk_idv_person_xor;

ALTER TABLE ttr.id_verifications
    ADD CONSTRAINT chk_idv_owner CHECK (
        (transaction_id IS NOT NULL
            AND ((party_id IS NOT NULL AND conducting_person_id IS NULL)
              OR (party_id IS NULL     AND conducting_person_id IS NOT NULL)))
        OR
        (transaction_id IS NULL
            AND party_id IS NULL
            AND conducting_person_id IS NULL
            AND customer_id IS NOT NULL
            AND verification_basis = 'new_capture')
    );

-- Normalised document number, for matching an ID typed with spaces or dashes ("AB-12 34"
-- finds AB1234). The rule is fixed: upper case, whitespace and dashes removed. The edge
-- functions' idKey (supabase/functions/_shared/goldKeys.ts) applies the same rule in JS.
-- This is a different, looser key than uq_idv_doc_new_capture (upper(btrim(...))), which is
-- left as it is: changing what counts as a duplicate document is not part of this change.
ALTER TABLE ttr.id_verifications
    ADD COLUMN number_norm TEXT
        GENERATED ALWAYS AS (upper(regexp_replace(document_number, '[\s-]', '', 'g'))) STORED;

CREATE INDEX idx_idv_number_norm ON ttr.id_verifications (reporting_entity_id, number_norm);

-- ─── Consistency trigger ─────────────────────────────────────────────────────────────────
-- Body as in 20260725000001 for transaction-bound rows, plus:
--   * customer-level rows: reporting_entity_id comes from the customer. If the caller also
--     supplied one that disagrees, the row is refused (a customer from another entity);
--     front/back images must be that customer's own images.
--   * transaction-bound rows: customer_id, if set, must be the party's customer_id and the
--     customer must belong to the transaction's entity. The browser can write draft rows, so
--     it must not be able to attach someone else's customer to its own capture.
-- Invoker rights, as before: the customer lookup runs under the caller's RLS, so a staff
-- member can only ever "see" customers of their own entity; the service role sees all.
CREATE OR REPLACE FUNCTION ttr.check_idv_consistency()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = ttr, public
AS $$
DECLARE
    v_customer_entity UUID;
    v_party_customer  UUID;
BEGIN
    IF NEW.transaction_id IS NULL THEN
        -- Customer-level capture.
        IF NEW.customer_id IS NULL THEN
            RAISE EXCEPTION 'a capture with no transaction must belong to a customer'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.party_id IS NOT NULL OR NEW.conducting_person_id IS NOT NULL THEN
            RAISE EXCEPTION 'a customer-level capture cannot also belong to a party or conducting person'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.verification_basis <> 'new_capture' THEN
            RAISE EXCEPTION 'a customer-level capture must be a new capture, not a reliance row'
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT c.reporting_entity_id INTO v_customer_entity
        FROM public.customers c WHERE c.id = NEW.customer_id;

        IF v_customer_entity IS NULL THEN
            RAISE EXCEPTION 'customer % does not exist', NEW.customer_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF NEW.reporting_entity_id IS NOT NULL AND NEW.reporting_entity_id <> v_customer_entity THEN
            RAISE EXCEPTION 'customer % belongs to a different reporting entity', NEW.customer_id
                USING ERRCODE = 'check_violation';
        END IF;
        NEW.reporting_entity_id := v_customer_entity;

        IF NEW.front_image_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM ttr.stored_images
            WHERE id = NEW.front_image_id AND customer_id = NEW.customer_id
        ) THEN
            RAISE EXCEPTION 'front_image_id % does not belong to customer %',
                NEW.front_image_id, NEW.customer_id;
        END IF;

        IF NEW.back_image_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM ttr.stored_images
            WHERE id = NEW.back_image_id AND customer_id = NEW.customer_id
        ) THEN
            RAISE EXCEPTION 'back_image_id % does not belong to customer %',
                NEW.back_image_id, NEW.customer_id;
        END IF;

        RETURN NEW;
    END IF;

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

    IF NEW.customer_id IS NOT NULL THEN
        IF NEW.party_id IS NULL THEN
            RAISE EXCEPTION 'only a party capture can carry a customer_id'
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT p.customer_id INTO v_party_customer FROM ttr.parties p WHERE p.id = NEW.party_id;
        IF v_party_customer IS DISTINCT FROM NEW.customer_id THEN
            RAISE EXCEPTION 'customer_id % is not the customer of party %', NEW.customer_id, NEW.party_id
                USING ERRCODE = 'check_violation';
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM public.customers c
            WHERE c.id = NEW.customer_id AND c.reporting_entity_id = NEW.reporting_entity_id
        ) THEN
            RAISE EXCEPTION 'customer % does not belong to the reporting entity of transaction %',
                NEW.customer_id, NEW.transaction_id
                USING ERRCODE = 'check_violation';
        END IF;
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

-- ─── Re-capture link: same-person test for customer-level rows ───────────────────────────
-- Body as in 20260727000003. That test compares dates of birth, resolving each side through
-- its party or conducting person. A customer-level row has neither, so its DOB comes from
-- the customer; without this a gold re-capture could link to, or be linked from, a record
-- for a different person and the check would silently not fire.
CREATE OR REPLACE FUNCTION ttr.check_idv_recapture_link()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = ttr, public
AS $$
DECLARE
    prior     RECORD;
    new_dob   DATE;
    prior_dob DATE;
BEGIN
    IF NEW.verification_basis <> 'new_capture' OR NEW.prior_verification_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT document_type, document_number, reporting_entity_id, party_id, conducting_person_id, customer_id
      INTO prior
      FROM ttr.id_verifications
     WHERE id = NEW.prior_verification_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'prior_verification_id % does not exist', NEW.prior_verification_id;
    END IF;

    IF prior.reporting_entity_id IS DISTINCT FROM NEW.reporting_entity_id THEN
        RAISE EXCEPTION 'prior verification % belongs to a different reporting entity',
            NEW.prior_verification_id;
    END IF;

    IF prior.document_type IS DISTINCT FROM NEW.document_type
       OR upper(btrim(prior.document_number)) IS DISTINCT FROM upper(btrim(NEW.document_number))
    THEN
        RAISE EXCEPTION
            're-capture must reference the prior verification of the same document (% %), not % %',
            prior.document_type, prior.document_number, NEW.document_type, NEW.document_number;
    END IF;

    -- Resolve the person behind each row. A party or conducting person row uses their own
    -- date of birth (a conducting person's only means anything when dob_known); a
    -- customer-level row, which has neither, uses the customer's.
    SELECT COALESCE(
             (SELECT p.date_of_birth FROM ttr.parties p WHERE p.id = NEW.party_id),
             (SELECT cp.date_of_birth FROM ttr.conducting_persons cp
               WHERE cp.id = NEW.conducting_person_id AND cp.dob_known),
             (SELECT c.date_of_birth FROM public.customers c
               WHERE c.id = NEW.customer_id
                 AND NEW.party_id IS NULL AND NEW.conducting_person_id IS NULL)
           ) INTO new_dob;

    SELECT COALESCE(
             (SELECT p.date_of_birth FROM ttr.parties p WHERE p.id = prior.party_id),
             (SELECT cp.date_of_birth FROM ttr.conducting_persons cp
               WHERE cp.id = prior.conducting_person_id AND cp.dob_known),
             (SELECT c.date_of_birth FROM public.customers c
               WHERE c.id = prior.customer_id
                 AND prior.party_id IS NULL AND prior.conducting_person_id IS NULL)
           ) INTO prior_dob;

    IF new_dob IS NOT NULL AND prior_dob IS NOT NULL AND new_dob <> prior_dob THEN
        RAISE EXCEPTION
            're-capture links to a record for a different person (date of birth % vs %); '
            'use the "different person who shares this document number" reason instead',
            prior_dob, new_dob;
    END IF;

    RETURN NEW;
END;
$$;
