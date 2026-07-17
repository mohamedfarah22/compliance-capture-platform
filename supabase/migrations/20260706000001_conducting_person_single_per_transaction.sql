-- Formalize the single-conducting-person-per-transaction invariant: the wizard's
-- saveConductingPerson always upserts one row per transaction (checks for an existing
-- row before inserting), but the table itself was designed as 0-to-many with only a
-- partial unique index on is_primary. Replace that partial index with a full unique
-- constraint on transaction_id so a second, non-primary CP row can never be silently
-- created and dropped from the AUSTRAC report (which only ever reads the primary CP).

DROP INDEX IF EXISTS ttr.idx_cp_one_primary;

ALTER TABLE ttr.conducting_persons
    ADD CONSTRAINT uq_cp_transaction UNIQUE (transaction_id);
