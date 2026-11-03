// Gold Phase 9a UAT, section I (case A) of docs/uat-gold-09a-ttr-handoff.md: the TTR wizard picks up a TTR that
// gold-start-ttr wrote for a returning customer with everything on file. The admin is signed in through the real
// login; the TTR is made with gold-save-purchase and gold-start-ttr for the admin's business, then opened in the
// wizard at /open-ttr/<id>.
import { expect, test } from '@playwright/test'
import { sql } from '../support/db.js'
import * as w from '../support/wizard.js'
import { invoice, openAdmin, person, startedScrap, ttrRow } from './wizard-support.js'

let context
let page
test.beforeAll(async ({ browser }) => {
  ;({ context } = await openAdmin(browser))
})
test.afterAll(async () => {
  await context.close()
})
test.beforeEach(async () => {
  // A new tab per test: sessionStorage (the wizard's own state) starts empty, the sign-in (localStorage) stays.
  page = await context.newPage()
  await page.goto('/')
})
test.afterEach(async () => {
  await page.close()
})

// The local date and time the browser shows for an instant, as a datetime-local value.
const localValue = (iso) =>
  page.evaluate((s) => new Date(s).toLocaleString('sv-SE').slice(0, 16).replace(' ', 'T'), iso)

test.describe('I · opening a case A TTR', () => {
  test('9.38 ⚠ — /open-ttr/<id> lands on Transaction Details (Step 3) with the invoice as reference, the scenario, the sale time and the cash', async () => {
    const { ttrId, number, purchaseId } = await startedScrap(page, { amount: '12000' })
    await page.goto(`/open-ttr/${ttrId}`)
    await expect(page).toHaveURL(/\/transaction-details$/)
    await expect(page.getByText('Step 3', { exact: true })).toBeVisible()
    await expect(page.locator('#transactionRef')).toHaveValue(number)
    await expect(page.getByText('Buy precious metal from customer').first()).toBeVisible()
    const [{ created_at: createdAt }] = await sql`select created_at from gold.purchases where id = ${purchaseId}`
    await expect(page.locator('#dateTime')).toHaveValue(await localValue(createdAt.toISOString()))
    await expect(page.getByLabel('Cash amount')).toHaveValue(/^12000(\.00)?$/)
  })

  test('9.47 — Continue on Transaction Details with nothing else changed leaves the sale time as it was (to the minute: not shifted by the time zone)', async () => {
    const { ttrId, purchaseId } = await startedScrap(page)
    await page.goto(`/open-ttr/${ttrId}`)
    await expect(page).toHaveURL(/\/transaction-details$/)
    // D2: the cash is not shown, so it is typed here; this row is about the time, which is left alone.
    if ((await page.getByLabel('Cash amount').inputValue()) === '') await page.getByLabel('Cash amount').fill('12000')
    await w.clickContinue(page)
    await expect(page).toHaveURL(/\/party-details$/)
    const [row] = await sql`
      select t.transaction_datetime as saved, p.created_at as sold from ttr.transactions t, gold.purchases p
      where t.id = ${ttrId} and p.id = ${purchaseId}`
    const minute = (d) => Math.floor(d.getTime() / 60_000)
    expect(minute(row.saved)).toBe(minute(row.sold))
  })

  const throughReview = async ({ ttrId, number }) => {
    await expect(page).toHaveURL(/\/party-details$/)
    await expect(page.getByText('Step 4', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Occupation or principal activity')).toHaveValue('Jeweller')
    await w.clickContinue(page)

    await expect(page).toHaveURL(/\/review$/)
    await expect(page.getByText(`From gold purchase(s) on invoice ${number}`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Complete / Reportable' })).toBeEnabled()
    await w.completeTransaction(page)
    await expect(page.getByText(number).first()).toBeVisible()
    expect((await ttrRow(ttrId)).status).toBe('complete')
  }

  test('9.39 ⚠ — case A: Continue with the cash as shown, Party Details already complete, Review shows the gold source, and Complete / Reportable completes the TTR', async () => {
    const started = await startedScrap(page)
    await page.goto(`/open-ttr/${started.ttrId}`)
    await expect(page).toHaveURL(/\/transaction-details$/)
    await w.clickContinue(page) // the cash is already on the page
    await throughReview(started)
  })

  test('9.69 (added by UAT, spec 3.3 "fully prefilled") — case A with the cash typed on Transaction Details: Party Details complete, Review shows the gold source, the TTR completes', async () => {
    const started = await startedScrap(page)
    await page.goto(`/open-ttr/${started.ttrId}`)
    await w.fillCash(page, 12000)
    await throughReview(started)
  })

  test('9.40 ⚠ — ID Verification shows the relied-on record and the counter confirmation, has no match tick, and Continue saves without it', async () => {
    const { ttrId } = await startedScrap(page)
    await page.goto(`/open-ttr/${ttrId}`)
    await expect(page).toHaveURL(/\/transaction-details$/)
    await w.goBack(page)
    await expect(page).toHaveURL(/\/id-verification$/)
    await expect(page.getByText('Step 2', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Verification method')).toHaveValue('Relied on prior identification')
    await expect(page.getByText(/ID sighted and matched to this record at the counter on/)).toBeVisible()
    await expect(page.getByLabel('I confirm the person presenting today matches these ID images')).toHaveCount(0)
    await w.clickContinue(page)
    await expect(page).toHaveURL(/\/transaction-details$/)
  })

  test('9.40 ⚠ (control) — a reliance row on a TTR started in the wizard still shows the match tick and refuses Continue without it', async () => {
    const jane = await person()
    await w.startTransaction(page, { scenario: 'Buy precious metal from customer', ref: invoice('CTRL') })
    await w.addExistingIndividual(page, { firstName: 'Jane', lastName: jane.last, dateOfBirth: '1980-01-01', fullName: `Jane ${jane.last}` })
    await w.confirmOwnBehalf(page, `Jane ${jane.last}`)
    await expect(page.getByLabel('Verification method')).toHaveValue('Relied on prior identification')
    await expect(page.getByLabel('I confirm the person presenting today matches these ID images')).toBeVisible()
    await w.clickContinue(page)
    await expect(page.getByText('Confirm the ID images match the person present')).toBeVisible()
    await expect(page).toHaveURL(/\/id-verification$/)
  })
})
