// Gold Phase 8b UAT, section A (rows 8b.20 to 8b.25): a second part on the same invoice (spec 3.4, 3.5) and the ID
// gates on the purchase form (C2, spec 3.3, 5.4).
import { expect, test } from '@playwright/test'
import {
  freshTab,
  buy,
  bullionBand,
  completeTtr,
  dmy,
  fillCommon,
  gina,
  inv,
  invoiceBox,
  jane,
  makeImage,
  melbourneDate,
  open,
  openCustomer,
  purchasesOf,
  recordButton,
  scrapCash,
  sighted,
  sightedBox,
  startTtr,
  tokenOf,
  typeOption,
  upload,
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
// A new tab's state for each test: the wizard keeps its active draft in sessionStorage.
test.beforeEach(async () => freshTab(page))

const partBox = () => page.getByLabel('Cash paid for this part (AUD)')
const earlierBox = () => page.getByLabel('Cash paid on that part (AUD)')
const RED = 'Update the ID before recording this cash purchase. An expired ID cannot go into an AUSTRAC report.'

/** Jane with an earlier scrap purchase (cash No, no amount) on `number` today, and the form open for a bullion part. */
const secondPart = async (number) => {
  const c = await jane()
  await buy('s1', { customerId: c.id, erpInvoiceNo: number })
  await openCustomer(page, c)
  await typeOption(page, 'Bullion').click()
  await fillCommon(page, img, { invoice: number })
  await invoiceBox(page).blur()
  return c
}

test('8b.20 — the same invoice as an earlier purchase today shows the linked-parts panel, and a blank part amount stops the save', async () => {
  const number = inv('B7')
  const c = await secondPart(number)
  await expect(page.getByText('Same invoice as an earlier purchase today for this customer')).toBeVisible()
  await expect(page.getByText('Scrap', { exact: true }).first()).toBeVisible()
  await expect(earlierBox()).toBeVisible()
  await expect(partBox()).toBeVisible()
  await expect(page.getByRole('radiogroup', { name: 'Cash paid' })).toHaveCount(0)
  await recordButton(page).click()
  await expect(page.getByText('Enter the cash paid for this part. Enter 0 if none was cash.')).toBeVisible()
  expect(await purchasesOf(c.id)).toHaveLength(1)
})

test('8b.21 — $6,000 on each part makes $12,000 on the invoice: the panel says it is reportable once, and the save is a reportable purchase that hands over', async () => {
  const number = inv('B7')
  const c = await secondPart(number)
  await earlierBox().fill('6000')
  await partBox().fill('6000')
  await expect(page.getByText('Cash on ' + number + ' today: $12,000.00. That’s $10,000.00 or more, so the invoice will be reported to AUSTRAC once.')).toBeVisible()
  await yesNo(page, `Is ${c.name} acting on their own behalf?`, 'Yes').click()
  await yesNo(page, 'Are these details still correct?', 'Yes').click()
  await page.getByRole('button', { name: 'Record purchase and continue to AUSTRAC' }).click()
  await expect(page).not.toHaveURL(/\/gold/)
  const rows = await purchasesOf(c.id)
  expect(rows).toHaveLength(2)
  expect(rows.map((r) => Number(r.cash_amount))).toEqual([6000, 6000])
  // The invoice is reportable: the new part carries the flag and the invoice total, and both parts link to a TTR.
  expect(rows[1].cash_10k_or_more).toBe(true)
  expect(Number(rows[1].invoice_cash_total)).toBe(12000)
  expect(rows.every((r) => r.ttr_transaction_id)).toBe(true)
})

test('8b.22 — a further part for a type whose TTR for the invoice is already complete is refused: "already finished"', async () => {
  const number = inv('B7')
  const c = await jane()
  const tok = await tokenOf('s1')
  await buy('s1', { customerId: c.id, cash10k: 'true', cashAmount: '6000', erpInvoiceNo: number })
  await buy('s1', { customerId: c.id, purchaseType: 'bullion', cash10k: undefined, bullionBand: '5k_to_10k', partAmount: '6000', erpInvoiceNo: number, ...yes })
  const [first] = await purchasesOf(c.id)
  const s = await startTtr(tok, { purchaseId: first.id })
  expect(s.status, s.text).toBe(200)
  for (const t of s.body.ttrs) await completeTtr(t.id)
  await openCustomer(page, c)
  await fillCommon(page, img, { invoice: number })
  await invoiceBox(page).blur()
  await expect(page.getByText('Same invoice as 2 earlier purchases today for this customer')).toBeVisible()
  await partBox().fill('0')
  await recordButton(page).click()
  await expect(page.getByText(`The AUSTRAC report for ${number} is already finished. Use a new ERP invoice number for this purchase.`)).toBeVisible()
  expect(await purchasesOf(c.id)).toHaveLength(2)
})

test('8b.23 — an expired ID blocks a cash purchase (red notice, Update ID now, Record purchase disabled) and only flags a non-cash one', async () => {
  const g = await gina({ id: { expiry: '2020-01-01' } })
  await openCustomer(page, g)
  await scrapCash(page, 'Yes').click()
  const alert = page.getByRole('alert').filter({ hasText: RED })
  await expect(alert).toBeVisible()
  await expect(alert).toContainText(`${g.name} (main seller): ID expired on`)
  await expect(alert.getByRole('button', { name: 'Update ID now' })).toBeVisible()
  await expect(recordButton(page)).toBeDisabled()
  await scrapCash(page, 'No').click()
  await expect(page.getByText(`ID on file has expired for ${g.name}. This purchase will be saved with an expired-ID flag.`)).toBeVisible()
  await fillCommon(page, img)
  await recordButton(page).click()
  await expect(page.getByText('Purchase recorded', { exact: false }).first()).toBeVisible()
  const [p] = await purchasesOf(g.id)
  expect(p.id_expired_at_time).toBe(true)
})

test('8b.24 — an ID photographed outside the re-verification window blocks cash and bullion $5,000+, but a non-cash purchase saves with a re-verify notice', async () => {
  const c = await jane({ id: { capturedDaysAgo: 800 } })
  await openCustomer(page, c)
  await scrapCash(page, 'Yes').click()
  const alert = page.getByRole('alert').filter({ hasText: RED })
  await expect(alert).toContainText(`${c.name} (main seller): ID photographed on`)
  await expect(alert).toContainText('more than 730 days ago')
  await expect(alert.getByRole('button', { name: 'Update ID now' })).toBeVisible()
  await expect(recordButton(page)).toBeDisabled()
  await scrapCash(page, 'No').click()
  await expect(page.getByText(/needs re-verifying/i).first()).toBeVisible()
  await expect(recordButton(page)).toBeEnabled()
  await typeOption(page, 'Bullion').click()
  await bullionBand(page, '$5,000 to $9,999').click()
  await expect(page.getByRole('alert').filter({ hasText: 'Update the ID before recording this purchase. Bullion bought with $5,000 or more in cash needs a current ID.' })).toBeVisible()
  await expect(recordButton(page)).toBeDisabled()
  await bullionBand(page, 'Under $5,000').click()
  await fillCommon(page, img)
  await recordButton(page).click()
  await expect(page.getByText('Purchase recorded', { exact: false }).first()).toBeVisible()
  expect(await purchasesOf(c.id)).toHaveLength(1)
})

test('8b.25 — Update ID now returns to the customer with the form as it was left, and the red notice gone', async () => {
  const g = await gina({ id: { expiry: '2020-01-01' } })
  const number = inv('B8')
  await openCustomer(page, g)
  await scrapCash(page, 'Yes').click()
  await fillCommon(page, img, { invoice: number })
  await page.getByRole('alert').getByRole('button', { name: 'Update ID now' }).click()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${g.id}/update-id$`))
  await page.getByRole('radio', { name: /^Renewed/ }).check()
  await page.getByLabel('ID expiry date').fill(dmy(melbourneDate(1500)))
  await upload(page, 'ID front', img)
  await upload(page, 'ID back', img)
  await sighted(page).check()
  await page.getByRole('button', { name: 'Save new ID' }).click()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${g.id}$`))
  await expect(page.getByRole('alert').filter({ hasText: RED })).toHaveCount(0)
  await expect(invoiceBox(page)).toHaveValue(number)
  await expect(page.getByRole('img', { name: 'Goods photo 1' })).toBeVisible()
  await expect(sightedBox(page)).toBeChecked()
  await expect(scrapCash(page, 'Yes')).toHaveAttribute('aria-checked', 'true')
  await expect(recordButton(page)).toBeEnabled()
  expect(await purchasesOf(g.id)).toHaveLength(0)
})
