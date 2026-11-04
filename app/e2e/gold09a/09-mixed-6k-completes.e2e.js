// Gold Phase 9a UAT, row 9.70 (added by UAT from spec 3.4 "Each TTR carries its own type's cash: $6,000 each"):
// both TTRs of the spec's own mixed-invoice example can be completed through complete-transaction. The fuller
// screen flow is 9.44 in 06-wizard-case-b-and-pickup.e2e.js.
import { expect, test } from '@playwright/test'
import { bullion, callFunction, save, startTtr, yes } from './support.js'
import { adminToken, openAdmin, person } from './wizard-support.js'

test('9.70 (added by UAT, spec 3.4) — each TTR of the mixed invoice ($6,000 scrap + $6,000 bullion) can be completed', async ({ browser }) => {
  const { context, page } = await openAdmin(browser)
  const tok = await adminToken(page)
  const mel = await person({ first: 'Mel' })
  const number = `INV-6K-${Date.now().toString(36).toUpperCase()}`
  const a = await save(tok, { customerId: mel.id, cash10k: 'true', cashAmount: '6000', erpInvoiceNo: number })
  const b = await save(tok, { customerId: mel.id, ...bullion('5k_to_10k', { partAmount: '6000', erpInvoiceNo: number }), ...yes })
  expect([a.status, b.status]).toEqual([201, 201])
  const s = await startTtr(tok, { purchaseId: b.body.purchaseId })
  expect(s.status, s.text).toBe(200)
  expect(s.body.ttrs).toHaveLength(2)
  for (const e of s.body.ttrs) {
    const r = await callFunction('complete-transaction', tok, { transactionId: e.id })
    expect(r.status, `${e.type}: ${r.text}`).toBe(200)
  }
  await context.close()
})
