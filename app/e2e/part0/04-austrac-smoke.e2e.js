// UAT matrix Part 0 — AUSTRAC smoke test (R24–R26).
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { signedInContext } from '../support/auth.js'
import { REGINA } from '../support/cast.js'
import { reportDateOf, sql } from '../support/db.js'
import { repoRoot } from '../support/env.js'
import * as w from '../support/wizard.js'

test.describe.configure({ mode: 'serial' })

let batch

// R13 already made this day's batch, and report_batches allows one per entity per day
// (UNIQUE (reporting_entity_id, report_date)), so a second generator call is refused.
// Regenerate is the supported way to rebuild it from every completed transaction that day.
test('R24 — a batch is produced covering the completed transactions', async ({ browser }) => {
  const reportDate = await reportDateOf('REG-002')
  const expected = (
    await sql`
      select t.transaction_ref from ttr.transactions t
       where t.status = 'complete'
         and to_char(t.completed_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD') = ${reportDate}
       order by 1`
  ).map((r) => r.transaction_ref)
  expect(expected).toEqual(expect.arrayContaining(['REG-001', 'REG-002', 'REG-004', 'REG-006']))

  const [previous] = await sql`select id, approval_token from ttr.report_batches where report_date = ${reportDate}`
  const context = await signedInContext(browser, 'admin')
  const page = await context.newPage()
  await page.goto(`/review-batch/${previous.id}?token=${previous.approval_token}`)
  await page.getByRole('button', { name: 'Regenerate' }).click()
  await expect(page).toHaveURL(/\/review-batch\/[^?]+\?token=/)
  await expect(page).not.toHaveURL(new RegExp(previous.id))
  await context.close()

  ;[batch] = await sql`
    select b.id, b.xml_content, b.transaction_count from ttr.report_batches b where b.report_date = ${reportDate}`
  const covered = (
    await sql`
      select t.transaction_ref from ttr.transaction_reports tr join ttr.transactions t on t.id = tr.transaction_id
       where tr.batch_id = ${batch.id} order by 1`
  ).map((r) => r.transaction_ref)
  expect(covered).toEqual(expected)

  const ttrCount = (batch.xml_content.match(/<ttr /g) ?? []).length
  expect(batch.xml_content).toContain(`<reportCount>${ttrCount}</reportCount>`)
  expect(ttrCount).toBe(batch.transaction_count)
})

test('R25 — the batch is valid under XSD 1.1, and the check is not vacuous', async ({}, testInfo) => {
  const file = testInfo.outputPath('batch.xml')
  writeFileSync(file, batch.xml_content)
  const python = process.env.PYTHON ?? 'python'
  let output
  try {
    output = execFileSync(python, [path.join(repoRoot, 'scripts', 'validate_ttr_xml.py'), file], { encoding: 'utf8' })
  } catch (err) {
    throw new Error(`validate_ttr_xml.py failed:\n${err.stdout ?? ''}${err.stderr ?? err.message}`, { cause: err })
  }
  await testInfo.attach('validator output', { body: output, contentType: 'text/plain' })
  expect(output).toContain('XMLSchema11 1.1: 0 error(s)')
  expect(output).toContain('control 1 (digit-led ttr id): 1 error(s)')
  expect(output).toContain('control 2 (trust without isExpressTrust): 1 error(s)')
})

test('R26 — the ordinary reliance path still works', async ({ browser }) => {
  // Left at R23's value, nothing auto-selects and this case silently tests nothing.
  const [{ idv_max_reliance_days: window }] = await sql`select idv_max_reliance_days from public.reporting_entities`
  expect(window).toBe(730)

  const context = await signedInContext(browser, 'admin')
  const page = await context.newPage()
  await w.startTransaction(page, { scenario: 'Sell bullion to customer', ref: 'REG-009' })
  await w.addExistingIndividual(page, REGINA)
  await w.confirmOwnBehalf(page, REGINA.fullName)

  // Change nothing: reliance and its reason are pre-selected, with no camera and no capture reason.
  await expect(page.getByLabel('Verification method')).toHaveValue('Relied on prior identification')
  await expect(page.getByLabel('Reason for reliance')).toHaveValue('prior_id_reviewed_still_valid')
  await expect(page.getByRole('img', { name: 'Front of ID' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start camera for front' })).toHaveCount(0)
  await expect(page.getByLabel('Reason for taking a new copy')).toHaveCount(0)
  const reliedOn = await page.getByLabel('Document or reference number').inputValue()
  const unlinkedBefore = await unlinkedCopies(reliedOn)

  // Continue is blocked until the image match is confirmed.
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/id-verification$/)
  await page.getByLabel('I confirm the person presenting today matches these ID images').check()
  await w.clickContinue(page)
  await w.fillCash(page, 10000)
  await w.fillIndividualDetails(page, REGINA)
  await w.completeTransaction(page)
  await context.close()

  const rows = await sql`
    select idv.document_number, idv.verification_basis::text as verification_basis, idv.reliance_reason,
           idv.new_capture_reason, idv.prior_verification_id is not null as linked, idv.front_image_id is not null as has_front
      from ttr.id_verifications idv join ttr.transactions t on t.id = idv.transaction_id
     where t.transaction_ref = 'REG-009'`
  expect(rows).toEqual([
    {
      document_number: reliedOn,
      verification_basis: 'relied_on_prior_identification',
      reliance_reason: 'prior_id_reviewed_still_valid',
      new_capture_reason: null,
      linked: true,
      has_front: false,
    },
  ])
  // Reliance rows sit outside uq_idv_doc_new_capture, so the unlinked copy count is unchanged.
  expect(await unlinkedCopies(reliedOn)).toBe(unlinkedBefore)
  expect(unlinkedBefore).toBe(1)
})

const unlinkedCopies = async (documentNumber) =>
  (
    await sql`
      select (count(*) filter (where idv.prior_verification_id is null))::int as n
        from ttr.id_verifications idv join ttr.parties p on p.id = idv.party_id
       where p.last_name ilike 'Testworth' and idv.document_number = ${documentNumber}`
  )[0].n
