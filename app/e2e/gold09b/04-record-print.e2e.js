// Gold Phase 9b UAT, section 5 (rows 9b.35 to 9b.41): Download record and printing on the Purchase record
// (spec 6.2 Printing, 2.3, 9 "Ctrl+P hides ID photos; Download record shows them", 6.4).
// window.print is replaced by a recorder (a headless browser opens no dialog); the print styles are checked with
// emulateMedia({ media: 'print' }). The `afterprint` event is sent by the test, as the browser does when the dialog closes.
import { expect, test } from '@playwright/test'
import { ACCOUNTS, E1, auditCount, auditRows, freshTab, open, sql, world9b } from './support.js'

let m1
let w
test.beforeAll(async ({ browser }) => {
  m1 = await open(browser, 'm1')
  w = await world9b('m1', m1.page)
  // What happened on the page, in order: gold-export start/finish and each window.print call.
  await m1.page.addInitScript(() => {
    window.__log = []
    window.print = () => window.__log.push(`print(class on: ${Boolean(document.querySelector('article[class*="printIdPhotos"]'))})`)
    const realFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      const isExport = url.includes('/functions/v1/gold-export')
      if (isExport) window.__log.push('export:start')
      try {
        return await realFetch(input, init)
      } finally {
        if (isExport) window.__log.push('export:done')
      }
    }
  })
})
test.afterAll(async () => m1?.context.close())
test.beforeEach(async () => freshTab(m1.page))

const log = (p) => p.evaluate(() => window.__log)
const idPhotos = (p) => p.locator('img[alt$="— ID front"], img[alt$="— ID back"]')
const goodsPhotos = (p) => p.locator('img[alt^="Goods photo"]')
const downloadRecord = (p) => p.getByRole('button', { name: 'Download record' })
const open_ = async (p, id) => {
  await p.emulateMedia({ media: 'screen' })
  await p.goto(`/gold/purchases/${id}`)
  await expect(p.getByRole('heading', { level: 1, name: /purchase$/ })).toBeVisible()
  await expect(idPhotos(p)).toHaveCount(id === w.p2 ? 4 : 0)
}
const afterPrint = (p) => p.evaluate(() => window.dispatchEvent(new Event('afterprint')))

test('9b.35 ⚠ — Download record calls gold-export (kind record, [P2]) and finishes before the print dialog opens; one audit row; pressing it twice writes two rows', async () => {
  const p = m1.page
  await open_(p, w.p2)
  const before = (await auditRows(E1)).length
  await downloadRecord(p).click()
  await expect.poll(() => log(p)).toEqual(['export:start', 'export:done', 'print(class on: true)'])
  let rows = (await auditRows(E1)).slice(before)
  expect(rows).toHaveLength(1)
  expect([rows[0].kind, rows[0].purchase_ids, rows[0].staff_member_id, rows[0].filters]).toEqual(['record', [w.p2], ACCOUNTS.m1.id, null])
  await afterPrint(p)
  await downloadRecord(p).click()
  await expect.poll(async () => (await log(p)).filter((l) => l === 'export:done').length).toBe(2)
  rows = (await auditRows(E1)).slice(before)
  expect(rows).toHaveLength(2)
})

test('9b.36 ⚠ — if gold-export refuses (403) or fails (500), the print dialog does not open, the page shows the error and the ID photos stay hidden for print', async () => {
  const p = m1.page
  await open_(p, w.p2)
  const before = await auditCount()
  for (const [status, error, message] of [
    [403, 'forbidden', 'You do not have permission to do that.'],
    [500, 'server_error', 'Could not prepare the download. Try again.'],
  ]) {
    await p.route('**/functions/v1/gold-export', (route) =>
      route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error }) }),
    )
    await downloadRecord(p).click()
    await expect(p.getByRole('alert').filter({ hasText: message })).toBeVisible()
    await p.unroute('**/functions/v1/gold-export')
  }
  expect((await log(p)).filter((l) => l.startsWith('print'))).toEqual([])
  expect(await auditCount()).toBe(before)
  await p.emulateMedia({ media: 'print' })
  await expect(idPhotos(p).first()).toBeHidden()
  await expect(idPhotos(p)).toHaveCount(4)
  for (const photo of await idPhotos(p).all()) await expect(photo).toBeHidden()
})

test('9b.37 ⚠ — a plain print (Ctrl+P) of P2 shows the purchase details and the goods photo but no ID front or back photo of either seller', async () => {
  const p = m1.page
  await open_(p, w.p2)
  for (const photo of await idPhotos(p).all()) await expect(photo).toBeVisible()
  await p.emulateMedia({ media: 'print' })
  for (const photo of await idPhotos(p).all()) await expect(photo).toBeHidden()
  await expect(goodsPhotos(p)).toHaveCount(1)
  await expect(goodsPhotos(p).first()).toBeVisible()
  await expect(p.getByText(w.janeNumber)).toBeVisible()
  await expect(p.getByText(w.joanNumber)).toBeVisible()
  await expect(p.getByRole('heading', { level: 1, name: /purchase$/ })).toBeVisible()
})

test('9b.46 — (added by UAT, spec 6.2 print styles) the gold page header is not printed', async () => {
  const p = m1.page
  await open_(p, w.p2)
  await expect(p.getByRole('banner')).toBeVisible()
  await p.emulateMedia({ media: 'print' })
  await expect(p.getByRole('banner')).toBeHidden()
})

test('9b.47 — (added by UAT, spec 6.2 print styles) Back to Purchases, Complete, Download record and its hint are not printed', async () => {
  const p = m1.page
  await open_(p, w.p3)
  const parts = [p.getByText('Back to Purchases'), p.getByRole('button', { name: 'Complete', exact: true }), downloadRecord(p), p.getByText('Opens the print dialog with the ID photos')]
  for (const part of parts) await expect(part).toBeVisible()
  await p.emulateMedia({ media: 'print' })
  for (const part of parts) await expect(part).toBeHidden()
})

test('9b.38 ⚠ — after Download record the print shows the ID front and back photos of both sellers, with the details and goods photos', async () => {
  const p = m1.page
  await open_(p, w.p2)
  await downloadRecord(p).click()
  await expect.poll(() => log(p)).toContain('print(class on: true)')
  await p.emulateMedia({ media: 'print' })
  expect(await idPhotos(p).count()).toBe(4)
  for (const photo of await idPhotos(p).all()) await expect(photo).toBeVisible()
  await expect(goodsPhotos(p).first()).toBeVisible()
  await expect(p.getByText(w.janeNumber)).toBeVisible()
  await expect(downloadRecord(p)).toBeHidden()
})

test('9b.39 ⚠ — once the print dialog closes (afterprint) a plain Ctrl+P hides the ID photos again', async () => {
  const p = m1.page
  await open_(p, w.p2)
  await downloadRecord(p).click()
  await expect.poll(() => log(p)).toContain('print(class on: true)')
  await p.emulateMedia({ media: 'print' })
  await expect(idPhotos(p).first()).toBeVisible()
  await p.emulateMedia({ media: 'screen' })
  await afterPrint(p)
  await expect(p.locator('article[class*="printIdPhotos"]')).toHaveCount(0)
  await p.emulateMedia({ media: 'print' })
  for (const photo of await idPhotos(p).all()) await expect(photo).toBeHidden()
})

test('9b.40 — on screen the record looks the same before and after Download record', async () => {
  const p = m1.page
  await open_(p, w.p2)
  const card = p.locator('article')
  const snap = async () => ({ text: await card.innerText(), box: await card.boundingBox(), visible: await idPhotos(p).evaluateAll((l) => l.map((i) => getComputedStyle(i.closest('figure')).display)) })
  const before = await snap()
  await downloadRecord(p).click()
  await expect.poll(() => log(p)).toContain('print(class on: true)')
  expect(await snap()).toEqual(before)
  expect(before.visible).toHaveLength(4)
  expect(before.visible).not.toContain('none')
})

test('9b.41 — opening a record writes a ttr.access_log view row for each ID image shown (images are still served only by get-id-image-urls)', async () => {
  const p = m1.page
  const since = (await sql`select now() as t`)[0].t
  await open_(p, w.p2)
  await expect(idPhotos(p).first()).toBeVisible()
  const images = await sql`
    select front_image_id, back_image_id from ttr.id_verifications where customer_id in (${w.jane.id}, ${w.joan.id})`
  const wanted = images.flatMap((r) => [r.front_image_id, r.back_image_id]).filter(Boolean)
  expect(wanted).toHaveLength(4)
  await expect
    .poll(async () => (await sql`select resource_id from ttr.access_log where action = 'view' and staff_member_id = ${ACCOUNTS.m1.id} and occurred_at >= ${since}`).map((r) => r.resource_id).sort())
    .toEqual(expect.arrayContaining([...wanted].sort()))
})
