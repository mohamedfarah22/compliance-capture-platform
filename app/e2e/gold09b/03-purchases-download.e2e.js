// Gold Phase 9b UAT, section 4 (rows 9b.23 to 9b.34, 9b.44): "Download (n)" on Purchases and the zip it saves
// (spec 2.3, 5.2 Purchases row, 6.2, 1.7 C1). Rows 9b.7 and 9b.25 (the 200 cap) are in 06-cap.
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { idPayload, postMultipart } from '../gold06/support.js'
import {
  ACCOUNTS,
  auditRows,
  auditCount,
  buy,
  csvOf,
  freshTab,
  goodsJpeg,
  jane,
  makeImage,
  open,
  photo,
  sql,
  tokenOf,
  uniq,
  unzip,
  world9b,
} from './support.js'

let m1
let s1
let a1
let w
test.beforeAll(async ({ browser }) => {
  m1 = await open(browser, 'm1')
  s1 = await open(browser, 's1')
  a1 = await open(browser, 'a1')
  w = await world9b('m1', m1.page)
})
test.afterAll(async () => {
  for (const c of [m1, s1, a1]) await c?.context.close()
})
test.beforeEach(async () => {
  for (const c of [m1, s1, a1]) await freshTab(c.page)
})

const summary = (p) => p.getByRole('status').filter({ hasText: /purchases?$|Loading/ })
const downloadButton = (p) => p.getByRole('button', { name: /^(Download \(\d+\)|Preparing)/ })
const search = (p) => p.getByLabel('Search')
const day = async (id) => (await sql`select (created_at at time zone 'Australia/Melbourne')::date::text as d from gold.purchases where id = ${id}`)[0].d
const folder = async (id, invoice) => `${await day(id)}_${invoice || 'NO-INVOICE'}_${id}`

/** Shows the purchases that match `last` (and the optional URL filters), presses Download and returns the saved zip. */
const download = async (page, last, query = '') => {
  await page.goto(`/gold/purchases${query}`)
  await search(page).fill(last)
  await expect(summary(page)).toHaveText(/^\d+ purchases?$/)
  const n = Number((await summary(page).innerText()).split(' ')[0])
  const [dl] = await Promise.all([page.waitForEvent('download'), downloadButton(page).click()])
  const path = await dl.path()
  return { n, name: dl.suggestedFilename(), files: unzip(readFileSync(path)) }
}

test('9b.23 — Staff Sam sees no "Download (n)" and no "Download record"; Manager Mel and Admin Ada see both', async () => {
  for (const [who, shown] of [[s1, false], [m1, true], [a1, true]]) {
    const p = who.page
    await p.goto('/gold/purchases')
    await expect(p.getByRole('heading', { name: 'Purchases' })).toBeVisible()
    await expect(summary(p)).toHaveText(/\d+ purchases?$/)
    await expect(p.getByRole('button', { name: /^Download/ })).toHaveCount(shown ? 1 : 0)
    await p.goto(`/gold/purchases/${w.p2}`)
    await expect(p.getByRole('heading', { level: 1, name: /purchase$/ })).toBeVisible()
    await expect(p.getByRole('button', { name: 'Download record' })).toHaveCount(shown ? 1 : 0)
    await expect(p.getByText('Opens the print dialog with the ID photos')).toHaveCount(shown ? 1 : 0)
  }
})

test('9b.24 — the button reads "Download (n)" with n the count under the filters, follows the filters, and is disabled with 0 results', async () => {
  const p = m1.page
  await p.goto('/gold/purchases')
  const count = async () => {
    await expect(summary(p)).toHaveText(/^\d+ purchases?$/)
    return Number((await summary(p).innerText()).split(' ')[0])
  }
  const n = await count()
  expect(n).toBeGreaterThanOrEqual(3)
  await expect(downloadButton(p)).toHaveText(`Download (${n})`)
  await p.getByLabel('Status').selectOption({ label: 'AUSTRAC' })
  await expect.poll(count).toBeLessThan(n)
  const austrac = await count()
  await expect(downloadButton(p)).toHaveText(`Download (${austrac})`)
  await p.getByLabel('Status').selectOption({ label: 'All' })
  await search(p).fill(`nobody-${uniq()}`)
  await expect(summary(p)).toHaveText('0 purchases')
  await expect(downloadButton(p)).toHaveText('Download (0)')
  await expect(downloadButton(p)).toBeDisabled()
})

let zip12
test('9b.26 — Download (2) for P1 and P2 shows "Preparing… x/2", saves purchases-<today>.zip, writes one zip audit row with the current filters (search text included) and exactly P1, P2, and says "Downloaded 2 purchases"', async () => {
  const p = m1.page
  await p.route('**/functions/v1/gold-export', async (route) => {
    await new Promise((r) => setTimeout(r, 2000))
    await route.continue()
  })
  const before = (await auditRows(ACCOUNTS.m1.entity)).length
  await p.goto('/gold/purchases?cash=yes')
  await search(p).fill(w.jane.last)
  await expect(summary(p)).toHaveText('2 purchases')
  const saved = p.waitForEvent('download')
  await downloadButton(p).click()
  await expect(p.getByRole('button', { name: /^Preparing… \d\/2$/ })).toBeDisabled()
  const dl = await saved
  const today = await p.evaluate(() => new Date().toLocaleDateString('en-CA'))
  expect(dl.suggestedFilename()).toBe(`purchases-${today}.zip`)
  zip12 = unzip(readFileSync(await dl.path()))
  await expect(p.getByRole('status').filter({ hasText: 'Downloaded 2 purchases' })).toBeVisible()
  await p.unroute('**/functions/v1/gold-export')
  const rows = (await auditRows(ACCOUNTS.m1.entity)).slice(before)
  expect(rows).toHaveLength(1)
  expect(rows[0].kind).toBe('zip')
  expect(rows[0].staff_member_id).toBe(ACCOUNTS.m1.id)
  expect(rows[0].filters).toEqual({ q: w.jane.last, cash: 'yes' })
  expect([...rows[0].purchase_ids].sort()).toEqual([w.p1, w.p2].sort())
})

test('9b.27 — the zip holds purchases.csv, READ ME.txt and one folder per purchase with the ID front/back (both sellers for P2) and goods photos, the files being the stored images', async () => {
  const f12 = zip12
  const d1 = await folder(w.p1, w.n1)
  const d2 = await folder(w.p2, w.n2)
  expect(Object.keys(f12).sort()).toEqual(
    [
      'READ ME.txt',
      'purchases.csv',
      ...['main-seller-id-front', 'main-seller-id-back', 'goods-1', 'goods-2'].map((n) => `${d1}/${n}.jpg`),
      ...['main-seller-id-front', 'main-seller-id-back', 'joint-seller-id-front', 'joint-seller-id-back', 'goods-1'].map((n) => `${d2}/${n}.jpg`),
    ].sort(),
  )
  const readme = f12['READ ME.txt'].toString('utf8')
  expect(readme).toMatch(/downloaded \d{1,2}\/\d{1,2}\/\d{4}/)
  expect(readme).toContain('2 purchase(s).')
  expect(readme).toContain('This download contains identity documents.')
  const same = (name, expected) => expect(f12[name].equals(expected), name).toBe(true)
  same(`${d1}/main-seller-id-front.jpg`, w.front)
  same(`${d1}/main-seller-id-back.jpg`, w.back)
  same(`${d1}/goods-1.jpg`, goodsJpeg(1))
  same(`${d1}/goods-2.jpg`, goodsJpeg(2))
  same(`${d2}/main-seller-id-front.jpg`, w.front)
  same(`${d2}/joint-seller-id-front.jpg`, w.joanFront)
  same(`${d2}/joint-seller-id-back.jpg`, w.joanBack)
  same(`${d2}/goods-1.jpg`, goodsJpeg(3))
})

test('9b.29 — purchases.csv has the 30 columns in order, one row per purchase, and folder matches the zip folder', async () => {
  const { header, rows } = csvOf(zip12)
  expect(header).toEqual(
    'purchase_id,recorded_at,recorded_by,status,completed_at,completed_by,erp_invoice_no,purchase_type,cash_paid,austrac_reportable,cash_amount_aud,main_seller_name,main_seller_phone,main_id_type,main_id_number,main_id_expiry,joint_seller_name,joint_seller_phone,joint_id_type,joint_id_number,joint_id_expiry,phone_at_purchase,id_sighted,id_expired_at_time,goods_photo_count,folder,ttr_status,ttr_reference,id_document_used,id_photo_copy_taken'.split(','),
  )
  expect(rows).toHaveLength(2)
  const byId = Object.fromEntries(rows.map((r) => [r.purchase_id, r]))
  expect(byId[w.p1].folder).toBe(await folder(w.p1, w.n1))
  expect(byId[w.p2].folder).toBe(await folder(w.p2, w.n2))
  expect(byId[w.p1]).toMatchObject({ erp_invoice_no: w.n1, main_seller_name: w.jane.name, main_id_number: w.janeNumber, joint_seller_name: '', goods_photo_count: '2' })
  expect(byId[w.p2]).toMatchObject({ joint_seller_name: w.joan.name, joint_id_number: w.joanNumber, goods_photo_count: '1', ttr_status: 'draft' })
})

// One purchase whose seller is José O"Brien, Zq<tag>, downloaded once for the three 9b.30 tests.
let accent
const accentDownload = async () => {
  if (accent) return accent
  const last = `O"Brien, Zq${uniq()}`
  const c = await jane({ first: 'José', last })
  await buy('m1', { customerId: c.id, erpInvoiceNo: `INV-9B-${uniq()}` })
  const { files } = await download(m1.page, `Zq${last.split('Zq')[1]}`)
  accent = { last, ...csvOf(files) }
  return accent
}

test('9b.30 ⚠ — (a) purchases.csv starts with the UTF-8 byte order mark (EF BB BF)', async () => {
  const { bytes } = await accentDownload()
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
})

test('9b.30 ⚠ — (b) lines end CRLF and every cell is in double quotes', async () => {
  const { bytes } = await accentDownload()
  const lines = bytes.toString('utf8').replace(/^﻿/, '').split('\r\n')
  expect(lines).toHaveLength(3) // header, one purchase, and the empty piece after the last CRLF
  expect(lines[2]).toBe('')
  for (const line of lines.slice(0, 2)) expect(line).toMatch(/^"(?:[^"]|"")*"(?:,"(?:[^"]|"")*")*$/)
})

test('9b.30 ⚠ — (c) a double quote inside a cell is doubled, and a name with a comma, a quote and an accent (José O"Brien, Zq…) reads back unchanged', async () => {
  const { bytes, rows, last } = await accentDownload()
  expect(bytes.toString('utf8')).toContain('"José O""Brien, Zq')
  expect(rows).toHaveLength(1)
  expect(rows[0].main_seller_name).toBe(`José ${last}`)
})

test('9b.31 ⚠ — a cell that starts with = + - @ a tab or a carriage return is written with a leading \' inside the quotes; other cells are unchanged', async () => {
  const p = m1.page
  const tag = `Fq${uniq()}`
  const firsts = ['=HYPERLINK("http://x")', '+1', '-1', '@SUM(1)', '\tTabbed', '\rReturned', 'Plain']
  for (const first of firsts) {
    const c = await jane({ first, last: `Citizen ${tag}` })
    await buy('m1', { customerId: c.id })
  }
  const { files } = await download(p, tag)
  const { rows } = csvOf(files)
  expect(rows).toHaveLength(firsts.length)
  const names = rows.map((r) => r.main_seller_name).sort()
  const want = firsts.map((f) => (/^[=+\-@\t\r]/.test(f) ? `'${f}` : f) + ` Citizen ${tag}`).sort()
  expect(names).toEqual(want)
  const raw = files['purchases.csv'].toString('utf8')
  expect(raw).toContain(`"'=HYPERLINK(""http://x"") Citizen ${tag}"`)
  expect(raw).toContain(`"'+1 Citizen ${tag}"`)
  expect(raw).toContain(`"'-1 Citizen ${tag}"`)
  expect(raw).toContain(`"'@SUM(1) Citizen ${tag}"`)
  expect(raw).toContain(`"Plain Citizen ${tag}"`)
})

test('9b.32 — P1 and P3: P1 Completed / AUSTRAC Yes / complete INV-1 reference; P3 Incomplete / AUSTRAC No / empty TTR / 0 goods photos and a NO-INVOICE folder with no images', async () => {
  const { files } = await download(m1.page, w.jane.last, '?type=scrap')
  const { rows } = csvOf(files)
  expect(rows).toHaveLength(2)
  const r1 = rows.find((r) => r.purchase_id === w.p1)
  const r3 = rows.find((r) => r.purchase_id === w.p3)
  expect(r1).toMatchObject({ status: 'Completed', austrac_reportable: 'Yes', ttr_status: 'complete', ttr_reference: w.n1 })
  expect(r3).toMatchObject({ status: 'Incomplete', austrac_reportable: 'No', ttr_status: '', ttr_reference: '', goods_photo_count: '0', erp_invoice_no: '' })
  const d3 = await folder(w.p3, '')
  expect(r3.folder).toBe(d3)
  expect(Object.keys(files).filter((n) => n.startsWith(`${d3}/`))).toEqual([])
})

test('9b.33 ⚠ — if the manager\'s role was changed to staff after the page loaded, Download shows "You do not have permission to do that.", saves no file and writes no audit row', async () => {
  const p = m1.page
  await p.goto('/gold/purchases')
  await search(p).fill(w.jane.last)
  await expect(summary(p)).toHaveText(/^\d+ purchases?$/)
  const before = await auditCount()
  let saved = false
  p.on('download', () => (saved = true))
  await sql`update public.staff_members set role = 'staff' where id = ${ACCOUNTS.m1.id}`
  try {
    await downloadButton(p).click()
    await expect(p.getByRole('status').filter({ hasText: 'You do not have permission to do that.' })).toBeVisible()
  } finally {
    await sql`update public.staff_members set role = 'manager' where id = ${ACCOUNTS.m1.id}`
  }
  expect(saved).toBe(false)
  expect(await auditCount()).toBe(before)
})

test('9b.34 — if one photo URL cannot be fetched the zip is still saved with the other photos and every CSV row, with no error page', async () => {
  const p = m1.page
  let blocked = false
  await p.route('**/object/sign/gold-goods/**', (route) => (blocked ? route.fallback() : ((blocked = true), route.abort())))
  try {
    const { files } = await download(p, w.jane.last, '?cash=yes')
    const { rows } = csvOf(files)
    expect(blocked).toBe(true)
    expect(rows).toHaveLength(2)
    const goods = Object.keys(files).filter((n) => /\/goods-\d\.jpg$/.test(n))
    expect(goods).toHaveLength(3 - 1)
    expect(Object.keys(files).filter((n) => /id-(front|back)\.jpg$/.test(n))).toHaveLength(6)
    await expect(p.getByRole('status').filter({ hasText: 'Downloaded 2 purchases' })).toBeVisible()
  } finally {
    await p.unroute('**/object/sign/gold-goods/**')
  }
})



test('9b.28 ⚠ — C1 in the zip: after the licence is renewed the downloaded ID images are the newer copy\'s (the image the record page shows), and the CSV says "newer copy" with its date', async () => {
  const p = m1.page
  const front = await makeImage(p, { width: 300, height: 200, label: 'OLD-F' })
  const back = await makeImage(p, { width: 300, height: 200, label: 'OLD-B' })
  const number = `DLZ${uniq()}`
  const c = await jane({ id: { front, back, number } })
  const pid = await buy('m1', { customerId: c.id, erpInvoiceNo: `INV-9B-${uniq()}` })
  // Real pictures, so the record page can draw them.
  const NEW_FRONT = { bytes: await makeImage(p, { width: 320, height: 210, label: 'NEW-F' }), type: 'image/jpeg' }
  const NEW_BACK = { bytes: await makeImage(p, { width: 320, height: 210, label: 'NEW-B' }), type: 'image/jpeg' }
  const upd = await postMultipart('gold-update-customer-id', await tokenOf('m1'), idPayload(c.id, { documentNumber: number }), { front: NEW_FRONT, back: NEW_BACK })
  expect(upd.status, upd.text).toBe(201)
  await p.goto(`/gold/purchases/${pid}`)
  await expect(p.getByText(/^Newer copy of this ID, taken \d{2} \w{3} \d{4}$/)).toBeVisible()
  const shown = p.locator('img[alt$="— ID front"]')
  await expect.poll(() => shown.evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true)
  const shownBytes = Buffer.from(await shown.evaluate(async (i) => {
    const buf = new Uint8Array(await (await fetch(i.src)).arrayBuffer())
    return Array.from(buf)
  }))
  expect(shownBytes.equals(NEW_FRONT.bytes)).toBe(true)
  const { files } = await download(p, c.last)
  const dir = await folder(pid, (await sql`select erp_invoice_no from gold.purchases where id = ${pid}`)[0].erp_invoice_no)
  expect(files[`${dir}/main-seller-id-front.jpg`].equals(NEW_FRONT.bytes)).toBe(true)
  expect(files[`${dir}/main-seller-id-back.jpg`].equals(NEW_BACK.bytes)).toBe(true)
  const [row] = csvOf(files).rows
  expect(row.id_photo_copy_taken).toMatch(/^main: newer copy, taken \d{4}-\d{2}-\d{2}$/)
  expect(row.id_document_used).toMatch(/^main: Driver licence, captured \d{4}-\d{2}-\d{2}$/)
})
