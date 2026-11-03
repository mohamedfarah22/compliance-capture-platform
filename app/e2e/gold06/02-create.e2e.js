// Gold Phase 6 UAT, section B rows 6.15 to 6.25: gold-create-customer happy path and what it writes
// (spec 1.6, 4.2, 4.5, 6.1). Alice's create is made once, lazily, and each row asserts its own part of it.
import { expect, test } from '@playwright/test'
import { AAL2, BACK, BOTH, ENTITY_ID, FRONT, create, makeCustomer, memo, mod, newCustomer, photo, q1, q2, q3, q4, q5, sql, staff, totals } from './support.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const S1 = () => AAL2('s1')
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d)

// B1: the sheet's base payload (Alice), with values unique to this run.
const B1 = newCustomer({ firstName: 'Alice', middleName: 'Q', email: 'alice.uatsix@example.test' })

const aliceCall = memo(async () => {
  const before = await totals()
  const [{ n: txBefore }] = await sql`select count(*)::int as n from ttr.transactions`
  const started = new Date()
  const res = await create(S1(), B1, BOTH())
  return { before, txBefore, after: await totals(), started, finished: new Date(), res, id: res.body.customerId }
})

test('6.15 — create as staff with front and back photos: 201 with four UUIDs', async () => {
  const { res } = await aliceCall()
  expect(res.status, res.text).toBe(201)
  for (const key of ['customerId', 'verificationId', 'frontImageId', 'backImageId']) expect(res.body[key], key).toMatch(UUID)
})

test('6.16 — Q1: the customer row is gold, individual, created by S1 in Entity One, with the details typed', async () => {
  const { id } = await aliceCall()
  const c = await q1(id)
  expect(c).toMatchObject({
    source: 'gold',
    customer_type: 'individual',
    created_by_staff_id: staff('s1').id,
    reporting_entity_id: ENTITY_ID,
    first_name: 'Alice',
    middle_name: 'Q',
    last_name: 'Uatsix',
    phone: B1.phone,
    email: 'alice.uatsix@example.test',
    res_street: '10 Test Street',
    res_suburb: 'Coburg',
    res_state: 'VIC',
    res_postcode: '3058',
    res_country: 'Australia',
  })
  expect(day(c.date_of_birth)).toBe(B1.dateOfBirth)
})

test('6.17 — Q2: aliases are saved in order', async () => {
  const { id } = await aliceCall()
  expect(await q2(id)).toEqual([
    { alias: 'Ally Uatsix', sort_order: 0 },
    { alias: 'A. Uatsix', sort_order: 1 },
  ])
})

test('6.18 — Q3: one customer-level new_capture row, no transaction, party or conducting person', async () => {
  const { id, res } = await aliceCall()
  const rows = await q3(id)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    transaction_id: null,
    party_id: null,
    conducting_person_id: null,
    customer_id: id,
    verification_basis: 'new_capture',
    new_capture_reason: null,
    prior_verification_id: null,
    document_type: 'Driver licence',
    document_number: B1.id.documentNumber,
    issuer: 'VIC',
    id_country_code: 'AU',
    has_expiry: true,
    is_complete: true,
    front_image_id: res.body.frontImageId,
    back_image_id: res.body.backImageId,
    id: res.body.verificationId,
    reporting_entity_id: ENTITY_ID,
  })
  expect(day(rows[0].expiry_date)).toBe('2030-06-30')
})

test('6.19 ⚠ — Q4: two photos under customers/<id>/, server-computed hashes and sizes, S1 as capturer, objects stored', async () => {
  const { id, res } = await aliceCall()
  const images = await q4(id)
  expect(images).toHaveLength(2)
  const front = images.find((i) => i.id === res.body.frontImageId)
  const back = images.find((i) => i.id === res.body.backImageId)
  const [f, b] = [FRONT(), BACK()]
  expect(front.object_path).toMatch(new RegExp(`^customers/${id}/[^/]+/front-.*\\.jpg$`))
  expect(back.object_path).toMatch(new RegExp(`^customers/${id}/[^/]+/back-.*\\.jpg$`))
  expect(front.content_hash_sha256).toBe(f.sha)
  expect(back.content_hash_sha256).toBe(b.sha)
  expect([front.byte_size, back.byte_size]).toEqual([f.size, b.size])
  for (const i of [front, back]) {
    expect(i.captured_by_staff_id).toBe(staff('s1').id)
    expect(i.superseded_at).toBeNull()
    expect(i.object_exists).toBe(1)
  }
})

test('6.20 — Q5: exactly one gold_create audit row by S1 holding old null -> new for the saved values', async () => {
  const { id, started, finished } = await aliceCall()
  const rows = await q5(id)
  expect(rows).toHaveLength(1)
  expect(rows[0].source).toBe('gold_create')
  expect(rows[0].changed_by).toBe(staff('s1').id)
  const when = rows[0].changed_at.getTime()
  expect(when).toBeGreaterThan(started.getTime() - 60_000)
  expect(when).toBeLessThan(finished.getTime() + 60_000)
  const c = rows[0].changes
  expect(c.first_name).toEqual({ old: null, new: 'Alice' })
  expect(c.phone).toEqual({ old: null, new: B1.phone })
  expect(c.res_street).toEqual({ old: null, new: '10 Test Street' })
  expect(c.res_postcode).toEqual({ old: null, new: '3058' })
  expect(c.aliases).toEqual({ old: null, new: ['Ally Uatsix', 'A. Uatsix'] })
})

test('6.21 — one create adds 1 customer, 2 images, 2 objects, 1 audit row and no TTR transaction or party', async () => {
  const { id, before, after, txBefore } = await aliceCall()
  expect(after.customers - before.customers).toBe(1)
  expect(after.images - before.images).toBe(2)
  expect(after.objects - before.objects).toBe(2)
  expect(after.audit_rows - before.audit_rows).toBe(1)
  expect((await sql`select count(*)::int as n from ttr.parties where customer_id = ${id}`)[0].n).toBe(0)
  expect((await sql`select count(*)::int as n from ttr.transactions`)[0].n).toBe(txBefore)
})

test('6.22 ⚠ — who and which business come from the token, not from the request body', async () => {
  const payload = mod(newCustomer(), {
    createdByStaffId: staff('m1').id,
    reportingEntityId: '00000000-0000-4000-8000-0000000000e2',
    source: 'ttr',
    created_by_staff_id: staff('m1').id,
    reporting_entity_id: '00000000-0000-4000-8000-0000000000e2',
  })
  const res = await create(S1(), payload, BOTH())
  expect(res.status, res.text).toBe(201)
  expect(await q1(res.body.customerId)).toMatchObject({ created_by_staff_id: staff('s1').id, reporting_entity_id: ENTITY_ID, source: 'gold' })
  const [capture] = await q3(res.body.customerId)
  expect(capture.reporting_entity_id).toBe(ENTITY_ID)
})

test('6.23 ⚠ — a client-supplied hash is ignored: the stored hash is the real SHA-256 of the file', async () => {
  const front = photo('hostile-front')
  const res = await create(S1(), mod(newCustomer(), { contentHashSha256: 'deadbeef', content_hash_sha256: 'deadbeef' }), { front, back: BACK() })
  expect(res.status, res.text).toBe(201)
  const images = await q4(res.body.customerId)
  expect(images.map((i) => i.content_hash_sha256)).not.toContain('deadbeef')
  expect(images.find((i) => i.id === res.body.frontImageId).content_hash_sha256).toBe(front.sha)
})

test('6.24 — Erin with no middle name, no email and no aliases is saved with nulls and no alias rows', async () => {
  const made = await makeCustomer({ firstName: 'Erin', middleName: '', aliases: [], email: '' })
  const c = await q1(made.id)
  expect([c.middle_name, c.email]).toEqual([null, null])
  expect(await q2(made.id)).toEqual([])
})

test('6.25 — a second, ordinary customer (Frank) is created and has his own customer id', async () => {
  const a = await makeCustomer({ firstName: 'Frank' })
  const b = await makeCustomer({ firstName: 'Frank' })
  expect(a.id).toMatch(UUID)
  expect(a.id).not.toBe(b.id)
})
