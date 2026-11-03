// Gold Phase 6 UAT, section F: gold-update-customer, managers and admins (spec 4.2, 4.3, 4.5, 5.2 "Edit rows", 6.1).
import { expect, test } from '@playwright/test'
import { AAL2, ENTITY_ID, edit, idHash, makeCustomer, q1, q5, sql, staff } from './support.js'

test.describe.configure({ mode: 'serial' })

const M1 = () => AAL2('m1')
const sorted = (o) => Object.keys(o ?? {}).sort()
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d)
const TX = '00000000-0000-4000-8000-0000000006a1'
const PARTY = '00000000-0000-4000-8000-0000000006a2'

let erin
let idHashBefore
let partyHashBefore

const partyHash = async () => (await sql`select md5(to_jsonb(p)::text) as h from ttr.parties p where id = ${PARTY}`)[0].h

test.beforeAll(async () => {
  const made = await makeCustomer({ firstName: 'Erin', middleName: '', aliases: [], email: '', dateOfBirth: '1980-05-05', phone: '0412 345 605', confirmNew: true })
  erin = made.id
  idHashBefore = await idHash(erin)
  await sql`insert into ttr.transactions (id, reporting_entity_id, scenario, transaction_ref, transaction_datetime, designated_service,
      location_snapshot, staff_member_name, staff_member_email, cash_currency, cash_amount, aud_value, status, completed_at)
    values (${TX}, ${ENTITY_ID}, 'bullion_sell', 'UAT6-TX-1', '2026-01-01', 'Sale of bullion for physical cash',
      'Coburg, VIC', 'Staff', 'staff@example.test', 'AUD', 15000, 15000, 'complete', '2026-01-01')`
  await sql`insert into ttr.parties (id, transaction_id, party_type, first_name, last_name, date_of_birth, phone, res_street, res_suburb, res_state, res_postcode, customer_id)
    values (${PARTY}, ${TX}, 'individual', 'Erin', 'Uatsix', '1980-05-05', '0412 345 605', '10 Test Street', 'Coburg', 'VIC', '3058', ${erin})`
  partyHashBefore = await partyHash()
})

const change = (token, changes, customerId = erin) => edit(token, { customerId, changes })

test('6.101 — a manager changes the first name and address: 200 listing exactly the columns that changed', async () => {
  const before = await q1(erin)
  const res = await change(M1(), { firstName: 'Erina', residentialAddress: { street: '22 New Street', suburb: 'Brunswick', state: 'VIC', postcode: '3056' } })
  expect(res.status, res.text).toBe(200)
  expect(res.body.customerId).toBe(erin)
  expect([...res.body.changed].sort()).toEqual(['first_name', 'res_postcode', 'res_street', 'res_suburb'])
  const after = await q1(erin)
  expect(after).toMatchObject({ first_name: 'Erina', res_street: '22 New Street', res_suburb: 'Brunswick', res_postcode: '3056', res_state: 'VIC' })
  expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime())
})

test('6.102 — one gold_edit audit row by M1 holds old -> new for those columns and nothing else', async () => {
  const rows = await q5(erin)
  expect(rows.map((r) => r.source)).toEqual(['gold_create', 'gold_edit'])
  const edit1 = rows[1]
  expect(edit1.changed_by).toBe(staff('m1').id)
  expect(Math.abs(edit1.changed_at.getTime() - Date.now())).toBeLessThan(10 * 60_000)
  expect(edit1.changes).toEqual({
    first_name: { old: 'Erin', new: 'Erina' },
    res_street: { old: '10 Test Street', new: '22 New Street' },
    res_suburb: { old: 'Coburg', new: 'Brunswick' },
    res_postcode: { old: '3058', new: '3056' },
  })
})

test('6.103 ⚠ — the past TTR party copy is unchanged and still linked to Erin', async () => {
  expect(await partyHash()).toBe(partyHashBefore)
  const [p] = await sql`select first_name, res_street, res_suburb, res_postcode, customer_id from ttr.parties where id = ${PARTY}`
  expect(p).toEqual({ first_name: 'Erin', res_street: '10 Test Street', res_suburb: 'Coburg', res_postcode: '3058', customer_id: erin })
})

test('6.104 — ID details are untouched by an edit', async () => {
  expect(await idHash(erin)).toBe(idHashBefore)
})

test('6.105 — an admin may edit: 200, changed first_name, audited as A1', async () => {
  const res = await change(AAL2('a1'), { firstName: 'Erin' })
  expect([res.status, res.body.changed]).toEqual([200, ['first_name']])
  const last = (await q5(erin)).at(-1)
  expect(last).toMatchObject({ source: 'gold_edit', changed_by: staff('a1').id })
  expect(last.changes).toEqual({ first_name: { old: 'Erina', new: 'Erin' } })
})

test('6.106 — every field kind in one call is saved, normalised and audited column by column', async () => {
  const res = await change(M1(), {
    middleName: 'R',
    lastName: 'Uatsix',
    dateOfBirth: '1980-05-06',
    gender: 'f',
    phone: '0412 345 615',
    email: 'erin@example.test',
    occupation: 'Jeweller',
    citizenshipCountryCode: 'nz',
    taxResidencyCountryCode: 'au',
  })
  expect(res.status, res.text).toBe(200)
  const columns = ['citizenship_country_code', 'date_of_birth', 'email', 'gender', 'middle_name', 'occupation', 'phone', 'tax_residency_country_code']
  expect([...res.body.changed].sort()).toEqual(columns)
  const row = await q1(erin)
  expect(row).toMatchObject({ gender: 'F', citizenship_country_code: 'NZ', tax_residency_country_code: 'AU', middle_name: 'R', occupation: 'Jeweller', email: 'erin@example.test', phone: '0412 345 615' })
  expect(iso(row.date_of_birth)).toBe('1980-05-06')
  const last = (await q5(erin)).at(-1)
  expect(sorted(last.changes)).toEqual(columns)
  expect(last.changes.middle_name).toEqual({ old: null, new: 'R' })
  expect(last.changes.phone).toEqual({ old: '0412 345 605', new: '0412 345 615' })
  expect(last.changes.gender).toEqual({ old: null, new: 'F' })
})

test('6.107 — clearing optional fields sets them to null and audits old -> null', async () => {
  const res = await change(M1(), { middleName: '', email: '', occupation: '', gender: '', citizenshipCountryCode: '' })
  expect(res.status, res.text).toBe(200)
  const row = await q1(erin)
  for (const c of ['middle_name', 'email', 'occupation', 'gender', 'citizenship_country_code']) expect(row[c], c).toBeNull()
  const last = (await q5(erin)).at(-1)
  expect(last.changes.middle_name).toEqual({ old: 'R', new: null })
  expect(last.changes.email).toEqual({ old: 'erin@example.test', new: null })
  expect(last.changes.citizenship_country_code).toEqual({ old: 'NZ', new: null })
})

test('6.108 — sending the current values changes nothing and writes no audit row', async () => {
  const audit = await q5(erin)
  const res = await change(M1(), { firstName: 'Erin', lastName: 'Uatsix' })
  expect([res.status, res.body.changed]).toEqual([200, []])
  expect(await q5(erin)).toHaveLength(audit.length)
})
