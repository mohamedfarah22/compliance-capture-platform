// Gold Phase 8b UAT, section A (rows 8b.8 to 8b.19): the counter questions, case A and case B, and the hand-off to the
// TTR wizard (spec 3.2, 3.3, 3.3a). Real gold functions behind the real screens; the wizard is the real one.
import { expect, test } from '@playwright/test'
import {
  freshTab,
  addJoint,
  buy,
  bullionBand,
  countPurchases,
  fillCommon,
  gina,
  inv,
  invoiceBox,
  jane,
  makeImage,
  open,
  openCustomer,
  partiesOf,
  purchaseRow,
  purchasesOf,
  recordButton,
  scrapCash,
  typeOption,
  txByRef,
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
// A new tab's state for each test: the wizard keeps its active draft in sessionStorage.
test.beforeEach(async () => freshTab(page))

const ASK1 = (c) => `Is ${c.name} acting on their own behalf?`
const ASK2 = 'Are these details still correct?'
const answerBoth = async (c, a = 'Yes', b = 'Yes') => {
  await yesNo(page, ASK1(c), a).click()
  await yesNo(page, ASK2, b).click()
}
const saved = (c) => purchasesOf(c.id)

test('8b.8 — the two counter questions show for a ready single seller with reportable cash (with what is on file), and hide when the cash is not reportable', async () => {
  const c = await jane()
  await openCustomer(page, c)
  await scrapCash(page, 'Yes').click()
  await expect(page.getByText(ASK1(c))).toBeVisible()
  await expect(page.getByText(ASK2)).toBeVisible()
  const onFile = page.locator('dl').filter({ hasText: 'Residential address' })
  await expect(onFile).toContainText('1 Test St, Coburg VIC 3058')
  await expect(onFile.locator('div').filter({ hasText: 'Occupation' }).first()).toContainText('Jeweller')
  await expect(onFile.locator('div').filter({ hasText: 'Citizenship' }).first()).toContainText('AU')
  await expect(onFile.locator('div').filter({ hasText: 'Tax residency' }).first()).toContainText('AU')
  await scrapCash(page, 'No').click()
  await expect(page.getByText(ASK2)).toHaveCount(0)
  await scrapCash(page, 'Yes').click()
  await page.getByLabel('Cash amount (AUD, optional)').fill('8,000')
  await expect(page.getByText(ASK2)).toHaveCount(0)
  await page.getByLabel('Cash amount (AUD, optional)').fill('10,000')
  await expect(page.getByText(ASK2)).toBeVisible()
})

test('8b.9 — the counter questions do not show for a customer who is not ready, or for a joint sale', async () => {
  const g = await gina()
  await openCustomer(page, g)
  await scrapCash(page, 'Yes').click()
  await expect(page.getByText('No invoice number yet', { exact: false })).toHaveCount(0)
  await expect(page.getByText(ASK2)).toHaveCount(0)
  const c = await jane()
  const joan = await jane({ first: 'Joan' })
  await openCustomer(page, c)
  await addJoint(page, joan)
  await scrapCash(page, 'Yes').click()
  await expect(page.getByText(ASK2)).toHaveCount(0)
})

test('8b.10 — answering only the first counter question stops the save: "Answer both questions."', async () => {
  const c = await jane()
  await openCustomer(page, c)
  await scrapCash(page, 'Yes').click()
  await fillCommon(page, img)
  await yesNo(page, ASK1(c), 'Yes').click()
  await recordButton(page).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Answer both questions.' })).toBeVisible()
  expect(await saved(c)).toHaveLength(0)
})

test('8b.11 — case A with no invoice: the "AUSTRAC pending" notice, the save stays on the page, the answers are stored, no TTR yet', async () => {
  const c = await jane()
  await openCustomer(page, c)
  await scrapCash(page, 'Yes').click()
  await answerBoth(c)
  await fillCommon(page, img)
  await expect(
    page.getByRole('status').filter({ hasText: 'No invoice number yet, so this purchase will be saved as AUSTRAC pending. Add the invoice number within 10 business days from To complete.' }),
  ).toBeVisible()
  await recordButton(page).click()
  await expect(page.getByText('Purchase recorded as AUSTRAC pending. Add the invoice number from To complete.')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}$`))
  await expect(page.getByRole('listitem').filter({ hasText: 'No invoice number yet' })).toContainText('AUSTRAC pending')
  const [p] = await saved(c)
  expect([p.cash_10k_or_more, p.ttr_self_conducted, p.ttr_details_confirmed, p.ttr_transaction_id]).toEqual([true, true, true, null])
})

test('8b.12 — case B by a No answer, with no invoice: the invoice is required and nothing is saved', async () => {
  const c = await jane()
  await openCustomer(page, c)
  await scrapCash(page, 'Yes').click()
  await answerBoth(c, 'No', 'Yes')
  await fillCommon(page, img)
  await recordButton(page).click()
  await expect(page.getByText(`Enter the ERP invoice number. The AUSTRAC report for ${c.name} must be started now.`)).toBeVisible()
  expect(await saved(c)).toHaveLength(0)
})

test('8b.13 — a customer who is not ready (gold-only) needs the invoice now: "AUSTRAC details are incomplete"; nothing is saved', async () => {
  const g = await gina()
  await openCustomer(page, g)
  await scrapCash(page, 'Yes').click()
  await fillCommon(page, img)
  await recordButton(page).click()
  await expect(page.getByText(`Enter the ERP invoice number. ${g.name}'s AUSTRAC details are incomplete, so the report must be started now.`)).toBeVisible()
  expect(await saved(g)).toHaveLength(0)
})

test('8b.14 — case B with the invoice: the button and notice say the AUSTRAC form opens, and after the save the wizard opens a draft TTR for the invoice with the customer as party', async () => {
  const g = await gina()
  const number = inv('B1')
  await openCustomer(page, g)
  await scrapCash(page, 'Yes').click()
  await fillCommon(page, img, { invoice: number })
  await expect(page.getByRole('button', { name: 'Record purchase and continue to AUSTRAC' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'After you record this purchase, the AUSTRAC form will open with this customer loaded.' })).toBeVisible()
  await page.getByRole('button', { name: 'Record purchase and continue to AUSTRAC' }).click()
  await expect(page).not.toHaveURL(/\/gold/)
  await expect(page).toHaveURL(/\/customers$/)
  const [tx] = await txByRef(number)
  expect([tx.scenario, tx.status, tx.transaction_ref]).toEqual(['precious_metal_buy', 'draft', number])
  const parties = await partiesOf(tx.id)
  expect(parties.map((p) => p.customer_id)).toEqual([g.id])
  expect((await saved(g))[0].ttr_transaction_id).toBe(tx.id)
})

test('8b.15 — a bullion purchase of $10,000 or more starts a bullion_buy TTR with the invoice as reference', async () => {
  const g = await gina()
  const number = inv('B2')
  await openCustomer(page, g)
  await typeOption(page, 'Bullion').click()
  await bullionBand(page, '$10,000 or more').click()
  await fillCommon(page, img, { invoice: number })
  await page.getByRole('button', { name: 'Record purchase and continue to AUSTRAC' }).click()
  await expect(page).not.toHaveURL(/\/gold/)
  const [tx] = await txByRef(number)
  expect([tx.scenario, tx.transaction_ref]).toEqual(['bullion_buy', number])
})

test('8b.16 — with another TTR draft active in the tab, the hand-off warns first, keeps the purchase, and "Open this report" opens the new TTR', async () => {
  const g1 = await gina()
  const g2 = await gina()
  const first = inv('B3a')
  const second = inv('B3')
  await openCustomer(page, g1)
  await scrapCash(page, 'Yes').click()
  await fillCommon(page, img, { invoice: first })
  await page.getByRole('button', { name: 'Record purchase and continue to AUSTRAC' }).click()
  await expect(page).toHaveURL(/\/customers$/)
  // The first draft is now the active one in this tab (sessionStorage survives the page load below).
  await openCustomer(page, g2)
  await scrapCash(page, 'Yes').click()
  await fillCommon(page, img, { invoice: second })
  await page.getByRole('button', { name: 'Record purchase and continue to AUSTRAC' }).click()
  await expect(page.getByRole('heading', { name: 'Another AUSTRAC report is in progress' })).toBeVisible()
  await expect(page.getByText(`You have another AUSTRAC report in progress (${first}). It stays saved; reopen it from the TTR start page.`)).toBeVisible()
  expect(await saved(g2)).toHaveLength(1)
  await page.getByRole('button', { name: 'Open this report' }).click()
  await expect(page).toHaveURL(/\/customers$/)
  const [tx] = await txByRef(second)
  const state = await page.evaluate(() => Object.values(sessionStorage).join(' '))
  expect(state).toContain(tx.id)
})

test('8b.17 — case A with the invoice entered at the counter starts the TTR but does not open it: the notice says so, gold stays on the customer page with the confirmation, and Resume TTR on To complete opens it on the self-conducted fast path (Transaction Details)', async () => {
  const c = await jane()
  const number = inv('B4')
  await openCustomer(page, c)
  await scrapCash(page, 'Yes').click()
  await answerBoth(c)
  await fillCommon(page, img, { invoice: number })
  await expect(page.getByRole('status').filter({ hasText: 'After you record this purchase, the AUSTRAC report will be started. Finish it from To complete.' })).toBeVisible()
  await expect(page.getByText('the AUSTRAC form will open')).toHaveCount(0)
  await recordButton(page).click()
  await expect(page.getByText('AUSTRAC report started. Finish it from To complete.')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}$`))
  const [tx] = await txByRef(number)
  expect(tx.status).toBe('draft')
  expect((await saved(c))[0].ttr_transaction_id).toBe(tx.id)
  // Started, not opened: this tab has no active TTR yet.
  expect(await page.evaluate(() => Object.values(sessionStorage).join(' '))).not.toContain(tx.id)
  await page.goto('/gold/to-complete')
  await page.locator('main li').filter({ hasText: c.name }).getByRole('button', { name: 'Resume TTR' }).click()
  await expect(page).toHaveURL(/\/transaction-details$/)
  expect(await page.evaluate(() => Object.values(sessionStorage).join(' '))).toContain(tx.id)
})

test('8b.18 — a reportable purchase with an invoice already used by another purchase is refused: nothing is saved', async () => {
  const g = await gina()
  const c = await jane()
  const number = inv('B5')
  await buy('s1', { customerId: g.id, cash10k: 'true', cashAmount: '12000', erpInvoiceNo: number })
  const before = await countPurchases()
  await openCustomer(page, c)
  await scrapCash(page, 'Yes').click()
  await answerBoth(c)
  await fillCommon(page, img, { invoice: number })
  await page.getByRole('button', { name: /^Record purchase/ }).click()
  await expect(page.getByText(`The ERP invoice number ${number} is already used by another purchase. A reportable purchase needs its own invoice number.`)).toBeVisible()
  expect(await countPurchases()).toBe(before)
  expect(await saved(c)).toHaveLength(0)
})

test('8b.19 — a non-reportable purchase with a used invoice only warns, and saves', async () => {
  const other = await jane()
  const c = await jane()
  const number = inv('B6')
  await buy('s1', { customerId: other.id, erpInvoiceNo: number })
  await openCustomer(page, c)
  await fillCommon(page, img)
  await invoiceBox(page).fill(number)
  await invoiceBox(page).blur()
  await expect(page.getByText('This invoice number is already recorded. Check it’s not a duplicate.')).toBeVisible()
  await recordButton(page).click()
  await expect(page.getByText('Purchase recorded', { exact: true })).toBeVisible()
  expect((await saved(c))[0].erp_invoice_no).toBe(number)
  expect((await purchaseRow((await saved(c))[0].id)).ttr_transaction_id).toBeNull()
})
