// UAT matrix Part 0, Phase 2 — access logging (R11–R15). R16/R17 are pgTAP
// (supabase/tests/database/access_log.test.sql). R11 is the foundation for Phases 2 and 3.
import { expect, test } from '@playwright/test'
import { signedInContext } from '../support/auth.js'
import { DOCS, REGINA } from '../support/cast.js'
import { invokeFunction, reportDateOf, sql, transactionId } from '../support/db.js'
import * as w from '../support/wizard.js'

test.describe.configure({ mode: 'serial' })

let context
let page
let batch

test.beforeAll(async ({ browser }) => {
  context = await signedInContext(browser, 'admin')
  page = await context.newPage()
})

test.afterAll(async () => {
  await context.close()
})

test('R11 + R12 ⚠ critical — foundation transaction; viewing a saved ID image is logged', async () => {
  await w.startTransaction(page, { scenario: 'Sell bullion to customer', ref: 'REG-001' })
  await w.createCustomer(page, REGINA)
  await w.confirmOwnBehalf(page, REGINA.fullName)

  await w.setVerificationMethod(page, 'Sighted original document')
  await w.enterDocument(page, DOCS.reginaLicence)
  await page.getByLabel('Issuer').fill(DOCS.reginaLicence.issuer)
  await w.setExpiry(page, DOCS.reginaLicence.expiry)
  // R11's control for Phase 3: a first-time customer is never asked for a reason.
  await expect(page.getByLabel('Reason for taking a new copy')).toHaveCount(0)
  await w.captureSide(page, 'front')
  await w.captureSide(page, 'back')
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/transaction-details$/)

  // R12: a completed transaction cannot be reopened, so go back to ID Verification now.
  // The saved images reload as freshly signed URLs, and that fetch is what gets logged.
  await w.goBack(page)
  await expect(page).toHaveURL(/\/id-verification$/)
  await expect(page.getByRole('img', { name: 'Front of ID accepted' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Back of ID accepted' })).toBeVisible()
  await w.clickContinue(page)

  await w.fillCash(page, 14000)
  await w.fillIndividualDetails(page, REGINA)
  await w.completeTransaction(page)

  const views = await sql`
    select l.resource_type, l.resource_id, l.detail, l.transaction_id
      from ttr.access_log l
     where l.action = 'view' and l.transaction_id = ${await transactionId('REG-001')}`
  const images = await sql`
    select si.id, si.object_path from ttr.stored_images si
      join ttr.transactions t on t.id = si.transaction_id where t.transaction_ref = 'REG-001'`
  expect(images).toHaveLength(2)
  for (const image of images) {
    expect(views, `a view row for ${image.object_path}`).toContainEqual(
      expect.objectContaining({ resource_type: 'stored_images', resource_id: image.id, detail: image.object_path }),
    )
  }
})

test('R13 — exporting a report is logged', async () => {
  const reportDate = await reportDateOf('REG-001')
  const res = await invokeFunction('generate-austrac-report', { reportDate })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  ;[batch] = await sql`
    select b.id, b.approval_token, b.report_date::text as report_date
      from ttr.report_batches b join ttr.transaction_reports tr on tr.batch_id = b.id
      join ttr.transactions t on t.id = tr.transaction_id where t.transaction_ref = 'REG-001'`
  expect(batch).toBeTruthy()

  await page.goto(`/review-batch/${batch.id}?token=${batch.approval_token}`)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download XML' }).click()
  expect((await download).suggestedFilename()).toBe(`ttr-fbs-${batch.report_date}.xml`)

  const [log] = await sql`
    select action, resource_type, detail from ttr.access_log
     where action = 'export' and resource_id = ${batch.id} order by occurred_at desc limit 1`
  expect(log).toEqual({ action: 'export', resource_type: 'report_batches', detail: `ttr-fbs-${batch.report_date}.xml` })
})

test('R14 ⚠ critical — the XML does not reach the browser on page load', async () => {
  const restBodies = []
  page.on('response', async (r) => {
    if (r.url().includes('/rest/v1/')) restBodies.push(await r.text().catch(() => ''))
  })
  const batchRequest = page.waitForResponse((r) => r.url().includes('/rest/v1/report_batches'))
  await page.goto(`/review-batch/${batch.id}?token=${batch.approval_token}`)
  expect((await batchRequest).ok()).toBe(true)
  await expect(page.getByRole('button', { name: 'Download XML' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  page.removeAllListeners('response')

  expect(restBodies.length).toBeGreaterThan(0)
  for (const body of restBodies) {
    expect(body).not.toContain('xml_content')
    expect(body).not.toContain('<ttr ')
  }

  // It arrives only from approve-batch, and only when Download is clicked.
  const approve = page.waitForResponse((r) => r.url().includes('/functions/v1/approve-batch'))
  await page.getByRole('button', { name: 'Download XML' }).click()
  expect((await (await approve).json()).xmlContent).toContain('<ttr ')
})

test('R15 — without a token the page is view-only, but Download still works and is logged', async () => {
  const exportsBefore = (await sql`select count(*)::int as n from ttr.access_log where action = 'export' and resource_id = ${batch.id}`)[0].n
  await page.goto(`/review-batch/${batch.id}`)
  await expect(page.getByText(/This page is view-only/)).toBeVisible()
  for (const name of [/Approve/, /Reject/, /Regenerate/]) {
    await expect(page.getByRole('button', { name })).toBeDisabled()
  }
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download XML' }).click()
  await download
  await expect
    .poll(async () => (await sql`select count(*)::int as n from ttr.access_log where action = 'export' and resource_id = ${batch.id}`)[0].n)
    .toBe(exportsBefore + 1)
})
