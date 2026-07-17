-- The column and constraint originally named "re_number" actually store and validate
-- the AUSTRAC Account Number (AAN, TTR-1-0 spec section 9.1) — the 9-digit identifier
-- written into <reAustracAccountNumber>/<submitterAustracAccountNumber> in report XML.
-- AUSTRAC Online shows a genuinely separate, shorter "RE number" for the account, which
-- is NOT what this column stores or what TTR-1-0 reporting requires. Renaming to remove
-- the misleading name before someone enters the wrong value here.

ALTER TABLE public.reporting_entities
  RENAME COLUMN austrac_re_number TO austrac_account_number;

ALTER TABLE public.reporting_entities
  RENAME CONSTRAINT re_aan_format TO aan_format;

COMMENT ON COLUMN public.reporting_entities.austrac_account_number IS
  'AUSTRAC Account Number (AAN) — required in every TTR report header. Distinct from the shorter AUSTRAC RE number shown on AUSTRAC Online.';
