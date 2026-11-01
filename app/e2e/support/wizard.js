import { expect } from '@playwright/test'

// DD/MM/YYYY, the format the app's DatePicker parses.
export const dmy = (iso) => iso.split('-').reverse().join('/')

// A FormField found by its label text. Needed for radio groups and date pickers, whose
// label is not tied to a single control.
export const field = (page, label) =>
  label instanceof RegExp
    ? page.locator('div', { has: page.locator('label', { hasText: label }) }).last()
    : page.locator(`xpath=//div[label[normalize-space()="${label}"]]`)

export const answer = (page, question, value) =>
  field(page, question).getByRole('radio', { name: value, exact: true }).check()

export const clickContinue = (page) => page.getByRole('button', { name: 'Continue', exact: true }).click()

// ─── Start ───────────────────────────────────────────────────────────────────

export const startTransaction = async (page, { scenario, ref }) => {
  await page.goto('/')
  await page.getByRole('radio', { name: scenario }).check()
  await page.getByLabel('Transaction reference').fill(ref)
  await page.getByRole('button', { name: 'Start transaction' }).click()
  await expect(page).toHaveURL(/\/customers$/)
}

// ─── Customers ───────────────────────────────────────────────────────────────

export const createCustomer = async (page, party) => {
  await page.getByRole('button', { name: 'Create new customer / party' }).click()
  await expect(page.getByRole('heading', { name: 'Create New Customer / Party' })).toBeVisible()
  if (party.type === 'company') {
    await page.getByRole('group', { name: 'Party type' }).getByRole('button', { name: 'Company / Business' }).click()
    await page.getByLabel('Registered entity name').fill(party.entityName)
    await page.getByLabel('ABN / ACN').fill(party.abn)
    await page.getByLabel('Registered suburb / postcode').fill(party.suburb)
    await page.getByLabel('Phone number').fill(party.phone)
    await page.getByLabel('Email address').fill(party.email)
  } else {
    await page.getByLabel('First name').fill(party.firstName)
    if (party.middleName) await page.getByLabel('Middle name').fill(party.middleName)
    await page.getByLabel('Last name').fill(party.lastName)
    await page.getByLabel('Date of birth').fill(dmy(party.dateOfBirth))
    await page.getByLabel('Phone number').fill(party.phone)
    await page.getByLabel('Email address').fill(party.email)
  }
  await page.getByRole('button', { name: 'Save customer' }).click()
  await expect(page.getByRole('heading', { name: 'Selected for this transaction' })).toBeVisible()
}

export const searchIndividual = async (page, { firstName, lastName, dateOfBirth }) => {
  await page.getByRole('group', { name: 'Search mode' }).getByRole('button', { name: 'Individual' }).click()
  await page.getByLabel('First name').fill(firstName)
  await page.getByLabel('Last name').fill(lastName)
  if (dateOfBirth) await page.getByLabel('Date of birth').fill(dmy(dateOfBirth))
  await page.getByRole('button', { name: 'Search', exact: true }).click()
}

// The individual fast path: the customer conducts the transaction themselves, which
// stands in for the matrix's "Conducting Person: No".
export const confirmOwnBehalf = async (page, fullName) => {
  await answer(page, `Is ${fullName} acting on their own behalf for this transaction?`, 'Yes')
  await clickContinue(page)
  await expect(page).toHaveURL(/\/id-verification$/)
}

// ─── ID verification ─────────────────────────────────────────────────────────

export const setVerificationMethod = (page, method) => page.getByLabel('Verification method').selectOption(method)

// Type then number, then leaves the number field: the collision lookup runs on its blur.
export const enterDocument = async (page, { type, number }) => {
  await page.getByLabel('Document or data-source type').selectOption(type)
  await page.getByLabel('Document or reference number').fill(number)
  await page.getByLabel('Document or reference number').blur()
}

export const setExpiry = async (page, isoDate) => {
  await answer(page, 'Is there an expiry date?', isoDate ? 'Yes' : 'No')
  if (isoDate) await page.getByLabel('Expiry date').fill(dmy(isoDate))
}

// Photographs one side through the app's own camera path (Chromium's fake device).
export const captureSide = async (page, side) => {
  const Side = side === 'front' ? 'Front' : 'Back'
  await page.getByRole('button', { name: `Start camera for ${side}` }).click()
  // Capturing before the first frame yields an empty image, which only fails at Continue.
  await expect.poll(() => page.locator('video').evaluate((v) => v.videoWidth)).toBeGreaterThan(0)
  await page.getByRole('button', { name: `Capture ${side}` }).click()
  await expect(page.getByRole('img', { name: `${Side} of ID preview` })).toBeVisible()
  await page.getByRole('button', { name: `Accept ${side} image` }).click()
  await expect(page.getByRole('button', { name: `Retake ${side}` })).toBeVisible()
}

// A fresh capture through the camera; a driver licence needs its back as well.
// doc.method and doc.source cover an electronic data source.
export const captureDocument = async (page, doc) => {
  await setVerificationMethod(page, doc.method ?? 'Sighted original document')
  if (doc.source) await page.getByLabel('Electronic data source').fill(doc.source)
  await enterDocument(page, doc)
  await page.getByLabel('Issuer').fill(doc.issuer)
  await setExpiry(page, doc.expiry ?? null)
  await captureSide(page, 'front')
  if (doc.type === 'Driver licence') await captureSide(page, 'back')
}

// A returning customer: reliance on the document already on file is pre-selected.
export const acceptReliance = async (page, doc) => {
  await expect(page.getByLabel('Verification method')).toHaveValue('Relied on prior identification')
  await expect(page.getByLabel('Reason for reliance')).toHaveValue('prior_id_reviewed_still_valid')
  await expect(page.getByLabel('Document or reference number')).toHaveValue(doc.number)
  await page.getByLabel('I confirm the person presenting today matches these ID images').check()
}

// ─── Transaction details, party details, review ─────────────────────────────

// Fill after the residential address: the postal block repeats its labels.
export const fillPostal = async (page, postal) => {
  await page.getByLabel('Postal address is different').check()
  await page.locator('#postStreet').fill(postal.street)
  await page.locator('#postSuburb').fill(postal.suburb)
  await page.locator('#postState').selectOption(postal.state)
  await page.locator('#postPostcode').fill(postal.postcode)
}

// A returning customer's details are carried over from their record, not re-entered.
// "Sole trader?" is the one blank: a saved No is stored as no legal form, so it only
// reads back on a party already completed in this transaction.
export const confirmCarriedOver = async (page, person) => {
  await expect(page).toHaveURL(/\/party-details$/)
  await expect(page.getByLabel('Full legal name')).toHaveValue(person.fullName)
  await expect(page.getByLabel('Street address')).toHaveValue(person.address.street)
  await expect(page.getByLabel('Occupation or principal activity')).toHaveValue(person.occupation)
  await expect(page.getByLabel('Gender')).toHaveValue(person.gender)
  await page.getByLabel('Is this person a sole trader?').selectOption('No')
}

export const fillCash = async (page, amount) => {
  await expect(page).toHaveURL(/\/transaction-details$/)
  await page.getByLabel('Cash amount').fill(String(amount))
  await clickContinue(page)
  await expect(page).not.toHaveURL(/\/transaction-details$/)
}

// Name and date of birth carry over from the customer record and are left untouched:
// the prior-ID lookup is keyed on them.
export const fillIndividualDetails = async (page, person) => {
  await expect(page).toHaveURL(/\/party-details$/)
  await page.getByLabel('Street address').fill(person.address.street)
  await page.getByLabel('Suburb').fill(person.address.suburb)
  await page.getByLabel('State').selectOption(person.address.state)
  await page.getByLabel('Postcode').fill(person.address.postcode)
  await page.getByLabel('Occupation or principal activity').fill(person.occupation)
  await page.getByLabel('Is this person a sole trader?').selectOption('No')
  await page.getByLabel('Gender').selectOption(person.gender)
  await clickContinue(page)
  await expect(page).not.toHaveURL(/\/party-details$/)
}

export const completeTransaction = async (page) => {
  await expect(page).toHaveURL(/\/review$/)
  await page.getByRole('button', { name: 'Complete / Reportable' }).click()
  await expect(page.getByRole('heading', { name: 'Transaction Complete' })).toBeVisible()
}

// The choices a select offers, without its "Select …" placeholder.
export const optionsOf = async (page, label) =>
  (await page.getByLabel(label).locator('option').allTextContents()).filter((o) => !o.startsWith('Select'))

export const addExistingIndividual = async (page, person) => {
  await searchIndividual(page, person)
  await page.getByRole('listitem').filter({ hasText: person.fullName }).getByRole('button', { name: 'Add to transaction' }).click()
  await expect(page.getByRole('heading', { name: 'Selected for this transaction' })).toBeVisible()
}

export const NO_COLLISION_REASONS = ['Customer presented a different document', 'ID has changed (e.g. renewed licence)']
export const SAME_PERSON_COLLISION_REASONS = [
  'ID has changed (e.g. renewed licence)',
  'Stored copy is unclear',
  'Different person who shares this document number',
]

// Exit the wizard and confirm, which deletes the draft (delete-draft-transaction).
export const abandonTransaction = async (page) => {
  await page.getByRole('button', { name: 'Exit', exact: true }).click()
  await page.getByRole('dialog', { name: 'Exit transaction?' }).getByRole('button', { name: 'Exit' }).click()
  await expect(page.getByRole('heading', { name: 'Start TTR Transaction' })).toBeVisible()
}

// A Trust must answer the express-trust question: pass trust: { type, name } for Yes.
export const fillCompanyDetails = async (page, company, { trust } = {}) => {
  await expect(page).toHaveURL(/\/party-details$/)
  await page.getByLabel('Legal form or structure').selectOption(company.legalForm)
  if (company.legalForm === 'Trust') await page.getByLabel('Is this an express trust?').selectOption(trust ? 'Yes' : 'No')
  if (trust) {
    await page.getByLabel('Trust type').fill(trust.type)
    await page.getByLabel('Trust name').fill(trust.name)
  }
  await page.getByLabel('Street address').fill(company.address.street)
  await page.getByLabel('Suburb').fill(company.address.suburb)
  await page.getByLabel('State').selectOption(company.address.state)
  await page.getByLabel('Postcode').fill(company.address.postcode)
  await page.getByLabel('Registration identifier type').selectOption(company.registrationType ?? 'ABN')
  await page.getByLabel('Registration identifier value').fill(company.abn)
  await page.getByLabel('Principal activity or business activity').fill(company.principalActivity)
  await clickContinue(page)
  await expect(page).not.toHaveURL(/\/party-details$/)
}

// Fills the conducting person (Colin for Wilma). Pass dateOfBirth: null to leave it blank (F6).
// A person with an employeeRole answers "Is an employee?" Yes and gives the role.
export const fillConductingPerson = async (page, person, { representing, dateOfBirth = person.dateOfBirth } = {}) => {
  await expect(page).toHaveURL(/\/conducting-person$/)
  await answer(page, 'Is a different person conducting the transaction on behalf of a party?', 'Yes')
  // Options read 'Name (Company) — ABN'.
  const represented = page.getByLabel('Customer / party being represented')
  const option = (await represented.locator('option').allTextContents()).find((o) => o.startsWith(representing))
  await represented.selectOption({ label: option })
  await page.getByLabel('Full legal name').fill(person.fullName)
  await answer(page, 'Is the date of birth known?', 'Yes')
  if (dateOfBirth) await page.getByLabel('Date of birth').fill(dmy(dateOfBirth))
  await page.getByLabel('Street address').fill(person.address.street)
  await page.getByLabel('Suburb').fill(person.address.suburb)
  await page.getByLabel('State').selectOption(person.address.state)
  await page.getByLabel('Postcode').fill(person.address.postcode)
  await page.getByLabel('Phone number').fill(person.phone)
  await page.getByLabel('Occupation, job title, or principal activity').fill(person.occupation)
  await page.getByLabel('Relationship to the customer / party').selectOption({ label: person.relationship })
  await page.getByLabel('Authority to act').fill(person.authorityToAct)
  await answer(page, 'Is the conducting person an employee of the customer / party?', person.employeeRole ? 'Yes' : 'No')
  if (person.employeeRole) await page.getByLabel('Employee title or role').fill(person.employeeRole)
  await answer(page, 'Is the conducting person acting through another entity?', 'No')
}

export const addExistingCompany = async (page, company) => {
  await page.getByRole('group', { name: 'Search mode' }).getByRole('button', { name: 'Company / Business' }).click()
  // Company search needs all three fields.
  await page.getByLabel('Registered entity name').fill(company.entityName)
  await page.getByLabel('ABN / ACN').fill(company.abn)
  await page.getByLabel('Registered suburb / postcode').fill(company.suburb)
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await page.getByRole('listitem').filter({ hasText: company.entityName }).getByRole('button', { name: 'Add to transaction' }).click()
  await expect(page.getByRole('heading', { name: 'Selected for this transaction' })).toBeVisible()
}

// The header's Back button (exact: "Start camera for back" also matches "Back").
export const goBack = (page) => page.getByRole('button', { name: 'Back', exact: true }).click()
