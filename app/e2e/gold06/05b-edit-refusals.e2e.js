// Gold Phase 6 UAT, section F refusals and edge cases of gold-update-customer (spec 4.3, 5.2, 6.1).
// Each row starts from Erin as she was created and checks that Erin, her ID and her audit rows are unchanged.
import { expect, test } from '@playwright/test'
import { AAL2, ENTITY_ID, edit, edgeLogs, idHash, makeCustomer, q1, q5, sql } from './support.js'

const M1 = () => AAL2('m1')
const sorted = (o) => Object.keys(o ?? {}).sort()

let erin
let idHashBefore
let since

test.beforeAll(async () => {
  since = new Date(Date.now() - 2000).toISOString()
  const made = await makeCustomer({ firstName: 'Erin', middleName: '', aliases: [], email: '', dateOfBirth: '1980-05-05', phone: '0412 345 605', confirmNew: true })
  erin = made.id
  idHashBefore = await idHash(erin)
})

const change = (token, changes, customerId = erin) => edit(token, { customerId, changes })

const refused = async (changes, status, fields, error = 'validation_failed') => {
  const [row, audit] = [await q1(erin), await q5(erin)]
  const res = await change(M1(), changes)
  expect(res.status, `${JSON.stringify(changes)}: ${res.text}`).toBe(status)
  expect(res.body.error).toBe(error)
  if (fields) expect(sorted(res.body.fields)).toEqual([...fields].sort())
  expect(await q1(erin)).toEqual(row)
  expect(await q5(erin)).toEqual(audit)
}

test('6.109 ⚠ — ID details and ownership are refused with the key named', async () => {
  const keys = { documentNumber: 'UAT6-DL-777', documentType: 'Passport', issuer: 'NSW', source: 'ttr', reportingEntityId: '00000000-0000-4000-8000-0000000000e2', customerType: 'company', id: '00000000-0000-4000-8000-0000000000aa', aliases: ['X'] }
  for (const [key, value] of Object.entries(keys)) await refused({ [key]: value }, 400, [key])
  expect(await idHash(erin)).toBe(idHashBefore)
})

test('6.110 — a mix of a valid and a forbidden field applies neither', async () => {
  await refused({ firstName: 'Ok', documentNumber: 'X' }, 400, ['documentNumber'])
})

test('6.111 — a phone of 7 digits, empty or null is 400 phone and the phone is unchanged', async () => {
  for (const phone of ['1234567', '', null]) await refused({ phone }, 400, ['phone'])
})

test('6.112 — a phone of 8 digits is accepted', async () => {
  const res = await change(M1(), { phone: '1234 5678' })
  expect([res.status, res.body.changed]).toEqual([200, ['phone']])
})

test('6.113 — a required name cannot be cleared', async () => {
  await refused({ firstName: '' }, 400, ['firstName'])
  await refused({ lastName: '  ' }, 400, ['lastName'])
})

test('6.114 — a future, too-early, impossible or empty date of birth is 400 dateOfBirth', async () => {
  for (const dateOfBirth of ['2999-01-01', '1899-12-31', '1980-13-01', '']) await refused({ dateOfBirth }, 400, ['dateOfBirth'])
})

test('6.115 — an unknown gender, a malformed email and a 3-letter country are each refused by name', async () => {
  await refused({ gender: 'X' }, 400, ['gender'])
  await refused({ email: 'erin@' }, 400, ['email'])
  await refused({ citizenshipCountryCode: 'NZL' }, 400, ['citizenshipCountryCode'])
})

test('6.116 — a partial address is refused: the whole address is replaced so every part is needed', async () => {
  await refused({ residentialAddress: { street: '1 A St' } }, 400, ['residentialAddress.suburb', 'residentialAddress.state', 'residentialAddress.postcode'])
})

test('6.117 — empty, missing or array changes, a missing customerId and a non-JSON body are refused', async () => {
  const bad = async (body, status, error, field) => {
    const res = await edit(M1(), body)
    expect([res.status, res.body.error], JSON.stringify(body)).toEqual([status, error])
    if (field) expect(sorted(res.body.fields)).toContain(field)
  }
  await bad({ customerId: erin, changes: {} }, 400, 'validation_failed', 'changes')
  await bad({ customerId: erin }, 400, 'validation_failed', 'changes')
  await bad({ customerId: erin, changes: [] }, 400, 'validation_failed', 'changes')
  await bad({ changes: { firstName: 'X' } }, 400, 'validation_failed', 'customerId')
  await bad('not json', 400, 'invalid_request')
})

test('6.118 ⚠ — a made-up customer, another business’s customer and Entity Two as the caller are all 404', async () => {
  const { id: xena } = await makeCustomer({}, { token: AAL2('x1') })
  const tokens = [[M1(), '00000000-0000-4000-8000-000000000999'], [M1(), xena], [AAL2('x1'), erin]]
  for (const [token, customerId] of tokens) {
    const res = await change(token, { firstName: 'Nope' }, customerId)
    expect([res.status, res.body.error]).toEqual([404, 'customer_not_found'])
  }
})

test('6.119 — a company customer cannot be edited (404)', async () => {
  const [{ id }] = await sql`insert into public.customers (reporting_entity_id, customer_type, source, entity_name, reg_identifier)
    values (${ENTITY_ID}, 'company', 'ttr', 'Uatsix Pty Ltd', '12345678901') returning id`
  const res = await change(M1(), { firstName: 'X' }, id)
  expect([res.status, res.body.error]).toEqual([404, 'customer_not_found'])
})

test('6.147 — edit refuses aliases, postal address, sole-trader and ABN fields in this phase', async () => {
  for (const key of ['aliases', 'postalAddress', 'hasPostalAddress', 'isSoleTrader', 'abn', 'entityName']) await refused({ [key]: key === 'aliases' ? ['X'] : 'X' }, 400, [key])
})

test('6.120 — the logs of the refusals and of a failed edit hold none of the personal data', async () => {
  // The refusals above log nothing, so make one edit fail inside the database and read what it logs.
  await sql`alter table public.customers add constraint uat6_block7 check (last_name <> 'Uatsixlog') not valid`
  try {
    const res = await change(M1(), { firstName: 'Erina', lastName: 'Uatsixlog', phone: '0412 345 699', email: 'erin@example.test', residentialAddress: { street: '22 New Street', suburb: 'Brunswick', state: 'VIC', postcode: '3056' } })
    expect([res.status, res.body.error]).toEqual([500, 'update_failed'])
  } finally {
    await sql`alter table public.customers drop constraint if exists uat6_block7`
  }
  let logs = ''
  await expect
    .poll(
      () => {
        logs = edgeLogs(since)
        return logs
      },
      { timeout: 15_000 },
    )
    .toMatch(/gold-update-customer: update failed/)
  for (const secret of ['Erin', 'Erina', 'Uatsix', '0412 345', '1980-05', '22 New Street', 'Brunswick', 'example.test']) expect(logs).not.toContain(secret)
})
