// Gold Phase 6 UAT, section E refusals and variants of gold-update-customer-id (spec 1.6, 5.2, 6.1).
// Each row starts from Carol as she was created; refusals leave every total unchanged.
import { expect, test } from '@playwright/test'
import { AAL2, idHash, idPayload, makeCustomer, photo, q1, q3, q4, staff, tag, totals, updateId } from './support.js'

const S1 = () => AAL2('s1')
const NUM = `UAT6-DL-${tag()}`
const sorted = (o) => Object.keys(o ?? {}).sort()
const two = (a, b) => ({ front: photo(a), back: photo(b) })

let carol

test.beforeAll(async () => {
  carol = await makeCustomer({ firstName: 'Carol', 'id.documentNumber': NUM })
})

const U1 = (changes = {}) => idPayload(carol.id, { documentNumber: NUM, ...changes })

test('6.89 — photo unclear for a document not on file is 409 document_not_on_file; nothing stored', async () => {
  const before = await totals()
  const res = await updateId(S1(), U1({ reason: 'photo_unclear', documentNumber: 'UAT6-DL-999-NOTHELD' }), two('front2', 'back2'))
  expect([res.status, res.body]).toEqual([409, { error: 'document_not_on_file' }])
  expect(await totals()).toEqual(before)
})

test('6.90 — different_document with a number the customer already has is 409 id_on_file', async () => {
  const before = await totals()
  const res = await updateId(S1(), U1({ reason: 'different_document' }), two('front2', 'back2'))
  expect([res.status, res.body.error]).toEqual([409, 'id_on_file'])
  expect(await totals()).toEqual(before)
})

test('6.91 ⚠ — another customer’s number is 409 id_on_file for every reason, naming that customer', async () => {
  const owner = await makeCustomer({ firstName: 'Alice', middleName: 'Q' })
  const before = await totals()
  for (const reason of ['renewed', 'photo_unclear', 'different_document']) {
    const res = await updateId(S1(), U1({ reason, documentNumber: owner.payload.id.documentNumber }), two('front2', 'back2'))
    expect([res.status, res.body.error], reason).toEqual([409, 'id_on_file'])
    expect(res.body.owner, reason).toMatchObject({ customerId: owner.id, name: 'Alice Q Uatsix' })
  }
  expect(await totals()).toEqual(before)
})

test('6.92 — a missing, unknown, empty or stored-value reason is 400 reason', async () => {
  const before = await totals()
  for (const reason of [undefined, 'because', '', 'id_changed']) {
    const res = await updateId(S1(), U1({ reason }), two('front2', 'back2'))
    expect([res.status, sorted(res.body.fields)], String(reason)).toEqual([400, ['reason']])
  }
  expect(await totals()).toEqual(before)
})

test('6.93 — a missing or malformed customerId is 400 customerId', async () => {
  for (const customerId of [undefined, 'nope']) {
    const res = await updateId(S1(), U1({ customerId }), two('front2', 'back2'))
    expect([res.status, sorted(res.body.fields)], String(customerId)).toEqual([400, ['customerId']])
  }
})

test('6.94 — a Driver licence update needs both photos: front only is 400 backImage, no photos is 400 frontImage', async () => {
  const before = await totals()
  const frontOnly = await updateId(S1(), U1(), { front: photo('front2') })
  expect([frontOnly.status, sorted(frontOnly.body.fields)]).toEqual([400, ['backImage']])
  const none = await updateId(S1(), U1(), {})
  expect(none.status).toBe(400)
  expect(sorted(none.body.fields)).toContain('frontImage')
  expect(await totals()).toEqual(before)
})

test('6.95 — invalid document fields are named at the top level of the payload', async () => {
  const cases = [
    [{ documentNumber: '' }, 'documentNumber'],
    [{ issuer: '' }, 'issuer'],
    [{ idCountryCode: 'AUS' }, 'idCountryCode'],
    [{ hasExpiry: undefined }, 'hasExpiry'],
    [{ hasExpiry: true, expiryDate: undefined }, 'expiryDate'],
    [{ documentType: 'Credit card' }, 'documentType'],
  ]
  for (const [changes, field] of cases) {
    const res = await updateId(S1(), U1(changes), two('front2', 'back2'))
    expect([res.status, sorted(res.body.fields)], field).toEqual([400, [field]])
  }
})

test('6.96 — a customer id that does not exist is 404 customer_not_found; nothing stored', async () => {
  const before = await totals()
  const res = await updateId(S1(), idPayload('00000000-0000-4000-8000-000000000999', { documentNumber: NUM }), two('front2', 'back2'))
  expect([res.status, res.body]).toEqual([404, { error: 'customer_not_found' }])
  expect(await totals()).toEqual(before)
})

test('6.97 ⚠ — Entity Two cannot update Carol’s ID: 404 and her rows are unchanged', async () => {
  const [ids, imgs] = [await idHash(carol.id), await q4(carol.id)]
  const res = await updateId(AAL2('x1'), U1(), two('front2', 'back2'))
  expect([res.status, res.body.error]).toEqual([404, 'customer_not_found'])
  expect(await idHash(carol.id)).toBe(ids)
  expect(await q4(carol.id)).toEqual(imgs)
})

test('6.148 — Update ID has no different-person option: another customer’s number is always id_on_file', async () => {
  const owner = await makeCustomer()
  const before = await totals()
  for (const reason of ['renewed', 'different_document']) {
    const res = await updateId(S1(), U1({ reason, documentNumber: owner.payload.id.documentNumber, differentPerson: true, confirmNew: true }), two('front2', 'back2'))
    expect([res.status, res.body.error], reason).toEqual([409, 'id_on_file'])
  }
  expect(await totals()).toEqual(before)
})

test('6.159 (added by UAT) — a renewal typed in lower case with spaces still links to the same document and supersedes its photos', async () => {
  const gus = await makeCustomer({ firstName: 'Gus' })
  const res = await updateId(S1(), idPayload(gus.id, { documentNumber: ` ${gus.payload.id.documentNumber.toLowerCase()} ` }), two('front2', 'back2'))
  expect(res.status, res.text).toBe(201)
  expect(res.body.superseded).toBe(2)
  const [first, second] = await q3(gus.id)
  expect(second).toMatchObject({ new_capture_reason: 'id_changed', prior_verification_id: first.id })
})

test('6.161 (added by UAT) — client-supplied identity, business and hash fields are ignored on Update ID', async () => {
  const hal = await makeCustomer({ firstName: 'Hal' })
  const front = photo('hostile-update')
  const res = await updateId(
    S1(),
    idPayload(hal.id, { documentNumber: hal.payload.id.documentNumber, capturedByStaffId: staff('m1').id, reportingEntityId: '00000000-0000-4000-8000-0000000000e2', contentHashSha256: 'deadbeef' }),
    { front, back: photo('hostile-back') },
  )
  expect(res.status, res.text).toBe(201)
  const rows = await q4(hal.id)
  const newest = rows.find((r) => r.id === res.body.frontImageId)
  expect(newest.captured_by_staff_id).toBe(staff('s1').id)
  expect(newest.content_hash_sha256).toBe(front.sha)
  const [, capture] = await q3(hal.id)
  expect(capture.reporting_entity_id).toBe((await q1(hal.id)).reporting_entity_id)
})

test('6.85 ⚠ — another person who shares the number keeps both photos when this customer renews', async () => {
  const dan = await makeCustomer({ firstName: 'Dan', 'id.documentNumber': NUM, differentPerson: true })
  const res = await updateId(S1(), U1(), two('front2', 'back2'))
  expect(res.status, res.text).toBe(201)
  expect(res.body.superseded).toBe(2)
  const rows = await q4(dan.id)
  expect(rows).toHaveLength(2)
  for (const r of rows) {
    expect(r.superseded_at).toBeNull()
    expect(r.object_exists).toBe(1)
  }
  expect(await q3(dan.id)).toHaveLength(1)
})
