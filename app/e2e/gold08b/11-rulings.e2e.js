// Gold Phase 8b UAT, rows added by UAT after the user's rulings (8b.65 to 8b.72), from the spec as edited in 7dff641:
// Q1 case A at the counter starts the TTR but does not open it (3.3), Q3 the amber notice on the TTR review (3.3, 3.2),
// Q5 a completed TTR is plain text on the purchase record (3.2, 5.2).
import { expect, test } from '@playwright/test'
import {
  addGoodsPhoto,
  buy,
  completeTtr,
  fillCommon,
  freshTab,
  gina,
  headerCount,
  inv,
  invoiceBox,
  jane,
  makeImage,
  open,
  openCustomer,
  purchasesOf,
  recordButton,
  reportableWithTtr,
  scrapCash,
  sql,
  txByRef,
  typeOption,
  yes,
  yesNo,
} from './support.js'

let ctx
let page
let img
test.beforeAll(async ({ browser }) => {
  ctx = await open(browser, 's1')
  page = ctx.page
  img = await makeImage(page, { width: 800, height: 500, label: 'Goods' })
})
test.afterAll(async () => ctx?.context.close())
test.beforeEach(async () => freshTab(page))

const STARTED = 'AUSTRAC report started. Finish it from To complete.'
const NOTICE = 'The customer wasn’t asked to confirm their details at the counter. Contact them to confirm before completing the TTR.'
const noticeBox = () => page.getByRole('status').filter({ hasText: NOTICE })
const activeTtr = () => page.evaluate(() => sessionStorage.getItem('ttr.transactionId'))
const rowOf = (name) => page.locator('main li').filter({ hasText: name })

/** Jane (ready), scrap, cash Yes, both counter answers Yes, the invoice entered at the counter: case A. Presses Record. */
const recordCaseA = async (c, number) => {
  await openCustomer(page, c)
  await scrapCash(page, 'Yes').click()
  await yesNo(page, `Is ${c.name} acting on their own behalf?`, 'Yes').click()
  await yesNo(page, 'Are these details still correct?', 'Yes').click()
  await fillCommon(page, img, { invoice: number })
  await recordButton(page).click()
}

/** Opens a draft TTR (by id, as the Resume link does) and goes to its review page. */
const reviewOf = async (ttrId) => {
  // Opening a draft while another is active in the tab asks first, so start from a tab with none.
  await page.evaluate(() => sessionStorage.clear())
  await page.goto(`/open-ttr/${ttrId}`)
  await expect(page).toHaveURL(/\/(transaction-details|party-details|customers|id-verification)$/)
  await page.goto('/review')
  await expect(page.getByText(/^From gold purchase\(s\) on invoice /)).toBeVisible()
}

test('8b.65 (added by UAT, spec 3.3 Q1) — after a case A purchase with the invoice at the counter, To complete lists it under "AUSTRAC pending" with Resume TTR and the due line, and the history and header count show it', async () => {
  const c = await jane()
  const number = inv('Q1')
  await recordCaseA(c, number)
  await expect(page.getByText(STARTED)).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}$`))
  const [tx] = await txByRef(number)
  expect([tx.scenario, tx.status, tx.transaction_ref]).toEqual(['precious_metal_buy', 'draft', number])
  const [p] = await purchasesOf(c.id)
  expect([p.ttr_transaction_id, p.erp_invoice_no]).toEqual([tx.id, number])
  const history = page.locator('li').filter({ hasText: number })
  await expect(history.getByText('AUSTRAC pending', { exact: true })).toBeVisible()
  await page.goto('/gold/to-complete')
  await expect(page.getByRole('heading', { name: 'To complete' })).toBeVisible()
  await expect(page.getByText('Loading…')).toHaveCount(0)
  const pending = page.getByRole('region', { name: /^AUSTRAC pending/ })
  const row = pending.locator('li').filter({ hasText: c.name })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(`Invoice ${number}`)
  await expect(row.getByRole('button', { name: 'Resume TTR' })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Start TTR' })).toHaveCount(0)
  await expect(row.locator('p', { hasText: 'AUSTRAC report due' })).toContainText(/AUSTRAC report due \d{1,2} \w+ \d{4} · /)
  expect(await headerCount(page)).toBeGreaterThanOrEqual(1)
})

test('8b.66 (added by UAT, spec 3.3 Q1) — case A at the counter shows no "another report in progress" warning even when another draft is active in the tab, and does not change which draft is active', async () => {
  const g = await gina()
  const first = inv('Q1a')
  await openCustomer(page, g)
  await scrapCash(page, 'Yes').click()
  await fillCommon(page, img, { invoice: first })
  await page.getByRole('button', { name: 'Record purchase and continue to AUSTRAC' }).click()
  await expect(page).toHaveURL(/\/customers$/)
  const [firstTx] = await txByRef(first)
  expect(await activeTtr()).toBe(firstTx.id)
  const c = await jane()
  const second = inv('Q1b')
  await recordCaseA(c, second)
  await expect(page.getByText(STARTED)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Another AUSTRAC report is in progress' })).toHaveCount(0)
  await expect(page.getByText(/You have another AUSTRAC report in progress/)).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}$`))
  const [secondTx] = await txByRef(second)
  expect(secondTx.status).toBe('draft')
  expect(await activeTtr()).toBe(firstTx.id)
})

test('8b.67 (added by UAT, spec 3.3 Q1) — if gold-start-ttr fails after a case A save at the counter, the purchase stays saved, the page says so, and To complete offers Start TTR', async () => {
  const c = await jane()
  const number = inv('Q1c')
  await page.route('**/functions/v1/gold-start-ttr', (route) => route.abort())
  await recordCaseA(c, number)
  await expect(page.getByText(/^Purchase recorded, but the AUSTRAC report could not be started\./)).toBeVisible()
  await expect(page.getByText(STARTED)).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}$`))
  const [p] = await purchasesOf(c.id)
  expect([p.erp_invoice_no, p.ttr_transaction_id]).toEqual([number, null])
  await page.unroute('**/functions/v1/gold-start-ttr')
  await page.goto('/gold/to-complete')
  await expect(rowOf(c.name).getByRole('button', { name: 'Start TTR' })).toBeVisible()
  expect(await sql`select 1 from ttr.transactions where transaction_ref = ${number}`).toHaveLength(0)
})

test('8b.68 (added by UAT, spec 3.3 Q1) — adding the invoice on Complete purchase to a reportable case A purchase still creates and opens the TTR (it is not held back like the counter save)', async () => {
  const c = await jane()
  const id = await buy('s1', { customerId: c.id, cash10k: 'true', cashAmount: '12000', ...yes })
  const number = inv('Q1d')
  await page.goto(`/gold/purchases/${id}/complete`)
  await expect(page.getByRole('heading', { name: 'Complete purchase' })).toBeVisible()
  await page.getByLabel('ERP invoice number').fill(number)
  await page.getByRole('button', { name: 'Save and continue to AUSTRAC' }).click()
  await expect(page).toHaveURL(/\/transaction-details$/)
  const [tx] = await txByRef(number)
  expect(tx.status).toBe('draft')
  expect(await activeTtr()).toBe(tx.id)
})

/** Jane: scrap part on `number` (cash No, no amount), then a bullion part on Complete purchase with 6,000 + 6,000. */
const becomesReportableOnComplete = async (number) => {
  const c = await jane()
  await buy('s1', { customerId: c.id, erpInvoiceNo: number })
  const part2 = await buy('s1', { customerId: c.id, purchaseType: 'bullion', cash10k: undefined, bullionBand: '5k_to_10k' })
  await page.goto(`/gold/purchases/${part2}/complete`)
  await expect(page.getByRole('heading', { name: 'Complete purchase' })).toBeVisible()
  await page.getByLabel('ERP invoice number').fill(number)
  await page.getByLabel('Cash paid on that part (AUD)').fill('6000')
  await page.getByLabel('Cash paid for this part (AUD)').fill('6000')
  await page.getByRole('button', { name: 'Save and continue to AUSTRAC' }).click()
  await expect(page).not.toHaveURL(/\/gold/)
  const txs = await txByRef(number)
  expect(txs.map((t) => t.scenario).sort()).toEqual(['bullion_buy', 'precious_metal_buy'])
  return { c, txs, bullion: txs.find((t) => t.scenario === 'bullion_buy') }
}

test('8b.69 (added by UAT, spec 3.3 Q3) — a purchase that became reportable on Complete purchase without the counter answers: its TTR review shows the amber notice next to "From gold purchase(s)"', async () => {
  const number = inv('Q3a')
  const { bullion } = await becomesReportableOnComplete(number)
  await reviewOf(bullion.id)
  await expect(page.getByText(`From gold purchase(s) on invoice ${number}`)).toBeVisible()
  await expect(noticeBox()).toBeVisible()
})

test('8b.70 (added by UAT, spec 3.3 Q3) — no notice on the TTR review of a normal case A purchase (both counter answers Yes), or of a case B purchase (reportable at the counter)', async () => {
  const caseA = await reportableWithTtr('s1', await jane(), { number: inv('Q3b') })
  await reviewOf(caseA.ttrId)
  await expect(page.getByText(`From gold purchase(s) on invoice ${caseA.number}`)).toBeVisible()
  await expect(page.getByText(NOTICE)).toHaveCount(0)
  const caseB = await reportableWithTtr('s1', await gina(), { number: inv('Q3c'), answers: {} })
  await reviewOf(caseB.ttrId)
  await expect(page.getByText(`From gold purchase(s) on invoice ${caseB.number}`)).toBeVisible()
  await expect(page.getByText(NOTICE)).toHaveCount(0)
})

test('8b.71 (added by UAT, spec 3.3 Q3, 3.4) — no notice on either TTR review of a mixed scrap + bullion invoice whose counter answers were given on the part that made it reportable (the case is decided once per invoice)', async () => {
  const c = await jane()
  const number = inv('Q3d')
  await buy('s1', { customerId: c.id, erpInvoiceNo: number })
  await openCustomer(page, c)
  await typeOption(page, 'Bullion').click()
  await addGoodsPhoto(page, img)
  await page.getByRole('checkbox', { name: /sighted in person today/ }).check()
  await invoiceBox(page).fill(number)
  await invoiceBox(page).blur()
  await page.getByLabel('Cash paid on that part (AUD)').fill('6000')
  await page.getByLabel('Cash paid for this part (AUD)').fill('6000')
  await yesNo(page, `Is ${c.name} acting on their own behalf?`, 'Yes').click()
  await yesNo(page, 'Are these details still correct?', 'Yes').click()
  await recordButton(page).click()
  await expect(page.getByText(STARTED)).toBeVisible()
  const txs = await txByRef(number)
  expect(txs.map((t) => t.scenario).sort()).toEqual(['bullion_buy', 'precious_metal_buy'])
  const parts = await purchasesOf(c.id)
  expect(parts.map((p) => [p.cash_10k_or_more, p.ttr_self_conducted])).toEqual([[false, null], [true, true]])
  for (const t of txs) {
    await reviewOf(t.id)
    await expect(page.getByText(`From gold purchase(s) on invoice ${number}`), t.scenario).toBeVisible()
    await expect(page.getByText(NOTICE), `${t.scenario} review`).toHaveCount(0)
  }
})

test('8b.72 (added by UAT, spec 3.2 Q5) — a completed TTR on the purchase record is plain text with the reference and completion date, and has no link; a draft keeps its link', async () => {
  const done = await reportableWithTtr('s1', await jane(), { number: inv('Q5a') })
  const draft = await reportableWithTtr('s1', await jane(), { number: inv('Q5b') })
  await completeTtr(done.ttrId)
  const [{ day }] = await sql`select to_char(completed_at at time zone 'Australia/Melbourne', 'YYYY-MM-DD') as day from ttr.transactions where id = ${done.ttrId}`
  const shown = new Intl.DateTimeFormat('en-AU', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`))
  await page.goto(`/gold/purchases/${done.purchaseId}`)
  await expect(page.getByRole('heading', { name: 'Scrap jewellery purchase' })).toBeVisible()
  const line = page.locator('p').filter({ hasText: /^AUSTRAC report:/ })
  await expect(line).toHaveText(`AUSTRAC report: complete. Reference ${done.number}, completed ${shown}.`)
  await expect(line.getByRole('link')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Open AUSTRAC report' })).toHaveCount(0)
  await page.goto(`/gold/purchases/${draft.purchaseId}`)
  await expect(page.getByText('AUSTRAC report: draft in progress.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open AUSTRAC report' })).toBeVisible()
})
