// Gold Phase 6 UAT row 6.130 (spec 4.6, 6.1): update_customer_phone for a customer the caller cannot see.
// Kept apart so that a failure here does not stop the rows that follow it in the phone file.
import { expect, test } from '@playwright/test'
import { AAL2, ENTITY_ID, makeCustomer, phoneRpc, q1, sql } from './support.js'

const S1 = () => AAL2('s1')

test('6.130 ⚠ — another business, a made-up id and a company customer all answer customer_not_found (P0002)', async () => {
  const frank = (await makeCustomer({ firstName: 'Frank' })).id
  const phoneOf = async () => (await q1(frank)).phone
  const before = await phoneOf()
  const [{ id: company }] = await sql`insert into public.customers (reporting_entity_id, customer_type, source, entity_name, reg_identifier)
    values (${ENTITY_ID}, 'company', 'ttr', 'Uatsix Phone Pty Ltd', '12345678902') returning id`
  for (const [token, id] of [[AAL2('x1'), frank], [S1(), '00000000-0000-4000-8000-000000000999'], [S1(), company]]) {
    const res = await phoneRpc(token, id, '0499 111 333')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect([res.body.code, res.body.message]).toEqual(['P0002', 'customer_not_found'])
  }
  expect(await phoneOf()).toBe(before)
})

