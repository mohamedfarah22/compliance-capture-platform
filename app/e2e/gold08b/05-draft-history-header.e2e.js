// Gold Phase 8b UAT, section A (rows 8b.32 to 8b.35): the draft surviving navigation, the purchase history, its tags
// and the gold header (spec 3.2, 5.3, handover 5).
import { expect, test } from '@playwright/test'
import {
  freshTab,
  E1,
  addGoodsPhoto,
  buy,
  completeTtr,
  expectedToCompleteCount,
  headerCount,
  inv,
  invoiceBox,
  jane,
  makeImage,
  open,
  openCustomer,
  reportableWithTtr,
  scrapCash,
  sightedBox,
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

test('8b.32 — the draft survives a trip to Purchases, is dropped by Switch journey, and is empty after a save', async () => {
  const c = await jane()
  const number = inv('D1')
  await openCustomer(page, c)
  await scrapCash(page, 'Yes').click()
  await addGoodsPhoto(page, img)
  await invoiceBox(page).fill(number)
  await page.getByRole('navigation', { name: 'Gold' }).getByRole('link', { name: 'Purchases' }).click()
  await expect(page.getByRole('heading', { name: 'Purchases' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Record purchase' })).toBeVisible()
  await expect(invoiceBox(page)).toHaveValue(number)
  await expect(page.getByRole('img', { name: 'Goods photo 1' })).toBeVisible()
  await expect(scrapCash(page, 'Yes')).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('link', { name: 'Switch journey' }).click()
  await expect(page).not.toHaveURL(/\/gold/)
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Record purchase' })).toBeVisible()
  await expect(invoiceBox(page)).toHaveValue('')
  await expect(page.getByRole('img', { name: /^Goods photo/ })).toHaveCount(0)
  await expect(scrapCash(page, 'No')).toHaveAttribute('aria-checked', 'true')
  await addGoodsPhoto(page, img)
  await sightedBox(page).check()
  await page.getByRole('button', { name: 'Record purchase' }).click()
  await expect(page.getByText('Purchase recorded', { exact: false }).first()).toBeVisible()
  await expect(invoiceBox(page)).toHaveValue('')
  await expect(sightedBox(page)).not.toBeChecked()
})

test('8b.33 — Purchase history is newest first; each row has the invoice link, tags, date and time, photo count and the joint-sale link; the invoice opens the record', async () => {
  const c = await jane()
  const joan = await jane({ first: 'Joan' })
  const [a, b, d] = [inv('H1'), inv('H2'), inv('H3')]
  await buy('s1', { customerId: c.id, erpInvoiceNo: a })
  await buy('s1', { customerId: c.id, erpInvoiceNo: b, jointCustomerId: joan.id })
  const lastId = await buy('s1', { customerId: c.id, erpInvoiceNo: d })
  await page.goto(`/gold/customers/${c.id}`)
  const rows = page.locator('section[aria-labelledby="historyHeading"] li')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText(d)
  await expect(rows.nth(1)).toContainText(b)
  await expect(rows.nth(2)).toContainText(a)
  await expect(rows.nth(0)).toContainText('Scrap')
  await expect(rows.nth(0)).toContainText(/\d{1,2} \w{3} \d{4}.*\d{1,2}:\d{2}/)
  await expect(rows.nth(0)).toContainText('1 photo')
  await expect(rows.nth(1).getByRole('link', { name: joan.name })).toBeVisible()
  await expect(rows.nth(0).getByRole('link', { name: /^Joint sale/ })).toHaveCount(0)
  await rows.nth(0).getByRole('link', { name: `View purchase ${d}` }).click()
  await expect(page).toHaveURL(new RegExp(`/gold/purchases/${lastId}$`))
})

test('8b.34 — tags: "AUSTRAC pending" while the TTR is a draft, "AUSTRAC" once it is complete, neither for a non-reportable purchase; "Incomplete" without an invoice', async () => {
  const c = await jane()
  const draft = await reportableWithTtr('s1', c, { number: inv('T1') })
  const done = await reportableWithTtr('s1', await jane(), { number: inv('T2') })
  await completeTtr(done.ttrId)
  const plain = inv('T3')
  await buy('s1', { customerId: c.id, erpInvoiceNo: plain })
  await buy('s1', { customerId: c.id })
  await page.goto(`/gold/customers/${c.id}`)
  const row = (text) => page.locator('section[aria-labelledby="historyHeading"] li').filter({ hasText: text })
  await expect(row(draft.number)).toContainText('AUSTRAC pending')
  await expect(row(plain)).not.toContainText('AUSTRAC')
  await expect(row(plain)).not.toContainText('Incomplete')
  await expect(row('No invoice number yet')).toContainText('Incomplete')
  const other = page.locator('section[aria-labelledby="historyHeading"] li')
  await expect(other).toHaveCount(3)
  await page.goto(`/gold/purchases/${done.purchaseId}`)
  await expect(page.getByRole('heading', { name: 'Scrap jewellery purchase' })).toBeVisible()
  await expect(page.getByText('AUSTRAC pending', { exact: true })).toHaveCount(0)
  await expect(page.getByText('AUSTRAC', { exact: true })).toBeVisible()
})

test('8b.35 — the gold header: brand, To complete (n) matching the To complete screen, Purchases, the staff name, Switch journey, Sign out', async () => {
  await page.goto('/gold')
  const nav = page.getByRole('navigation', { name: 'Gold' })
  await expect(page.getByRole('link', { name: 'Gold due diligence' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Purchases' })).toBeVisible()
  await expect(nav.getByText('UAT8a Staff', { exact: true })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Switch journey' })).toBeVisible()
  await expect(nav.getByRole('button', { name: 'Sign out' })).toBeVisible()
  const n = await headerCount(page)
  await expect.poll(() => headerCount(page)).toBe(await expectedToCompleteCount(E1))
  await nav.getByRole('link', { name: /^To complete/ }).click()
  await expect(page.getByRole('heading', { name: 'To complete' })).toBeVisible()
  await expect(page.locator('main li').filter({ has: page.getByRole('button', { name: /Complete|Resume TTR|Start TTR/ }) })).toHaveCount(n)
})
