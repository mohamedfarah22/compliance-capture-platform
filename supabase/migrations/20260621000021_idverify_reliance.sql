-- Separates the basis of identification from the method used.
-- verification_method = how the document was examined (existing column, unchanged)
-- verification_basis  = whether new evidence was captured or prior CDD was relied on
CREATE TYPE id_verification_basis AS ENUM (
    'new_capture',
    'relied_on_prior_identification'
);

ALTER TABLE ttr.id_verifications
    ADD COLUMN verification_basis    id_verification_basis NOT NULL DEFAULT 'new_capture',
    ADD COLUMN prior_verification_id UUID
        REFERENCES ttr.id_verifications(id)
        ON DELETE RESTRICT,
    ADD COLUMN reliance_reason        TEXT;

-- Prevent a row from pointing to itself.
ALTER TABLE ttr.id_verifications
    ADD CONSTRAINT chk_idv_no_self_reference CHECK (
        prior_verification_id IS NULL OR prior_verification_id != id
    );

-- Bi-directional constraint: prevents mixed states in either direction.
-- Requires reliance_reason for reliance rows; prohibits it for new_capture rows.
-- ON DELETE RESTRICT: a verification referenced by a reliance record cannot be deleted.
-- In practice this never fires for completed transactions (immutability trigger blocks deletion).
ALTER TABLE ttr.id_verifications
    ADD CONSTRAINT chk_idv_reliance_reason CHECK (
        (verification_basis = 'new_capture'
            AND prior_verification_id IS NULL
            AND reliance_reason IS NULL)
        OR
        (verification_basis = 'relied_on_prior_identification'
            AND prior_verification_id IS NOT NULL
            AND reliance_reason IS NOT NULL)
    );

-- Constrain reliance_reason to the agreed dropdown values.
ALTER TABLE ttr.id_verifications
    ADD CONSTRAINT chk_idv_reliance_reason_values CHECK (
        reliance_reason IS NULL OR reliance_reason IN (
    'customer_known_to_business',
    'prior_id_reviewed_still_valid',
    'customer_confirmed_details_unchanged',
    'manager_approved',
    'other'
)
    );
