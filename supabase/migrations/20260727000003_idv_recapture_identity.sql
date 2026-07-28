-- Stops a re-capture linking to a record that belongs to a DIFFERENT PERSON.
--
-- The second half of UAT finding #8. 20260727000002 stops the UI offering the linking
-- reasons across identities; this stops the database accepting one however it is reached
-- — a script, a direct REST call, or a future feature that forgets the rule. The UI half
-- alone would leave every UAT case passing while the invariant stayed unenforced.
--
-- check_idv_recapture_link() already proves the link points at the same DOCUMENT
-- (20260725000002). That is what makes a renewed licence recordable: Australian licence
-- numbers survive renewal, so an 'id_changed' re-capture legitimately collides and can
-- only save by linking. What it never checked is whether the two rows describe the same
-- PERSON — and the same collision happens when two people in different states share a
-- number, which is what 'different_person' exists to record.
--
-- The test is date of birth, deliberately not name:
--   * DOB is exact. Names are not — middle names, married names and typos would produce
--     false "different person" rejections, and each one blocks a legitimate re-capture at
--     save time with no way forward. That failure mode is worse than the gap.
--   * Two records for one person always share a DOB. Two different people sharing a
--     document number almost never do.
--   * When either side's DOB is unknown the rule cannot fire and the capture proceeds as
--     before. This is defence in depth behind the UI, not a proof of identity.
--
-- IdVerificationPage applies the identical rule when deciding which reasons to offer, so
-- the UI can never offer something this trigger rejects. That mismatch is exactly what
-- made UAT R19 unrunnable: it asked staff to reach a state the UI could not produce.

CREATE OR REPLACE FUNCTION ttr.check_idv_recapture_link()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = ttr
AS $$
DECLARE
    prior     RECORD;
    new_dob   DATE;
    prior_dob DATE;
BEGIN
    IF NEW.verification_basis <> 'new_capture' OR NEW.prior_verification_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT document_type, document_number, reporting_entity_id, party_id, conducting_person_id
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

    -- Resolve the person behind each row. Exactly one of party_id / conducting_person_id
    -- is set, and a conducting person's date_of_birth only means anything when dob_known
    -- (chk_cp_dob permits NULL otherwise).
    SELECT COALESCE(
             (SELECT p.date_of_birth FROM ttr.parties p WHERE p.id = NEW.party_id),
             (SELECT cp.date_of_birth FROM ttr.conducting_persons cp
               WHERE cp.id = NEW.conducting_person_id AND cp.dob_known)
           ) INTO new_dob;

    SELECT COALESCE(
             (SELECT p.date_of_birth FROM ttr.parties p WHERE p.id = prior.party_id),
             (SELECT cp.date_of_birth FROM ttr.conducting_persons cp
               WHERE cp.id = prior.conducting_person_id AND cp.dob_known)
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
