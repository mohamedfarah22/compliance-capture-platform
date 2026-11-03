// Gold Phase 9a UAT, section I (case B, the warning, completed and unknown ids, mixed invoices, the Start page) of
// docs/uat-gold-09a-ttr-handoff.md. Rows 9.66 to 9.69 were added by UAT from spec 3.4 and 3.3.
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { sql } from '../support/db.js'
import * as w from '../support/wizard.js'
import { ENTITY_ID, invoice, openAdmin, person, startedMixed, startedScrap, ttrRow } from './wizard-support.js'

let context
let page
test.beforeAll(async ({ browser }) => {
  ;({ context } = await openAdmin(browser))
})
test.afterAll(async () => {
  await context.close()
})
test.beforeEach(async () => {
  page = await context.newPage()
  await page.goto('/')
})
test.afterEach(async () => {
  await page.close()
})

const activeId = () => page.evaluate(() => sessionStorage.getItem('ttr.transactionId'))
const continueButton = () => page.getByRole('button', { name: 'Continue', exact: true })

// The cash a gold TTR holds is not shown on Transaction Details (D2), so it is typed; the button must then be on.
const typeCashAndContinue = async (amount) => {
  await expect(page).toHaveURL(/\/transaction-details$/)
  await page.getByLabel('Cash amount').fill(String(amount))
  await expect(continueButton(), `Continue with $${amount} cash`).toBeEnabled()
  await continueButton().click()
}

const fillMissing = async () => {
  await expect(page).toHaveURL(/\/party-details$/)
  await page.getByLabel('Occupation or principal activity').fill('Goldsmith')
  await page.getByLabel('Is this person a sole trader?').selectOption('No')
  await page.getByLabel('Gender').selectOption('F')
  await page.getByLabel('Citizenship country').fill('AU')
  await page.getByLabel('Tax residency country').fill('AU')
}

test.describe('I · case B and joint', () => {
  test('9.41 ⚠ — case B (Gina): opens on Customers with her added and asks if she acts on her own behalf; Yes goes to ID Verification with the copied confirmation, and Party Details asks for what is missing', async () => {
    const gina = await person({ first: 'Gina', ready: false })
    const { ttrId } = await startedScrap(page, { who: gina })
    await page.goto(`/open-ttr/${ttrId}`)
    await expect(page).toHaveURL(/\/customers$/)
    await expect(page.getByRole('heading', { name: 'Selected for this transaction' })).toBeVisible()
    await expect(page.getByText(`Gina ${gina.last}`).first()).toBeVisible()
    await expect(page.getByText(`Is Gina ${gina.last} acting on their own behalf for this transaction?`)).toBeVisible()

    await w.confirmOwnBehalf(page, `Gina ${gina.last}`)
    await expect(page.getByLabel('Verification method')).toHaveValue('Relied on prior identification')
    await expect(page.getByText(/ID sighted and matched to this record at the counter on/)).toBeVisible()
    await w.clickContinue(page)

    await typeCashAndContinue(12000)
    await expect(page).toHaveURL(/\/party-details$/)
    // Gina has no occupation or gender on file, so those are empty; the page itself offers AU for the two countries.
    await expect(page.getByLabel('Occupation or principal activity')).toHaveValue('')
    await expect(page.getByLabel('Gender')).toHaveValue('')
    await expect(page.getByLabel('Citizenship country')).toBeVisible()
    await expect(page.getByLabel('Tax residency country')).toBeVisible()
    await w.clickContinue(page)
    await expect(page).toHaveURL(/\/party-details$/) // refused until the missing fields are given

    await fillMissing()
    await w.clickContinue(page)
    await w.completeTransaction(page)
    expect((await ttrRow(ttrId)).status).toBe('complete')
  })

  test('9.41 ⚠ (No) — answering No goes to Transaction Details, then Party Details, then Conducting Person', async () => {
    const gina = await person({ first: 'Gina', ready: false })
    const { ttrId } = await startedScrap(page, { who: gina })
    await page.goto(`/open-ttr/${ttrId}`)
    await expect(page).toHaveURL(/\/customers$/)
    await w.answer(page, `Is Gina ${gina.last} acting on their own behalf for this transaction?`, 'No')
    await w.clickContinue(page)
    await expect(page).toHaveURL(/\/transaction-details$/)
    await expect(page.getByText('Step 2 of 3')).toBeVisible()
    await typeCashAndContinue(12000)
    await fillMissing()
    await w.clickContinue(page)
    await expect(page).toHaveURL(/\/conducting-person$/)
  })

  test('9.41 ⚠ (joint) — a joint TTR lists both sellers on Customers and its path includes Conducting Person', async () => {
    const jane = await person({ first: 'Jane' })
    const joan = await person({ first: 'Joan' })
    const { ttrId } = await startedScrap(page, { who: jane, extra: { jointCustomerId: joan.id } })
    await page.goto(`/open-ttr/${ttrId}`)
    await expect(page).toHaveURL(/\/customers$/)
    await expect(page.getByText(`Jane ${jane.last}`).first()).toBeVisible()
    await expect(page.getByText(`Joan ${joan.last}`).first()).toBeVisible()
    await w.clickContinue(page)
    await expect(page).toHaveURL(/\/transaction-details$/)
    await typeCashAndContinue(12000)
    await expect(page).toHaveURL(/\/party-details$/)
    await w.clickContinue(page)
    await expect(page).toHaveURL(/\/conducting-person$/)
  })
})

test.describe('I · the warning and refusals', () => {
  test('9.42 ⚠ — opening another TTR while one is active warns and opens nothing; Open this report opens it; Cancel goes to /start and leaves the first draft', async () => {
    const a = await startedScrap(page)
    const b = await startedScrap(page)
    await page.goto(`/open-ttr/${a.ttrId}`) // none active: no warning
    await expect(page).toHaveURL(/\/transaction-details$/)
    expect(await activeId()).toBe(a.ttrId)
    await page.goto(`/open-ttr/${a.ttrId}`) // the same one again: no warning
    await expect(page).toHaveURL(/\/transaction-details$/)

    await page.goto(`/open-ttr/${b.ttrId}`)
    await expect(page.getByText(`You have another AUSTRAC report in progress (${a.number}). It stays saved; reopen it from the TTR start page.`)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/open-ttr/${b.ttrId}$`))
    expect(await activeId()).toBe(a.ttrId) // nothing opened yet

    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page).toHaveURL(/\/start$/)
    expect(await activeId()).toBe(a.ttrId)
    expect((await ttrRow(a.ttrId)).status).toBe('draft')

    await page.goto(`/open-ttr/${b.ttrId}`)
    await page.getByRole('button', { name: 'Open this report' }).click()
    await expect(page).toHaveURL(/\/transaction-details$/)
    await expect(page.locator('#transactionRef')).toHaveValue(b.number)
    expect(await activeId()).toBe(b.ttrId)
  })

  test('9.43 — a completed TTR and an unknown id show a message and a TTR start button, and leave the active report as it was', async () => {
    const live = await startedScrap(page)
    const done = await startedScrap(page)
    await sql`update ttr.transactions set status = 'complete', completed_at = now() - interval '3 days' where id = ${done.ttrId}`
    await page.goto(`/open-ttr/${live.ttrId}`)
    await expect(page).toHaveURL(/\/transaction-details$/)

    // With another report active the warning comes first (spec 3.2); Open this report then shows the refusal.
    const refusal = async (id, words) => {
      await page.goto(`/open-ttr/${id}`)
      const open = page.getByRole('button', { name: 'Open this report' })
      await expect(open.or(page.getByText(words))).toBeVisible()
      if (await open.isVisible()) await open.click()
      await expect(page.getByText(words)).toBeVisible()
      await expect(page.getByRole('button', { name: 'TTR start' })).toBeVisible()
      expect(await activeId()).toBe(live.ttrId)
    }
    await refusal(done.ttrId, /already complete/)
    await refusal(randomUUID(), /could not be found/)
    await page.getByRole('button', { name: 'TTR start' }).click()
    await expect(page).toHaveURL(/\/start$/)
  })

  test('9.43 (no report active) — a completed TTR and an unknown id show the message and the TTR start button straight away', async () => {
    const done = await startedScrap(page)
    await sql`update ttr.transactions set status = 'complete', completed_at = now() - interval '3 days' where id = ${done.ttrId}`
    await page.goto(`/open-ttr/${done.ttrId}`)
    await expect(page.getByText(/already complete/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'TTR start' })).toBeVisible()
    await page.goto(`/open-ttr/${randomUUID()}`)
    await expect(page.getByText(/could not be found/)).toBeVisible()
    expect(await activeId()).toBeNull()
  })
})

// A mixed invoice: gold opens the first TTR (bullion), finishing it offers the other.
const mixedFlow = async (scrapCash, bullionCash) => {
  const { number, bullionId, scrapId } = await startedMixed(page, { scrapCash: String(scrapCash), bullionCash: String(bullionCash) })
  await page.goto(`/open-ttr/${bullionId}`)
  await typeCashAndContinue(bullionCash)
  await expect(page).toHaveURL(/\/party-details$/)
  await w.clickContinue(page)
  await w.completeTransaction(page)
  const notice = page.getByText(`Another AUSTRAC report for ${number} is waiting`)
  await expect(notice).toBeVisible()
  await page.getByRole('button', { name: 'Open it' }).click()
  await expect(page).toHaveURL(/\/transaction-details$/)
  await expect(page.locator('#transactionRef')).toHaveValue(number)
  expect(await activeId()).toBe(scrapId)
  await typeCashAndContinue(scrapCash)
  await w.clickContinue(page)
  await w.completeTransaction(page)
  await expect(page.getByText(/Another AUSTRAC report for .* is waiting/)).toHaveCount(0)
  expect([(await ttrRow(bullionId)).status, (await ttrRow(scrapId)).status]).toEqual(['complete', 'complete'])
}

test.describe('I · a mixed invoice', () => {
  test('9.44 ⚠ — INV-900 style mixed invoice, $6,000 scrap + $6,000 bullion: open and complete the first, the notice offers the other, and it goes after the second completes', async () => {
    await mixedFlow(6000, 6000)
  })

  test('9.66 (added by UAT, spec 3.4) — the same flow with $10,000 + $10,000: the waiting notice shows after the first and is gone after the second', async () => {
    await mixedFlow(10000, 10000)
  })
})

// ─── The Start page (spec 3.4) ───────────────────────────────────────────────────────────

const staffId = async () => (await sql`select id from public.staff_members where email = 'uat-admin@example.test'`)[0].id
const insertReport = async (ref, scenario, status) => {
  const id = randomUUID()
  const service = scenario === 'bullion_buy' ? 'Purchase of bullion for physical cash' : 'Purchase of precious metal for physical cash'
  await sql`
    insert into ttr.transactions (id, reporting_entity_id, created_by_staff_id, scenario, transaction_ref, transaction_datetime,
        designated_service, location_snapshot, staff_member_name, staff_member_email, staff_member_role, cash_currency, cash_amount, aud_value)
    values (${id}, ${ENTITY_ID}, ${await staffId()}, ${scenario}, ${ref}, now(), ${service}, 'Coburg, VIC', 'UAT Admin',
        'uat-admin@example.test', 'admin', 'AUD', 12000, 12000)`
  // Completed three days ago, so these party-less fixtures are never in today's AUSTRAC batch (08-austrac-file).
  if (status === 'complete') await sql`update ttr.transactions set status = 'complete', completed_at = now() - interval '3 days' where id = ${id}`
  return id
}

const BULLION = 'Buy bullion from customer'
const METAL = 'Buy precious metal from customer'
const COMPLETED = /belongs to a completed transaction/

test.describe('I · the Start page', () => {
  test('9.45 ⚠ — a reference with a completed bullion report is blocked for bullion, free for precious metal, and starts normally there', async () => {
    const ref = invoice('SP')
    await insertReport(ref, 'bullion_buy', 'complete')
    await page.goto('/start')
    await page.getByLabel('Transaction reference').fill(ref)
    await page.getByRole('radio', { name: BULLION }).check()
    await expect(page.getByText(COMPLETED)).toBeVisible()
    await page.getByRole('radio', { name: METAL }).check()
    await expect(page.getByText(COMPLETED)).toHaveCount(0)
    await page.getByRole('button', { name: 'Start transaction' }).click()
    await expect(page).toHaveURL(/\/customers$/)
  })

  test('9.45 ⚠ (draft) — with a draft for the chosen scenario the Start page says "Existing draft found — fields pre-filled."', async () => {
    const ref = invoice('SQ')
    await insertReport(ref, 'bullion_buy', 'complete')
    await insertReport(ref, 'precious_metal_buy', 'draft')
    await page.goto('/start')
    await page.getByRole('radio', { name: BULLION }).check()
    await page.getByLabel('Transaction reference').fill(ref)
    await page.getByLabel('Transaction reference').blur()
    await expect(page.getByText(COMPLETED)).toBeVisible()
    await page.getByRole('radio', { name: METAL }).check()
    await expect(page.getByText(COMPLETED)).toHaveCount(0)
    await expect(page.getByText('Existing draft found — fields pre-filled.')).toBeVisible()
  })

  test('9.68 (added by UAT, spec 3.4 Start page) — typing the reference first and then choosing Buy bullion keeps bullion and shows the completed message, even when a precious metal draft exists', async () => {
    const ref = invoice('ST')
    await insertReport(ref, 'bullion_buy', 'complete')
    await insertReport(ref, 'precious_metal_buy', 'draft')
    await page.goto('/start')
    await page.getByLabel('Transaction reference').fill(ref)
    await page.getByRole('radio', { name: BULLION }).check()
    await page.waitForTimeout(2000) // let every check settle
    await expect(page.getByRole('radio', { name: BULLION })).toBeChecked()
    await expect(page.getByText(COMPLETED)).toBeVisible()
  })

  test('9.67 (added by UAT, spec 3.4 findTransactionByRef) — the same reference with a draft for each scenario reopens the one for the chosen scenario', async () => {
    const ref = invoice('SR')
    const metal = await insertReport(ref, 'precious_metal_buy', 'draft')
    const gold = await insertReport(ref, 'bullion_buy', 'draft')
    for (const [scenario, id] of [[METAL, metal], [BULLION, gold], [METAL, metal]]) {
      await page.goto('/start')
      await page.getByRole('radio', { name: scenario }).check()
      await page.getByLabel('Transaction reference').fill(ref)
      await page.getByRole('button', { name: 'Start transaction' }).click()
      await expect(page).toHaveURL(/\/customers$/)
      expect(await activeId(), scenario).toBe(id)
    }
  })
})
