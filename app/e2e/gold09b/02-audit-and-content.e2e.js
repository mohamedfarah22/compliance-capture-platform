// Gold Phase 9b UAT, sections 2 and 3 (rows 9b.11 to 9b.22): the export audit row and what gold-export returns
// (spec 4.2, 6.2, 6.4, 1.7 C1). Rows 9b.13 and 9b.42 (audit insert fails; audit row before signing) are Deno tests.
import { expect, test } from '@playwright/test'
import { postMultipart, idPayload } from '../gold06/support.js'
import { localEnv } from '../support/env.js'
import {
  ACCOUNTS,
  E1,
  E2,
  accessLogCount,
  auditCount,
  auditRows,
  buy,
  exportReq,
  fetchSigned,
  goodsJpeg,
  jane,
  makeImage,
  open,
  photo,
  recordReq,
  signedExp,
  sql,
  tokenOf,
  uniq,
  world9b,
  zipReq,
} from './support.js'

let m1
let a1
let s1
let m2
let s2
let w
let other
test.beforeAll(async ({ browser }) => {
  m1 = await open(browser, 'm1')
  a1 = await open(browser, 'a1')
  s1 = await open(browser, 's1')
  m2 = await open(browser, 'm2')
  s2 = await open(browser, 's2')
  w = await world9b('m1', m1.page)
  other = await buy('s2', { customerId: (await jane({ entity: E2 })).id })
})
test.afterAll(async () => {
  for (const c of [m1, a1, s1, m2, s2]) await c?.context.close()
})

const { API_URL, SERVICE_ROLE_KEY, ANON_KEY } = localEnv()
const newAudit = async (before) => (await auditRows(E1)).slice(before)
const bytes = async (url) => Buffer.from(await (await fetchSigned(url)).arrayBuffer())
const photoOf = (entry, name) => entry.photos.find((p) => p.name === name)

const FILTERS = { q: 'Jane', status: 'austrac', type: 'scrap', cash: 'yes', from: '2026-11-01', to: '2026-11-07', recordedBy: ACCOUNTS.s1.id }
const lying = (filters) => ({
  kind: 'zip',
  filters,
  purchaseIds: [w.p1, w.p2],
  staffId: ACCOUNTS.a1.id,
  reportingEntityId: E2,
  unknown: 1,
})

test('9b.11 ⚠ — (a) a zip writes one audit row from the verified caller: Mel\'s staff id and business One, kind zip, [P1, P2], now, whatever staffId / reportingEntityId the body claims', async () => {
  const before = (await auditRows(E1)).length
  const sent = Date.now()
  const res = await exportReq(await tokenOf('m1'), lying(FILTERS))
  expect(res.status, res.text).toBe(200)
  const rows = await newAudit(before)
  expect(rows).toHaveLength(1)
  const [row] = rows
  expect([row.staff_member_id, row.reporting_entity_id, row.kind]).toEqual([ACCOUNTS.m1.id, E1, 'zip'])
  expect(row.purchase_ids).toEqual([w.p1, w.p2])
  expect(Math.abs(new Date(row.exported_at).getTime() - sent)).toBeLessThan(60_000)
})

test('9b.11 ⚠ — (b) the audit row\'s filters hold exactly the seven known keys with the values sent, and nothing from staffId / reportingEntityId / unknown', async () => {
  const before = (await auditRows(E1)).length
  const filters = { ...FILTERS, staffId: ACCOUNTS.a1.id, reportingEntityId: E2, unknown: 1 }
  const res = await exportReq(await tokenOf('m1'), { kind: 'zip', filters, purchaseIds: [w.p1, w.p2] })
  expect(res.status, res.text).toBe(200)
  const rows = await newAudit(before)
  expect(rows).toHaveLength(1)
  expect(rows[0].filters).toEqual(FILTERS)
})

test('9b.12 — Admin Ada\'s record request for P1 writes one audit row: her staff id, kind record, purchase_ids [P1]', async () => {
  const before = (await auditRows(E1)).length
  const res = await recordReq(await tokenOf('a1'), w.p1)
  expect(res.status).toBe(200)
  const rows = await newAudit(before)
  expect(rows).toHaveLength(1)
  expect([rows[0].staff_member_id, rows[0].kind, rows[0].purchase_ids]).toEqual([ACCOUNTS.a1.id, 'record', [w.p1]])
})

test('9b.14 ⚠ — the service role cannot update or delete an audit row, a manager\'s session cannot insert one, and the row is unchanged', async () => {
  await zipReq(await tokenOf('m1'), [w.p1])
  const [row] = (await auditRows(E1)).slice(-1)
  const call = (method, token, key, body, query = `?id=eq.${row.id}`) =>
    fetch(`${API_URL}/rest/v1/export_audit_log${query}`, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Profile': 'gold', 'Accept-Profile': 'gold' },
      body: body ? JSON.stringify(body) : undefined,
    })
  const upd = await call('PATCH', SERVICE_ROLE_KEY, SERVICE_ROLE_KEY, { kind: 'record' })
  expect([upd.ok, (await upd.json()).code]).toEqual([false, 'P0001'])
  const del = await call('DELETE', SERVICE_ROLE_KEY, SERVICE_ROLE_KEY)
  expect([del.ok, (await del.json()).code]).toEqual([false, 'P0001'])
  const ins = await call('POST', await tokenOf('m1'), ANON_KEY, { reporting_entity_id: E1, staff_member_id: ACCOUNTS.m1.id, kind: 'zip', purchase_ids: [w.p1] }, '')
  expect([ins.ok, (await ins.json()).code]).toEqual([false, '42501'])
  const [after] = await sql`select * from gold.export_audit_log where id = ${row.id}`
  expect(after).toEqual(row)
})

test('9b.15 — Manager Mel and Admin Ada read business One\'s audit rows, Staff Sam reads none, and a manager of business Two reads none of business One\'s', async () => {
  const mine = await auditRows(E1)
  expect(mine.length).toBeGreaterThan(0)
  const ownTwo = await zipReq(await tokenOf('m2'), [other])
  expect(ownTwo.status, ownTwo.text).toBe(200)
  const read = async (label) => {
    const res = await fetch(`${API_URL}/rest/v1/export_audit_log?select=id,reporting_entity_id`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${await tokenOf(label)}`, 'Accept-Profile': 'gold' },
    })
    expect(res.status).toBe(200)
    return res.json()
  }
  for (const label of ['m1', 'a1']) {
    const rows = await read(label)
    expect(rows.map((r) => r.id).sort()).toEqual((await auditRows(E1)).map((r) => r.id).sort())
  }
  expect(await read('s1')).toEqual([])
  const two = await read('m2')
  expect(two.length).toBeGreaterThan(0)
  expect(new Set(two.map((r) => r.reporting_entity_id))).toEqual(new Set([E2]))
})

test('9b.16 — a zip of P1, P2, P3 returns one entry per purchase with every CSV field, joint fields empty for P1 and P3 and filled for P2', async () => {
  const res = await zipReq(await tokenOf('m1'), [w.p1, w.p2, w.p3])
  expect(res.status).toBe(200)
  expect(res.body.purchases.map((p) => p.id)).toEqual([w.p1, w.p2, w.p3])
  const FIELDS = [
    'purchase_id', 'created_at', 'created_by', 'completed_at', 'completed_by', 'erp_invoice_no', 'purchase_type', 'cash_band', 'cash_10k_or_more',
    'cash_amount', 'main_seller_name', 'main_seller_phone', 'main_id_type', 'main_id_number', 'main_id_expiry', 'joint_seller_name', 'joint_seller_phone',
    'joint_id_type', 'joint_id_number', 'joint_id_expiry', 'phone_at_purchase', 'id_sighted', 'id_expired_at_time', 'goods_photo_count', 'ttr_status',
    'ttr_reference', 'id_document_used', 'id_photo_copy_taken',
  ]
  const [e1, e2, e3] = res.body.purchases
  for (const e of res.body.purchases) expect(Object.keys(e.row).sort()).toEqual([...FIELDS].sort())
  expect(e1.row).toMatchObject({
    purchase_id: w.p1,
    created_by: ACCOUNTS.m1.name,
    erp_invoice_no: w.n1,
    purchase_type: 'scrap',
    cash_10k_or_more: true,
    cash_amount: 12000,
    main_seller_name: w.jane.name,
    main_id_type: 'Driver licence',
    main_id_number: w.janeNumber,
    id_sighted: true,
    goods_photo_count: 2,
    joint_seller_name: '',
    joint_id_number: '',
  })
  expect(e2.row).toMatchObject({
    purchase_type: 'bullion',
    erp_invoice_no: w.n2,
    joint_seller_name: w.joan.name,
    joint_id_type: 'Driver licence',
    joint_id_number: w.joanNumber,
    goods_photo_count: 1,
  })
  expect(e3.row).toMatchObject({ erp_invoice_no: '', goods_photo_count: 0, joint_seller_name: '', joint_id_number: '', completed_at: null })
})

test('9b.17 — (a) each purchase\'s photo entries: P1 two goods and Jane\'s ID front and back, P2 one goods and both sellers\' ID photos, P3 none', async () => {
  const res = await zipReq(await tokenOf('m1'), [w.p1, w.p2, w.p3])
  const names = (e) => e.photos.map((p) => p.name).sort()
  const [e1, e2, e3] = res.body.purchases
  expect(names(e1)).toEqual(['goods-1', 'goods-2', 'main-seller-id-back', 'main-seller-id-front'])
  expect(names(e2)).toEqual(['goods-1', 'joint-seller-id-back', 'joint-seller-id-front', 'main-seller-id-back', 'main-seller-id-front'])
  expect(e3.photos).toEqual([])
})

test('9b.17 — (b) every photo URL is a signed storage URL whose token expires within 300 seconds', async () => {
  const res = await zipReq(await tokenOf('m1'), [w.p1, w.p2])
  const [e1, e2] = res.body.purchases
  const now = Date.now() / 1000
  for (const p of [...e1.photos, ...e2.photos]) {
    const exp = signedExp(p.url)
    expect(exp, p.name).toBeGreaterThan(now)
    expect(exp, p.name).toBeLessThanOrEqual(now + 300 + 5)
  }
})

test('9b.18 — a signed goods URL and a signed ID URL return the stored image bytes; the same storage path without the token is refused', async () => {
  const res = await zipReq(await tokenOf('m1'), [w.p1])
  const [e1] = res.body.purchases
  const goods = photoOf(e1, 'goods-1')
  const front = photoOf(e1, 'main-seller-id-front')
  for (const [entry, expected] of [[goods, goodsJpeg(1)], [front, w.front]]) {
    const got = await fetchSigned(entry.url)
    expect([got.status, got.headers.get('content-type')]).toEqual([200, 'image/jpeg'])
    expect(Buffer.from(await got.arrayBuffer()).equals(expected), entry.name).toBe(true)
    const unsigned = entry.url.replace('/object/sign/', '/object/').replace(/\?.*$/, '')
    expect((await fetchSigned(unsigned)).ok, entry.name).toBe(false)
    expect((await fetchSigned(unsigned.replace('/object/', '/object/public/'))).ok, entry.name).toBe(false)
  }
})

test('9b.19 — ttr_status and ttr_reference: P1 complete with its invoice, P2 draft with its reference, P3 both empty', async () => {
  const res = await zipReq(await tokenOf('m1'), [w.p1, w.p2, w.p3])
  const [r1, r2, r3] = res.body.purchases.map((p) => p.row)
  const [t2] = await sql`select transaction_ref from ttr.transactions where id = ${w.ttr2}`
  expect([r1.ttr_status, r1.ttr_reference]).toEqual(['complete', w.n1])
  expect([r2.ttr_status, r2.ttr_reference]).toEqual(['draft', t2.transaction_ref])
  expect(t2.transaction_ref).toBeTruthy()
  expect([r3.ttr_status, r3.ttr_reference]).toEqual(['', ''])
})

const melbourneDay = async (iso) => (await sql`select (${iso}::timestamptz at time zone 'Australia/Melbourne')::date::text as d`)[0].d
const NEW_FRONT = photo('c1-new-front')
const NEW_BACK = photo('c1-new-back')

// A customer whose licence was used for a purchase and then renewed (same document, new photos).
const renewed = async () => {
  const front = await makeImage(m1.page, { width: 300, height: 200, label: 'ORIG-F' })
  const back = await makeImage(m1.page, { width: 300, height: 200, label: 'ORIG-B' })
  const number = `DLC1${uniq()}`
  const c = await jane({ id: { front, back, number } })
  const pid = await buy('m1', { customerId: c.id })
  const [orig] = await sql`select created_at from ttr.id_verifications where customer_id = ${c.id}`
  const before = await zipReq(await tokenOf('m1'), [pid])
  expect(before.body.purchases[0].row.id_photo_copy_taken).toMatch(/^main: original, taken \d{4}-\d{2}-\d{2}$/)
  const upd = await postMultipart('gold-update-customer-id', await tokenOf('m1'), idPayload(c.id, { documentNumber: number }), { front: NEW_FRONT, back: NEW_BACK })
  expect(upd.status, upd.text).toBe(201)
  const res = await zipReq(await tokenOf('m1'), [pid])
  return { entry: res.body.purchases[0], number, orig }
}

test('9b.20 ⚠ — (a) C1: after the licence is renewed the export carries the newer copy\'s ID front and back photos (the current images)', async () => {
  const { entry: e } = await renewed()
  expect(photoOf(e, 'main-seller-id-front'), "the newer copy's front photo is in the export").toBeDefined()
  expect((await bytes(photoOf(e, 'main-seller-id-front').url)).equals(NEW_FRONT.bytes)).toBe(true)
  expect((await bytes(photoOf(e, 'main-seller-id-back').url)).equals(NEW_BACK.bytes)).toBe(true)
})

test('9b.20 ⚠ — (b) C1: id_photo_copy_taken says "newer copy" with the date taken, and id_document_used still names the document P1 used', async () => {
  const { entry: e, number, orig } = await renewed()
  const today = await melbourneDay(new Date().toISOString())
  expect(e.row.id_photo_copy_taken).toBe(`main: newer copy, taken ${today}`)
  expect(e.row.id_document_used).toBe(`main: Driver licence, captured ${await melbourneDay(orig.created_at.toISOString())}`)
  expect(e.row.main_id_number).toBe(number)
})

test('9b.21 ⚠ — C1: a different document (a passport) is a separate capture: the earlier purchase keeps the licence photos, the later one gets the passport\'s, both say original', async () => {
  const front = await makeImage(m1.page, { width: 300, height: 200, label: 'LIC-F' })
  const back = await makeImage(m1.page, { width: 300, height: 200, label: 'LIC-B' })
  const c = await jane({ id: { front, back, number: `DLP${uniq()}` } })
  const p1 = await buy('m1', { customerId: c.id })
  const passportFront = photo('passport-front')
  const upd = await postMultipart(
    'gold-update-customer-id',
    await tokenOf('m1'),
    idPayload(c.id, { reason: 'different_document', documentType: 'Passport', documentNumber: `PP${uniq()}`, issuer: 'Australia' }),
    { front: passportFront, back: photo('passport-back') },
  )
  expect(upd.status, upd.text).toBe(201)
  const p4 = await buy('m1', { customerId: c.id })
  const res = await zipReq(await tokenOf('m1'), [p1, p4])
  const [e1, e4] = res.body.purchases
  expect((await bytes(photoOf(e1, 'main-seller-id-front').url)).equals(front)).toBe(true)
  expect((await bytes(photoOf(e4, 'main-seller-id-front').url)).equals(passportFront.bytes)).toBe(true)
  expect(e1.row.main_id_type).toBe('Driver licence')
  expect(e4.row.main_id_type).toBe('Passport')
  for (const e of [e1, e4]) expect(e.row.id_photo_copy_taken).toMatch(/^main: original, taken \d{4}-\d{2}-\d{2}$/)
})

test('9b.22 — a successful zip and record request add no ttr.access_log rows (the export audit row is its record)', async () => {
  const before = await accessLogCount()
  const audits = await auditCount()
  expect((await zipReq(await tokenOf('m1'), [w.p1, w.p2])).status).toBe(200)
  expect((await recordReq(await tokenOf('m1'), w.p2)).status).toBe(200)
  expect(await auditCount()).toBe(audits + 2)
  expect(await accessLogCount()).toBe(before)
})
