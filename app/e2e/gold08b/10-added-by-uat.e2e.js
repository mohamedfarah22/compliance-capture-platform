// Gold Phase 8b UAT, rows added by UAT (8b.59 to 8b.64) from the spec: business isolation (4.3), password-only sessions
// (2.3), the server re-check shown on the screen (3.3, 4.3) and a hand-off that fails after the save (3.2).
import { expect, test } from '@playwright/test'
import {
  E2,
  buy,
  completeTtr,
  countPurchases,
  startTtr,
  tokenOf,
  yes,
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

test('8b.63 (added by UAT, spec 3.4 "Finishing both") — To complete lists both purchases of a mixed invoice, each with Resume TTR, until both TTRs are complete', async () => {
  const c = await jane()
  const number = inv('X5')
  const first = await buy('s1', { customerId: c.id, cash10k: 'true', cashAmount: '6000', erpInvoiceNo: number })
  const second = await buy('s1', { customerId: c.id, purchaseType: 'bullion', cash10k: undefined, bullionBand: '5k_to_10k', partAmount: '6000', erpInvoiceNo: number, ...yes })
  const s = await startTtr(await tokenOf('s1'), { purchaseId: second })
  expect(s.status, s.text).toBe(200)
  expect(s.body.ttrs).toHaveLength(2)
  // The earlier (scrap) part is linked to a draft TTR but its own flag is false; its record still shows the AUSTRAC report.
  await page.goto(`/gold/purchases/${first}`)
  await expect(page.getByText(/AUSTRAC report: draft in progress/)).toBeVisible()
  const rowsOf = async () => {
    await page.goto('/gold/to-complete')
    await expect(page.getByRole('heading', { name: 'To complete' })).toBeVisible()
    await expect(page.getByText('Loading…')).toHaveCount(0)
    return page.locator('main li').filter({ hasText: c.name })
  }
  let rows = await rowsOf()
  await expect(rows).toHaveCount(2)
  await expect(rows.getByRole('button', { name: 'Resume TTR' })).toHaveCount(2)
  await completeTtr(s.body.ttrs[0].id)
  rows = await rowsOf()
  await expect(rows).toHaveCount(1)
  await completeTtr(s.body.ttrs[1].id)
  rows = await rowsOf()
  await expect(rows).toHaveCount(0)
})

test('8b.64 (added by UAT, spec 3.2 "AUSTRAC pending" and 3.4) — the part of a mixed invoice that is linked to an incomplete TTR sits under "AUSTRAC pending" with that tag and the deadline line, whichever part tipped the total', async () => {
  const c = await jane()
  const number = inv('X6')
  await buy('s1', { customerId: c.id, cash10k: 'true', cashAmount: '6000', erpInvoiceNo: number })
  const second = await buy('s1', { customerId: c.id, purchaseType: 'bullion', cash10k: undefined, bullionBand: '5k_to_10k', partAmount: '6000', erpInvoiceNo: number, ...yes })
  const s = await startTtr(await tokenOf('s1'), { purchaseId: second })
  expect(s.status, s.text).toBe(200)
  await page.goto('/gold/to-complete')
  await expect(page.getByRole('heading', { name: 'To complete' })).toBeVisible()
  await expect(page.getByText('Loading…')).toHaveCount(0)
  const rows = page.locator('main li').filter({ hasText: c.name })
  await expect(rows).toHaveCount(2)
  const pending = page.getByRole('region', { name: /^AUSTRAC pending/ })
  await expect(pending.locator('li').filter({ hasText: c.name })).toHaveCount(2)
  await expect(rows.filter({ hasText: 'AUSTRAC pending' })).toHaveCount(2)
  await expect(rows.locator('p', { hasText: 'AUSTRAC report due' })).toHaveCount(2)
})
