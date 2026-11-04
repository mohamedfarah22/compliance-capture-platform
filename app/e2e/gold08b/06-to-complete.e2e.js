// Gold Phase 8b UAT, section B (rows 8b.36 to 8b.40): the To complete screen (spec 3.2, 3.3, 5.2 ToComplete row).
import { expect, test } from '@playwright/test'
import {
  freshTab,
  E2,
  abandonTransaction,
  backdate,
  buy,
  completeTtr,
  expectedToComplete,
  gina,
  headerCount,
  inv,
  jane,
  melbourneDate,
  open,
  reportableWithTtr,
  sql,
  txByRef,
  yes,
} from './support.js'

let ctx
let page
test.beforeAll(async ({ browser }) => {
  ctx = await open(browser, 's1')
  page = ctx.page
})
test.afterAll(async () => ctx?.context.close())
test.beforeEach(async () => freshTab(page))

const rowOf = (name) => page.locator('main li').filter({ hasText: name })
const section = (title) => page.getByRole('region', { name: new RegExp(`^${title}`) })

// Weekdays (Mon to Fri) from a YYYY-MM-DD date, worked out here and not with the app's helpers.
const day = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000
const isWeekday = (d) => ![0, 6].includes(new Date(d * 86_400_000).getUTCDay())
const addBusinessDays = (iso, n) => {
  let d = day(iso)
  for (let left = n; left > 0; ) if (isWeekday(++d)) left--
  return d
}
const businessDaysLeft = (dueDay, todayIso) => {
  let d = day(todayIso)
  let n = 0
  const step = dueDay >= d ? 1 : -1
  while (d !== dueDay) {
    d += step
    if (isWeekday(d)) n += step
  }
  return n
}
const plural = (n) => `${n} business day${n === 1 ? '' : 's'}`

test('8b.36 — To complete: "AUSTRAC pending" holds the reportable ones, "Other purchases" the rest; each row has names, tags, recorded-by and photos; Complete or Resume TTR', async () => {
  const a = await jane()
  const b = await jane()
  const g = await gina()
  const caseA = await buy('s1', { customerId: a.id, cash10k: 'true', cashAmount: '12000', ...yes })
  await buy('s1', { customerId: b.id })
  const caseB = await reportableWithTtr('s1', g, { number: inv('TC1'), answers: {} })
  await page.goto('/gold/to-complete')
  await expect(page.getByRole('heading', { name: 'To complete' })).toBeVisible()
  const want = await expectedToComplete()
  await expect(page.getByRole('heading', { name: `AUSTRAC pending (${want.pending})` })).toBeVisible()
  await expect(page.getByRole('heading', { name: `Other purchases (${want.other})` })).toBeVisible()
  const pending = section('AUSTRAC pending')
  const other = section('Other purchases')
  await expect(pending.locator('li').filter({ hasText: a.name })).toHaveCount(1)
  await expect(pending.locator('li').filter({ hasText: g.name })).toHaveCount(1)
  await expect(other.locator('li').filter({ hasText: b.name })).toHaveCount(1)
  await expect(pending.locator('li').filter({ hasText: a.name })).not.toContainText(g.name)
  const rowA = rowOf(a.name)
  await expect(rowA).toContainText('AUSTRAC pending')
  await expect(rowA).toContainText('Incomplete')
  await expect(rowA).toContainText('Recorded')
  await expect(rowA).toContainText('by UAT8a Staff')
  await expect(rowA).toContainText('1 photo')
  await expect(rowA.getByRole('button', { name: 'Complete' })).toBeVisible()
  await expect(rowOf(b.name).getByRole('button', { name: 'Complete' })).toBeVisible()
  await expect(rowOf(b.name)).not.toContainText('AUSTRAC pending')
  await expect(rowOf(g.name)).toContainText(`Invoice ${caseB.number}`)
  await expect(rowOf(g.name).getByRole('button', { name: 'Resume TTR' })).toBeVisible()
  await rowA.getByRole('button', { name: 'Complete' }).click()
  await expect(page).toHaveURL(new RegExp(`/gold/purchases/${caseA}/complete$`))
})

test('8b.37 — the AUSTRAC deadline line: sale date plus 10 business days, amber with more than 2 business days left, red with 2 or fewer or overdue', async () => {
  const fresh = await jane()
  const old = await jane()
  const edge = await jane()
  const mk = (c) => buy('s1', { customerId: c.id, cash10k: 'true', cashAmount: '12000', ...yes })
  const [pFresh, pOld, pEdge] = [await mk(fresh), await mk(old), await mk(edge)]
  const today = melbourneDate()
  // Sale dates chosen so the business days left are exactly 3 (amber), exactly 2 (red) and -2 (overdue, red).
  const daysAgoFor = (target) => {
    for (let k = 0; k < 40; k++) if (businessDaysLeft(addBusinessDays(melbourneDate(-k), 10), today) === target) return k
    throw new Error(`no sale date gives ${target}`)
  }
  await backdate(pFresh, daysAgoFor(3))
  await backdate(pOld, daysAgoFor(-2))
  await backdate(pEdge, daysAgoFor(2))
  await page.goto('/gold/to-complete')
  const expected = async (purchaseId) => {
    const [{ sale_date: saleDate }] = await sql`select sale_date::text from gold.purchases where id = ${purchaseId}`
    return businessDaysLeft(addBusinessDays(saleDate, 10), today)
  }
  const line = (name) => rowOf(name).locator('p', { hasText: 'AUSTRAC report due' })
  const colourOf = (name) => line(name).evaluate((el) => getComputedStyle(el).color)
  const [lf, lo, le] = [await expected(pFresh), await expected(pOld), await expected(pEdge)]
  const text = (n) => (n < 0 ? `Overdue by ${plural(-n)}` : n === 0 ? 'Due today' : `${plural(n)} left`)
  await expect(line(fresh.name)).toContainText(/AUSTRAC report due \d{1,2} \w+ \d{4} · /)
  await expect(line(fresh.name)).toContainText(text(lf))
  await expect(line(old.name)).toContainText(text(lo))
  await expect(line(edge.name)).toContainText(text(le))
  expect([lf, lo, le]).toEqual([3, -2, 2])
  const [amber, red, edgeColour] = [await colourOf(fresh.name), await colourOf(old.name), await colourOf(edge.name)]
  expect(red).not.toBe(amber)
  expect(edgeColour).toBe(red)
})

test('8b.38 — Resume TTR opens the same draft in the wizard at the first step that needs input, not a second one', async () => {
  const g = await gina()
  const t = await reportableWithTtr('s1', g, { number: inv('TC2'), answers: {} })
  await page.goto('/gold/to-complete')
  await rowOf(g.name).getByRole('button', { name: 'Resume TTR' }).click()
  await expect(page).toHaveURL(/\/customers$/)
  expect(await sql`select id from ttr.transactions where transaction_ref = ${t.number}`).toHaveLength(1)
  expect(await page.evaluate(() => Object.values(sessionStorage).join(' '))).toContain(t.ttrId)
})

test('8b.39 — after the draft TTR is deleted in the wizard the purchase is still listed with Start TTR, which makes a new draft with the same reference', async () => {
  const g = await gina()
  const t = await reportableWithTtr('s1', g, { number: inv('TC3'), answers: {} })
  await page.goto('/gold/to-complete')
  await rowOf(g.name).getByRole('button', { name: 'Resume TTR' }).click()
  await expect(page).toHaveURL(/\/customers$/)
  await abandonTransaction(page)
  expect(await sql`select id from ttr.transactions where id = ${t.ttrId}`).toHaveLength(0)
  await page.goto('/gold/to-complete')
  await expect(rowOf(g.name).getByRole('button', { name: 'Start TTR' })).toBeVisible()
  await rowOf(g.name).getByRole('button', { name: 'Start TTR' }).click()
  await expect(page).toHaveURL(/\/customers$/)
  const rows = await txByRef(t.number)
  expect(rows).toHaveLength(1)
  expect(rows[0].id).not.toBe(t.ttrId)
  expect(rows[0].status).toBe('draft')
})

test('8b.40 — a purchase leaves To complete when its TTR is complete (header count one lower); with nothing left: "Nothing to complete"', async ({ browser }) => {
  // Business Two: its staff, customers and purchases are used only here and by the isolation rows, which leave nothing incomplete.
  const two = await open(browser, 's2')
  try {
    const c = await jane({ entity: E2 })
    const t = await reportableWithTtr('s2', c, { number: inv('TC4') })
    await two.page.goto('/gold/to-complete')
    await expect(two.page.locator('main li').filter({ hasText: c.name }).getByRole('button', { name: 'Resume TTR' })).toBeVisible()
    const before = await headerCount(two.page)
    await completeTtr(t.ttrId)
    await two.page.reload()
    await expect(two.page.locator('main li').filter({ hasText: c.name })).toHaveCount(0)
    await expect.poll(() => headerCount(two.page)).toBe(before - 1)
    await expect(two.page.getByText('Nothing to complete. Every purchase has an invoice number.')).toBeVisible()
  } finally {
    await two.context.close()
  }
})
