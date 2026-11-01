// UAT matrix Part 1 — transactions A–J, run as Part 1C's Step 0 re-run: on a reset database
// with the one-copy-of-ID rule in place, so TX-B2 and TX-G accept the auto-selected reliance
// and TX-I takes TX-M's collision path. The XML each row proves is checked in 03-report.
// Recipient & Delivery and Bullion / Precious Metal Details are skipped:
// ITEM_AND_DELIVERY_CAPTURE_ENABLED is off.
import { expect, test } from '@playwright/test'
import { signedInContext } from '../support/auth.js'
import { sql } from '../support/db.js'
import {
  DAVID, GOLDEN, GRACE, JANE, MARCUS, MATRIX_DOCS, MICHAEL, PERTH_METAL, PRIYA, SARAH, SOUTHERN_CROSS, TOM,
} from '../support/matrix-cast.js'
import * as w from '../support/wizard.js'

test.describe.configure({ mode: 'serial' })

const REASON = 'Reason for taking a new copy'
const HAS_CP = 'Is a different person conducting the transaction on behalf of a party?'
let context
let page

test.beforeAll(async ({ browser }) => {
  context = await signedInContext(browser, 'admin')
  page = await context.newPage()
})

test.afterAll(async () => {
  await context.close()
})

const saveAndNextPerson = async () => {
  await page.getByRole('button', { name: 'Save and next person' }).click()
  await expect(page.getByLabel('Verification method')).toHaveValue('')
}

const fillForeignCash = async () => {
  await expect(page).toHaveURL(/\/transaction-details$/)
  await page.getByRole('group', { name: 'Cash currency' }).getByRole('button', { name: 'Other', exact: true }).click()
  await page.getByLabel('Foreign currency type').selectOption('USD')
  await page.getByLabel('Foreign currency amount').fill('8000')
  await page.getByLabel('FX rate used').fill('1.52')
  await page.getByLabel('Rate source').selectOption('Internal POS rate')
  await expect(page.getByLabel('Australian dollar value')).toHaveValue(/^12160(\.0+)?$/)
  await w.clickContinue(page)
  await expect(page).not.toHaveURL(/\/transaction-details$/)
}

// Every Party Details field the matrix names for an individual.
const fillIndividual = async (person) => {
  await expect(page).toHaveURL(/\/party-details$/)
  await expect(page.getByLabel('Full legal name')).toHaveValue(person.fullName)
  if (person.alias) {
    await page.getByPlaceholder('Enter alias and press Enter').fill(person.alias)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByRole('button', { name: `Remove alias ${person.alias}` })).toBeVisible()
  }
  await page.getByLabel('Street address').fill(person.address.street)
  await page.getByLabel('Suburb').fill(person.address.suburb)
  await page.getByLabel('State').selectOption(person.address.state)
  await page.getByLabel('Postcode').fill(person.address.postcode)
  if (person.postal) await w.fillPostal(page, person.postal)
  await page.getByLabel('Occupation or principal activity').fill(person.occupation)
  await page.getByLabel('Is this person a sole trader?').selectOption('No')
  await page.getByLabel('Gender').selectOption(person.gender)
  await page.getByLabel('Citizenship country').fill(person.citizenship)
  await page.getByLabel('Tax residency country').fill(person.citizenship)
  await w.clickContinue(page)
  await expect(page).not.toHaveURL(/\/party-details$/)
}

const notOwnBehalf = async (person) => {
  await w.answer(page, `Is ${person.fullName} acting on their own behalf for this transaction?`, 'No')
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/transaction-details$/)
}

// Options read 'Name (Individual)' or 'Name (Company) — ABN'.
const selectParty = async (label, name) => {
  const select = page.getByLabel(label)
  await select.selectOption({ label: (await select.locator('option').allTextContents()).find((o) => o.startsWith(name)) })
}

// TX-D / TX-J: a company customer with no identifiable individual.
const nightSafe = async () => {
  await expect(page).toHaveURL(/\/conducting-person$/)
  await w.answer(page, HAS_CP, 'No')
  await w.answer(page, 'Can the individual who conducted this transaction be identified?', 'No — impersonal channel (ATM, night safe, cash courier)')
  await page.getByLabel('Method of conducting the transaction').selectOption({ label: 'Night safe or express deposit' })
  await w.clickContinue(page)
}

const companyToConductingPerson = async (company, amount, options) => {
  await w.clickContinue(page)
  await w.fillCash(page, amount)
  await w.fillCompanyDetails(page, company, options)
}

const idRows = (documentNumber) => sql`
  select idv.verification_basis::text as verification_basis, idv.new_capture_reason,
         idv.prior_verification_id is not null as linked, idv.party_id is null as is_conducting_person
    from ttr.id_verifications idv where idv.document_number = ${documentNumber} order by idv.created_at`

test('TX-A — sell bullion, baseline happy path', async () => {
  await w.startTransaction(page, { scenario: 'Sell bullion to customer', ref: 'UAT-A-0001' })
  await w.createCustomer(page, JANE)
  await w.confirmOwnBehalf(page, JANE.fullName)
  // Part 1C regression: a first-time customer is never asked for a reason.
  await expect(page.getByLabel(REASON)).toHaveCount(0)
  await w.captureDocument(page, MATRIX_DOCS.janePassport)
  await expect(page.getByLabel(REASON)).toHaveCount(0)
  await w.clickContinue(page)
  await w.fillCash(page, 15000)
  await fillIndividual(JANE)
  await w.completeTransaction(page)
})

test('TX-B — buy bullion, foreign currency, driver licence front and back', async () => {
  await w.startTransaction(page, { scenario: 'Buy bullion from customer', ref: 'UAT-B-0002' })
  await w.createCustomer(page, DAVID)
  await w.confirmOwnBehalf(page, DAVID.fullName)
  await w.captureDocument(page, MATRIX_DOCS.davidLicence)
  await w.clickContinue(page)
  await fillForeignCash()
  await fillIndividual(DAVID)
  await w.completeTransaction(page)
})

test('TX-B2 — Agent conducting for an individual, reliance on TX-B’s licence', async () => {
  await w.startTransaction(page, { scenario: 'Buy bullion from customer', ref: 'UAT-B2-0002B' })
  await w.addExistingIndividual(page, DAVID)
  await notOwnBehalf(DAVID)
  await fillForeignCash()
  await w.confirmCarriedOver(page, DAVID)
  await w.clickContinue(page)
  await w.fillConductingPerson(page, PRIYA, { representing: DAVID.fullName })
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/id-verification$/)

  await w.acceptReliance(page, MATRIX_DOCS.davidLicence)
  await saveAndNextPerson()
  await w.captureDocument(page, MATRIX_DOCS.priyaPassport)
  await w.clickContinue(page)
  await w.completeTransaction(page)

  const [cp] = await sql`
    select cp.full_name, cp.relationship::text as relationship, cp.authority_to_act
      from ttr.conducting_persons cp join ttr.transactions t on t.id = cp.transaction_id
     where t.transaction_ref = 'UAT-B2-0002B'`
  expect(cp).toEqual({ full_name: PRIYA.fullName, relationship: 'Agent', authority_to_act: PRIYA.authorityToAct })
})

test('TX-C — company customer, Employee conducting with a role', async () => {
  await w.startTransaction(page, { scenario: 'Sell bullion to customer', ref: 'UAT-C-0003' })
  await w.createCustomer(page, GOLDEN)
  await companyToConductingPerson(GOLDEN, 12000)
  await w.fillConductingPerson(page, TOM, { representing: GOLDEN.entityName })
  await w.clickContinue(page)
  // Only Tom: a company customer gets no ID Verification record of its own.
  await expect(page).toHaveURL(/\/id-verification$/)
  await expect(page.getByRole('button', { name: 'Save and next person' })).toHaveCount(0)
  await w.captureDocument(page, MATRIX_DOCS.tomProofOfAge)
  await w.clickContinue(page)
  await w.completeTransaction(page)
})

test('TX-D — trust customer through a night safe, no ID Verification', async () => {
  await w.startTransaction(page, { scenario: 'Buy bullion from customer', ref: 'UAT-D-0004' })
  await w.createCustomer(page, SOUTHERN_CROSS)
  await companyToConductingPerson(SOUTHERN_CROSS, 20000)
  await nightSafe()
  await w.completeTransaction(page)
})

test('TX-E — alias, postal address, electronic verification source', async () => {
  await w.startTransaction(page, { scenario: 'Sell precious metal to customer', ref: 'UAT-E-0005' })
  await w.createCustomer(page, SARAH)
  await w.confirmOwnBehalf(page, SARAH.fullName)
  await w.captureDocument(page, MATRIX_DOCS.sarahEvs)
  await w.clickContinue(page)
  await w.fillCash(page, 10500)
  await fillIndividual(SARAH)
  await w.completeTransaction(page)
})

const returningSarah = async (ref) => {
  await w.startTransaction(page, { scenario: 'Sell precious metal to customer', ref })
  await w.addExistingIndividual(page, SARAH)
  await w.confirmOwnBehalf(page, SARAH.fullName)
  await w.acceptReliance(page, MATRIX_DOCS.sarahEvs)
  await w.clickContinue(page)
  await w.fillCash(page, 10500)
  await w.confirmCarriedOver(page, SARAH)
}

test('TX-E2 — reliance on prior identification (TC-209)', async () => {
  await returningSarah('UAT-E2-0005B')
  await w.clickContinue(page)
  await w.completeTransaction(page)

  const [row] = await sql`
    select idv.verification_basis::text as verification_basis, idv.document_type::text as document_type,
           idv.document_number, idv.front_image_id is not null as has_front
      from ttr.id_verifications idv join ttr.transactions t on t.id = idv.transaction_id
     where t.transaction_ref = 'UAT-E2-0005B'`
  expect(row).toEqual({
    verification_basis: 'relied_on_prior_identification',
    document_type: 'Electronic verification source',
    document_number: 'EVS-000123',
    has_front: false,
  })
})

test('TX-E3 — the alias carries over without being re-entered', async () => {
  await returningSarah('UAT-E3-0005C')
  await expect(page.getByRole('button', { name: `Remove alias ${SARAH.alias}` })).toBeVisible()
  await w.clickContinue(page)
  await w.completeTransaction(page)
})

test('TX-F — sole trader with an ACN, Director representing it', async () => {
  await w.startTransaction(page, { scenario: 'Buy precious metal from customer', ref: 'UAT-F-0006' })
  await w.createCustomer(page, PERTH_METAL)
  await companyToConductingPerson(PERTH_METAL, 18000)
  await w.fillConductingPerson(page, MICHAEL, { representing: PERTH_METAL.entityName })
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/id-verification$/)
  await w.captureDocument(page, MATRIX_DOCS.michaelLicence)
  await w.clickContinue(page)
  await w.completeTransaction(page)
})

test('TX-G — two customers, the second one conducted', async () => {
  await w.startTransaction(page, { scenario: 'Sell bullion to customer', ref: 'UAT-G-0007' })
  await w.addExistingIndividual(page, JANE)
  await w.createCustomer(page, MARCUS)
  await w.clickContinue(page)
  await w.fillCash(page, 11000)

  await w.confirmCarriedOver(page, JANE)
  await page.getByRole('button', { name: 'Save and next party' }).click()
  await fillIndividual(MARCUS)

  await expect(page).toHaveURL(/\/conducting-person$/)
  await w.answer(page, HAS_CP, 'No')
  await selectParty('Which party conducted this transaction?', MARCUS.fullName)
  await w.clickContinue(page)

  await expect(page).toHaveURL(/\/id-verification$/)
  await w.acceptReliance(page, MATRIX_DOCS.janePassport)
  await saveAndNextPerson()
  await w.captureDocument(page, MATRIX_DOCS.marcusMedicare)
  await w.clickContinue(page)
  await w.completeTransaction(page)
})

test('TX-H — buy bullion, national identity card', async () => {
  await w.startTransaction(page, { scenario: 'Buy bullion from customer', ref: 'UAT-H-0008' })
  await w.createCustomer(page, GRACE)
  await w.confirmOwnBehalf(page, GRACE.fullName)
  await w.captureDocument(page, MATRIX_DOCS.graceNationalId)
  await w.clickContinue(page)
  await w.fillCash(page, 10200)
  await fillIndividual(GRACE)
  await w.completeTransaction(page)
})

test('TX-I / TX-M ⚠ — Employee draft reload (fix #5), conducting-person collision', async () => {
  await w.startTransaction(page, { scenario: 'Sell bullion to customer', ref: 'UAT-I-0009' })
  await w.addExistingCompany(page, GOLDEN)
  await w.clickContinue(page)
  await w.fillCash(page, 12000)
  await expect(page.getByLabel('Legal form or structure')).toHaveValue(GOLDEN.legalForm)
  await w.clickContinue(page)
  await w.fillConductingPerson(page, TOM, { representing: GOLDEN.entityName })
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/id-verification$/)

  // The dbRowToCp half of fix #5: reloaded from the draft, both answers survive, and so
  // does "Is the date of birth known?" (Part 1C regression).
  await w.goBack(page)
  await expect(page).toHaveURL(/\/conducting-person$/)
  await expect(w.field(page, 'Is the conducting person an employee of the customer / party?').getByRole('radio', { name: 'Yes' })).toBeChecked()
  await expect(page.getByLabel('Employee title or role')).toHaveValue(TOM.employeeRole)
  await expect(w.field(page, 'Is the date of birth known?').getByRole('radio', { name: 'Yes' })).toBeChecked()
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/id-verification$/)

  // TX-M: a conducting person has no name lookup, so nothing is pre-selected and the
  // document collision is the only route to reuse.
  const doc = MATRIX_DOCS.tomProofOfAge
  await expect(page.getByLabel('Verification method')).toHaveValue('')
  await w.setVerificationMethod(page, 'Sighted original document')
  await w.enterDocument(page, doc)
  await expect(page.getByText(`${doc.type} ${doc.number} is already on file`)).toBeVisible()
  await expect.poll(() => w.optionsOf(page, REASON)).toEqual(w.SAME_PERSON_COLLISION_REASONS)
  await page.getByLabel(REASON).selectOption({ label: 'Stored copy is unclear' })
  await w.captureSide(page, 'front')
  await w.clickContinue(page)
  await w.completeTransaction(page)

  expect(await idRows(doc.number)).toEqual([
    { verification_basis: 'new_capture', new_capture_reason: null, linked: false, is_conducting_person: true },
    { verification_basis: 'new_capture', new_capture_reason: 'stored_copy_unclear', linked: true, is_conducting_person: true },
  ])
})

test('TX-J — the express-trust question on a returning trust (fix #7)', async () => {
  await w.startTransaction(page, { scenario: 'Buy bullion from customer', ref: 'UAT-J-0010' })
  await w.addExistingCompany(page, SOUTHERN_CROSS)
  await w.clickContinue(page)
  await w.fillCash(page, 20000)
  await expect(page.getByLabel('Legal form or structure')).toHaveValue('Trust')
  await w.fillCompanyDetails(page, SOUTHERN_CROSS, { trust: { type: 'Discretionary trust', name: 'Southern Cross Family Trust' } })
  await nightSafe()
  await w.completeTransaction(page)
})
