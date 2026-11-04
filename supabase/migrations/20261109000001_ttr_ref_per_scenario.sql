-- Gold Phase 9a, spec 3.4: one TTR per invoice per type.
--
-- WARNING: this changes an existing TTR constraint. Until now a transaction reference was unique per business;
-- it is now unique per business AND scenario, so a mixed scrap + bullion invoice can carry the same reference
-- (the ERP invoice number) on two reports. Every existing row already satisfies the wider rule, so nothing is
-- rewritten. Applies to the client project on its next manual `db push`.

ALTER TABLE ttr.transactions DROP CONSTRAINT uq_tx_ref_per_entity;

ALTER TABLE ttr.transactions
    ADD CONSTRAINT uq_tx_ref_per_entity UNIQUE (reporting_entity_id, transaction_ref, scenario);
