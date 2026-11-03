// Gold Phase 9a UAT, section J of docs/uat-gold-09a-ttr-handoff.md (spec 7 build-time checks): the wizard pages read
// the database for a gold-started TTR rather than leftovers in the browser session (9.48), and a TTR in progress
// survives an idle sign-out (9.50). 9.49 (no exit goes to `/`) is app/src/__tests__/ttrExitsToStart.uat.test.js.
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { ACCOUNTS, AUTH_DIR, completeMfa, signedInContext, signIn } from '../support/auth.js'
import { sql } from '../support/db.js'
import * as w from '../support/wizard.js'
import { invoice, openAdmin, person, startedScrap } from './wizard-support.js'
import { world } from './support.js'

const BUY_METAL = 'Buy precious metal from customer'

test.describe('J · wizard state', () => {
  let context
  test.beforeAll(async ({ browser }) => {
    ;({ context } = await openAdmin(browser))
  })
  test.afterAll(async () => {
    await context.close()
  })

  test('9.48 ⚠ — a fresh browser session opens a gold-started TTR: every wizard page shows that TTR\'s data, and a second TTR replaces it completely', async () => {
    const page = await context.newPage() // an empty sessionStorage: nothing from an earlier report
    await page.goto('/')
    const a = await startedScrap(page)
    const b = await startedScrap(page)
    const [{ document_number: docA }] = await sql`select document_number from ttr.id_verifications where id = ${a.who.verId}`
    const nameA = `Jane ${a.who.last}`
    const nameB = `Jane ${b.who.last}`
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('ttr.')))).toEqual([])

    await page.goto(`/open-ttr/${a.ttrId}`)
    await expect(page).toHaveURL(/\/transaction-details$/)
    await expect(page.getByText('Step 3', { exact: true })).toBeVisible()
    await expect(page.locator('#transactionRef')).toHaveValue(a.number)
    await expect(page.getByText('Buy precious metal from customer').first()).toBeVisible()

    await page.goto('/customers')
    await expect(page.getByRole('heading', { name: 'Selected for this transaction' })).toBeVisible()
    await expect(page.getByText(nameA).first()).toBeVisible()

    await page.goto('/id-verification')
    await expect(page.getByText('Step 2', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Document or reference number')).toHaveValue(docA)

    await page.goto('/transaction-details')
    await page.getByLabel('Cash amount').fill('12000')
    await w.clickContinue(page)
    await expect(page).toHaveURL(/\/party-details$/)
    await expect(page.getByText('Step 4', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Full legal name')).toHaveValue(nameA)
    await w.clickContinue(page)
    await expect(page).toHaveURL(/\/review$/)
    await expect(page.getByText(`From gold purchase(s) on invoice ${a.number}`)).toBeVisible()
    await expect(page.getByText(nameA).first()).toBeVisible()

    // The second TTR, opened over the first through the warning, replaces every trace of it.
    await page.goto(`/open-ttr/${b.ttrId}`)
    await page.getByRole('button', { name: 'Open this report' }).click()
    await expect(page).toHaveURL(/\/transaction-details$/)
    await expect(page.locator('#transactionRef')).toHaveValue(b.number)
    await page.goto('/customers')
    await expect(page.getByText(nameB).first()).toBeVisible()
    await expect(page.getByText(nameA)).toHaveCount(0)
    await page.goto('/id-verification')
    const [{ document_number: docB }] = await sql`select document_number from ttr.id_verifications where id = ${b.who.verId}`
    await expect(page.getByLabel('Document or reference number')).toHaveValue(docB)
    await page.close()
  })
})

// The idle sign-out revokes the staff member's session on the server, so this uses the plain staff account, which no
// other row uses, and saves the new sign-in over the cached one.
test.describe('J · idle sign-out', () => {
  test('9.50 ⚠ — after the idle sign-out the browser session is cleared and the drafts are not; /open-ttr/<id> (as the login redirect) and /start reopen them', async ({ browser }) => {
    await world()
    const context = await signedInContext(browser, 'staff')
    const page = await context.newPage()
    await page.goto('/')
    const jane = await person()
    const refW = invoice('IDLEW')

    // A TTR started on /start, then a gold-started one opened over it: the gold one is active, both are saved.
    await w.startTransaction(page, { scenario: BUY_METAL, ref: refW })
    await w.addExistingIndividual(page, { firstName: 'Jane', lastName: jane.last, dateOfBirth: '1980-01-01', fullName: `Jane ${jane.last}` })
    await w.confirmOwnBehalf(page, `Jane ${jane.last}`)
    expect(await sql`select 1 from ttr.transactions where transaction_ref = ${refW}`).toHaveLength(1)
    const g = await startedScrap(page)
    await page.goto(`/open-ttr/${g.ttrId}`)
    await page.getByRole('button', { name: 'Open this report' }).click()
    await expect(page).toHaveURL(/\/transaction-details$/)

    // Ten minutes idle: the last activity is eleven minutes old and the next check signs out.
    await page.evaluate(() => {
      localStorage.setItem('ccp.lastActivity', String(Date.now() - 11 * 60 * 1000))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(page).toHaveURL(/\/login/)
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('ttr.')))).toEqual([])
    expect(await sql`select 1 from ttr.transactions where id = ${g.ttrId}`).toHaveLength(1)
    expect(await sql`select 1 from ttr.transactions where transaction_ref = ${refW}`).toHaveLength(1)

    // Signing in again with the redirect reopens the gold-started TTR with its data.
    await signIn(page, ACCOUNTS.staff, { redirect: `/open-ttr/${g.ttrId}` })
    await completeMfa(page, ACCOUNTS.staff)
    await expect(page).toHaveURL(/\/transaction-details$/)
    await expect(page.locator('#transactionRef')).toHaveValue(g.number)
    await context.storageState({ path: path.join(AUTH_DIR, 'staff.json') }) // the old cached session was revoked

    // The wizard-started one reopens from /start by reference and scenario.
    await w.startTransaction(page, { scenario: BUY_METAL, ref: refW })
    await expect(page.getByText(`Jane ${jane.last}`).first()).toBeVisible()
    await context.close()
  })
})

