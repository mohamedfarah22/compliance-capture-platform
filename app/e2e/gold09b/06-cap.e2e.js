// Gold Phase 9b UAT, rows 9b.7, 9b.25 and 9b.44: the 200-purchase cap, on gold-export and on the Download button
// (spec 6.2 "at most 200 purchases per export"). 201 purchases of one customer are saved once for the file.
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { ACCOUNTS, E1, auditCount, auditRows, backdate, buy, csvOf, freshTab, jane, melbourneDate, open, tokenOf, unzip, zipReq } from './support.js'

test.setTimeout(600_000)
let m1
let ids
let customer
test.beforeAll(async ({ browser }) => {
  m1 = await open(browser, 'm1')
  customer = await jane()
  ids = []
  for (let i = 0; i < 201; i += 10) {
    const batch = Array.from({ length: Math.min(10, 201 - i) }, () => buy('m1', { customerId: customer.id }))
    ids.push(...(await Promise.all(batch)))
  }
  // The oldest one is backdated, so a "From today" filter leaves exactly 200.
  await backdate(ids[0], 40)
})
test.afterAll(async () => m1?.context.close())
test.beforeEach(async () => freshTab(m1.page))

const summary = (p) => p.getByRole('status').filter({ hasText: /purchases?$|Loading/ })
const button = (p) => p.getByRole('button', { name: /^(Download \(\d+\)|Preparing)/ })

test('9b.7 ⚠ — exactly 200 distinct purchases: 200 OK and one audit row holding 200 ids; 201: 400 too_many_purchases, no audit row', async () => {
  const token = await tokenOf('m1')
  const before = (await auditRows(E1)).length
  const ok = await zipReq(token, ids.slice(0, 200))
  expect(ok.status, ok.text.slice(0, 200)).toBe(200)
  expect(ok.body.purchases).toHaveLength(200)
  const rows = (await auditRows(E1)).slice(before)
  expect(rows).toHaveLength(1)
  expect(rows[0].purchase_ids).toHaveLength(200)
  const count = await auditCount()
  const over = await zipReq(token, ids)
  expect([over.status, over.body]).toEqual([400, { error: 'too_many_purchases' }])
  expect(over.text).not.toMatch(/https?:/)
  expect(await auditCount()).toBe(count)
  // The same cap, with duplicates not counting: 201 ids of which 200 are distinct is allowed.
  const dup = await zipReq(token, [...ids.slice(0, 200), ids[0]])
  expect(dup.status).toBe(200)
})

test('9b.25 — with 201 matches the button is disabled and the page says "Too many purchases to download (201). Narrow the filters to 200 or fewer."; at 200 it is enabled', async () => {
  const p = m1.page
  await p.goto('/gold/purchases')
  await p.getByLabel('Search').fill(customer.last)
  await expect(summary(p)).toHaveText('201 purchases')
  await expect(button(p)).toHaveText('Download (201)')
  await expect(button(p)).toBeDisabled()
  await expect(p.getByRole('alert').filter({ hasText: 'Too many purchases to download (201). Narrow the filters to 200 or fewer.' })).toBeVisible()
  await p.getByLabel('From').fill(melbourneDate())
  await expect(summary(p)).toHaveText('200 purchases')
  await expect(button(p)).toHaveText('Download (200)')
  await expect(button(p)).toBeEnabled()
  await expect(p.getByText('Too many purchases to download')).toHaveCount(0)
})

test('9b.44 — (added by UAT, spec 6.2) Download (200) takes every matching purchase, not just the first page: the zip has 200 CSV rows and 200 folders, and the audit row holds the same 200 ids', async () => {
  const p = m1.page
  await p.goto(`/gold/purchases?from=${melbourneDate()}`)
  await p.getByLabel('Search').fill(customer.last)
  await expect(summary(p)).toHaveText('200 purchases')
  const before = (await auditRows(E1)).length
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 300_000 }), button(p).click()])
  const files = unzip(readFileSync(await dl.path()))
  const { rows } = csvOf(files)
  expect(rows).toHaveLength(200)
  expect(new Set(rows.map((r) => r.purchase_id))).toEqual(new Set(ids.slice(1)))
  const folders = new Set(Object.keys(files).filter((n) => n.includes('/')).map((n) => n.split('/')[0]))
  expect(folders.size).toBe(200)
  const audit = (await auditRows(E1)).slice(before)
  expect(audit).toHaveLength(1)
  expect([...audit[0].purchase_ids].sort()).toEqual([...ids.slice(1)].sort())
  expect(audit[0].staff_member_id).toBe(ACCOUNTS.m1.id)
})
