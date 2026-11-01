// "Dummy data — reusable identities" from docs/uat-test-matrix.md (Part 1), reused by Part 1C.

export const JANE = {
  type: 'individual',
  firstName: 'Jane',
  middleName: 'Alice',
  lastName: 'Citizen',
  fullName: 'Jane Alice Citizen',
  dateOfBirth: '1985-06-15',
  phone: '0400111222',
  email: 'jane.citizen@example.test',
  occupation: 'Jeweller',
  gender: 'F',
  citizenship: 'AU',
  address: { street: '12 Test St', suburb: 'Coburg', state: 'VIC', postcode: '3058' },
}

export const MARCUS = {
  type: 'individual',
  firstName: 'Marcus',
  middleName: 'James',
  lastName: 'Tester',
  fullName: 'Marcus James Tester',
  dateOfBirth: '1990-03-22',
  phone: '0400333444',
  email: 'marcus.tester@example.test',
  occupation: 'Retailer',
  gender: 'M',
  citizenship: 'AU',
  address: { street: '45 Sample Ave', suburb: 'Richmond', state: 'VIC', postcode: '3121' },
}

export const DAVID = {
  type: 'individual',
  firstName: 'David',
  middleName: 'Paul',
  lastName: 'Sampleton',
  fullName: 'David Paul Sampleton',
  dateOfBirth: '1978-11-02',
  phone: '0400555666',
  email: 'david.sampleton@example.test',
  occupation: 'Accountant',
  gender: 'M',
  citizenship: 'AU',
  address: { street: '9 Demo Rd', suburb: 'Brunswick', state: 'VIC', postcode: '3056' },
}

export const SARAH = {
  type: 'individual',
  firstName: 'Sarah',
  middleName: 'Jane',
  lastName: 'Austen',
  fullName: 'Sarah Jane Austen',
  dateOfBirth: '1975-01-20',
  phone: '0400222333',
  email: 'sarah.austen@example.test',
  occupation: 'Designer',
  gender: 'F',
  citizenship: 'AU',
  alias: 'Sarah A. Austen-Smith',
  address: { street: '5 River St', suburb: 'Northcote', state: 'VIC', postcode: '3070' },
  postal: { street: 'PO Box 100', suburb: 'Northcote', state: 'VIC', postcode: '3070' },
}

export const GRACE = {
  type: 'individual',
  firstName: 'Grace',
  lastName: 'Harbour',
  fullName: 'Grace Harbour',
  dateOfBirth: '1988-08-08',
  phone: '0400666777',
  email: 'grace.harbour@example.test',
  occupation: 'Nurse',
  gender: 'F',
  citizenship: 'AU',
  address: { street: '18 Bay St', suburb: 'Geelong', state: 'VIC', postcode: '3220' },
}

// Conducting persons.

export const PRIYA = {
  fullName: 'Priya Agent',
  dateOfBirth: '1982-04-10',
  phone: '0400777888',
  occupation: 'Financial adviser',
  relationship: 'Agent',
  authorityToAct: "Power of attorney dated 2026-06-01 authorising Priya Agent to act on David Sampleton's behalf for this transaction.",
  address: { street: '3 Broker Ln', suburb: 'Fitzroy', state: 'VIC', postcode: '3065' },
}

export const TOM = {
  fullName: 'Tom Employee',
  dateOfBirth: '1995-09-09',
  phone: '0400999000',
  occupation: 'Branch teller',
  relationship: 'Employee',
  authorityToAct: 'Employed staff member authorised to transact on behalf of Golden Bullion Traders Pty Ltd.',
  employeeRole: 'Store manager',
  address: { street: '8 Staff St', suburb: 'Dandenong', state: 'VIC', postcode: '3175' },
}

export const MICHAEL = {
  fullName: 'Michael Director',
  dateOfBirth: '1970-07-07',
  phone: '0400444555',
  occupation: 'Company director',
  relationship: 'Director',
  authorityToAct: 'Sole director and company secretary, authorised under the company constitution to act for Perth Metal Co.',
  address: { street: '4 Harbour Rd', suburb: 'Fremantle', state: 'WA', postcode: '6160' },
}

// Companies. `suburb` is what Create Customer and Company search take.

export const GOLDEN = {
  type: 'company',
  entityName: 'Golden Bullion Traders Pty Ltd',
  abn: '12345678901',
  suburb: 'Dandenong',
  phone: '0398765432',
  email: 'accounts@goldenbullion.example.test',
  legalForm: 'Company',
  principalActivity: 'Bullion dealing',
  address: { street: '100 Industry Rd', suburb: 'Dandenong', state: 'VIC', postcode: '3175' },
}

export const SOUTHERN_CROSS = {
  type: 'company',
  entityName: 'Southern Cross Metals Trust',
  abn: '98765432109',
  suburb: 'Box Hill',
  phone: '0387654321',
  email: 'admin@socrossmetals.example.test',
  legalForm: 'Trust',
  principalActivity: 'Precious metal trading',
  address: { street: '22 Commerce St', suburb: 'Box Hill', state: 'VIC', postcode: '3128' },
}

export const PERTH_METAL = {
  type: 'company',
  entityName: 'Perth Metal Co',
  abn: '123456789',
  registrationType: 'ACN',
  suburb: 'Fremantle',
  phone: '0894561234',
  email: 'info@perthmetal.example.test',
  legalForm: 'Sole trader',
  principalActivity: 'Metal refining',
  address: { street: '7 Harbour Rd', suburb: 'Fremantle', state: 'WA', postcode: '6160' },
}

// "ID verification defaults" and the per-transaction documents.
export const MATRIX_DOCS = {
  janePassport: { type: 'Passport', number: 'PA1234567', issuer: 'Australian Passport Office', expiry: '2031-06-15' },
  davidLicence: { type: 'Driver licence', number: 'DL987654321', issuer: 'VicRoads', expiry: '2028-03-01' },
  priyaPassport: { type: 'Passport', number: 'PA7654321', issuer: 'Australian Passport Office', expiry: '2029-09-09' },
  tomProofOfAge: { type: 'Proof of age card', number: 'POA-11223', issuer: 'Service Victoria', expiry: '2027-12-01' },
  sarahEvs: {
    method: 'Electronic data source',
    source: 'Electronic Verification Co',
    type: 'Electronic verification source',
    number: 'EVS-000123',
    issuer: 'Electronic Verification Co',
  },
  michaelLicence: { type: 'Driver licence', number: 'DL456789123', issuer: 'Department of Transport WA', expiry: '2027-05-05' },
  marcusMedicare: { type: 'Medicare card', number: 'MC998877', issuer: 'Services Australia' },
  graceNationalId: { type: 'National identity card', number: 'NIC-334455', issuer: 'Department of Home Affairs' },
  sarahPassport: { type: 'Passport', number: 'PA5566778', issuer: 'Australian Passport Office', expiry: '2032-01-20' },
  janeLicence: { type: 'Driver licence', number: 'DL111222333', issuer: 'VicRoads' },
}
