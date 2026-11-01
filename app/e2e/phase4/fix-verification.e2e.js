// UAT matrix Phase 4 — fix verification (F1–F12), on a clean dataset (F0 is the db reset
// in `npm run uat:phase4`). F4 is pgTAP (supabase/tests/database/recapture_link.test.sql).
// Recipient & Delivery and Bullion Details are skipped: ITEM_AND_DELIVERY_CAPTURE_ENABLED is off.
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { signedInContext } from '../support/auth.js'
import { BARRY, COLIN, DOCS, REGINA, WILMA } from '../support/cast.js'
import { deleteObject, invokeFunction, objectExists, putObject, reportDateOf, sql, transactionId } from '../support/db.js'
import { repoRoot } from '../support/env.js'
import * as w from '../support/wizard.js'

test.describe.configure({ mode: 'serial' })

const REASON = 'Reason for taking a new copy'
// Barry's own licence, for the drafts F10, F11 and the stale-draft check abandon.
const BARRY_LICENCE = { type: 'Driver licence', number: 'BRY-776655', issuer: 'VicRoads', country: 'AU' }
const OWNER = `already on file for ${REGINA.fullName} (DOB ${w.dmy(REGINA.dateOfBirth)})`

let context
let page

test.beforeAll(async ({ browser }) => {
  context = await signedInContext(browser, 'admin')
  page = await context.newPage()
})

test.afterAll(async () => {
  await context.close()
})

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

// Barry as a new customer, at ID Verification with a fresh capture of the given document.
const barryCapture = async (ref, doc, reason) => {
  await w.startTransaction(page, { scenario: 'Buy bullion from customer', ref })
  await w.createCustomer(page, BARRY)
  await w.confirmOwnBehalf(page, BARRY.fullName)
  await w.setVerificationMethod(page, 'Sighted original document')
  await w.enterDocument(page, doc)
  await page.getByLabel('Issuer').fill(doc.issuer)
  await w.setExpiry(page, null)
  if (reason) {
    await expect.poll(() => w.optionsOf(page, REASON)).toContain(reason)
    await page.getByLabel(REASON).selectOption({ label: reason })
  }
  await w.captureSide(page, 'front')
  await w.captureSide(page, 'back')
}

const imagesOf = (ref) => sql`
  select si.id, si.object_path, si.superseded_at is not null as superseded, si.content_hash_sha256 is not null as hash_retained
    from ttr.stored_images si join ttr.transactions t on t.id = si.transaction_id
   where t.transaction_ref = ${ref} order by si.captured_at`

test('F1 — first-time capture (control, and the #9/#11 baseline)', async () => {
  await w.startTransaction(page, { scenario: 'Sell bullion to customer', ref: 'FIX-001' })
  await w.createCustomer(page, REGINA)
  await w.confirmOwnBehalf(page, REGINA.fullName)
  await w.setVerificationMethod(page, 'Sighted original document')
  await w.enterDocument(page, DOCS.reginaLicence)
  await page.getByLabel('Issuer').fill(DOCS.reginaLicence.issuer)
  await w.setExpiry(page, DOCS.reginaLicence.expiry)
  await expect(page.getByLabel(REASON)).toHaveCount(0)
  await w.captureSide(page, 'front')
  await w.captureSide(page, 'back')
  await finishAsRegina(14000)
  expect(await imagesOf('FIX-001')).toHaveLength(2)
})

test('F2 ⚠ — same document re-captured: #11 pre-fill, #9 supersede', async () => {
  await startForRegina('FIX-002', 'Buy bullion from customer')
  await w.setVerificationMethod(page, 'Sighted original document')
  await expect(page.getByLabel('Document or reference number')).toHaveValue('')
  await w.enterDocument(page, DOCS.reginaLicence)
  await expect.poll(() => w.optionsOf(page, REASON)).toEqual(w.SAME_PERSON_COLLISION_REASONS)
  await expect(page.getByText(OWNER)).toBeVisible()
  await page.getByLabel(REASON).selectOption({ label: 'Stored copy is unclear' })
  await expect(w.field(page, 'Is there an expiry date?').getByRole('radio', { name: 'Yes' })).toBeChecked()
  await expect(page.getByLabel('Expiry date')).toHaveValue(w.dmy(DOCS.reginaLicence.expiry))
  await w.captureSide(page, 'front')
  await w.captureSide(page, 'back')
  await finishAsRegina(11000)

  // #9: FIX-001's rows are kept with their hash; only the objects go.
  const fix001 = await imagesOf('FIX-001')
  expect(fix001.map(({ superseded, hash_retained }) => ({ superseded, hash_retained }))).toEqual([
    { superseded: true, hash_retained: true },
    { superseded: true, hash_retained: true },
  ])
  for (const image of fix001) expect(await objectExists(image.object_path), image.object_path).toBe(false)
  for (const image of await imagesOf('FIX-002')) {
    expect(image).toMatchObject({ superseded: false, hash_retained: true })
    expect(await objectExists(image.object_path)).toBe(true)
  }

  // #11: both rows agree on the expiry.
  const expiries = await sql`
    select t.transaction_ref, idv.new_capture_reason, idv.expiry_date::text as expiry_date
      from ttr.id_verifications idv join ttr.transactions t on t.id = idv.transaction_id
     where upper(btrim(idv.document_number)) = ${DOCS.reginaLicence.number} order by idv.created_at`
  expect(expiries).toEqual([
    { transaction_ref: 'FIX-001', new_capture_reason: null, expiry_date: '2030-05-12' },
    { transaction_ref: 'FIX-002', new_capture_reason: 'stored_copy_unclear', expiry_date: '2030-05-12' },
  ])
})

test('F3 ⚠ critical — #8, a different person cannot link', async () => {
  await w.startTransaction(page, { scenario: 'Buy bullion from customer', ref: 'FIX-003' })
  await w.createCustomer(page, BARRY)
  await w.confirmOwnBehalf(page, BARRY.fullName)
  await w.setVerificationMethod(page, 'Sighted original document')
  await w.enterDocument(page, DOCS.reginaLicence)
  // Exactly one exit. ID has changed / Stored copy is unclear here would be #8 unfixed.
  await expect.poll(() => w.optionsOf(page, REASON)).toEqual(['Different person who shares this document number'])
  await expect(page.getByText(OWNER)).toBeVisible()
  await page.getByLabel(REASON).selectOption({ label: 'Different person who shares this document number' })
  await page.getByLabel('Issuer').fill(DOCS.reginaLicence.issuer)
  await w.setExpiry(page, null)
  await w.captureSide(page, 'front')
  await w.captureSide(page, 'back')
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/transaction-details$/)

  const rows = await sql`
    select p.last_name, idv.new_capture_reason, idv.prior_verification_id is not null as linked
      from ttr.id_verifications idv join ttr.parties p on p.id = idv.party_id
     where upper(btrim(idv.document_number)) = ${DOCS.reginaLicence.number} and p.last_name = ${BARRY.lastName}`
  expect(rows).toEqual([{ last_name: BARRY.lastName, new_capture_reason: 'different_person', linked: false }])
  await w.abandonTransaction(page)
})

test('F5 — #11 counterexample: a renewal does not inherit the expiry', async () => {
  await startForRegina('FIX-004')
  await w.setVerificationMethod(page, 'Sighted original document')
  await w.enterDocument(page, DOCS.reginaLicence)
  await expect.poll(() => w.optionsOf(page, REASON)).toEqual(w.SAME_PERSON_COLLISION_REASONS)
  await page.getByLabel(REASON).selectOption({ label: 'ID has changed (e.g. renewed licence)' })
  const expiryRadios = w.field(page, 'Is there an expiry date?').getByRole('radio')
  await expect(expiryRadios.nth(0)).not.toBeChecked()
  await expect(expiryRadios.nth(1)).not.toBeChecked()
  await w.setExpiry(page, '2035-05-12')
  await w.captureSide(page, 'front')
  await w.captureSide(page, 'back')
  await finishAsRegina(13000)

  // FIX-002's pair is superseded in turn, leaving FIX-004's as the only live one.
  expect((await imagesOf('FIX-002')).every((i) => i.superseded)).toBe(true)
  expect((await imagesOf('FIX-004')).every((i) => !i.superseded)).toBe(true)
})

test('F6 — #10, the conducting person’s date of birth', async () => {
  await w.startTransaction(page, { scenario: 'Sell bullion to customer', ref: 'FIX-005' })
  await w.createCustomer(page, WILMA)
  await w.clickContinue(page)
  await w.fillCash(page, 15000)
  await w.fillCompanyDetails(page, WILMA)
  await w.fillConductingPerson(page, COLIN, { representing: WILMA.entityName, dateOfBirth: null })

  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await w.clickContinue(page)
  await expect(page.getByText('Enter the date of birth, or set "Is date of birth known?" to No.')).toBeVisible()
  await expect(page).toHaveURL(/\/conducting-person$/)
  page.removeAllListeners('pageerror')
  page.removeAllListeners('console')
  expect(errors).toEqual([])

  await page.getByLabel('Date of birth').fill(w.dmy(COLIN.dateOfBirth))
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/id-verification$/)
  // The #4/#5 read path: reloaded from the draft, both answers survive.
  await w.goBack(page)
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
})

test('F7 — regression: the ordinary reliance path is untouched', async () => {
  await startForRegina('FIX-006')
  await expect(page.getByLabel('Verification method')).toHaveValue('Relied on prior identification')
  await expect(page.getByLabel('Reason for reliance')).toHaveValue('prior_id_reviewed_still_valid')
  await expect(page.getByLabel(REASON)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start camera for front' })).toHaveCount(0)
  // The thumbnails must be FIX-004's surviving pair, not dead links to superseded objects.
  await expect(page.getByText('Transaction: FIX-004')).toBeVisible()
  for (const name of ['Front of ID', 'Back of ID']) {
    const img = page.getByRole('img', { name, exact: true })
    await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth)).toBeGreaterThan(0)
  }
  await page.getByLabel('I confirm the person presenting today matches these ID images').check()
  await finishAsRegina(10000)
})

test('F8 — final state, all four findings at once; the XML is still valid', async ({}, testInfo) => {
  const live = await sql`
    select idv.document_type::text as document_type, upper(btrim(idv.document_number)) as doc,
           (count(*) filter (where si.superseded_at is null))::int as live_images, count(*)::int as total_image_rows
      from ttr.id_verifications idv join ttr.stored_images si on si.id in (idv.front_image_id, idv.back_image_id)
     group by 1, 2 order by 2`
  expect(live).toEqual([
    { document_type: 'Passport', doc: 'CLB-334455', live_images: 1, total_image_rows: 1 },
    { document_type: 'Driver licence', doc: 'RGN-111222', live_images: 2, total_image_rows: 6 },
  ])

  const picture = await sql`
    select t.transaction_ref, p.last_name, idv.new_capture_reason, idv.reliance_reason,
           idv.prior_verification_id is not null as linked, idv.expiry_date::text as expiry_date
      from ttr.id_verifications idv join ttr.transactions t on t.id = idv.transaction_id
      left join ttr.parties p on p.id = idv.party_id
     where upper(btrim(idv.document_number)) = ${DOCS.reginaLicence.number} order by idv.created_at`
  expect(picture.map(({ expiry_date, ...rest }) => (rest.reliance_reason ? rest : { ...rest, expiry_date }))).toEqual([
    { transaction_ref: 'FIX-001', last_name: 'Testworth', new_capture_reason: null, reliance_reason: null, linked: false, expiry_date: '2030-05-12' },
    { transaction_ref: 'FIX-002', last_name: 'Testworth', new_capture_reason: 'stored_copy_unclear', reliance_reason: null, linked: true, expiry_date: '2030-05-12' },
    { transaction_ref: 'FIX-004', last_name: 'Testworth', new_capture_reason: 'id_changed', reliance_reason: null, linked: true, expiry_date: '2035-05-12' },
    { transaction_ref: 'FIX-006', last_name: 'Testworth', new_capture_reason: null, reliance_reason: 'prior_id_reviewed_still_valid', linked: true },
  ])

  // R24/R25 again for the FIX- date: #9 and #11 change what the generator reads.
  const reportDate = await reportDateOf('FIX-001')
  const res = await invokeFunction('generate-austrac-report', { reportDate })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  const [{ xml_content: xml }] = await sql`select xml_content from ttr.report_batches where report_date = ${reportDate}`
  const file = testInfo.outputPath('batch.xml')
  writeFileSync(file, xml)
  let output
  try {
    output = execFileSync(process.env.PYTHON ?? 'python', [path.join(repoRoot, 'scripts', 'validate_ttr_xml.py'), file], { encoding: 'utf8' })
  } catch (err) {
    throw new Error(`validate_ttr_xml.py failed:\n${err.stdout ?? ''}${err.stderr ?? err.message}`, { cause: err })
  }
  expect(output).toContain('XMLSchema11 1.1: 0 error(s)')
})

test('F9 — entry order no longer matters (#14)', async () => {
  await startForRegina('FIX-008')
  await w.setVerificationMethod(page, 'Sighted original document')
  // Number first, then type: the lookup also runs from the type dropdown.
  await page.getByLabel('Document or reference number').fill(DOCS.reginaLicence.number)
  await page.getByLabel('Document or reference number').blur()
  await page.getByLabel('Document or data-source type').selectOption(DOCS.reginaLicence.type)
  await expect.poll(() => w.optionsOf(page, REASON)).toEqual(w.SAME_PERSON_COLLISION_REASONS)
  await expect(page.getByText(OWNER)).toBeVisible()
  await w.abandonTransaction(page)
  expect(await transactionId('FIX-008')).toBeUndefined()
})

test('F10 ⚠ critical — a failed save can be retried (#12)', async () => {
  await barryCapture('FIX-009', BARRY_LICENCE)
  let uploads = 0
  page.on('request', (r) => r.url().includes('/functions/v1/upload-id-image') && uploads++)

  // The photos upload, then the database save drops: the case that used to be terminal.
  let failed = false
  await page.route('**/rest/v1/id_verifications*', (route) => {
    const write = ['POST', 'PATCH'].includes(route.request().method())
    if (write && !failed) {
      failed = true
      return route.abort('connectionreset')
    }
    return route.fallback()
  })
  await w.clickContinue(page)
  await expect.poll(() => failed).toBe(true)
  await expect(page).toHaveURL(/\/id-verification$/)
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()

  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/transaction-details$/)
  await expect(page.getByText(/already exists/)).toHaveCount(0)
  await page.unroute('**/rest/v1/id_verifications*')
  page.removeAllListeners('request')

  expect(uploads).toBe(2)
  const [{ n }] = await sql`select count(*)::int as n from ttr.stored_images where transaction_id = ${await transactionId('FIX-009')}`
  expect(n).toBe(2)
  await w.abandonTransaction(page)
})

test('F11 — Cancel works on a draft holding ID photos (#13)', async () => {
  await barryCapture('FIX-010', BARRY_LICENCE)
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/transaction-details$/)
  const id = await transactionId('FIX-010')
  const paths = (await sql`select object_path from ttr.stored_images where transaction_id = ${id}`).map((r) => r.object_path)
  expect(paths).toHaveLength(2)

  await w.abandonTransaction(page)
  await expect(page.getByText(/Failed to delete/)).toHaveCount(0)
  const [counts] = await sql`
    select (select count(*)::int from ttr.transactions where id = ${id}) as transactions,
           (select count(*)::int from ttr.stored_images where transaction_id = ${id}) as images,
           (select count(*)::int from ttr.id_verifications where transaction_id = ${id}) as verifications,
           (select count(*)::int from storage.objects where bucket_id = 'compliance-media' and name like ${`${id}/%`}) as objects`
  expect(counts).toEqual({ transactions: 0, images: 0, verifications: 0, objects: 0 })
})

test('F12 ⚠ critical — the reconciliation sweep (#17) spares another person’s images (#15)', async () => {
  // A completed different_person capture for Barry. Drafts are outside the sweep (#20),
  // so F3's cancelled draft could not show this.
  const reginaLive = (await imagesOf('FIX-004')).map((i) => i.id)
  await barryCapture('FIX-007', DOCS.reginaLicence, 'Different person who shares this document number')
  await w.clickContinue(page)
  await w.fillCash(page, 10500)
  await w.fillIndividualDetails(page, BARRY)
  await w.completeTransaction(page)
  const barry = await imagesOf('FIX-007')
  expect(barry.every((i) => !i.superseded)).toBe(true)
  // #15's failure: completing Barry's capture swept Regina's live copy.
  expect((await imagesOf('FIX-004')).every((i) => !i.superseded)).toBe(true)

  // One of each drift class.
  const [unstamped] = await imagesOf('FIX-001') // class 3
  await sql`update ttr.stored_images set superseded_at = null, superseded_by_image_id = null where id = ${unstamped.id}`
  const orphanPath = `${await transactionId('FIX-004')}/orphan-uat.jpg` // class 1
  await putObject(orphanPath)
  // Class 2, from a folder that keeps another object: the sweep only checks rows in
  // folders it can list, and an emptied folder no longer lists.
  const [, reginaBack] = await imagesOf('FIX-004')
  await deleteObject(reginaBack.object_path)
  const strayFolder = randomUUID() // class 4
  await putObject(`${strayFolder}/stray-uat.jpg`)
  const imageRowsBefore = (await sql`select count(*)::int as n from ttr.stored_images`)[0].n

  const dry = await invokeFunction('reconcile-stored-images', { apply: false, full: true })
  expect(dry.status, JSON.stringify(dry.body)).toBe(200)
  const report = dry.body
  expect(report.mode).toBe('dry-run')
  // The dangling folder's file has no row either, so it is also an orphan object.
  expect({ ...report.orphanObjects, paths: [...report.orphanObjects.paths].sort() }).toEqual({
    count: 2,
    paths: [orphanPath, `${strayFolder}/stray-uat.jpg`].sort(),
    deleted: 0,
  })
  expect(report.missingObjects.imageIds).toContain(reginaBack.id)
  expect(report.unsupersededCopies).toEqual({ count: 1, imageIds: [unstamped.id], superseded: 0 })
  expect(report.danglingFolders).toEqual({ count: 1, folders: [strayFolder], deleted: 0 })
  for (const id of [...barry.map((i) => i.id), ...reginaLive]) expect(report.unsupersededCopies.imageIds).not.toContain(id)

  const applied = await invokeFunction('reconcile-stored-images', { apply: true, full: true })
  expect(applied.status, JSON.stringify(applied.body)).toBe(200)
  expect(await objectExists(orphanPath)).toBe(false)
  expect(await objectExists(`${strayFolder}/stray-uat.jpg`)).toBe(false)
  const [restamped] = await sql`select superseded_at is not null as s, superseded_by_image_id is not null as b from ttr.stored_images where id = ${unstamped.id}`
  expect(restamped).toEqual({ s: true, b: true })
  // A missing object is reported, never remediated: the row is the only proof it was sighted.
  expect(applied.body.missingObjects.imageIds).toContain(reginaBack.id)
  const [kept] = await sql`select superseded_at is null as live from ttr.stored_images where id = ${reginaBack.id}`
  expect(kept).toEqual({ live: true })
  for (const image of barry) expect(await objectExists(image.object_path)).toBe(true)
  expect((await imagesOf('FIX-007')).every((i) => !i.superseded)).toBe(true)
  expect((await sql`select count(*)::int as n from ttr.stored_images`)[0].n).toBe(imageRowsBefore)

  const breaches = await sql`
    select coalesce(idv.prior_verification_id, idv.id) as chain_root
      from ttr.id_verifications idv
      join ttr.stored_images si on si.id in (idv.front_image_id, idv.back_image_id)
      join ttr.transactions t on t.id = idv.transaction_id
     where idv.verification_basis = 'new_capture' and t.status = 'complete'
     group by 1 having count(*) filter (where si.superseded_at is null) > 2`
  expect(breaches).toEqual([])
})

test('F12 — a stale draft holding ID photos is deleted, not skipped (#17, #21, #22)', async () => {
  // F12 completed a capture for Barry, so his own licence is now a different document.
  await barryCapture('FIX-011', BARRY_LICENCE, 'Customer presented a different document')
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/transaction-details$/)
  const id = await transactionId('FIX-011')
  await page.goto('/') // leave the draft behind, as an abandoned tab would
  await sql`update ttr.transactions set created_at = now() - interval '31 days' where id = ${id}`

  const res = await invokeFunction('cleanup-stale-drafts')
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  expect(res.body).toMatchObject({ deleted: 1, skipped: 0 })
  expect(await transactionId('FIX-011')).toBeUndefined()
  const [{ n }] = await sql`select count(*)::int as n from storage.objects where bucket_id = 'compliance-media' and name like ${`${id}/%`}`
  expect(n).toBe(0)
})
