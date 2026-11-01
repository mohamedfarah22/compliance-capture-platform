// The "Regression cast" from docs/uat-test-matrix.md (Part 0), reused by Phase 4.

export const REGINA = {
  type: 'individual',
  firstName: 'Regina',
  middleName: 'Mae',
  lastName: 'Testworth',
  fullName: 'Regina Mae Testworth',
  dateOfBirth: '1983-05-12',
  phone: '0400123123',
  email: 'regina.testworth@example.test',
  occupation: 'Florist',
  gender: 'F',
  country: 'AU',
  address: { street: '14 Regress Rd', suburb: 'Preston', state: 'VIC', postcode: '3072', country: 'Australia' },
}

export const BARRY = {
  type: 'individual',
  firstName: 'Barry',
  lastName: 'Doubleton',
  fullName: 'Barry Doubleton',
  dateOfBirth: '1979-09-30',
  phone: '0400456456',
  email: 'barry.doubleton@example.test',
  occupation: 'Mechanic',
  gender: 'M',
  country: 'AU',
  address: { street: '27 Repeat St', suburb: 'Thornbury', state: 'VIC', postcode: '3071', country: 'Australia' },
}

// Conducting person for Wilma Wholesale.
export const COLIN = {
  fullName: 'Colin Broker',
  dateOfBirth: '1986-02-14',
  phone: '0400789789',
  occupation: 'Broker',
  relationship: 'Agent',
  authorityToAct: 'Authorised to transact on behalf of Wilma Wholesale Pty Ltd.',
  address: { street: '5 Agent Ave', suburb: 'Carlton', state: 'VIC', postcode: '3053', country: 'Australia' },
}

export const WILMA = {
  type: 'company',
  entityName: 'Wilma Wholesale Pty Ltd',
  abn: '55667788990',
  suburb: 'Carlton',
  phone: '0392223333',
  email: 'accounts@wilmawholesale.example.test',
  legalForm: 'Company',
  principalActivity: 'Metal wholesaling',
  address: { street: '9 Trade Pl', suburb: 'Carlton', state: 'VIC', postcode: '3053', country: 'Australia' },
}

export const DOCS = {
  reginaLicence: { type: 'Driver licence', number: 'RGN-111222', issuer: 'VicRoads', country: 'AU', expiry: '2030-05-12' },
  reginaPassport: { type: 'Passport', number: 'PRG-998877', issuer: 'Australian Passport Office', country: 'AU', expiry: '2033-05-12' },
  colinPassport: { type: 'Passport', number: 'CLB-334455', issuer: 'Australian Passport Office', country: 'AU', expiry: '2031-02-14' },
}
