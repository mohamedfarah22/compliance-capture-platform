-- TTR-1-0: OrganisationDetails.isExpressTrust / TrustDetails, only applicable when
-- legal_form = 'Trust'. trustParticipant/trustBeneficiary sub-structures are
-- deliberately not modeled — both are schema-optional (minOccurs="0") and their
-- conditional asserts only fire once isTenOrLessBeneficiaries is set, which this
-- system never does, so omitting them keeps generated XML fully schema-valid.
ALTER TABLE ttr.parties
  ADD COLUMN is_express_trust BOOLEAN,
  ADD COLUMN trust_type_other TEXT,
  ADD COLUMN trust_name TEXT;

COMMENT ON COLUMN ttr.parties.is_express_trust IS
  'TTR-1-0 isExpressTrust — only applicable when legal_form = ''Trust''';
COMMENT ON COLUMN ttr.parties.trust_type_other IS
  'TTR-1-0 TrustDetails.trustTypeOther — free text, AUSTRAC TrustType reference codes not available in this schema';
COMMENT ON COLUMN ttr.parties.trust_name IS
  'TTR-1-0 TrustDetails.trustName';
