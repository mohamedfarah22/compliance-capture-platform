-- Reconciles the configurable re-verification window with the "one copy of ID on
-- file" rule (privacy policy §3).
--
-- The problem: once a verification passes reporting_entities.idv_max_reliance_days,
-- the wizard stops offering ordinary reliance and requires manager approval. A
-- staff member who instead re-photographs the same document hits the uniqueness
-- index, and none of the new_capture_reason values honestly describes "our own
-- policy says re-verify after N days" — the document has not changed, the stored
-- copy is not unclear, and it is not a different person.
--
-- The resolution is that a lapsed window calls for re-SIGHTING the document, not
-- re-photographing it: staff check the original against the copy already held and
-- record that they did. That keeps exactly one copy on file, stays within what
-- policy §3 tells customers, and needs no exemption from the index because
-- reliance rows are outside it by construction.
--
-- This adds the reason that describes that act. It sits alongside
-- 'manager_approved' rather than replacing it — the two record different things
-- (staff sighted the document / a manager authorised continued reliance), and the
-- existing approval control is deliberately left intact.

ALTER TABLE ttr.id_verifications DROP CONSTRAINT chk_idv_reliance_reason_values;

ALTER TABLE ttr.id_verifications
    ADD CONSTRAINT chk_idv_reliance_reason_values CHECK (
        reliance_reason IS NULL OR reliance_reason IN (
            'customer_known_to_business',
            'prior_id_reviewed_still_valid',
            'customer_confirmed_details_unchanged',
            'manager_approved',
            'original_document_resighted',
            'other'
        )
    );
