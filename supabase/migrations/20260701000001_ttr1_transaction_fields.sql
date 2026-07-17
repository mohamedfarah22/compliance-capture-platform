-- TTR-1-0: new mandatory capture fields on transactions
ALTER TABLE ttr.transactions
  ADD COLUMN lpp_flag                      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN is_other_ds_provider_involved BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN ttr.transactions.lpp_flag IS
  'Large Party Platform determination (TTR-1-0 lppFlag Y/N)';
COMMENT ON COLUMN ttr.transactions.is_other_ds_provider_involved IS
  'Whether another designated service provider is involved (TTR-1-0 isOtherDsProviderInvolved Y/N)';
