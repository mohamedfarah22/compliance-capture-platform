-- Records who conducted the transaction when there is no separate conducting-person
-- record: either a specific party (self-conducted, disambiguates when there are
-- multiple parties) or, for company customers where no individual can be identified,
-- an AUSTRAC methodOfConductingTxn code.
ALTER TABLE ttr.transactions
  ADD COLUMN conducted_by_party_id uuid REFERENCES ttr.parties(id) ON DELETE SET NULL,
  ADD COLUMN method_of_conducting_txn text CHECK (method_of_conducting_txn IN ('A', 'N', 'C'));

COMMENT ON COLUMN ttr.transactions.conducted_by_party_id IS
  'Party who conducted the transaction when hasConductingPerson=no and there is more than one party, or the company party a methodOfConductingTxn applies to.';
COMMENT ON COLUMN ttr.transactions.method_of_conducting_txn IS
  'AUSTRAC TTR-1-0 methodOfConductingTxn code (A=ATM deposit, N=night safe/express deposit, C=payroll or cash courier) — set instead of otherPerson when a company customer''s conducting individual cannot be identified.';
