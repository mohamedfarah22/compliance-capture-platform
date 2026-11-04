// Gold Phase 8b UAT, section E (rows 8b.55 to 8b.58): the Purchase record (spec 3.2, C1, 5.2 PurchaseRecord row).
import { expect, test } from '@playwright/test'
import {
  buy,
  completeTtr,
  dmy,
  freshTab,
  inv,
  jane,
  makeImage,
  melbourneDate,
  open,
  reportableWithTtr,
  sighted,
  sql,
  uniq,
  upload,
} from './support.js'

let ctx
let page
let img
test.beforeAll(async ({ browser }) => {
  ctx = await open(browser, 's1')
  page = ctx.page
  img = await makeImage(page, { width: 400, height: 300, label: 'ID' })
})
test.afterAll(async () => ctx?.context.close())
test.beforeEach(async () => freshTab(page))

const dd = (label) => page.locator('dt', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd')
const loaded = (locator) => expect.poll(() => locator.evaluate((i) => i.complete && i.naturalWidth > 0))
const withPhotos = (o = {}) => ({ front: img, back: img, ...o })
const AU = (iso) => new Intl.DateTimeFormat('en-AU', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`))

test('8b.55 — the record of a joint sale shows every detail, and for each seller the ID details used, the ID front and back photos, and the goods photos', async () => {
  const numberA = `RA${uniq()}`
  const numberB = `RB${uniq()}`
  const c = await jane({ id: withPhotos({ number: numberA, expiry: '2031-03-04' }) })
  const joan = await jane({ first: 'Joan', id: withPhotos({ number: numberB, expiry: '2029-06-07' }) })
  const number = inv('R1')
  const id = await buy('s1', { customerId: c.id, jointCustomerId: joan.id, cash10k: 'true', cashAmount: '12000', erpInvoiceNo: number })
  await page.goto(`/gold/purchases/${id}`)
  await expect(page.getByRole('heading', { name: 'Scrap jewellery purchase' })).toBeVisible()
  await expect(page.getByText(`ERP invoice ${number}`)).toBeVisible()
  await expect(dd('Recorded by')).toHaveText('UAT8a Staff')
  await expect(dd('Completed')).toHaveText('At capture')
  await expect(dd('Type')).toHaveText('Scrap jewellery')
  await expect(dd('AUSTRAC report \\(cash \\$10,000 or more\\)')).toHaveText('Yes')
  await expect(dd('Cash amount')).toHaveText('$12,000.00')
  await expect(dd('Phone at purchase')).toHaveText('0412 345 678')
  await expect(dd('Sighted in person')).toHaveText('Yes')
  await expect(dd('ID expired at time of purchase')).toHaveText('No')
  await expect(dd('Purchase ID')).toHaveText(id)
  await expect(dd('Recorded')).not.toHaveText('—')
  await expect(dd('Cash paid')).not.toHaveText('—')
  const main = page.locator('section').filter({ has: page.getByText('Main seller', { exact: true }) })
  const joint = page.locator('section').filter({ has: page.getByText('Joint seller', { exact: true }) })
  for (const [section, who, number_, expiry] of [[main, c, numberA, '2031-03-04'], [joint, joan, numberB, '2029-06-07']]) {
    await expect(section.getByRole('link', { name: who.name })).toBeVisible()
    await expect(section).toContainText('Driver licence')
    await expect(section).toContainText(number_)
    await expect(section).toContainText('VIC')
    await expect(section).toContainText(AU(expiry))
    await expect(section).toContainText(/Captured by UAT8a Staff on \d/)
    await loaded(section.getByRole('img', { name: new RegExp(`${who.name} — ID front`) }))
    await loaded(section.getByRole('img', { name: new RegExp(`${who.name} — ID back`) }))
  }
  await expect(page.getByRole('heading', { name: 'Goods photos (1)' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Goods photo 1' })).toHaveAttribute('src', /^http/)
})

test('8b.56 — after the ID is renewed, an older purchase still shows the ID details from the time, with the new photos labelled "Newer copy of this ID"', async () => {
  const number = `RN${uniq()}`
  const c = await jane({ id: withPhotos({ number, expiry: '2027-05-05' }) })
  const id = await buy('s1', { customerId: c.id, erpInvoiceNo: inv('R2') })
  await page.goto(`/gold/customers/${c.id}/update-id`)
  await page.getByRole('radio', { name: /^Renewed/ }).check()
  await page.getByLabel('ID expiry date').fill(dmy('2033-09-09'))
  await upload(page, 'ID front', img)
  await upload(page, 'ID back', img)
  await sighted(page).check()
  await page.getByRole('button', { name: 'Save new ID' }).click()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}$`))
  await page.goto(`/gold/purchases/${id}`)
  await expect(page.getByRole('heading', { name: 'Scrap jewellery purchase' })).toBeVisible()
  const seller = page.locator('section').filter({ has: page.getByText('Main seller', { exact: true }) })
  await expect(seller).toContainText(number)
  await expect(seller).toContainText(AU('2027-05-05'))
  await expect(seller).not.toContainText(AU('2033-09-09'))
  await expect(seller.getByText(`Newer copy of this ID, taken ${AU(melbourneDate())}`)).toBeVisible()
  await loaded(seller.getByRole('img', { name: new RegExp('ID front') }))
})

test('8b.57 — the AUSTRAC line: draft in progress with a link that opens the report, complete with no link, and nothing for a non-reportable purchase', async () => {
  const draft = await reportableWithTtr('s1', await jane(), { number: inv('R3') })
  const done = await reportableWithTtr('s1', await jane(), { number: inv('R4') })
  await completeTtr(done.ttrId)
  const plain = await buy('s1', { customerId: (await jane()).id, erpInvoiceNo: inv('R5') })
  await page.goto(`/gold/purchases/${plain}`)
  await expect(page.getByRole('heading', { name: 'Scrap jewellery purchase' })).toBeVisible()
  await expect(page.getByText(/AUSTRAC report:/)).toHaveCount(0)
  await page.goto(`/gold/purchases/${done.purchaseId}`)
  await expect(page.getByText('AUSTRAC report: complete')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open AUSTRAC report' })).toHaveCount(0)
  await page.goto(`/gold/purchases/${draft.purchaseId}`)
  await expect(page.getByText('AUSTRAC report: draft in progress.')).toBeVisible()
  await page.getByRole('link', { name: 'Open AUSTRAC report' }).click()
  await expect(page).not.toHaveURL(/\/gold/)
  await expect(page).toHaveURL(/\/transaction-details$/)
  expect(await page.evaluate(() => Object.values(sessionStorage).join(' '))).toContain(draft.ttrId)
})

test('8b.58 — an incomplete purchase has a Complete button that opens Complete purchase; there is no Download record or print button', async () => {
  const id = await buy('s1', { customerId: (await jane()).id })
  await page.goto(`/gold/purchases/${id}`)
  await expect(page.getByRole('heading', { name: 'Scrap jewellery purchase' })).toBeVisible()
  await expect(page.getByRole('button', { name: /download|print|export/i })).toHaveCount(0)
  await expect(dd('Completed')).toHaveText('Not yet')
  await page.getByRole('button', { name: 'Complete', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/gold/purchases/${id}/complete$`))
  await expect(page.getByRole('heading', { name: 'Complete purchase' })).toBeVisible()
  const done = await buy('s1', { customerId: (await jane()).id, erpInvoiceNo: inv('R6') })
  await page.goto(`/gold/purchases/${done}`)
  await expect(page.getByRole('heading', { name: 'Scrap jewellery purchase' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Complete', exact: true })).toHaveCount(0)
  expect(await sql`select 1 from gold.purchases where id = ${done}`).toHaveLength(1)
})
