// UAT matrix Part 1C — one copy of ID on file (TX-K, TX-L, TX-N, TX-O), on Part 1's data.
// Step 0 is the db reset in `npm run uat:part1`; TX-M is TX-I's ID step in 01-transactions;
// K-1–K-11 are pgTAP (supabase/tests/database/idv_uniqueness.test.sql).
// Recipient & Delivery and Bullion / Precious Metal Details are skipped:
// ITEM_AND_DELIVERY_CAPTURE_ENABLED is off.
import { expect, test } from '@playwright/test'
import { signedInContext } from '../support/auth.js'
import { sql } from '../support/db.js'
import { GRACE, JANE, MARCUS, MATRIX_DOCS, SARAH } from '../support/matrix-cast.js'
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

// A returning customer, searched for and added, at ID Verification.
const startReturning = async (person, ref, scenario = 'Sell bullion to customer') => {
  await w.startTransaction(page, { scenario, ref })
  await w.addExistingIndividual(page, person)
  await w.confirmOwnBehalf(page, person.fullName)
}

const finishReturning = async (person, amount) => {
  await w.clickContinue(page)
  await w.fillCash(page, amount)
  await w.confirmCarriedOver(page, person)
  // Not carried over by customer search: see TX-E2 in 01-transactions.
  if (person.postal) await w.fillPostal(page, person.postal)
  await w.clickContinue(page)
  await w.completeTransaction(page)
}

const idRows = (documentNumber) => sql`
  select idv.verification_basis::text as verification_basis, idv.new_capture_reason, idv.reliance_reason,
         idv.prior_verification_id is not null as linked
    from ttr.id_verifications idv
   where upper(btrim(idv.document_number)) = ${documentNumber} order by idv.created_at`

test('TX-K — same document re-captured because the stored copy is unclear', async () => {
  const doc = MATRIX_DOCS.graceNationalId
  await startReturning(GRACE, 'UAT-K-0011', 'Buy bullion from customer')

  // 1. Her TX-H record is inside the window: reliance, and nothing overridden, so no reason.
  await expect(page.getByLabel('Verification method')).toHaveValue('Relied on prior identification')
  await expect(page.getByLabel(REASON)).toHaveCount(0)

  // 2. A fresh capture needs a reason, naming the ID on file.
  await w.setVerificationMethod(page, 'Sighted original document')
  await expect(page.getByText(`This customer already has ID on file (${doc.type} ${doc.number}`)).toBeVisible()

  // 3. Continue is refused without one.
  await w.clickContinue(page)
  await expect(page.getByText('This customer already has ID on file — give a reason for taking a new copy')).toBeVisible()
  await expect(page).toHaveURL(/\/id-verification$/)

  // 4. Stored copy is unclear is offered once the document collides; it links and fills the issuer.
  await w.enterDocument(page, doc)
  await expect.poll(() => w.optionsOf(page, REASON)).toEqual(w.SAME_PERSON_COLLISION_REASONS)
  await page.getByLabel(REASON).selectOption({ label: 'Stored copy is unclear' })
  await expect(page.getByLabel('Issuer')).toHaveValue(doc.issuer)
  await expect(page.getByText('Linked to the copy already on file, so this replaces it rather than adding a second one.')).toBeVisible()

  // 5.
  await w.setExpiry(page, null)
  await w.captureSide(page, 'front')
  await finishReturning(GRACE, 10200)

  // A linked re-capture, not a reliance row.
  expect(await idRows(doc.number)).toEqual([
    { verification_basis: 'new_capture', new_capture_reason: null, reliance_reason: null, linked: false },
    { verification_basis: 'new_capture', new_capture_reason: 'stored_copy_unclear', reliance_reason: null, linked: true },
  ])
})

test('TX-L — a genuinely different document is not linked', async () => {
  const doc = MATRIX_DOCS.sarahPassport
  await startReturning(SARAH, 'UAT-L-0012', 'Sell precious metal to customer')
  await w.setVerificationMethod(page, 'Sighted original document')
  await page.getByLabel(REASON).selectOption({ label: 'ID has changed (e.g. renewed licence)' })
  // Nothing to link to, so nothing is filled in and the fields stay editable.
  await expect(page.getByLabel('Document or data-source type')).toHaveValue('')
  await expect(page.getByLabel('Document or reference number')).toHaveValue('')
  await expect(page.getByLabel('Document or reference number')).toBeEditable()
  await w.enterDocument(page, doc)
  await page.getByLabel('Issuer').fill(doc.issuer)
  await w.setExpiry(page, doc.expiry)
  await w.captureSide(page, 'front')
  await finishReturning(SARAH, 10500)

  expect(await idRows(doc.number)).toEqual([
    { verification_basis: 'new_capture', new_capture_reason: 'id_changed', reliance_reason: null, linked: false },
  ])
  // One copy per document, not one document per person.
  const documents = await sql`
    select idv.document_number
      from ttr.id_verifications idv join ttr.parties p on p.id = idv.party_id
     where p.last_name = ${SARAH.lastName} and idv.verification_basis = 'new_capture' order by idv.created_at`
  expect(documents.map((d) => d.document_number)).toEqual([MATRIX_DOCS.sarahEvs.number, doc.number])
})

test('TX-N — a different document than last time; leaving reliance clears its identifiers', async () => {
  const doc = MATRIX_DOCS.janeLicence
  await startReturning(JANE, 'UAT-N-0013')
  await expect(page.getByLabel('Verification method')).toHaveValue('Relied on prior identification')
  await expect(page.getByLabel('Document or reference number')).toHaveValue(MATRIX_DOCS.janePassport.number)

  // Left in place, these would file a licence photo under the passport's number.
  await w.setVerificationMethod(page, 'Sighted original document')
  await expect(page.getByLabel('Document or data-source type')).toHaveValue('')
  await expect(page.getByLabel('Document or reference number')).toHaveValue('')
  await expect(page.getByLabel('Issuer')).toHaveValue('')

  // A number never seen before: no collision. Other is no longer offered (#16).
  await w.enterDocument(page, doc)
  await expect.poll(() => w.optionsOf(page, REASON)).toEqual(w.NO_COLLISION_REASONS)
  await expect(page.getByText(/is already on file/)).toHaveCount(0)
  await page.getByLabel(REASON).selectOption({ label: 'Customer presented a different document' })
  await page.getByLabel('Issuer').fill(doc.issuer)
  await w.setExpiry(page, null)
  await w.captureSide(page, 'front')
  await w.captureSide(page, 'back')
  await finishReturning(JANE, 10000)

  const documents = await sql`
    select idv.document_type::text as document_type, idv.document_number, idv.new_capture_reason,
           idv.prior_verification_id is not null as linked
      from ttr.id_verifications idv join ttr.parties p on p.id = idv.party_id
     where lower(p.last_name) = 'citizen' and idv.verification_basis = 'new_capture' order by idv.created_at`
  expect(documents).toEqual([
    { document_type: 'Passport', document_number: 'PA1234567', new_capture_reason: null, linked: false },
    { document_type: 'Driver licence', document_number: 'DL111222333', new_capture_reason: 'different_document', linked: false },
  ])
})

test('TX-O — re-verification window has lapsed: re-sighted, no second copy', async () => {
  const doc = MATRIX_DOCS.marcusMedicare
  // -1, not 0: records here are created the same day, and 0 > 0 blocks nothing.
  await sql`update public.reporting_entities set idv_max_reliance_days = -1`
  try {
    await startReturning(MARCUS, 'UAT-O-0014')
    await expect(page.getByLabel('Verification method')).toHaveValue('')
    await w.setVerificationMethod(page, 'Relied on prior identification')
    const prior = page.getByRole('button', { name: new RegExp(`^${doc.type} · ${doc.number}`) })
    await expect(prior).toContainText('✕ Blocked')
    await prior.click()
    expect(await w.optionsOf(page, 'Reason for reliance')).toEqual(['Original document re-sighted today', 'Manager approved reliance'])
    await expect(page.getByText(/past the -1-day re-verification window.*no second copy is taken/)).toBeVisible()
    await page.getByLabel('Reason for reliance').selectOption({ label: 'Original document re-sighted today' })
    await page.getByLabel('I confirm the person presenting today matches these ID images').check()
    await finishReturning(MARCUS, 10000)
  } finally {
    await sql`update public.reporting_entities set idv_max_reliance_days = 730`
  }

  const rows = await sql`
    select idv.verification_basis::text as verification_basis, idv.reliance_reason,
           idv.front_image_id is not null as has_front, idv.back_image_id is not null as has_back
      from ttr.id_verifications idv join ttr.transactions t on t.id = idv.transaction_id
     where t.transaction_ref = 'UAT-O-0014'`
  expect(rows).toEqual([
    { verification_basis: 'relied_on_prior_identification', reliance_reason: 'original_document_resighted', has_front: false, has_back: false },
  ])
  // Still exactly one copy of the card on file.
  expect((await idRows(doc.number)).filter((r) => r.verification_basis === 'new_capture')).toEqual([
    { verification_basis: 'new_capture', new_capture_reason: null, reliance_reason: null, linked: false },
  ])
})
