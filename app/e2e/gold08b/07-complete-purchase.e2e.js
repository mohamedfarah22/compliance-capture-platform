// Gold Phase 8b UAT, section C (rows 8b.41 to 8b.49): the Complete purchase screen (spec 3.3, 3.5, 4.3, 5.2 CompletePurchase row).
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
  E2,
  buy,
  completeTtr,
  freshTab,
  inv,
  jane,
  gina,
  open,
  purchaseRow,
  sql,
  startTtr,
  tokenOf,
  txByRef,
  yes,
} from './support.js'

let ctx
let page
let manager
test.beforeAll(async ({ browser }) => {
  ctx = await open(browser, 's1')
  page = ctx.page
  manager = await open(browser, 'm1')
})
test.afterAll(async () => {
  await ctx?.context.close()
  await manager?.context.close()
})
test.beforeEach(async () => freshTab(page))

const completePage = async (purchaseId, p = page) => {
  await p.goto(`/gold/purchases/${purchaseId}/complete`)
  await expect(p.getByRole('heading', { name: 'Complete purchase' })).toBeVisible()
}
const invoiceField = (p = page) => p.getByLabel('ERP invoice number')
const saveButton = (name = 'Save and complete', p = page) => p.getByRole('button', { name })
const reportableNoInvoice = (c, extra = {}) => buy('s1', { customerId: c.id, cash10k: 'true', cashAmount: '12000', ...yes, ...extra })

test('8b.41 — Complete purchase shows the tags, who recorded it and when, the sellers with ID badges (read only), the goods photos (opening in a viewer) and the invoice box with its hint', async () => {
  const c = await jane()
  const id = await buy('s1', { customerId: c.id })
  await completePage(id)
  await expect(page.getByText('Scrap', { exact: true })).toBeVisible()
  await expect(page.getByText('Incomplete', { exact: true })).toBeVisible()
  await expect(page.getByText(/^Scrap jewellery, recorded .* by UAT8a Staff\. Add the ERP invoice number to complete it\.$/)).toBeVisible()
  await expect(page.getByText('Main seller', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: c.name })).toBeVisible()
  await expect(page.getByText(/^Driver licence /)).toBeVisible()
  await expect(page.getByText('Required to complete the purchase.')).toBeVisible()
  await expect(invoiceField()).toBeEditable()
  const photo = page.getByRole('button', { name: 'Goods photo 1' })
  await expect(photo).toBeVisible()
  await photo.click()
  await expect(page.getByRole('dialog', { name: 'Photo' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Photo' })).toHaveCount(0)
})

test('8b.42 — Save and complete with the invoice blank shows "Enter the ERP invoice number for this purchase." and saves nothing', async () => {
  const c = await jane()
  const id = await buy('s1', { customerId: c.id })
  await completePage(id)
  await saveButton().click()
  await expect(page.getByText('Enter the ERP invoice number for this purchase.')).toBeVisible()
  expect((await purchaseRow(id)).erp_invoice_no).toBeNull()
})

test('8b.43 — a manager completing a staff member\'s purchase: back on To complete with "Purchase completed", gone from the list, and the record shows who completed it', async () => {
  const c = await jane()
  const id = await buy('s1', { customerId: c.id })
  const number = inv('C1')
  await completePage(id, manager.page)
  await invoiceField(manager.page).fill(number)
  await saveButton('Save and complete', manager.page).click()
  await expect(manager.page).toHaveURL(/\/gold\/to-complete$/)
  await expect(manager.page.getByText('Purchase completed', { exact: true })).toBeVisible()
  await expect(manager.page.locator('main li').filter({ hasText: c.name })).toHaveCount(0)
  await manager.page.goto(`/gold/purchases/${id}`)
  const completed = manager.page.locator('dt', { hasText: /^Completed$/ }).locator('xpath=following-sibling::dd')
  await expect(completed).toContainText('by UAT8a Manager')
  await expect(manager.page.locator('dt', { hasText: 'Recorded by' }).locator('xpath=following-sibling::dd')).toHaveText('UAT8a Staff')
})

test('8b.44 — completing a case A purchase: the button says "Save and continue to AUSTRAC" and the TTR opens on Transaction Details with the invoice as reference', async () => {
  const c = await jane()
  const id = await reportableNoInvoice(c)
  const number = inv('C2')
  await completePage(id)
  await expect(page.getByText('After you save, the AUSTRAC form will open with this customer loaded.')).toBeVisible()
  await invoiceField().fill(number)
  await saveButton('Save and continue to AUSTRAC').click()
  await expect(page).toHaveURL(/\/transaction-details$/)
  const [tx] = await txByRef(number)
  expect([tx.status, tx.scenario]).toEqual(['draft', 'precious_metal_buy'])
  expect((await purchaseRow(id)).ttr_transaction_id).toBe(tx.id)
})

test('8b.45 — a purchase that becomes reportable on Complete purchase: both parts\' cash is added, the amber "wasn\'t asked" notice shows, and Save creates both TTRs', async () => {
  const c = await jane()
  const number = inv('C3')
  await buy('s1', { customerId: c.id, erpInvoiceNo: number })
  const part2 = await buy('s1', { customerId: c.id, purchaseType: 'bullion', cash10k: undefined, bullionBand: '5k_to_10k' })
  await completePage(part2)
  await invoiceField().fill(number)
  await page.getByLabel('Cash paid on that part (AUD)').fill('6000')
  await page.getByLabel('Cash paid for this part (AUD)').fill('6000')
  await expect(page.getByText(`Cash on ${number} today: $12,000.00.`)).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'The customer wasn’t asked to confirm their details at the counter. Contact them to confirm before completing the TTR.' })).toBeVisible()
  await saveButton('Save and continue to AUSTRAC').click()
  await expect(page).not.toHaveURL(/\/gold/)
  const txs = await txByRef(number)
  expect(txs.map((t) => t.scenario).sort()).toEqual(['bullion_buy', 'precious_metal_buy'])
  expect(txs.every((t) => t.status === 'draft')).toBe(true)
})

test('8b.46 — completing a reportable purchase with an invoice another customer\'s reportable purchase uses is refused; a non-reportable one only warns', async () => {
  const number = inv('C4')
  await buy('s1', { customerId: (await gina()).id, cash10k: 'true', cashAmount: '12000', erpInvoiceNo: number })
  const c = await jane()
  const id = await reportableNoInvoice(c)
  await completePage(id)
  await invoiceField().fill(number)
  await saveButton('Save and continue to AUSTRAC').click()
  await expect(page.getByText(`The ERP invoice number ${number} is already used by another purchase. A reportable purchase needs its own invoice number.`)).toBeVisible()
  expect((await purchaseRow(id)).erp_invoice_no).toBeNull()

  const plain = await buy('s1', { customerId: (await jane()).id })
  await completePage(plain)
  await invoiceField().fill(number)
  await expect(page.getByText('This invoice number is already recorded. Check it’s not a duplicate.')).toBeVisible()
  await saveButton().click()
  await expect(page).toHaveURL(/\/gold\/to-complete$/)
  expect((await purchaseRow(plain)).erp_invoice_no).toBe(number)
})

test('8b.47 — a reportable purchase saved with an expired ID cannot be completed: red text, red box, save disabled', async () => {
  const c = await jane({ id: { expiry: '2020-01-01' } })
  const id = await buy('s1', { customerId: c.id })
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`
    await tx`update gold.purchases set cash_10k_or_more = true, cash_band = '10k_plus', cash_amount = 12000 where id = ${id}`
  })
  await completePage(id)
  await expect(page.getByText('An ID on file had expired when this purchase was recorded.')).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'This purchase can’t go into an AUSTRAC report.' })).toBeVisible()
  await expect(saveButton('Save and continue to AUSTRAC')).toBeDisabled()
})

test('8b.48 — completing a part whose type\'s TTR for the invoice is already complete is refused: "already finished"', async () => {
  const c = await jane()
  const number = inv('C5')
  await buy('s1', { customerId: c.id, cash10k: 'true', cashAmount: '6000', erpInvoiceNo: number })
  const second = await buy('s1', { customerId: c.id, purchaseType: 'bullion', cash10k: undefined, bullionBand: '5k_to_10k', partAmount: '6000', erpInvoiceNo: number, ...yes })
  const s = await startTtr(await tokenOf('s1'), { purchaseId: second })
  expect(s.status, s.text).toBe(200)
  for (const t of s.body.ttrs) await completeTtr(t.id)
  const late = await buy('s1', { customerId: c.id })
  await completePage(late)
  await invoiceField().fill(number)
  await page.getByLabel('Cash paid for this part (AUD)').fill('0')
  await saveButton().click()
  await expect(page.getByText(`The AUSTRAC report for ${number} is already finished. Use a new ERP invoice number for this purchase.`)).toBeVisible()
  expect((await purchaseRow(late)).erp_invoice_no).toBeNull()
})

test('8b.49 — an already completed purchase says so; an unknown id and another business\'s purchase both say "Purchase not found."', async ({ browser }) => {
  const c = await jane()
  const done = await buy('s1', { customerId: c.id, erpInvoiceNo: inv('C6') })
  await page.goto(`/gold/purchases/${done}/complete`)
  await expect(page.getByRole('heading', { name: 'Purchase already completed' })).toBeVisible()
  await expect(page.getByText(/^Invoice INV-8B-/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back' })).toBeVisible()
  await page.goto(`/gold/purchases/${randomUUID()}/complete`)
  await expect(page.getByText('Purchase not found.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to To complete' })).toBeVisible()
  const two = await open(browser, 's2')
  try {
    const theirs = await buy('s2', { customerId: (await jane({ entity: E2 })).id, erpInvoiceNo: inv('C7') })
    await page.goto(`/gold/purchases/${theirs}/complete`)
    await expect(page.getByText('Purchase not found.')).toBeVisible()
    await expect(page.getByText('Purchase already completed')).toHaveCount(0)
    await expect(page.getByText(/INV-8B-/)).toHaveCount(0)
  } finally {
    await two.context.close()
  }
})
