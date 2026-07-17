-- verification_description was defined in the original CREATE TABLE but may be absent
-- in databases set up before the column was added to the migration file.
ALTER TABLE ttr.id_verifications
  ADD COLUMN IF NOT EXISTS verification_description TEXT NOT NULL DEFAULT '';
