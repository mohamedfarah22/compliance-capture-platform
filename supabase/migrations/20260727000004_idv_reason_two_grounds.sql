-- Aligns the permitted new-capture reasons with privacy policy §3.
--
-- §3 tells customers, verbatim: "We will only take a new copy if your ID has changed
-- (for example, a renewed licence) or if our stored copy is unclear." Two grounds.
-- 20260725000002 also permitted 'other', reasoned as "so staff are never forced to
-- mis-state the reason to proceed". That is a good instinct about data quality and a
-- bad outcome for the promise: a customer is told only two grounds exist, so a third
-- catch-all cannot be offered for re-copying an ID already on file.
--
-- Enforced here rather than only in the UI. §3 is a customer-facing commitment, and it
-- should not be able to drift back with a future UI change — the same argument as
-- trg_idv_recapture_link (finding #8). The dropdown no longer offers it either.
--
-- The two remaining non-§3 values are deliberately kept, because neither is a second
-- copy of an ID already held:
--   'different_person'   — somebody else's document that happens to share a number.
--                          Their FIRST copy. Removing it would leave the uniqueness
--                          index with no lawful exit for a real situation (licence
--                          numbers are unique per state, not nationally).
--   'different_document' — a first copy of a DIFFERENT document. §2 already anticipates
--                          more than one ("a photograph of your photo ID (or of two
--                          approved non-photo documents)"), and "a new copy" in §3 means
--                          a new copy of the ID already held — a passport is not a copy
--                          of a licence. Keeping it also avoids forcing staff to record
--                          a passport as "ID has changed", which would be untrue.
--
-- PRE-FLIGHT — must return 0 before applying, or the ALTER below fails by design:
--
--   SELECT count(*) FROM ttr.id_verifications WHERE new_capture_reason = 'other';
--
-- A non-zero count is a human decision: each row needs re-classifying against the two
-- permitted grounds (or 'different_document') before §3 can be truthfully claimed.
-- Deliberately not auto-migrated — nobody but the staff member who captured it can say
-- what actually happened.

ALTER TABLE ttr.id_verifications DROP CONSTRAINT chk_idv_new_capture_reason_values;

ALTER TABLE ttr.id_verifications
    ADD CONSTRAINT chk_idv_new_capture_reason_values CHECK (
        new_capture_reason IS NULL OR new_capture_reason IN (
            'id_changed',           -- §3 ground 1
            'stored_copy_unclear',  -- §3 ground 2
            'different_person',      -- not a re-copy: another person's first copy
            'different_document'     -- not a re-copy: a different document's first copy
        )
    );
