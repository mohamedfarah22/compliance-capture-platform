// UAT matrix Part 0, Phase 3 — one copy of ID on file (R18–R23). Needs R11.
// Recipient & Delivery and Bullion Details are skipped: ITEM_AND_DELIVERY_CAPTURE_ENABLED is off.
import { expect, test } from '@playwright/test'
import { signedInContext } from '../support/auth.js'
import { BARRY, COLIN, DOCS, REGINA, WILMA } from '../support/cast.js'
import { sql } from '../support/db.js'
import * as w from '../support/wizard.js'

test.describe.configure({ mode: 'serial' })

const REASON = 'Reason for taking a new copy'
let context
let page

test.beforeAll(async ({ browser }) => {
  context = await signedInContext(browser, 'admin')
  page = await context.newPage()
})

test.afterAll(async () => {
  await context.close()
})

// Regina, returning: search, add, own behalf, arrive at ID Verification.
const startForRegina = async (ref, scenario = 'Sell bullion to customer') => {
  await w.startTransaction(page, { scenario, ref })
  await w.addExistingIndividual(page, REGINA)
  await w.confirmOwnBehalf(page, REGINA.fullName)
}

const finishAsRegina = async (amount) => {
  await w.clickContinue(page)
  await w.fillCash(page, amount)
  await w.fillIndividualDetails(page, REGINA)
  await w.completeTransaction(page)
}

test('R18 — same customer, same document, stored copy unclear', async () => {
  await startForRegina('REG-002', 'Buy bullion from customer')

  // 1. Reliance on her licence is pre-selected on arrival, with no camera.
  await expect(page.getByLabel('Verification method')).toHaveValue('Relied on prior identification')
  await expect(page.getByLabel('Document or reference number')).toHaveValue(DOCS.reginaLicence.number)
  await expect(page.getByLabel('Reason for reliance')).toHaveValue('prior_id_reviewed_still_valid')
  await expect(page.getByLabel('I confirm the person presenting today matches these ID images')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start camera for front' })).toHaveCount(0)

  // 2. ⚠ critical: switching to a fresh capture clears type, number and issuer.
  await w.setVerificationMethod(page, 'Sighted original document')
  await expect(page.getByLabel('Document or data-source type')).toHaveValue('')
  await expect(page.getByLabel('Document or reference number')).toHaveValue('')
  await expect(page.getByLabel('Issuer')).toHaveValue('')

  // 3. She has ID on file, so a reason is needed at once, above the camera.
  expect(await w.optionsOf(page, REASON)).toEqual(w.NO_COLLISION_REASONS)
  await expect(page.getByText(`This customer already has ID on file (Driver licence ${DOCS.reginaLicence.number}`)).toBeVisible()
  const reasonY = (await page.getByLabel(REASON).boundingBox()).y
  const cameraY = (await page.getByRole('heading', { name: 'Capture front of ID' }).boundingBox()).y
  expect(reasonY).toBeLessThan(cameraY)

  // 4–5. The collision narrows the reasons to the three that can save against it.
  await w.enterDocument(page, DOCS.reginaLicence)
  await expect.poll(() => w.optionsOf(page, REASON)).toEqual(w.SAME_PERSON_COLLISION_REASONS)
  await expect(page.getByText(`Driver licence ${DOCS.reginaLicence.number} is already on file`)).toBeVisible()

  // 7. Linking: issuer fills in and the helper says it replaces the copy on file.
  await page.getByLabel(REASON).selectOption({ label: 'Stored copy is unclear' })
  await expect(page.getByLabel('Issuer')).toHaveValue(DOCS.reginaLicence.issuer)
  await expect(page.getByText('Linked to the copy already on file, so this replaces it rather than adding a second one.')).toBeVisible()

  // 8. Finding #11: the same card's expiry is carried over, not left blank.
  await expect(w.field(page, 'Is there an expiry date?').getByRole('radio', { name: 'Yes' })).toBeChecked()
  await expect(page.getByLabel('Expiry date')).toHaveValue(w.dmy(DOCS.reginaLicence.expiry))

  await w.captureSide(page, 'front')
  await w.captureSide(page, 'back')
  await finishAsRegina(11000)

  const rows = await sql`
    select verification_basis, new_capture_reason, prior_verification_id is not null as linked
      from ttr.id_verifications where document_number = ${DOCS.reginaLicence.number} order by created_at`
  expect(rows).toEqual([
    { verification_basis: 'new_capture', new_capture_reason: null, linked: false },
    { verification_basis: 'new_capture', new_capture_reason: 'stored_copy_unclear', linked: true },
  ])
})

test('R19 ⚠ critical — a different person cannot quietly reuse the number', async () => {
  await w.startTransaction(page, { scenario: 'Buy bullion from customer', ref: 'REG-003' })
  await w.createCustomer(page, BARRY)
  await w.confirmOwnBehalf(page, BARRY.fullName)
  await w.setVerificationMethod(page, 'Sighted original document')

  // Detection is on the document, not the person: Barry has no history of his own.
  await expect(page.getByLabel(REASON)).toHaveCount(0)
  await w.enterDocument(page, DOCS.reginaLicence)
  // Finding #8: another person's record leaves only the audited exit.
  await expect.poll(() => w.optionsOf(page, REASON)).toEqual(['Different person who shares this document number'])
  await page.getByLabel('Issuer').fill(DOCS.reginaLicence.issuer)
  await w.setExpiry(page, null)
  await w.captureSide(page, 'front')
  await w.captureSide(page, 'back')

  // With no reason chosen, Continue is refused on the page.
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/id-verification$/)
  await expect(page.getByText(/duplicate key value|23505/)).toHaveCount(0)

  await page.getByLabel(REASON).selectOption({ label: 'Different person who shares this document number' })
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/transaction-details$/)

  const rows = await sql`
    select p.last_name, idv.new_capture_reason, idv.prior_verification_id is not null as linked
      from ttr.id_verifications idv join ttr.parties p on p.id = idv.party_id
     where upper(btrim(idv.document_number)) = ${DOCS.reginaLicence.number} order by idv.created_at`
  expect(rows.filter((r) => r.last_name === BARRY.lastName)).toEqual([
    { last_name: BARRY.lastName, new_capture_reason: 'different_person', linked: false },
  ])

  await w.abandonTransaction(page)
})

test('R20 — customer presents a different document', async () => {
  await startForRegina('REG-004')
  await w.setVerificationMethod(page, 'Sighted original document')
  await w.enterDocument(page, DOCS.reginaPassport)
  await page.getByLabel('Issuer').fill(DOCS.reginaPassport.issuer)
  await w.setExpiry(page, DOCS.reginaPassport.expiry)
  // No collision, so the list is unchanged: Stored copy is unclear has nothing to link to.
  await expect.poll(() => w.optionsOf(page, REASON)).toEqual(w.NO_COLLISION_REASONS)
  await page.getByLabel(REASON).selectOption({ label: 'Customer presented a different document' })
  await w.captureSide(page, 'front')
  await finishAsRegina(12000)

  const history = await sql`
    select t.transaction_ref, idv.document_type::text as document_type, idv.document_number,
           idv.new_capture_reason, idv.prior_verification_id is not null as linked
      from ttr.id_verifications idv
      join ttr.transactions t on t.id = idv.transaction_id
      join ttr.parties p on p.id = idv.party_id
     where p.last_name ilike 'Testworth' order by idv.created_at`
  expect(history).toEqual([
    { transaction_ref: 'REG-001', document_type: 'Driver licence', document_number: 'RGN-111222', new_capture_reason: null, linked: false },
    { transaction_ref: 'REG-002', document_type: 'Driver licence', document_number: 'RGN-111222', new_capture_reason: 'stored_copy_unclear', linked: true },
    { transaction_ref: 'REG-004', document_type: 'Passport', document_number: 'PRG-998877', new_capture_reason: 'different_document', linked: false },
  ])
  expect(await copiesPerDocument()).toEqual([
    { document_number: 'PRG-998877', unlinked_copies: 1, total_rows: 1 },
    { document_number: 'RGN-111222', unlinked_copies: 1, total_rows: 2 },
  ])
})

test('R21 — renewed licence, unchanged number', async () => {
  await startForRegina('REG-005')
  await w.setVerificationMethod(page, 'Sighted original document')
  await w.enterDocument(page, DOCS.reginaLicence)
  await expect.poll(() => w.optionsOf(page, REASON)).toEqual(w.SAME_PERSON_COLLISION_REASONS)
  await page.getByLabel(REASON).selectOption({ label: 'ID has changed (e.g. renewed licence)' })

  // Finding #11's counterexample: a renewal must not inherit the old expiry.
  const expiryRadios = w.field(page, 'Is there an expiry date?').getByRole('radio')
  await expect(expiryRadios.nth(0)).not.toBeChecked()
  await expect(expiryRadios.nth(1)).not.toBeChecked()
  await w.setExpiry(page, '2035-05-12')
  await w.captureSide(page, 'front')
  await w.captureSide(page, 'back')
  await finishAsRegina(13000)

  const rows = await sql`
    select t.transaction_ref, idv.new_capture_reason, idv.prior_verification_id is not null as linked,
           idv.expiry_date::text as expiry_date
      from ttr.id_verifications idv join ttr.transactions t on t.id = idv.transaction_id
     where upper(btrim(idv.document_number)) = 'RGN-111222' order by idv.created_at`
  expect(rows).toEqual([
    { transaction_ref: 'REG-001', new_capture_reason: null, linked: false, expiry_date: '2030-05-12' },
    { transaction_ref: 'REG-002', new_capture_reason: 'stored_copy_unclear', linked: true, expiry_date: '2030-05-12' },
    { transaction_ref: 'REG-005', new_capture_reason: 'id_changed', linked: true, expiry_date: '2035-05-12' },
  ])
  expect((await copiesPerDocument()).find((r) => r.document_number === 'RGN-111222')).toEqual({
    document_number: 'RGN-111222',
    unlinked_copies: 1,
    total_rows: 3,
  })
})

// R20's "two documents, one copy each" query.
const copiesPerDocument = () => sql`
  select idv.document_number,
         (count(*) filter (where idv.prior_verification_id is null))::int as unlinked_copies,
         count(*)::int as total_rows
    from ttr.id_verifications idv join ttr.parties p on p.id = idv.party_id
   where p.last_name ilike 'Testworth' group by 1 order by 1`

// Wilma Wholesale with Colin Broker conducting, as far as Colin's ID Verification.
const wilmaWithColin = async (ref, { existing }) => {
  await w.startTransaction(page, { scenario: 'Sell bullion to customer', ref })
  if (existing) await w.addExistingCompany(page, WILMA)
  else await w.createCustomer(page, WILMA)
  await w.clickContinue(page)
  await w.fillCash(page, 15000)
  await w.fillCompanyDetails(page, WILMA)
  await w.fillConductingPerson(page, COLIN, { representing: WILMA.entityName })
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/id-verification$/)
}

test('R22 ⚠ critical — the same conducting person, twice', async () => {
  await wilmaWithColin('REG-006', { existing: false })

  // The DOB-known read path (fixes #4/#5): back to Conducting Person, reloaded from the draft.
  await w.goBack(page)
  await expect(page).toHaveURL(/\/conducting-person$/)
  await expect(w.field(page, 'Is the date of birth known?').getByRole('radio', { name: 'Yes' })).toBeChecked()
  await expect(page.getByLabel('Date of birth')).toHaveValue(w.dmy(COLIN.dateOfBirth))
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/id-verification$/)

  await w.setVerificationMethod(page, 'Sighted original document')
  await w.enterDocument(page, DOCS.colinPassport)
  await page.getByLabel('Issuer').fill(DOCS.colinPassport.issuer)
  await w.setExpiry(page, DOCS.colinPassport.expiry)
  await w.captureSide(page, 'front')
  await w.clickContinue(page)
  await w.completeTransaction(page)

  await wilmaWithColin('REG-007', { existing: true })
  // Conducting persons have no name lookup, so nothing is pre-selected...
  await expect(page.getByLabel('Verification method')).toHaveValue('')
  // ...and the document collision is their only route to reuse.
  await w.setVerificationMethod(page, 'Sighted original document')
  await w.enterDocument(page, DOCS.colinPassport)
  await expect(page.getByText(`Passport ${DOCS.colinPassport.number} is already on file`)).toBeVisible()
  await expect.poll(() => w.optionsOf(page, REASON)).toContain('Stored copy is unclear')
  await page.getByLabel(REASON).selectOption({ label: 'Stored copy is unclear' })
  await w.captureSide(page, 'front')
  await w.clickContinue(page)
  await w.completeTransaction(page)

  const rows = await sql`
    select verification_basis, new_capture_reason, prior_verification_id is not null as linked,
           party_id is null as is_conducting_person
      from ttr.id_verifications where document_number = ${DOCS.colinPassport.number} order by created_at`
  expect(rows).toEqual([
    { verification_basis: 'new_capture', new_capture_reason: null, linked: false, is_conducting_person: true },
    { verification_basis: 'new_capture', new_capture_reason: 'stored_copy_unclear', linked: true, is_conducting_person: true },
  ])
})

test('R23 — re-verification window has lapsed', async () => {
  const [{ applied }] = await sql`
    select pg_get_constraintdef(oid) like '%original_document_resighted%' as applied
      from pg_constraint where conname = 'chk_idv_reliance_reason_values'`
  expect(applied).toBe(true)

  // -1, not 0: records here are created the same day, and 0 > 0 blocks nothing.
  await sql`update public.reporting_entities set idv_max_reliance_days = -1`
  try {
    await startForRegina('REG-008')
    await expect(page.getByLabel('Verification method')).toHaveValue('')
    await w.setVerificationMethod(page, 'Relied on prior identification')
    const priors = page.getByRole('button', { name: /Verified .* by UAT Admin/ })
    await expect(priors.first()).toBeVisible()
    for (const prior of await priors.all()) await expect(prior).toContainText('✕ Blocked')

    await page.getByRole('button', { name: new RegExp(`^Driver licence · ${DOCS.reginaLicence.number}`) }).click()
    expect(await w.optionsOf(page, 'Reason for reliance')).toEqual(['Original document re-sighted today', 'Manager approved reliance'])
    await expect(page.getByText(/past the -1-day re-verification window.*no second copy is taken/)).toBeVisible()
    await page.getByLabel('Reason for reliance').selectOption({ label: 'Original document re-sighted today' })
    await page.getByLabel('I confirm the person presenting today matches these ID images').check()
    await finishAsRegina(10200)
  } finally {
    await sql`update public.reporting_entities set idv_max_reliance_days = 730`
  }

  const rows = await sql`
    select t.transaction_ref, idv.verification_basis::text as verification_basis, idv.reliance_reason,
           idv.new_capture_reason, idv.front_image_id is not null as has_front, idv.back_image_id is not null as has_back
      from ttr.id_verifications idv join ttr.transactions t on t.id = idv.transaction_id
     where t.transaction_ref = 'REG-008'`
  // Both image flags false: "no second copy is taken", made checkable.
  expect(rows).toEqual([
    {
      transaction_ref: 'REG-008',
      verification_basis: 'relied_on_prior_identification',
      reliance_reason: 'original_document_resighted',
      new_capture_reason: null,
      has_front: false,
      has_back: false,
    },
  ])
})
