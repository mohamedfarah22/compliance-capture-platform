-- TTR-1-0: new IndividualDetails fields on parties (individuals only)
ALTER TABLE ttr.parties
  ADD COLUMN gender                     CHAR(1) CHECK (gender IN ('M', 'F', 'U')),
  ADD COLUMN citizenship_country_code   CHAR(2),
  ADD COLUMN tax_residency_country_code CHAR(2);

COMMENT ON COLUMN ttr.parties.gender IS
  'IndividualDetails gender: M=Male, F=Female, U=Unknown';
COMMENT ON COLUMN ttr.parties.citizenship_country_code IS
  'ISO 3166-1 alpha-2 country code for citizenship';
COMMENT ON COLUMN ttr.parties.tax_residency_country_code IS
  'ISO 3166-1 alpha-2 country code for tax residency';

-- TTR-1-0: country of issue on ID verification documents
ALTER TABLE ttr.id_verifications
  ADD COLUMN id_country_code CHAR(2);

COMMENT ON COLUMN ttr.id_verifications.id_country_code IS
  'ISO 3166-1 alpha-2 country code for the issuing country of the ID document';

-- TTR-1-0: enforce 9-digit AAN format on reporting entities.
-- NOT VALID skips validation of existing rows so the migration doesn't fail
-- when the AAN hasn't been set yet; new inserts/updates must comply.
ALTER TABLE reporting_entities
  ADD CONSTRAINT re_aan_format CHECK (
    austrac_re_number IS NULL OR austrac_re_number ~ '^[0-9]{9}$'
  ) NOT VALID;

COMMENT ON CONSTRAINT re_aan_format ON reporting_entities IS
  'AUSTRAC Account Number must be exactly 9 digits';
