// UAT matrix Part 0 — a completed transaction's reference cannot be re-used (R27).
import { expect, test } from '@playwright/test'
import { signedInContext } from '../support/auth.js'
import { REGINA } from '../support/cast.js'
import { transactionId } from '../support/db.js'
import * as w from '../support/wizard.js'

const COMPLETED_REF_ERROR = 'This reference belongs to a completed transaction and cannot be reused. Enter a different reference.'
const DRAFT_NOTICE = 'Existing draft found — fields pre-filled.'

test('R27 — a completed transaction’s reference cannot be re-used', async ({ browser }) => {
  const context = await signedInContext(browser, 'admin')
  const page = await context.newPage()
  const ref = page.getByLabel('Transaction reference')

  await page.goto('/')
  await ref.fill('REG-001')
  await ref.blur()
  await expect(page.getByText(COMPLETED_REF_ERROR)).toBeVisible()
  await expect(page.getByText(DRAFT_NOTICE)).toHaveCount(0)

  await page.getByRole('radio', { name: 'Sell bullion to customer' }).check()
  await page.getByRole('button', { name: 'Start transaction' }).click()
  await expect(page.getByText(COMPLETED_REF_ERROR)).toBeVisible()
  await expect(page).not.toHaveURL(/\/customers/)

  await ref.fill('REG-001X')
  await ref.blur()
  await expect(page.getByText(COMPLETED_REF_ERROR)).toHaveCount(0)
  await page.getByRole('button', { name: 'Start transaction' }).click()
  await expect(page).toHaveURL(/\/customers$/)

  // Regression: a draft left mid-wizard still resumes. Leave it once its row exists.
  await w.addExistingIndividual(page, REGINA)
  await w.confirmOwnBehalf(page, REGINA.fullName)
  await page.getByLabel('I confirm the person presenting today matches these ID images').check()
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/transaction-details$/)
  await expect.poll(() => transactionId('REG-001X')).toBeTruthy()

  await page.goto('/')
  await ref.fill('REG-001X')
  await ref.blur()
  await expect(page.getByText(DRAFT_NOTICE)).toBeVisible()
  await page.getByRole('button', { name: 'Start transaction' }).click()
  await expect(page).toHaveURL(/\/customers$/)
  await expect(page.getByRole('listitem').filter({ hasText: REGINA.fullName })).toBeVisible()

  await w.abandonTransaction(page)
  expect(await transactionId('REG-001X')).toBeUndefined()
  await context.close()
})
