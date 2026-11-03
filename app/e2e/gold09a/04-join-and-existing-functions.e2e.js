// Gold Phase 9a UAT, sections G and H of docs/uat-gold-09a-ttr-handoff.md: a later part on an invoice that already
// has a TTR joins a draft and is blocked by a completed one (spec 3.5, 4.3), and the two changed TTR functions,
// cleanup-stale-drafts and delete-draft-transaction (spec 4.4). Row 9.65 was added by UAT from spec 4.3.
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { sql } from '../support/db.js'
import {
  bullion, callAsService, callFunction, complete, customer, E1, inv, linkOf, partiesOf, reportable, row, S1, save, saved, snap, startTtr,
  token, ttrSnap, txRow, world, yes,
} from './support.js'

let t1
test.beforeAll(async () => {
  await world()
})
test.beforeEach(async () => {
  t1 = await token('t1')
})

const finished = (number) => `The AUSTRAC report for ${number} is already finished. Use a new ERP invoice number for this purchase.`

// Jane, a $12,000 scrap sale on `number` with its TTR started (a draft).
const withDraftTtr = async (number) => {
  const jane = await customer({ first: 'Jane', last: 'Citizen' })
  const a = await save(t1, { customerId: jane.id, cashAmount: '12000', ...reportable, erpInvoiceNo: number })
  expect(a.status, a.text).toBe(201)
  const s = await startTtr(t1, { purchaseId: a.body.purchaseId })
  expect(s.status, s.text).toBe(200)
  return { jane, first: a.body.purchaseId, ttrId: s.body.ttrs[0].id }
}

const markComplete = (ttrId) => sql`update ttr.transactions set status = 'complete', completed_at = now() where id = ${ttrId}`

test.describe('G · a later part on an invoice that has a TTR', () => {
  test('9.30 ⚠ — a scrap part of $3,000 saved on the invoice joins the draft, whose cash becomes $15,000', async () => {
    const number = inv('30')
    const { jane, ttrId } = await withDraftTtr(number)
    const r = await save(t1, { customerId: jane.id, partAmount: '3000', erpInvoiceNo: number, ...yes })
    expect(r.status, r.text).toBe(201)
    expect(await linkOf(r.body.purchaseId)).toBe(ttrId)
    expect(await txRow(ttrId)).toMatchObject({ cash_amount: 15000, aud_value: 15000, status: 'draft' })
    expect(await sql`select 1 from ttr.transactions where transaction_ref = ${number}`).toHaveLength(1)
  })

  test('9.31 — a scrap part saved with no invoice and given INV through gold-complete-purchase joins the draft the same way', async () => {
    const number = inv('31')
    const { jane, ttrId } = await withDraftTtr(number)
    const part = await saved(t1, { customerId: jane.id, cash10k: 'false' })
    expect(await linkOf(part)).toBeNull()
    const r = await complete(t1, { purchaseId: part, erpInvoiceNo: number, partAmount: '3000' })
    expect(r.status, r.text).toBe(200)
    expect((await row(part)).erp_invoice_no).toBe(number)
    expect(await linkOf(part)).toBe(ttrId)
    expect(await txRow(ttrId)).toMatchObject({ cash_amount: 15000, aud_value: 15000 })
  })

  test('9.32 — a bullion part of $500 on the invoice does not join the scrap TTR, and the scrap cash is unchanged', async () => {
    const number = inv('32')
    const { jane, ttrId } = await withDraftTtr(number)
    const r = await save(t1, { customerId: jane.id, ...bullion('under_5k', { partAmount: '500', erpInvoiceNo: number }), ...yes })
    expect(r.status, r.text).toBe(201)
    expect(await linkOf(r.body.purchaseId)).toBeNull()
    expect(await txRow(ttrId)).toMatchObject({ cash_amount: 12000, aud_value: 12000 })
  })

  test('9.33 ⚠ — once the TTR is complete, a new scrap part on the invoice is 422 with the finished message, nothing saved, the TTR unchanged', async () => {
    const number = inv('33')
    const { jane, ttrId } = await withDraftTtr(number)
    await markComplete(ttrId)
    const ttrBefore = await txRow(ttrId)
    const before = { ...(await snap()), ...(await ttrSnap()) }
    const r = await save(t1, { customerId: jane.id, partAmount: '3000', erpInvoiceNo: number, ...yes })
    expect(r.status, r.text).toBe(422)
    expect(r.body.errors.erp_invoice_no).toBe(finished(number))
    expect({ ...(await snap()), ...(await ttrSnap()) }).toEqual(before)
    expect(await txRow(ttrId)).toEqual(ttrBefore)
  })

  test('9.34 ⚠ — adding the invoice of a completed TTR to a saved scrap part through gold-complete-purchase gives the same 422 and the purchase keeps no invoice', async () => {
    const number = inv('34')
    const { jane, ttrId } = await withDraftTtr(number)
    const part = await saved(t1, { customerId: jane.id, cash10k: 'false' })
    await markComplete(ttrId)
    const ttrBefore = await txRow(ttrId)
    const r = await complete(t1, { purchaseId: part, erpInvoiceNo: number, partAmount: '3000' })
    expect(r.status, r.text).toBe(422)
    expect(r.body.errors.erp_invoice_no).toBe(finished(number))
    expect((await row(part)).erp_invoice_no).toBeNull()
    expect(await linkOf(part)).toBeNull()
    expect(await txRow(ttrId)).toEqual(ttrBefore)
  })

  test('9.65 (added by UAT, spec 3.4 and 4.3 "for that type") — a completed scrap TTR does not block a bullion part on the same invoice', async () => {
    const number = inv('65')
    const { jane, ttrId } = await withDraftTtr(number)
    await markComplete(ttrId)
    const r = await save(t1, { customerId: jane.id, ...bullion('under_5k', { partAmount: '500', erpInvoiceNo: number }), ...yes })
    expect(r.status, r.text).toBe(201)
    expect(await linkOf(r.body.purchaseId)).toBeNull()
  })
})

test.describe('H · existing TTR functions', () => {
  test('9.35 ⚠ — cleanup-stale-drafts deletes the old unlinked draft and keeps the old draft linked to a gold purchase, with its parties', async () => {
    const { ttrId: linked } = await withDraftTtr(inv('35'))
    const unlinked = randomUUID()
    await sql`
      insert into ttr.transactions (id, reporting_entity_id, created_by_staff_id, scenario, transaction_ref, transaction_datetime,
          designated_service, location_snapshot, staff_member_name, staff_member_email, staff_member_role, cash_currency, cash_amount, aud_value)
      values (${unlinked}, ${E1}, ${S1}, 'bullion_buy', ${inv('35u')}, now(), 'Purchase of bullion for physical cash', 'Coburg, VIC',
          'UAT Staff One', 'uat-gold-staff1@example.test', 'staff', 'AUD', 500, 500)`
    await sql`update ttr.transactions set created_at = now() - interval '60 days' where id in ${sql([linked, unlinked])}`
    const r = await callAsService('cleanup-stale-drafts')
    expect(r.status, r.text).toBe(200)
    expect(await txRow(unlinked)).toBeUndefined()
    expect(await txRow(linked)).toMatchObject({ status: 'draft' })
    expect(await partiesOf(linked)).toHaveLength(1)
  })

  test('9.36 ⚠ — Exit (delete-draft-transaction) on the linked draft is 200: the TTR goes, the purchase stays with no link, and Start TTR makes a fresh draft', async () => {
    const number = inv('36')
    const { first, ttrId } = await withDraftTtr(number)
    const r = await callFunction('delete-draft-transaction', t1, { transactionId: ttrId })
    expect(r.status, r.text).toBe(200)
    expect(await txRow(ttrId)).toBeUndefined()
    const p = await row(first)
    expect(p).toBeDefined()
    expect(p.ttr_transaction_id).toBeNull()
    expect(await sql`select 1 from ttr.parties where transaction_id = ${ttrId}`).toHaveLength(0)
    const again = await startTtr(t1, { purchaseId: first })
    expect(again.status, again.text).toBe(200)
    expect(again.body.ttrs[0]).toMatchObject({ created: true })
    expect(again.body.ttrs[0].id).not.toBe(ttrId)
    expect(await linkOf(first)).toBe(again.body.ttrs[0].id)
  })
})
