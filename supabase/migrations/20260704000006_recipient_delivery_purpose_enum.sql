-- Constrain purpose_of_transfer to a fixed set of choices: a customer is always
-- either collecting or dropping off bullion, or collecting or dropping off
-- precious metal — free text just invites inconsistent data entry.

CREATE TYPE transfer_purpose AS ENUM (
  'Collecting bullion',
  'Dropping off bullion',
  'Collecting precious metal',
  'Dropping off precious metal'
);

UPDATE ttr.recipient_deliveries
SET purpose_of_transfer = 'Collecting bullion'
WHERE purpose_of_transfer NOT IN (
  'Collecting bullion',
  'Dropping off bullion',
  'Collecting precious metal',
  'Dropping off precious metal'
);

ALTER TABLE ttr.recipient_deliveries
  ALTER COLUMN purpose_of_transfer TYPE transfer_purpose
  USING purpose_of_transfer::transfer_purpose;
