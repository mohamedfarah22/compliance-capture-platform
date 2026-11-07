// Gold Phase 8b UAT, section D (rows 8b.50 to 8b.54): the Purchases screen (spec 3.2, 5.2 Purchases row, 8 step 7).
import { expect, test } from '@playwright/test'
import {
  E2,
  buy,
  completeTtr,
  freshTab,
  inv,
  jane,
  melbourneDate,
  open,
  reportableWithTtr,
  seed,
  startTtr,
  tokenOf,
  uniq,
  yes,
} from './support.js'

let staff
let manager
let admin
let two
test.beforeAll(async ({ browser }) => {
  staff = await open(browser, 's1')
  manager = await open(browser, 'm1')
  admin = await open(browser, 'a1')
  two = await open(browser, 's2')
})
test.afterAll(async () => {
  for (const c of [staff, manager, admin, two]) await c?.context.close()
})
test.beforeEach(async () => freshTab(staff.page))

const rows = (p) => p.locator('main ul li')
const summary = (p) => p.getByRole('status').filter({ hasText: /purchases?$|Loading/ })
const filtersOf = (p) => ({
  type: p.getByLabel('Type'),
  status: p.getByLabel('Status'),
  cash: p.getByLabel('Cash', { exact: true }),
  from: p.getByLabel('From'),
  to: p.getByLabel('To', { exact: true }),
  by: p.getByLabel('Recorded by'),
  search: p.getByLabel('Search'),
})

test('8b.50 — 26 purchases: 25 on the first page, Next shows the 26th with page=2 in the URL, Previous goes back, a row opens its record', async () => {
  const c = await jane({ entity: E2 })
  let last
  for (let i = 0; i < 26; i++) last = await buy('s2', { customerId: c.id, erpInvoiceNo: inv('P') })
  const p = two.page
  await p.goto('/gold/purchases')
  // Searching for this customer's unique name makes the list exactly these 26, whatever else the business holds.
  await filtersOf(p).search.fill(c.last)
  await expect(summary(p)).toHaveText('26 purchases')
  await expect(rows(p)).toHaveCount(25)
  await expect(rows(p).first()).toContainText('INV-8B-')
  await expect(p.getByText('Page 1 of 2')).toBeVisible()
  await p.getByRole('button', { name: 'Next' }).click()
  await expect(p).toHaveURL(/page=2/)
  await expect(rows(p)).toHaveCount(1)
  await expect(p.getByRole('button', { name: 'Next' })).toBeDisabled()
  await p.getByRole('button', { name: 'Previous' }).click()
  await expect(rows(p)).toHaveCount(25)
  await expect(p).not.toHaveURL(/page=/)
  await rows(p).first().getByRole('link').click()
  await expect(p).toHaveURL(new RegExp(`/gold/purchases/${last}$`))
})

test('8b.51 — the filters (type, status, cash, dates, recorded by) are in the URL, survive a reload, and Clear filters resets them; the search text is not in the URL', async () => {
  const hit = await jane()
  const decoys = { staff: await jane(), scrap: await jane(), done: await jane(), noncash: await jane() }
  const bullion10 = { purchaseType: 'bullion', cash10k: undefined, bullionBand: '10k_plus', cashAmount: '12000', ...yes }
  const mk = async (who, c, fields) => {
    const purchaseId = await buy(who, { customerId: c.id, ...fields })
    return purchaseId
  }
  const target = await mk('m1', hit, { ...bullion10, erpInvoiceNo: inv('F1') })
  expect((await startTtr(await tokenOf('m1'), { purchaseId: target })).status).toBe(200)
  const byStaff = await mk('s1', decoys.staff, { ...bullion10, erpInvoiceNo: inv('F2') })
  await startTtr(await tokenOf('s1'), { purchaseId: byStaff })
  const scrap = await mk('m1', decoys.scrap, { cash10k: 'true', cashAmount: '12000', erpInvoiceNo: inv('F3'), ...yes })
  await startTtr(await tokenOf('m1'), { purchaseId: scrap })
  const done = await mk('m1', decoys.done, { ...bullion10, erpInvoiceNo: inv('F4') })
  const started = await startTtr(await tokenOf('m1'), { purchaseId: done })
  await completeTtr(started.body.ttrs[0].id)
  await mk('m1', decoys.noncash, { purchaseType: 'bullion', cash10k: undefined, bullionBand: 'under_5k', erpInvoiceNo: inv('F5') })

  const p = staff.page
  await p.goto('/gold/purchases')
  const f = filtersOf(p)
  const today = melbourneDate()
  await f.type.selectOption({ label: 'Bullion' })
  await f.status.selectOption({ label: 'AUSTRAC pending' })
  await f.cash.selectOption({ label: 'Cash $10k+ (AUSTRAC)' })
  await f.from.fill(today)
  await f.to.fill(today)
  await f.by.selectOption({ label: 'UAT8a Manager' })
  await f.search.fill('zzz-not-in-url')
  await f.search.fill('')
  const url = new URL(p.url())
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ type: 'bullion', status: 'austrac_pending', cash: 'yes', from: today, to: today })
  expect(url.searchParams.get('by')).toBeTruthy()
  await expect(rows(p).filter({ hasText: hit.name })).toHaveCount(1)
  for (const d of Object.values(decoys)) await expect(rows(p).filter({ hasText: d.name })).toHaveCount(0)
  const before = await rows(p).allInnerTexts()
  await f.search.fill('zzz-not-in-url')
  expect(p.url()).not.toContain('zzz')
  await f.search.fill('')
  await p.reload()
  await expect(filtersOf(p).type).toHaveValue('bullion')
  await expect(filtersOf(p).status).toHaveValue('austrac_pending')
  await expect(filtersOf(p).cash).toHaveValue('yes')
  await expect(filtersOf(p).from).toHaveValue(today)
  await expect(filtersOf(p).to).toHaveValue(today)
  await expect(filtersOf(p).by).toHaveValue(url.searchParams.get('by'))
  await expect(filtersOf(p).search).toHaveValue('')
  await expect.poll(() => rows(p).allInnerTexts()).toEqual(before)
  await p.getByRole('button', { name: 'Clear filters' }).click()
  await expect(p).toHaveURL(/\/gold\/purchases$/)
  await expect(filtersOf(p).type).toHaveValue('')
  await expect(filtersOf(p).by).toHaveValue('')
  await expect(p.getByRole('button', { name: 'Clear filters' })).toHaveCount(0)
})

test('8b.52 — the search finds purchases by name (including as joint seller), phone, licence number and invoice number', async () => {
  const number = `LIC${uniq()}`
  const phone = `04${Math.floor(10_000_000 + Math.random() * 89_999_999)}`.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3')
  const p1 = await seed({ first: 'Pia', last: `Findme${uniq()}`, phone, profile: {}, id: { number } })
  const q1 = await jane()
  const invoice = inv('S1')
  await buy('s1', { customerId: p1.id, erpInvoiceNo: invoice })
  await buy('s1', { customerId: q1.id, jointCustomerId: p1.id, erpInvoiceNo: inv('S2') })
  const p = staff.page
  await p.goto('/gold/purchases')
  const search = filtersOf(p).search
  for (const [term, want] of [[p1.last, 2], [phone, 2], [number, 2], [invoice, 1]]) {
    await search.fill(term)
    await expect.poll(() => rows(p).count(), { message: `search for ${term}` }).toBe(want)
  }
  await search.fill(p1.last)
  await expect(rows(p).filter({ hasText: `${q1.name} and Pia ${p1.last}` })).toHaveCount(1)
})

test('8b.53 — the Status options and what each shows: AUSTRAC pending (reportable, TTR not complete), AUSTRAC (TTR complete), Completed, Incomplete', async () => {
  const c = await jane()
  const plain = inv('ST1')
  const noInvoice = await buy('s1', { customerId: c.id })
  await buy('s1', { customerId: c.id, erpInvoiceNo: plain })
  const pending = await reportableWithTtr('s1', c, { number: inv('ST2') })
  const finished = await reportableWithTtr('s1', c, { number: inv('ST3') })
  await completeTtr(finished.ttrId)
  const p = staff.page
  await p.goto('/gold/purchases')
  const f = filtersOf(p)
  await expect(f.status.locator('option')).toHaveText(['All', 'Incomplete', 'Completed', 'AUSTRAC pending', 'AUSTRAC'])
  await f.search.fill(c.last)
  const shown = async (status) => {
    await f.status.selectOption({ label: status })
    await expect(summary(p)).toHaveText(/\d+ purchases?$/)
    return (await rows(p).allInnerTexts()).map((t) => /INV-8B-\S+-(ST\d)-/.exec(t)?.[1] ?? 'none')
  }
  await expect.poll(() => shown('AUSTRAC pending')).toEqual(['ST2'])
  await expect.poll(() => shown('AUSTRAC')).toEqual(['ST3'])
  await expect.poll(async () => (await shown('Completed')).sort()).toEqual(['ST1', 'ST3'])
  await expect.poll(async () => (await shown('Incomplete')).sort()).toEqual(['ST2', 'none'])
  expect([noInvoice, pending.purchaseId].every(Boolean)).toBe(true)
})

test('8b.54 — there is no Download or print button on Purchases, for staff or an admin (that is Phase 9b)', async () => {
  for (const who of [staff, admin]) {
    await who.page.goto('/gold/purchases')
    await expect(who.page.getByRole('heading', { name: 'Purchases' })).toBeVisible()
    await expect(who.page.getByRole('button', { name: /download|print|export/i })).toHaveCount(0)
    await expect(who.page.getByRole('link', { name: /download|print|export/i })).toHaveCount(0)
  }
})
