-- Electronic data source used for identity verification (e.g. ABR, electoral roll, World-Check).
-- Required by AUSTRAC <electDataSrc> when verification_method = 'Electronic data source'.
ALTER TABLE ttr.id_verifications
  ADD COLUMN elec_data_src TEXT;
