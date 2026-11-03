// Gold Phase 6 UAT: section G (update_customer_phone, called over REST with real tokens) and the
// non-UI rows of section H and J (spec 1.6, 4.5, 4.6, 6.1, 2.2).
import { expect, test } from '@playwright/test'
import { AAL2, ENTITY_ID, makeCustomer, phoneRpc, q1, q5, sql, staff } from './support.js'

test.describe.configure({ mode: 'serial' })

const S1 = () => AAL2('s1')
let frank

test.beforeAll(async () => {
  frank = (await makeCustomer({ firstName: 'Frank', phone: '0412 345 606', confirmNew: true })).id
})

const phoneOf = async () => (await q1(frank)).phone
const expectError = (res, status, code, message) => {
  expect(res.status, res.text).toBe(status)
  expect([res.body.code, res.body.message]).toEqual([code, message])
}

test('6.121 — staff change a phone: 200 true and the new number is saved', async () => {
  const res = await phoneRpc(S1(), frank, '0488 777 666')
  expect([res.status, res.body]).toEqual([200, true])
  expect(await phoneOf()).toBe('0488 777 666')
})

test('6.122 — a phone_change audit row by S1 holds old -> new for the phone and nothing else', async () => {
  const last = (await q5(frank)).at(-1)
  expect(last).toMatchObject({ source: 'phone_change', changed_by: staff('s1').id })
  expect(last.changes).toEqual({ phone: { old: '0412 345 606', new: '0488 777 666' } })
})

test('6.123 — the same number padded with spaces answers false and writes no audit row', async () => {
  const audit = await q5(frank)
  const res = await phoneRpc(S1(), frank, ' 0488 777 666 ')
  expect([res.status, res.body]).toEqual([200, false])
  expect(await q5(frank)).toHaveLength(audit.length)
})

test('6.124 ⚠ — fewer than 8 digits, empty and blank are 22023 invalid_phone', async () => {
  for (const phone of ['1234567', '123 4567', '+61 (0) 12-34', '', '   ']) {
    expectError(await phoneRpc(S1(), frank, phone), 400, '22023', 'invalid_phone')
  }
  expect(await phoneOf()).toBe('0488 777 666')
})

test('6.125 — exactly 8 digits and a punctuated number are accepted', async () => {
  for (const phone of ['12345678', '(03) 9123 4567']) {
    const res = await phoneRpc(S1(), frank, phone)
    expect([res.status, res.body], phone).toEqual([200, true])
    expect(await phoneOf()).toBe(phone)
  }
})

test('6.126 — managers and admins may change a phone too', async () => {
  for (const [who, phone] of [['m1', '0499 100 001'], ['a1', '0499 100 002']]) {
    const res = await phoneRpc(AAL2(who), frank, phone)
    expect([res.status, res.body], who).toEqual([200, true])
    expect((await q5(frank)).at(-1).changed_by).toBe(staff(who).id)
  }
})

test('6.131 ⚠ — a phone change leaves the past TTR party copy of the number alone', async () => {
  const tx = '00000000-0000-4000-8000-0000000006b1'
  const party = '00000000-0000-4000-8000-0000000006b2'
  await sql`insert into ttr.transactions (id, reporting_entity_id, scenario, transaction_ref, transaction_datetime, designated_service,
      location_snapshot, staff_member_name, staff_member_email, cash_currency, cash_amount, aud_value, status, completed_at)
    values (${tx}, ${ENTITY_ID}, 'bullion_sell', 'UAT6-TX-2', '2026-01-01', 'Sale of bullion for physical cash',
      'Coburg, VIC', 'Staff', 'staff@example.test', 'AUD', 15000, 15000, 'complete', '2026-01-01')`
  await sql`insert into ttr.parties (id, transaction_id, party_type, first_name, last_name, date_of_birth, phone, res_street, res_suburb, res_state, res_postcode, customer_id)
    values (${party}, ${tx}, 'individual', 'Frank', 'Uatsix', '1981-06-06', '0412 345 606', '10 Test Street', 'Coburg', 'VIC', '3058', ${frank})`
  const hash = async () => (await sql`select md5(to_jsonb(p)::text) as h from ttr.parties p where id = ${party}`)[0].h
  const before = await hash()
  const res = await phoneRpc(S1(), frank, '0488 000 131')
  expect([res.status, res.body]).toEqual([200, true])
  expect(await hash()).toBe(before)
  expect((await sql`select phone from ttr.parties where id = ${party}`)[0].phone).toBe('0412 345 606')
})

