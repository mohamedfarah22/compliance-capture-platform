// Gold Phase 6 UAT, section A: every function refuses what it should (spec 2.2, 4.5, 6.1).
// Rows 6.1 to 6.3 (the GOLD_JOURNEY_ENABLED secret) cannot be toggled on the shared local runtime:
// they are covered in supabase/functions/_shared/gold06Flag.test.ts.
import { expect, test } from '@playwright/test'
import { localEnv } from '../support/env.js'
import {
  AAL1,
  AAL2,
  BOTH,
  ENTITY_ID,
  create,
  edit,
  idPayload,
  makeCustomer,

  newCustomer,
  phoneRpc,
  q1,
  q5,
  raw,
  rest,
  rpc,
  multipartForm,
  sql,
  staff,
  totals,
  updateId,
} from './support.js'


const FUNCTIONS = ['gold-create-customer', 'gold-update-customer-id', 'gold-update-customer']
const MISSING = '00000000-0000-4000-8000-000000000999'

let erin
let erinPayload

test.beforeAll(async () => {
  const made = await makeCustomer({ firstName: 'Erin', middleName: '', aliases: [], email: '' })
  erin = made.id
  erinPayload = made.payload
})

// A call per function that would succeed for a fully entitled caller, so a refusal is about the caller.
const calls = (token) => ({
  'gold-create-customer': () => create(token, newCustomer(), BOTH()),
  'gold-update-customer-id': () =>
    updateId(token, idPayload(erin, { reason: 'different_document', documentType: 'Passport', documentNumber: `UAT6-PP-${Math.random()}`, issuer: 'Australia' }), { front: BOTH().front }),
  'gold-update-customer': () => edit(token, { customerId: erin, changes: { occupation: 'Jeweller' } }),
})

const expectRefused = async (token, status, error, names = FUNCTIONS) => {
  const before = await totals()
  for (const name of names) {
    const res = await calls(token)[name]()
    expect(res.status, `${name}: ${res.text}`).toBe(status)
    if (error) expect(res.body.error, name).toBe(error)
  }
  expect(await totals()).toEqual(before)
}

test('6.4 ⚠ — no Authorization header: all three functions answer 401', async () => {
  const before = await totals()
  for (const name of FUNCTIONS) {
    const res = await raw(name, { method: 'POST', headers: { apikey: localEnv().ANON_KEY }, body: multipartForm(newCustomer(), BOTH()) })
    expect(res.status, name).toBe(401)
  }
  expect(await totals()).toEqual(before)
})

test('6.5 ⚠ — the anon key as the bearer token is refused by all three functions (never 2xx)', async () => {
  const before = await totals()
  for (const name of FUNCTIONS) {
    const res = await calls(undefined)[name]()
    expect([401, 403], `${name}: ${res.status} ${res.text}`).toContain(res.status)
  }
  expect(await totals()).toEqual(before)
})

test('6.6 ⚠ — a password-only (aal1) token gets 403 mfa_required from all three functions', async () => {
  await expectRefused(AAL1('s1'), 403, 'mfa_required', ['gold-create-customer', 'gold-update-customer-id'])
  await expectRefused(AAL1('m1'), 403, 'mfa_required', ['gold-update-customer'])
  await expectRefused(AAL1('a1'), 403, 'mfa_required')
})

test('6.7 ⚠ — an inactive staff member at aal2 gets 403 forbidden from all three functions', async () => {
  await expectRefused(AAL2('i1'), 403, 'forbidden')
})

test('6.8 ⚠ — ordinary staff cannot edit customer details (403 forbidden); nothing changes, no audit row', async () => {
  const before = await q5(erin)
  const res = await edit(AAL2('s1'), { customerId: erin, changes: { firstName: 'Nope' } })
  expect(res.status).toBe(403)
  expect(res.body).toEqual({ error: 'forbidden' })
  expect((await q1(erin)).first_name).toBe('Erin')
  expect(await q5(erin)).toHaveLength(before.length)
})

test('6.9 — managers and admins both pass the manager check on gold-update-customer', async () => {
  for (const who of ['m1', 'a1']) {
    const res = await edit(AAL2(who), { customerId: erin, changes: { firstName: 'Erin' } })
    expect(res.status, who).toBe(200)
    expect(res.body.changed).toEqual([])
  }
})

test('6.10 — any active staff member may create a customer and update an ID', async () => {
  const made = await makeCustomer({}, { token: AAL2('s1') })
  expect((await q1(made.id)).created_by_staff_id).toBe(staff('s1').id)
  const res = await updateId(AAL2('s1'), idPayload(made.id, { documentNumber: made.payload.id.documentNumber }), BOTH())
  expect(res.status, res.text).toBe(201)
})

test('6.11 ⚠ — another business: edit and update-ID answer 404 customer_not_found, the phone RPC errors; made-up ids answer the same', async () => {
  const before = await totals()
  const erinBefore = await q1(erin)
  for (const customerId of [erin, MISSING]) {
    const e = await edit(AAL2('x1'), { customerId, changes: { firstName: 'Nope' } })
    expect([e.status, e.body.error], 'edit').toEqual([404, 'customer_not_found'])
    const u = await updateId(AAL2('x1'), idPayload(customerId, { documentNumber: erinPayload.id.documentNumber }), BOTH())
    expect([u.status, u.body.error], 'update id').toEqual([404, 'customer_not_found'])
    const p = await phoneRpc(AAL2('x1'), customerId, '0499 000 000')
    expect(p.status, `phone: ${p.text}`).toBeGreaterThanOrEqual(400)
    expect(p.status, `phone: ${p.text}`).toBeLessThan(500)
    expect(p.body.code).toBe('P0002')
    expect(p.body.message).toBe('customer_not_found')
  }
  expect(await q1(erin)).toEqual(erinBefore)
  expect(await totals()).toEqual(before)
})

test('6.12 ⚠ — the SQL write functions are not reachable through the REST API by a signed-in user', async () => {
  const u = '00000000-0000-4000-8000-000000000001'
  // Full argument lists, so PostgREST finds the function and the refusal is about permission, not a bad signature.
  const calls = {
    gold_create_customer: { p_entity_id: ENTITY_ID, p_staff_id: staff('s1').id, p_customer_id: u, p_verification_id: u, p_customer: {}, p_aliases: [], p_id: {}, p_images: [], p_different_person: false },
    gold_update_customer_id: { p_entity_id: ENTITY_ID, p_staff_id: staff('s1').id, p_customer_id: erin, p_verification_id: u, p_reason: 'id_changed', p_prior_verification_id: null, p_id: {}, p_images: [] },
    gold_update_customer: { p_entity_id: ENTITY_ID, p_staff_id: staff('m1').id, p_customer_id: erin, p_changes: { first_name: 'Hacked' } },
    _gold_assert_staff: { p_entity_id: ENTITY_ID, p_staff_id: staff('s1').id },
  }
  for (const [name, args] of Object.entries(calls)) {
    for (const token of [AAL2('s1'), AAL2('m1'), undefined]) {
      const res = await rpc(name, token, args)
      expect([401, 403], `${name}: ${res.status} ${res.text}`).toContain(res.status)
      expect(res.body.code, name).toBe('42501')
    }
  }
  expect((await q1(erin)).first_name).toBe('Erin')
})

test('6.13 ⚠ — a manager cannot write customers, aliases, audit rows, photos or ID captures directly', async () => {
  const m1 = AAL2('m1')
  const before = await totals()
  const erinBefore = await q1(erin)
  const attempts = [
    ['POST', '/customers', { reporting_entity_id: ENTITY_ID, customer_type: 'individual', source: 'gold', first_name: 'Direct', last_name: 'Uatsix' }, undefined],
    ['POST', '/customer_aliases', { customer_id: erin, alias: 'Direct' }, undefined],
    ['POST', '/customer_audit_log', { customer_id: erin, reporting_entity_id: ENTITY_ID, source: 'gold_edit', changes: {} }, undefined],
    ['PATCH', `/customers?id=eq.${erin}`, { first_name: 'Direct' }, undefined],
    ['POST', '/stored_images', { customer_id: erin, storage_bucket: 'compliance-media', object_path: `customers/${erin}/direct/front.jpg`, content_hash_sha256: 'x' }, 'ttr'],
    ['POST', '/id_verifications', { customer_id: erin, verification_basis: 'new_capture', document_type: 'Passport', document_number: 'DIRECT-1', issuer: 'AU', id_country_code: 'AU', has_expiry: false, verification_method: 'Sighted original document', verification_description: 'x', is_complete: true }, 'ttr'],
  ]
  for (const [method, route, body, schema] of attempts) {
    const res = await rest(method, route, m1, { body, schema, prefer: 'return=representation' })
    const wrote = res.status < 300 && !(Array.isArray(res.body) && res.body.length === 0)
    expect(wrote, `${method} ${route}: ${res.status} ${res.text}`).toBe(false)
  }
  expect(await totals()).toEqual(before)
  expect(await q1(erin)).toEqual(erinBefore)
  expect(await sql`select count(*)::int as n from public.customers where first_name = 'Direct'`).toEqual([{ n: 0 }])
})

test('6.14 — customers are readable inside the business and invisible to another business', async () => {
  const mine = await rest('GET', `/customers?id=eq.${erin}&select=id,first_name`, AAL2('s1'))
  expect(mine.body).toEqual([{ id: erin, first_name: 'Erin' }])
  const theirs = await rest('GET', `/customers?id=eq.${erin}&select=id,first_name`, AAL2('x1'))
  expect(theirs.body).toEqual([])
  const all = await rest('GET', `/customers?last_name=eq.Uatsix&select=id`, AAL2('x1'))
  expect(all.body).toEqual([])
})

test('6.154 (added by UAT) — an inactive manager and an inactive admin are refused by the manager-only function', async () => {
  const before = await totals()
  for (const who of ['im', 'ia']) {
    const res = await edit(AAL2(who), { customerId: erin, changes: { occupation: 'Jeweller' } })
    expect([res.status, res.body.error], who).toEqual([403, 'forbidden'])
  }
  expect((await q1(erin)).occupation).toBeNull()
  expect(await totals()).toEqual(before)
})

test('6.160 (added by UAT) — edit refuses created_by, created_at, updated_at and company-only fields', async () => {
  const before = await q1(erin)
  for (const key of ['createdByStaffId', 'created_by_staff_id', 'createdAt', 'updatedAt', 'entityName', 'first_name']) {
    const res = await edit(AAL2('m1'), { customerId: erin, changes: { [key]: 'X' } })
    expect([res.status, res.body.error, Object.keys(res.body.fields ?? {})], key).toEqual([400, 'validation_failed', [key]])
  }
  expect(await q1(erin)).toEqual(before)
})

test('6.162 (added by UAT) — update-ID for a company customer is 404 customer_not_found (gold writes individuals only)', async () => {
  const [{ id }] = await sql`insert into public.customers (reporting_entity_id, customer_type, source, entity_name, reg_identifier)
    values (${ENTITY_ID}, 'company', 'ttr', 'Uatsix Pty Ltd', '12345678901') returning id`
  const before = await totals()
  const res = await updateId(AAL2('s1'), idPayload(id, { documentNumber: 'UAT6-CO-1' }), BOTH())
  expect([res.status, res.body.error]).toEqual([404, 'customer_not_found'])
  expect(await totals()).toEqual(before)
})
