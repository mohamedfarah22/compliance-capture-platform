// Gold Phase 6 UAT section G refusals of update_customer_phone (spec 4.3, 4.6, 6.1), over REST with real tokens.
// Each row makes its own customer, so the rows are independent.
import { expect, test } from '@playwright/test'
import { AAL1, AAL2, makeCustomer, phoneRpc, q1 } from './support.js'

const S1 = () => AAL2('s1')
const frankFor = async () => {
  const frank = (await makeCustomer({ firstName: 'Frank' })).id
  return { frank, phoneOf: async () => (await q1(frank)).phone }
}
const expectError = (res, status, code, message) => {
  expect(res.status, res.text).toBe(status)
  expect([res.body.code, res.body.message]).toEqual([code, message])
}

test('6.127 ⚠ — a password-only (aal1) session gets 42501 forbidden and nothing changes', async () => {
  const { frank, phoneOf } = await frankFor()
  const before = await phoneOf()
  expectError(await phoneRpc(AAL1('s1'), frank, '0499 111 333'), 403, '42501', 'forbidden')
  expect(await phoneOf()).toBe(before)
})

test('6.128 ⚠ — the anon key is refused', async () => {
  const { frank, phoneOf } = await frankFor()
  const before = await phoneOf()
  const res = await phoneRpc(undefined, frank, '0499 111 333')
  expect([401, 403]).toContain(res.status)
  expect(await phoneOf()).toBe(before)
})

test('6.129 ⚠ — an inactive staff member gets 42501', async () => {
  const { frank, phoneOf } = await frankFor()
  const before = await phoneOf()
  expect((await phoneRpc(AAL2('i1'), frank, '0499 111 333')).body.code).toBe('42501')
  expect(await phoneOf()).toBe(before)
})

test('6.158 (added by UAT) — a null phone is 22023 invalid_phone', async () => {
  const { frank } = await frankFor()
  expectError(await phoneRpc(S1(), frank, null), 400, '22023', 'invalid_phone')
})

// ─── H: storage ───────────────────────────────────────────────────────────────────────────────

