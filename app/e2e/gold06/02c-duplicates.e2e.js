// Gold Phase 6 UAT, section C: duplicates and collisions (spec 1.6 "Uniqueness and collisions", 5.2, 6.1).
// Alice is made once per run with unique values; every row derives its payload from hers.
import { expect, test } from '@playwright/test'
import { AAL2, BOTH, ENTITY_ID, FRONT, create, memo, mod, newCustomer, q1, q3, sql, staff, tag, totals } from './support.js'

const S1 = () => AAL2('s1')
const B1 = newCustomer({ firstName: 'Alice', middleName: 'Q', email: 'alice.uatsix@example.test' })
const ALICE_NAME = 'Alice Q Uatsix'
const aliceId = memo(async () => {
  const res = await create(S1(), B1, BOTH())
  if (res.status !== 201) throw new Error(`Alice was not created: ${res.status} ${res.text}`)
  return res.body.customerId
})

// B2: another person (Bob) presenting Alice's number.
const bobPayload = (changes = {}) => mod(B1, { firstName: `Bob${tag()}`, dateOfBirth: '1970-07-07', phone: fresh().phone, email: '', aliases: [], ...changes })
const fresh = (changes = {}) => newCustomer(changes)

const expectOwner = async (res, id = null) => {
  expect(res.status, res.text).toBe(409)
  expect(res.body.error).toBe('id_on_file')
  expect(res.body.owner).toMatchObject({ customerId: id ?? (await aliceId()), name: ALICE_NAME, dateOfBirth: B1.dateOfBirth, documentType: 'Driver licence' })
}

// A refused call leaves every total unchanged, including the stored objects.
const refusedOnce = async (token, payload, check) => {
  await aliceId()
  const before = await totals()
  const res = await create(token, payload, BOTH())
  await check(res)
  expect(await totals()).toEqual(before)
}

const expectDuplicate = async (res, reason) => {
  expect(res.status, res.text).toBe(409)
  expect(res.body.error).toBe('possible_duplicates')
  expect(res.body.duplicates[0]).toMatchObject({ customerId: await aliceId(), matchReason: reason })
}

test('6.59 ⚠ — the same Driver licence number as Alice is 409 id_on_file naming Alice', async () => {
  await refusedOnce(S1(), bobPayload(), (res) => expectOwner(res))
})

test('6.60 ⚠ — the number is compared trimmed and upper-cased', async () => {
  await refusedOnce(S1(), bobPayload({ 'id.documentNumber': ` ${B1.id.documentNumber.toLowerCase()} ` }), (res) => expectOwner(res))
})

test('6.61 — the same number on a different document type is not a collision', async () => {
  await aliceId()
  const res = await create(S1(), bobPayload({ 'id.documentType': 'Passport' }), { front: FRONT() })
  expect(res.status, res.text).toBe(201)
})

test('6.62 ⚠ — differentPerson saves the capture as different_person; Alice is unchanged', async () => {
  const alice = await aliceId()
  const aliceBefore = JSON.stringify(await q3(alice))
  const res = await create(S1(), bobPayload({ differentPerson: true }), BOTH())
  expect(res.status, res.text).toBe(201)
  expect((await q3(res.body.customerId))[0]).toMatchObject({ new_capture_reason: 'different_person', prior_verification_id: null })
  expect(JSON.stringify(await q3(alice))).toBe(aliceBefore)
})

test('6.63 — a third person with the same number is also saved as different_person', async () => {
  await aliceId()
  for (const name of ['Bob', 'Cara']) {
    const res = await create(S1(), bobPayload({ firstName: `${name}${tag()}`, differentPerson: true }), BOTH())
    expect(res.status, `${name}: ${res.text}`).toBe(201)
    expect((await q3(res.body.customerId))[0].new_capture_reason, name).toBe('different_person')
  }
})

test('6.64 ⚠ — differentPerson on a number nobody holds saves with a null reason', async () => {
  const res = await create(S1(), fresh({ differentPerson: true }), BOTH())
  expect(res.status, res.text).toBe(201)
  expect((await q3(res.body.customerId))[0].new_capture_reason).toBeNull()
})

test('6.65 ⚠ — that number is then a collision for the next person (409 id_on_file naming the holder)', async () => {
  const dora = fresh({ firstName: 'Dora', differentPerson: true })
  const first = await create(S1(), dora, BOTH())
  expect(first.status, first.text).toBe(201)
  const before = await totals()
  const res = await create(S1(), fresh({ firstName: 'Dee', 'id.documentNumber': dora.id.documentNumber }), BOTH())
  expect(res.status, res.text).toBe(409)
  expect(res.body.owner).toMatchObject({ customerId: first.body.customerId, name: expect.stringContaining('Dora') })
  expect(await totals()).toEqual(before)
})

test('6.66 — Entity Two may use Alice’s number: uniqueness is per business', async () => {
  await aliceId()
  const res = await create(AAL2('x1'), mod(B1, { firstName: `Xena${tag()}`, dateOfBirth: '1990-01-01', phone: fresh().phone, email: '', aliases: [] }), BOTH())
  expect(res.status, res.text).toBe(201)
  const [{ e }] = await sql`select reporting_entity_id as e from public.staff_members where id = ${staff('x1').id}`
  expect((await q1(res.body.customerId)).reporting_entity_id).toBe(e)
  expect(e).not.toBe(ENTITY_ID)
})

test('6.67 ⚠ — Alice’s name and date of birth with a new phone and number is 409 possible_duplicates (name_dob)', async () => {
  await refusedOnce(S1(), mod(B1, { phone: fresh().phone, 'id.documentNumber': fresh().id.documentNumber }), async (res) => {
    await expectDuplicate(res, 'name_dob')
    expect(res.body.duplicates[0]).toMatchObject({ firstName: 'Alice', lastName: 'Uatsix', dateOfBirth: B1.dateOfBirth, phone: B1.phone })
  })
})

test('6.68 — the name match is case-insensitive', async () => {
  await refusedOnce(S1(), mod(B1, { firstName: 'ALICE', lastName: 'UATSIX', phone: fresh().phone, 'id.documentNumber': fresh().id.documentNumber }), (res) => expectDuplicate(res, 'name_dob'))
})

test('6.69 ⚠ — Alice’s phone written with +61 is 409 possible_duplicates (phone)', async () => {
  const intl = `+61 ${B1.phone.slice(1)}`
  await refusedOnce(S1(), fresh({ phone: intl }), (res) => expectDuplicate(res, 'phone'))
})

test('6.70 — the same name with a date of birth one day off is not a duplicate', async () => {
  await aliceId()
  const next = new Date(Date.parse(`${B1.dateOfBirth}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
  const res = await create(S1(), mod(B1, { dateOfBirth: next, phone: fresh().phone, 'id.documentNumber': fresh().id.documentNumber }), BOTH())
  expect(res.status, res.text).toBe(201)
})

test('6.71 — a phone differing in the last digit is not a duplicate', async () => {
  await aliceId()
  const last = B1.phone.slice(-1)
  const other = `${B1.phone.slice(0, -1)}${(Number(last) + 1) % 10}`
  const res = await create(S1(), fresh({ phone: other }), BOTH())
  expect(res.status, res.text).toBe(201)
})

test('6.72 ⚠ — confirmNew creates a second Alice with the same name and date of birth', async () => {
  await aliceId()
  const res = await create(S1(), mod(B1, { phone: fresh().phone, 'id.documentNumber': fresh().id.documentNumber, confirmNew: true }), BOTH())
  expect(res.status, res.text).toBe(201)
  const [{ n }] = await sql`select count(*)::int as n from public.customers where first_name = 'Alice' and last_name = 'Uatsix' and date_of_birth = ${B1.dateOfBirth}`
  expect(n).toBe(2)
})

test('6.73 ⚠ — confirmNew does not override an ID collision', async () => {
  await refusedOnce(S1(), bobPayload({ confirmNew: true }), (res) => expectOwner(res))
})

test('6.74 — when the number, name and date of birth all match, the ID collision is reported first', async () => {
  await refusedOnce(S1(), mod(B1, { phone: fresh().phone }), (res) => expectOwner(res))
})

test('6.75 ⚠ — another business’s customers are never shown as duplicates', async () => {
  await aliceId()
  const res = await create(AAL2('x1'), mod(B1, { 'id.documentNumber': fresh().id.documentNumber }), BOTH())
  expect(res.status, res.text).toBe(201)
})

test('6.76 — refused calls store no photo: the object count is unchanged after 6.59, 6.60, 6.67 and 6.73', async () => {
  await aliceId()
  const before = (await totals()).objects
  const payloads = [
    bobPayload(),
    bobPayload({ 'id.documentNumber': ` ${B1.id.documentNumber.toLowerCase()} ` }),
    mod(B1, { phone: fresh().phone, 'id.documentNumber': fresh().id.documentNumber }),
    bobPayload({ confirmNew: true }),
  ]
  for (const payload of payloads) expect((await create(S1(), payload, BOTH())).status).toBe(409)
  expect((await totals()).objects).toBe(before)
})

test('6.144 — differentPerson only applies to a real collision (6.64) and confirmNew never overrides an ID collision (6.73)', async () => {
  const held = fresh({ differentPerson: true })
  const unheld = await create(S1(), held, BOTH())
  expect(unheld.status, unheld.text).toBe(201)
  expect((await q3(unheld.body.customerId))[0].new_capture_reason).toBeNull()
  const second = await create(S1(), fresh({ 'id.documentNumber': held.id.documentNumber, confirmNew: true }), BOTH())
  expect([second.status, second.body.error]).toEqual([409, 'id_on_file'])
})

test('6.145 — an ID collision is reported before a name/DOB or phone match (6.74)', async () => {
  await aliceId()
  const res = await create(S1(), mod(B1, { phone: fresh().phone }), BOTH())
  expect([res.status, res.body.error]).toEqual([409, 'id_on_file'])
})
