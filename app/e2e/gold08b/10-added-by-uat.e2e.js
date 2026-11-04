// Gold Phase 8b UAT, rows added by UAT (8b.59 to 8b.62) from the spec: business isolation (4.3), password-only sessions
// (2.3), the server re-check shown on the screen (3.3, 4.3) and a hand-off that fails after the save (3.2).
import { expect, test } from '@playwright/test'
import {
  E2,
  buy,
  countPurchases,
  fillCommon,
  freshTab,
  inv,
  invoiceBox,
  jane,
  gina,
  makeImage,
  open,
  openAs,
  purchasesOf,
  scrapCash,
  sql,
  yesNo,
  openCustomer,
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

test('8b.59 (added by UAT, spec 4.3) — the record of another business\'s purchase says "Purchase not found." and shows nothing from it', async ({ browser }) => {
  const two = await open(browser, 's2')
  try {
    const theirs = await buy('s2', { customerId: (await jane({ entity: E2 })).id, erpInvoiceNo: inv('X1') })
    await page.goto(`/gold/purchases/${theirs}`)
    await expect(page.getByText('Purchase not found.')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to Purchases' })).toBeVisible()
    await expect(page.getByText(/INV-8B-/)).toHaveCount(0)
    await expect(page.getByText('Purchase ID')).toHaveCount(0)
    await page.goto('/gold/purchases')
    await expect(page.getByRole('status').filter({ hasText: /purchases?$/ })).toBeVisible()
    await expect(page.getByText(/INV-8B-[A-Z0-9]+-X1-/)).toHaveCount(0)
  } finally {
    await two.context.close()
  }
})

test('8b.60 (added by UAT, spec 2.3) — a password-only (aal1) session on Purchases, To complete or a purchase is sent to login and no purchase data is requested', async ({ browser }) => {
  const id = await buy('s1', { customerId: (await jane()).id, erpInvoiceNo: inv('X2') })
  for (const path of ['/gold/purchases', '/gold/to-complete', `/gold/purchases/${id}`, `/gold/purchases/${id}/complete`]) {
    const { context, page: p } = await openAs(browser, 'm1', { aal1: true })
    const rest = []
    p.on('request', (r) => r.url().includes('/rest/v1/') && rest.push(r.url()))
    await p.goto(path)
    await expect(p).toHaveURL(/\/login/)
    expect(rest.filter((u) => /search_gold_purchases|list_incomplete|purchases|goods_photos|invoice_purchases/.test(u)), path).toEqual([])
    await context.close()
  }
})

test('8b.61 (added by UAT, spec 3.3/4.3) — when the browser cannot see a used invoice, the server still refuses the reportable purchase and the screen shows its message under the invoice box', async () => {
  const number = inv('X3')
  await buy('s1', { customerId: (await gina()).id, cash10k: 'true', cashAmount: '12000', erpInvoiceNo: number })
  const c = await jane()
  await page.route('**/rpc/invoice_purchases*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
  const before = await countPurchases()
  await openCustomer(page, c)
  await scrapCash(page, 'Yes').click()
  await yesNo(page, `Is ${c.name} acting on their own behalf?`, 'Yes').click()
  await yesNo(page, 'Are these details still correct?', 'Yes').click()
  await fillCommon(page, img, { invoice: number })
  const sent = page.waitForResponse((r) => r.url().includes('/functions/v1/gold-save-purchase'))
  await page.getByRole('button', { name: /^Record purchase/ }).click()
  expect((await sent).status()).toBe(422)
  await expect(page.getByText(`The ERP invoice number ${number} is already used by another purchase.`, { exact: false })).toBeVisible()
  await expect(invoiceBox(page)).toHaveAttribute('aria-invalid', 'true')
  expect(await countPurchases()).toBe(before)
  expect(await purchasesOf(c.id)).toHaveLength(0)
  await page.unroute('**/rpc/invoice_purchases*')
})

test('8b.62 (added by UAT, spec 3.2) — if the TTR cannot be started after the save, the purchase stays saved, the page says so, and To complete offers Start TTR', async () => {
  const c = await gina()
  const number = inv('X4')
  await page.route('**/functions/v1/gold-start-ttr', (route) => route.abort())
  await openCustomer(page, c)
  await scrapCash(page, 'Yes').click()
  await fillCommon(page, img, { invoice: number })
  await page.getByRole('button', { name: 'Record purchase and continue to AUSTRAC' }).click()
  await expect(page.getByText(/^Purchase recorded, but the AUSTRAC report could not be started\./)).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}$`))
  const [p] = await purchasesOf(c.id)
  expect([p.erp_invoice_no, p.ttr_transaction_id]).toEqual([number, null])
  await page.unroute('**/functions/v1/gold-start-ttr')
  await page.goto('/gold/to-complete')
  await expect(page.locator('main li').filter({ hasText: c.name }).getByRole('button', { name: 'Start TTR' })).toBeVisible()
  expect(await sql`select 1 from ttr.transactions where transaction_ref = ${number}`).toHaveLength(0)
})
