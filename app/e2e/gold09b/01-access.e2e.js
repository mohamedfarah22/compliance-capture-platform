// Gold Phase 9b UAT, section 1 (rows 9b.2 to 9b.10, 9b.43): who may call gold-export and what it accepts
// (spec 2.3, 6.1, 6.2, 9). Row 9b.1 (the feature flag) is a Deno test: supabase/functions/_shared/gold09bUat.test.ts.
import { expect, test } from '@playwright/test'
import { ACCOUNTS, E2, auditCount, auditRows, buy, exportReq, ianToken, jane, login, open, recordReq, tokenOf, world9b, zipReq } from './support.js'

let m1
let s1
let a1
let m2
let s2
let w
let other
test.beforeAll(async ({ browser }) => {
  m1 = await open(browser, 'm1')
  s1 = await open(browser, 's1')
  a1 = await open(browser, 'a1')
  m2 = await open(browser, 'm2')
  s2 = await open(browser, 's2')
  w = await world9b('m1', m1.page)
  other = await buy('s2', { customerId: (await jane({ entity: E2 })).id })
})
test.afterAll(async () => {
  for (const c of [m1, s1, a1, m2, s2]) await c?.context.close()
})

const ALL = () => [w.p1, w.p2, w.p3]

test('9b.2 ⚠ — no Authorization header is 401 unauthorized; a password-only (aal1) token is 403 mfa_required; no audit row either time', async () => {
  const before = await auditCount()
  const anon = await zipReq(null, ALL())
  expect([anon.status, anon.body.error]).toEqual([401, 'unauthorized'])
  const aal1 = await zipReq((await login('m1', { aal1: true })).access_token, ALL())
  expect([aal1.status, aal1.body.error]).toEqual([403, 'mfa_required'])
  expect(await auditCount()).toBe(before)
})

test('9b.3 ⚠ — Staff Sam gets 403 forbidden on a zip and on a record request: no audit row and no URL in the answer', async () => {
  const before = await auditCount()
  const token = await tokenOf('s1')
  for (const res of [await zipReq(token, ALL()), await recordReq(token, w.p1)]) {
    expect([res.status, res.body.error]).toEqual([403, 'forbidden'])
    expect(res.text).not.toMatch(/https?:|signed|purchases/)
  }
  expect(await auditCount()).toBe(before)
})

test('9b.4 ⚠ — Inactive Ian (an inactive manager of business One) gets 403 forbidden: no audit row', async () => {
  const before = await auditCount()
  const res = await zipReq(await ianToken(), ALL())
  expect([res.status, res.body.error]).toEqual([403, 'forbidden'])
  expect(await auditCount()).toBe(before)
})

test('9b.5 — a manager and an admin both get 200 on a zip of P1, P2, P3, and each writes its own audit row', async () => {
  const before = await auditCount()
  const mel = await zipReq(await tokenOf('m1'), ALL())
  const ada = await zipReq(await tokenOf('a1'), ALL())
  expect([mel.status, ada.status]).toEqual([200, 200])
  expect(mel.body.purchases).toHaveLength(3)
  expect(ada.body.purchases).toHaveLength(3)
  const rows = (await auditRows(ACCOUNTS.m1.entity)).slice(before)
  expect(rows.map((r) => r.staff_member_id)).toEqual([ACCOUNTS.m1.id, ACCOUNTS.a1.id])
})

// One test per bad request, so a break that lets one through fails only its own test.
const BAD = [
  ['kind "csv"', (ok) => ({ ...ok, kind: 'csv' }), 'kind'],
  ['no kind', (ok) => ({ filters: ok.filters, purchaseIds: ok.purchaseIds }), 'kind'],
  ['no purchaseIds', (ok) => ({ kind: ok.kind, filters: ok.filters }), 'purchaseIds'],
  ['purchaseIds a string', (ok) => ({ ...ok, purchaseIds: ok.purchaseIds[0] }), 'purchaseIds'],
  ['purchaseIds []', (ok) => ({ ...ok, purchaseIds: [] }), 'purchaseIds'],
  ['purchaseIds ["nope"]', (ok) => ({ ...ok, purchaseIds: ['nope'] }), 'purchaseIds'],
  ['filters an array', (ok) => ({ ...ok, filters: ['q'] }), 'filters'],
  ['an unreadable body', () => '{not json', 'body'],
]
for (const [what, make, field] of BAD) {
  test(`9b.6 ⚠ — ${what} is 400 bad_request naming "${field}": no audit row`, async () => {
    const before = await auditCount()
    const res = await exportReq(await tokenOf('m1'), make({ kind: 'zip', filters: null, purchaseIds: [w.p1] }))
    expect([res.status, res.body.error, res.body.field]).toEqual([400, 'bad_request', field])
    expect(await auditCount()).toBe(before)
  })
}

test('9b.8 — a record request with two purchase ids is 400 bad_request (purchaseIds) with no audit row; with one it is 200 and writes one row', async () => {
  const token = await tokenOf('m1')
  const before = await auditCount()
  const two = await exportReq(token, { kind: 'record', filters: null, purchaseIds: [w.p1, w.p2] })
  expect([two.status, two.body.error, two.body.field]).toEqual([400, 'bad_request', 'purchaseIds'])
  expect(await auditCount()).toBe(before)
  const one = await recordReq(token, w.p2)
  expect([one.status, one.body]).toEqual([200, { ok: true }])
  expect(await auditCount()).toBe(before + 1)
})

test('9b.9 ⚠ — a zip with another business\'s purchase, or with an id that is no purchase, is 404 purchase_not_found, with the same answer both ways and no audit row', async () => {
  const token = await tokenOf('m1')
  const before = await auditCount()
  const mixed = await zipReq(token, [w.p1, other])
  const unknown = await zipReq(token, [w.p1, '5f1c0a6e-7b0d-4c53-9d0b-0a1b2c3d4e5f'])
  expect([mixed.status, mixed.body]).toEqual([404, { error: 'purchase_not_found' }])
  expect([unknown.status, unknown.body]).toEqual([404, { error: 'purchase_not_found' }])
  expect(mixed.text).toBe(unknown.text)
  expect(mixed.text).not.toContain(other)
  expect(await auditCount()).toBe(before)
})

test('9b.10 — a zip for [P1, P1, P2] returns 2 purchases and writes an audit row holding 2 ids', async () => {
  const before = await auditCount()
  const res = await zipReq(await tokenOf('m1'), [w.p1, w.p1, w.p2])
  expect(res.status).toBe(200)
  expect(res.body.purchases.map((p) => p.id)).toEqual([w.p1, w.p2])
  const rows = (await auditRows(ACCOUNTS.m1.entity)).slice(before)
  expect(rows).toHaveLength(1)
  expect(rows[0].purchase_ids).toEqual([w.p1, w.p2])
})

test("9b.43 — (added by UAT, spec 6.1) a manager of business Two cannot export or print business One's purchase (404, no audit row), but can export business Two's own", async () => {
  const token = await tokenOf('m2')
  const before = await auditCount()
  for (const res of [await zipReq(token, [w.p1]), await recordReq(token, w.p1)]) {
    expect([res.status, res.body]).toEqual([404, { error: 'purchase_not_found' }])
  }
  expect(await auditCount()).toBe(before)
  const own = await zipReq(token, [other])
  expect(own.status).toBe(200)
  const rows = (await auditRows(E2)).filter((r) => r.purchase_ids.includes(other))
  expect(rows).toHaveLength(1)
  expect(rows[0].staff_member_id).toBe(ACCOUNTS.m2.id)
})
