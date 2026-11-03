// Gold Phase 9a UAT, section C of docs/uat-gold-09a-ttr-handoff.md: what gold-start-ttr writes for a case A sale
// (spec 3.2): the TTR, its party, its reliance row, the links, idempotence and the audit row.
import { expect, test } from '@playwright/test'
import { sql } from '../support/db.js'
import {
  auditRows, bullion, customer, idvOf, inv, linkOf, partiesOf, reportable, row, S1, save, saved, startTtr, token, ttrSnap, txRow, world,
  yes,
} from './support.js'

let t1
test.beforeAll(async () => {
  await world()
})
test.beforeEach(async () => {
  t1 = await token('t1')
})

// Jane, one scrap purchase, $12,000 cash, with the invoice, both counter questions Yes.
const janeSale = async (number) => {
  const jane = await customer({ first: 'Jane', last: 'Citizen' })
  const r = await save(t1, { customerId: jane.id, cashAmount: '12000', ...reportable, erpInvoiceNo: number })
  expect(r.status, r.text).toBe(201)
  expect(r.body.ttr).toBe('A')
  return { jane, purchaseId: r.body.purchaseId }
}

test.describe('C · what a case A TTR contains', () => {
  test('9.12 ⚠ — gold-start-ttr returns one scrap entry (draft, created, case A) and writes the draft with the invoice as its reference and the cash', async () => {
    const number = inv('12')
    const { purchaseId } = await janeSale(number)
    const r = await startTtr(t1, { purchaseId })
    expect(r.status, r.text).toBe(200)
    expect(r.body.ttrs).toHaveLength(1)
    const [entry] = r.body.ttrs
    expect(entry).toMatchObject({ type: 'scrap', scenario: 'precious_metal_buy', status: 'draft', created: true, case: 'A' })
    expect(await txRow(entry.id)).toMatchObject({
      status: 'draft',
      transaction_ref: number,
      scenario: 'precious_metal_buy',
      cash_amount: 12000,
      aud_value: 12000,
      cash_currency: 'AUD',
    })
    expect(await sql`select 1 from ttr.transactions where transaction_ref = ${number}`).toHaveLength(1)
  })

  test("9.13 — the TTR's time is the purchase's created_at; service, location and staff snapshot are the caller's and the shared constants", async () => {
    const { purchaseId } = await janeSale(inv('13'))
    const r = await startTtr(t1, { purchaseId })
    const id = r.body.ttrs[0].id
    const [t] = await sql`
      select t.*, (t.transaction_datetime = p.created_at) as same_time, s.full_name, s.email, s.role::text as role
      from ttr.transactions t join gold.purchases p on p.id = ${purchaseId}, public.staff_members s where t.id = ${id} and s.id = ${S1}`
    expect(t.same_time).toBe(true)
    expect(t.designated_service).toBe('Purchase of precious metal for physical cash')
    expect(t.location_snapshot).toBe('Coburg, VIC')
    expect([t.staff_member_name, t.staff_member_email, t.staff_member_role]).toEqual([t.full_name, t.email, t.role])
    expect(t.created_by_staff_id).toBe(S1)
  })

  test("9.14 — one individual party for Jane with customer_id set and her details copied; complete", async () => {
    const { jane, purchaseId } = await janeSale(inv('14'))
    const id = (await startTtr(t1, { purchaseId })).body.ttrs[0].id
    const parties = await partiesOf(id)
    expect(parties).toHaveLength(1)
    const [c] = await sql`select * from public.customers where id = ${jane.id}`
    const [p] = parties
    expect(p).toMatchObject({
      party_type: 'individual',
      customer_id: jane.id,
      is_complete: true,
      first_name: 'Jane',
      last_name: 'Citizen',
      full_name: 'Jane Citizen',
      date_of_birth: c.date_of_birth,
      phone: c.phone,
      res_street: c.res_street,
      res_suburb: c.res_suburb,
      res_state: c.res_state,
      res_postcode: c.res_postcode,
      res_country: c.res_country,
      occupation: 'Jeweller',
      gender: 'F',
      citizenship_country_code: 'AU',
      tax_residency_country_code: 'AU',
    })
    expect(p.legal_form).toBeNull() // not a sole trader
    expect(p.abn).toBeNull()
  })

  test('9.15 ⚠ — one reliance row: the capture relied on, its document copied, the case A reason, no image, and the counter confirmation', async () => {
    const { jane, purchaseId } = await janeSale(inv('15'))
    const id = (await startTtr(t1, { purchaseId })).body.ttrs[0].id
    const rows = await idvOf(id)
    expect(rows).toHaveLength(1)
    const [capture] = await sql`select * from ttr.id_verifications where id = ${jane.verId}`
    const [p] = await sql`select created_at, created_by_staff_id, main_id_verification_id from gold.purchases where id = ${purchaseId}`
    const [party] = await partiesOf(id)
    const [v] = rows
    expect(p.main_id_verification_id).toBe(jane.verId)
    expect(v).toMatchObject({
      party_id: party.id,
      verification_basis: 'relied_on_prior_identification',
      prior_verification_id: jane.verId,
      reliance_reason: 'customer_confirmed_details_unchanged',
      is_complete: true,
      document_type: capture.document_type,
      document_number: capture.document_number,
      issuer: 'VIC',
      id_country_code: 'AU',
      has_expiry: capture.has_expiry,
      expiry_date: capture.expiry_date,
      counter_confirmed_by_staff_id: p.created_by_staff_id,
    })
    expect(v.front_image_id).toBeNull()
    expect(v.back_image_id).toBeNull()
    expect(new Date(v.counter_confirmed_at).getTime()).toBe(new Date(p.created_at).getTime())
  })

  test('9.16 — parts of the same type, invoice, day and seller share the TTR; the other type gets its own, another invoice none', async () => {
    const jane = await customer({ first: 'Jane', last: 'Citizen' })
    const number = inv('16')
    const a = await save(t1, { customerId: jane.id, cash10k: 'true', cashAmount: '6000', erpInvoiceNo: number })
    const b = await save(t1, { customerId: jane.id, partAmount: '6000', erpInvoiceNo: number, ...yes })
    const c = await save(t1, { customerId: jane.id, ...bullion('under_5k', { partAmount: '100', erpInvoiceNo: number }), ...yes })
    const d = await saved(t1, { customerId: jane.id, cash10k: 'true', cashAmount: '300', erpInvoiceNo: inv('16x') })
    const [pa, pb, pc] = [a, b, c].map((x) => x.body.purchaseId)
    const r = await startTtr(t1, { purchaseId: pa })
    expect(r.status, r.text).toBe(200)
    const scrap = r.body.ttrs.find((e) => e.type === 'scrap').id
    const gold = r.body.ttrs.find((e) => e.type === 'bullion').id
    expect(scrap).not.toBe(gold)
    expect([await linkOf(pa), await linkOf(pb)]).toEqual([scrap, scrap])
    expect(await linkOf(pc)).toBe(gold)
    expect(await linkOf(d)).toBeNull()
    expect(await txRow(scrap)).toMatchObject({ cash_amount: 12000 })
  })

  test('9.17 — no photo is copied: no storage object and no ttr.stored_images row is created', async () => {
    const { purchaseId } = await janeSale(inv('17'))
    const before = await ttrSnap()
    const id = (await startTtr(t1, { purchaseId })).body.ttrs[0].id
    const after = await ttrSnap()
    expect([after.images, after.objects]).toEqual([before.images, before.objects])
    expect(await sql`select 1 from ttr.stored_images where transaction_id = ${id}`).toHaveLength(0)
    expect(await sql`select 1 from storage.objects where name like ${`${id}/%`}`).toHaveLength(0)
  })

  test('9.18 ⚠ — calling again, and for a second same-type part, returns the same TTR (created false, case null) and writes nothing more', async () => {
    const jane = await customer({ first: 'Jane', last: 'Citizen' })
    const number = inv('18')
    const a = await save(t1, { customerId: jane.id, cash10k: 'true', cashAmount: '6000', erpInvoiceNo: number })
    const b = await save(t1, { customerId: jane.id, partAmount: '6000', erpInvoiceNo: number, ...yes })
    const first = await startTtr(t1, { purchaseId: a.body.purchaseId })
    const id = first.body.ttrs[0].id
    expect(first.body.ttrs[0].created).toBe(true)
    const before = await ttrSnap()
    for (const purchaseId of [a.body.purchaseId, b.body.purchaseId]) {
      const again = await startTtr(t1, { purchaseId })
      expect(again.status, again.text).toBe(200)
      expect(again.body.ttrs).toEqual([{ id, type: 'scrap', scenario: 'precious_metal_buy', status: 'draft', created: false, case: null }])
    }
    expect(await ttrSnap()).toEqual(before)
    expect(await sql`select 1 from ttr.transactions where transaction_ref = ${number}`).toHaveLength(1)
    expect(await partiesOf(id)).toHaveLength(1)
    expect(await idvOf(id)).toHaveLength(1)
  })

  test('9.19 — a reportable bullion purchase with no cash amount entered gets the placeholder 1.00', async () => {
    const jane = await customer({ first: 'Jane', last: 'Citizen' })
    const r = await save(t1, { customerId: jane.id, ...bullion('10k_plus', { erpInvoiceNo: inv('19') }), ...yes })
    expect(r.status, r.text).toBe(201)
    expect((await row(r.body.purchaseId)).cash_amount).toBeNull()
    const s = await startTtr(t1, { purchaseId: r.body.purchaseId })
    expect(s.status, s.text).toBe(200)
    expect(s.body.ttrs[0]).toMatchObject({ type: 'bullion', scenario: 'bullion_buy' })
    expect(await txRow(s.body.ttrs[0].id)).toMatchObject({ cash_amount: 1, aud_value: 1 })
  })

  test('9.20 — one audit row for the purchase: source start_ttr, the caller, and only ttr_transaction_id changed (none on a repeat call)', async () => {
    const { purchaseId } = await janeSale(inv('20'))
    expect(await auditRows(purchaseId)).toHaveLength(0)
    const id = (await startTtr(t1, { purchaseId })).body.ttrs[0].id
    const rows = await auditRows(purchaseId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'start_ttr', changed_by: S1 })
    expect(Object.keys(rows[0].changes)).toEqual(['ttr_transaction_id'])
    expect(JSON.stringify(rows[0].changes.ttr_transaction_id)).toContain(id)
    await startTtr(t1, { purchaseId })
    expect(await auditRows(purchaseId)).toHaveLength(1)
  })
})
