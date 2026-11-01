// Gold Phase 6 UAT, section B (per-type photo and expiry rules, required fields, request shape) and the
// create-side decisions of section I (spec 1.6, 4.3, 5.2, 6.1). Every row is independent of the others.
import { expect, test } from '@playwright/test'
import { localEnv } from '../support/env.js'
import { AAL2, BOTH, FRONT, create, melbourneToday, newCustomer, photo, q1, q2, q3, q4, raw, totals } from './support.js'

const S1 = () => AAL2('s1')
const sorted = (o) => Object.keys(o ?? {}).sort()

// A refused call: the status and body are as expected and no row or object was written.
const expectRefusedCall = async (res, status, error, fields) => {
  expect(res.status, res.text).toBe(status)
  if (error) expect(res.body.error).toBe(error)
  if (fields) expect(sorted(res.body.fields)).toEqual([...fields].sort())
}

// ─── Back photo and expiry follow CCP's per-type rules ────────────────────────────────────────

const refusedWithNoTrace = async (payload, photos, fields, error = 'validation_failed') => {
  const before = await totals()
  const res = await create(S1(), payload, photos)
  await expectRefusedCall(res, 400, error, fields)
  expect(await totals()).toEqual(before)
  return res
}

test('6.26 ⚠ — a Driver licence with the front photo only is 400 backImage; nothing stored', async () => {
  await refusedWithNoTrace(newCustomer(), { front: FRONT() }, ['backImage'])
})

test('6.27 — a Driver licence with front and back is created', async () => {
  const res = await create(S1(), newCustomer(), BOTH())
  expect(res.status, res.text).toBe(201)
})

test('6.28 — Passport, Proof of age card, National identity card, Medicare card and Other government document need no back photo', async () => {
  for (const documentType of ['Passport', 'Proof of age card', 'National identity card', 'Medicare card', 'Other government document']) {
    const res = await create(S1(), newCustomer({ 'id.documentType': documentType }), { front: FRONT() })
    expect(res.status, `${documentType}: ${res.text}`).toBe(201)
    expect(res.body.backImageId, documentType).toBeNull()
    expect(await q4(res.body.customerId), documentType).toHaveLength(1)
    expect((await q3(res.body.customerId))[0], documentType).toMatchObject({ back_image_id: null, document_type: documentType })
  }
})

test('6.29 — Other with a description is saved with its description and sentence', async () => {
  const res = await create(S1(), newCustomer({ 'id.documentType': 'Other', 'id.documentTypeOther': 'Student card' }), { front: FRONT() })
  expect(res.status, res.text).toBe(201)
  expect((await q3(res.body.customerId))[0]).toMatchObject({
    document_type: 'Other',
    document_type_other: 'Student card',
    verification_description: 'Original Student card sighted in person',
  })
})

test('6.30 — Other with no description is 400 id.documentTypeOther', async () => {
  await refusedWithNoTrace(newCustomer({ 'id.documentType': 'Other' }), { front: FRONT() }, ['id.documentTypeOther'])
})

test('6.31 — a passport with front and back stores both photos', async () => {
  const res = await create(S1(), newCustomer({ 'id.documentType': 'Passport' }), BOTH())
  expect(res.status, res.text).toBe(201)
  expect(await q4(res.body.customerId)).toHaveLength(2)
})

test('6.32 — a passport with no photos is 400 frontImage', async () => {
  await refusedWithNoTrace(newCustomer({ 'id.documentType': 'Passport' }), {}, ['frontImage'])
})

test('6.33 — Birth certificate, Electronic verification source and an empty type are 400 id.documentType', async () => {
  for (const documentType of ['Birth certificate', 'Electronic verification source', '']) {
    await refusedWithNoTrace(newCustomer({ 'id.documentType': documentType }), BOTH(), ['id.documentType'])
  }
})

test('6.34 — hasExpiry true with an expiry date stores both', async () => {
  const res = await create(S1(), newCustomer({ 'id.hasExpiry': true, 'id.expiryDate': '2031-01-31' }), BOTH())
  expect(res.status, res.text).toBe(201)
  const [c] = await q3(res.body.customerId)
  expect(c.has_expiry).toBe(true)
  expect(c.expiry_date.toISOString().slice(0, 10)).toBe('2031-01-31')
})

test('6.35 — hasExpiry false with no expiry date stores has_expiry false and a null date', async () => {
  const res = await create(S1(), newCustomer({ 'id.hasExpiry': false, 'id.expiryDate': undefined }), BOTH())
  expect(res.status, res.text).toBe(201)
  expect((await q3(res.body.customerId))[0]).toMatchObject({ has_expiry: false, expiry_date: null })
})

test('6.36 ⚠ — hasExpiry true with a missing, empty, impossible or non-ISO expiry date is 400 id.expiryDate', async () => {
  for (const expiryDate of [undefined, '', '2031-02-30', '31/01/2031']) {
    await refusedWithNoTrace(newCustomer({ 'id.hasExpiry': true, 'id.expiryDate': expiryDate }), BOTH(), ['id.expiryDate'])
  }
})

test('6.37 — hasExpiry missing or the string "yes" is 400 id.hasExpiry', async () => {
  for (const hasExpiry of [undefined, 'yes']) {
    await refusedWithNoTrace(newCustomer({ 'id.hasExpiry': hasExpiry }), BOTH(), ['id.hasExpiry'])
  }
})

// ─── Required fields and the phone rule: one test per sheet row ───────────────────────────────

const ADDRESS_ALL = ['residentialAddress.street', 'residentialAddress.suburb', 'residentialAddress.state', 'residentialAddress.postcode']
// [row, spec, [[changes to B1, fields expected or null for 201], ...]]
const ROWS = [
  ['6.38 ⚠ — phone of 7 digits is 400 phone', [[{ phone: '1234567' }, ['phone']]]],
  ['6.39 ⚠ — phone of 7 digits with punctuation is 400 phone', [[{ phone: '12-34-56-7' }, ['phone']]]],
  ['6.40 — an empty or missing phone is 400 phone', [[{ phone: '' }, ['phone']], [{ phone: undefined }, ['phone']]]],
  ['6.41 — a phone of exactly 8 digits is accepted', [[{ phone: '12345678' }, null]]],
  ['6.42 — a phone of 11 digits with punctuation is accepted', [[{ phone: '+61 (3) 9123-4567' }, null]]],
  ['6.43 — an empty, blank or missing first name is 400 firstName', [[{ firstName: '' }, ['firstName']], [{ firstName: '   ' }, ['firstName']], [{ firstName: undefined }, ['firstName']]]],
  ['6.44 — an empty or missing last name is 400 lastName', [[{ lastName: '' }, ['lastName']], [{ lastName: undefined }, ['lastName']]]],
  [
    '6.45 — a missing, impossible or non-ISO date of birth is 400 dateOfBirth',
    [[{ dateOfBirth: undefined }, ['dateOfBirth']], [{ dateOfBirth: '1990-02-30' }, ['dateOfBirth']], [{ dateOfBirth: '14/03/1985' }, ['dateOfBirth']]],
  ],
  ['6.46 — a missing residential address names all four parts', [[{ residentialAddress: undefined }, ADDRESS_ALL]]],
  [
    '6.47 — each bad address part is named: street, suburb, state (unknown or empty), postcode (3, 5 digits or letters)',
    [
      [{ 'residentialAddress.street': '' }, ['residentialAddress.street']],
      [{ 'residentialAddress.suburb': '' }, ['residentialAddress.suburb']],
      [{ 'residentialAddress.state': 'XX' }, ['residentialAddress.state']],
      [{ 'residentialAddress.state': '' }, ['residentialAddress.state']],
      [{ 'residentialAddress.postcode': '305' }, ['residentialAddress.postcode']],
      [{ 'residentialAddress.postcode': '30580' }, ['residentialAddress.postcode']],
      [{ 'residentialAddress.postcode': '30A8' }, ['residentialAddress.postcode']],
    ],
  ],
  ['6.48 — a lower-case state is accepted', [[{ 'residentialAddress.state': 'nt' }, null]]],
  ['6.49 — an empty or missing ID number is 400 id.documentNumber', [[{ 'id.documentNumber': '' }, ['id.documentNumber']], [{ 'id.documentNumber': undefined }, ['id.documentNumber']]]],
  ['6.50 — an empty issuer is 400 id.issuer', [[{ 'id.issuer': '' }, ['id.issuer']]]],
  [
    '6.51 — an empty, 3-letter or alphanumeric ID country code is 400 id.idCountryCode',
    [[{ 'id.idCountryCode': '' }, ['id.idCountryCode']], [{ 'id.idCountryCode': 'AUS' }, ['id.idCountryCode']], [{ 'id.idCountryCode': 'A1' }, ['id.idCountryCode']]],
  ],
  ['6.52 — a lower-case ID country code is accepted and stored upper case', [[{ 'id.idCountryCode': 'au' }, null]]],
  ['6.53 — omitted or blank aliases are accepted and no alias rows are written', [[{ aliases: undefined }, null], [{ aliases: ['', '  '] }, null]]],
  ['6.54 — an omitted email is accepted and stored as null', [[{ email: undefined }, null]]],
]

for (const [name, variations] of ROWS) {
  test(name, async () => {
    for (const [changes, fields] of variations) {
      const payload = newCustomer(changes)
      const before = await totals()
      const res = await create(S1(), payload, BOTH())
      const label = JSON.stringify(changes)
      if (fields) {
        expect([res.status, res.body.error, sorted(res.body.fields)], label).toEqual([400, 'validation_failed', [...fields].sort()])
        expect(await totals(), label).toEqual(before)
        continue
      }
      expect(res.status, `${label}: ${res.text}`).toBe(201)
      const id = res.body.customerId
      if (name.startsWith('6.48')) expect((await q1(id)).res_state).toBe('NT')
      if (name.startsWith('6.52')) expect((await q3(id))[0].id_country_code).toBe('AU')
      if (name.startsWith('6.53')) expect(await q2(id), label).toEqual([])
      if (name.startsWith('6.54')) expect((await q1(id)).email).toBeNull()
    }
  })
}

// ─── Request shape ────────────────────────────────────────────────────────────────────────────

const url = () => `${localEnv().API_URL}/functions/v1/gold-create-customer`
const authHeaders = (token) => ({ apikey: localEnv().ANON_KEY, Authorization: `Bearer ${token}` })

test('6.55 — a JSON body (not multipart) is 400 invalid_request', async () => {
  const res = await raw('gold-create-customer', { method: 'POST', headers: { ...authHeaders(S1()), 'Content-Type': 'application/json' }, body: JSON.stringify(newCustomer()) })
  expect([res.status, res.body.error]).toEqual([400, 'invalid_request'])
})

test('6.56 — a payload that is not JSON is 400 invalid_request', async () => {
  const res = await create(S1(), 'not json', BOTH())
  expect([res.status, res.body.error]).toEqual([400, 'invalid_request'])
})

test('6.57 — GET is 405 method_not_allowed for a valid staff token', async () => {
  const res = await raw('gold-create-customer', { method: 'GET', headers: authHeaders(S1()) })
  expect([res.status, res.body.error]).toEqual([405, 'method_not_allowed'])
})

test('6.58 — the CORS preflight without credentials succeeds (2xx) with Access-Control-Allow-Origin (the handler own 204 is in gold06Flag.test.ts)', async () => {
  const res = await fetch(url(), { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST' } })
  expect([200, 204], `preflight answered ${res.status}`).toContain(res.status)
  expect(res.headers.get('access-control-allow-origin')).toBeTruthy()
})


// ─── I: decisions the spec leaves open (create side) ──────────────────────────────────────────

test('6.138 — date of birth: today and 1900-01-01 are accepted; tomorrow and 1899-12-31 are 400 dateOfBirth', async () => {
  for (const [dob, ok] of [[melbourneToday(), true], [melbourneToday(1), false], ['1900-01-01', true], ['1899-12-31', false]]) {
    const res = await create(S1(), newCustomer({ dateOfBirth: dob }), BOTH())
    if (ok) expect(res.status, `${dob}: ${res.text}`).toBe(201)
    else expect([res.status, sorted(res.body.fields)], dob).toEqual([400, ['dateOfBirth']])
  }
})

test('6.139 — names and ID numbers: 100 characters accepted, 101 refused', async () => {
  const ok1 = await create(S1(), newCustomer({ firstName: 'a'.repeat(100) }), BOTH())
  expect(ok1.status, ok1.text).toBe(201)
  const bad1 = await create(S1(), newCustomer({ firstName: 'a'.repeat(101) }), BOTH())
  expect([bad1.status, sorted(bad1.body.fields)]).toEqual([400, ['firstName']])
  const ok2 = await create(S1(), newCustomer({ 'id.documentNumber': '9'.repeat(100) }), BOTH())
  expect(ok2.status, ok2.text).toBe(201)
  const bad2 = await create(S1(), newCustomer({ 'id.documentNumber': '9'.repeat(101) }), BOTH())
  expect([bad2.status, sorted(bad2.body.fields)]).toEqual([400, ['id.documentNumber']])
})

test('6.140 — an email without a domain is 400 email; a normal address is accepted', async () => {
  const bad = await create(S1(), newCustomer({ email: 'alice@' }), BOTH())
  expect([bad.status, sorted(bad.body.fields)]).toEqual([400, ['email']])
  const ok = await create(S1(), newCustomer({ email: 'alice@example.test' }), BOTH())
  expect(ok.status, ok.text).toBe(201)
})

test('6.141 — photos: PDF, empty and 10 MB + 1 are 400 frontImage; exactly 10 MB is accepted', async () => {
  const passport = (c = {}) => newCustomer({ 'id.documentType': 'Passport', ...c })
  for (const [label, front] of [
    ['pdf', photo('pdf', 2048, 'application/pdf')],
    ['10 MB + 1', photo('toobig', 10 * 1024 * 1024 + 1)],
    ['empty', { ...photo('empty', 2048), bytes: Buffer.alloc(0), size: 0 }],
  ]) {
    const res = await create(S1(), passport(), { front })
    expect([res.status, sorted(res.body.fields)], label).toEqual([400, ['frontImage']])
  }
  const big = await create(S1(), passport(), { front: photo('big', 10 * 1024 * 1024) })
  expect(big.status, big.text).toBe(201)
})

test('6.142 — a postcode of 0800 is accepted and res_country is always Australia', async () => {
  const res = await create(S1(), newCustomer({ 'residentialAddress.state': 'VIC', 'residentialAddress.postcode': '0800' }), BOTH())
  expect(res.status, res.text).toBe(201)
  expect(await q1(res.body.customerId)).toMatchObject({ res_postcode: '0800', res_country: 'Australia' })
})

test('6.143 — hasExpiry false stores no expiry date even if one is sent', async () => {
  const res = await create(S1(), newCustomer({ 'id.hasExpiry': false, 'id.expiryDate': '2031-01-31' }), BOTH())
  expect(res.status, res.text).toBe(201)
  expect((await q3(res.body.customerId))[0]).toMatchObject({ has_expiry: false, expiry_date: null })
})

test('6.146 — issuer holds the issuing state or authority as typed', async () => {
  for (const issuer of ['VIC', 'Department of Foreign Affairs']) {
    const res = await create(S1(), newCustomer({ 'id.issuer': issuer }), BOTH())
    expect(res.status, res.text).toBe(201)
    expect((await q3(res.body.customerId))[0].issuer).toBe(issuer)
  }
})

