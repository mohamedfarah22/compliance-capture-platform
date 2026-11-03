// Gold Phase 9a UAT, sections A and B of docs/uat-gold-09a-ttr-handoff.md: who may call gold-start-ttr (9.2 to 9.7)
// and the rules the server works out again whatever the client says (9.8 to 9.11). 9.1 (flag off) is a Deno test.
// Rows 9.59 to 9.61 and 9.71 were added by UAT from spec 3.2, 3.4 and 4.3.
import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { sql } from '../support/db.js'
import { localEnv } from '../support/env.js'
import {
  customer, E1, E2, inv, linkOf, melbourneToday, partiesOf, reportable, S1, save, saved, startTtr, token, ttrSnap, txRow, world, yes,
} from './support.js'

let t1
test.beforeAll(async () => {
  await world()
})
test.beforeEach(async () => {
  t1 = await token('t1')
})

// A reportable scrap purchase, saved with its invoice. `ready: false` makes Gina, who is not ready for case A.
const reportableWithInvoice = async (number, { who, amount = '12000', extra = {} } = {}) => {
  const c = who ?? (await customer())
  const r = await save(t1, { customerId: c.id, cashAmount: amount, ...reportable, erpInvoiceNo: number, ...extra })
  expect(r.status, r.text).toBe(201)
  return { c, id: r.body.purchaseId }
}

test.describe('A · refusals', () => {
  test('9.2 ⚠ — no token, then the anon key as the token: 401 both times, nothing written', async () => {
    const { id } = await reportableWithInvoice(inv('2'))
    const before = await ttrSnap()
    const none = await startTtr(null, { purchaseId: id })
    expect(none.status, none.text).toBe(401)
    const anon = await startTtr(localEnv().ANON_KEY, { purchaseId: id })
    expect(anon.status, anon.text).toBe(401)
    expect(await ttrSnap()).toEqual(before)
    expect(await linkOf(id)).toBeNull()
  })

  test('9.3 ⚠ — a password-only (aal1) session is 403 mfa_required, nothing written', async () => {
    const { id } = await reportableWithInvoice(inv('3'))
    const before = await ttrSnap()
    const r = await startTtr(await token('t1aal1'), { purchaseId: id })
    expect(r.status, r.text).toBe(403)
    expect(r.body).toEqual({ error: 'mfa_required' })
    expect(await ttrSnap()).toEqual(before)
  })

  test('9.4 — a deactivated staff member (with MFA) is 403 forbidden', async () => {
    const { id } = await reportableWithInvoice(inv('4'))
    const before = await ttrSnap()
    const r = await startTtr(await token('t3'), { purchaseId: id })
    expect(r.status, r.text).toBe(403)
    expect(r.body).toEqual({ error: 'forbidden' })
    expect(await ttrSnap()).toEqual(before)
  })

  test("9.5 ⚠ — another business's staff gets 404 purchase_not_found, the same answer as for an unknown id, and nothing is written", async () => {
    const { id } = await reportableWithInvoice(inv('5'))
    const t2 = await token('t2')
    const before = await ttrSnap()
    const theirs = await startTtr(t2, { purchaseId: id })
    const unknown = await startTtr(t2, { purchaseId: randomUUID() })
    expect([theirs.status, unknown.status]).toEqual([404, 404])
    expect(theirs.body).toEqual({ error: 'purchase_not_found' })
    expect(theirs.body).toEqual(unknown.body)
    expect(await ttrSnap()).toEqual(before)
    expect(await linkOf(id)).toBeNull()
  })

  test('9.6 — bodies that are not a purchase id are 400 bad_request naming the field, nothing written', async () => {
    const before = await ttrSnap()
    const cases = [
      [{}, 'purchaseId'],
      [{ purchaseId: 'nope' }, 'purchaseId'],
      [{ purchaseId: 12 }, 'purchaseId'],
      ['this is not json', 'body'],
      [[{ purchaseId: randomUUID() }], 'body'],
      [null, 'body'],
    ]
    for (const [body, field] of cases) {
      const r = await startTtr(t1, typeof body === 'string' ? body : JSON.stringify(body), { raw: true })
      expect(r.status, `${JSON.stringify(body)}: ${r.text}`).toBe(400)
      expect(r.body).toEqual({ error: 'bad_request', field })
    }
    expect(await ttrSnap()).toEqual(before)
  })

  test('9.7 — a plain staff member (not a manager or admin) can start a TTR: 200', async () => {
    const { id } = await reportableWithInvoice(inv('7'))
    expect((await sql`select role::text as r from public.staff_members where id = ${S1}`)[0].r).toBe('staff')
    const r = await startTtr(t1, { purchaseId: id })
    expect(r.status, r.text).toBe(200)
    expect(r.body.ttrs).toHaveLength(1)
  })
})

test.describe('B · rules the server re-checks', () => {
  test('9.8 ⚠ — a reportable purchase with no invoice number is 422 invoice_required, nothing written', async () => {
    const c = await customer()
    const r = await save(t1, { customerId: c.id, cashAmount: '12000', ...reportable }) // case A may be saved without it
    expect(r.status, r.text).toBe(201)
    expect(r.body.ttr).toBe('A')
    const before = await ttrSnap()
    const s = await startTtr(t1, { purchaseId: r.body.purchaseId })
    expect(s.status, s.text).toBe(422)
    expect(s.body).toEqual({ error: 'invoice_required' })
    expect(await ttrSnap()).toEqual(before)
  })

  test('9.9 ⚠ — $9,999.99 in one purchase is 422 not_reportable; two linked parts of $5,000 + $5,000 reach $10,000 and start one TTR', async () => {
    const c = await customer()
    const under = await save(t1, { customerId: c.id, cash10k: 'true', cashAmount: '9999.99', erpInvoiceNo: inv('9a') })
    expect(under.status, under.text).toBe(201)
    const before = await ttrSnap()
    const no = await startTtr(t1, { purchaseId: under.body.purchaseId })
    expect(no.status, no.text).toBe(422)
    expect(no.body).toEqual({ error: 'not_reportable' })
    expect(await ttrSnap()).toEqual(before)

    const number = inv('9b')
    const a = await save(t1, { customerId: c.id, cash10k: 'true', cashAmount: '5000', erpInvoiceNo: number })
    expect(a.status, a.text).toBe(201)
    const b = await save(t1, { customerId: c.id, partAmount: '5000', erpInvoiceNo: number, ...yes })
    expect(b.status, b.text).toBe(201)
    const ok = await startTtr(t1, { purchaseId: a.body.purchaseId }) // the first part: it is not flagged on its own
    expect(ok.status, ok.text).toBe(200)
    expect(ok.body.ttrs).toHaveLength(1)
    expect(await txRow(ok.body.ttrs[0].id)).toMatchObject({ cash_amount: 10000, transaction_ref: number })
  })

  test('9.10 — a purchase flagged reportable whose entered cash amount is 0 is 422 no_cash, nothing written', async () => {
    const c = await customer()
    const number = inv('10')
    // gold-save-purchase never stores this shape (a 0 amount is not reportable), so the row is written directly.
    const id = randomUUID()
    await sql`
      insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band,
          cash_10k_or_more, cash_amount, erp_invoice_no, sale_date, phone, id_sighted, created_by_staff_id)
      values (${id}, ${E1}, ${c.id}, ${c.verId}, 'scrap', '10k_plus', true, 0, ${number}, ${await melbourneToday()},
          '0411 111 111', true, ${S1})`
    const before = await ttrSnap()
    const r = await startTtr(t1, { purchaseId: id })
    expect(r.status, r.text).toBe(422)
    expect(r.body).toEqual({ error: 'no_cash' })
    expect(await ttrSnap()).toEqual(before)
  })

  test('9.11 ⚠ — a lying client: extra cash, staff, entity, ref, scenario and case fields change nothing', async () => {
    const gina = await customer({ ready: false, first: 'Gina', last: 'Goldonly' })
    const number = inv('11')
    const { id } = await reportableWithInvoice(number, { who: gina })
    const staff = await sql`select full_name, email from public.staff_members where id = ${S1}`
    const r = await startTtr(t1, {
      purchaseId: id,
      cash: 1,
      cashAmount: 1,
      staff: 'a0000000-0000-4000-8000-0000000000ff',
      staffId: 'a0000000-0000-4000-8000-0000000000ff',
      entity: E2,
      reportingEntityId: E2,
      ref: 'HACK-1',
      transactionRef: 'HACK-1',
      scenario: 'bullion_buy',
      case: 'A',
      caseA: true,
    })
    expect(r.status, r.text).toBe(200)
    expect(r.body.ttrs).toHaveLength(1)
    expect(r.body.ttrs[0]).toMatchObject({ type: 'scrap', scenario: 'precious_metal_buy', created: true, case: 'B' })
    expect(await txRow(r.body.ttrs[0].id)).toMatchObject({
      reporting_entity_id: E1,
      transaction_ref: number,
      scenario: 'precious_metal_buy',
      cash_amount: 12000,
      aud_value: 12000,
      created_by_staff_id: S1,
      staff_member_name: staff[0].full_name,
      staff_member_email: staff[0].email,
    })
    expect(await sql`select 1 from ttr.transactions where transaction_ref = 'HACK-1'`).toHaveLength(0)
    expect((await partiesOf(r.body.ttrs[0].id)).every((p) => p.customer_id === gina.id)).toBe(true)
  })
})

test.describe('Added by UAT', () => {
  test('9.59 (added by UAT, spec 3.2 idempotent) — starting a TTR that is already complete returns it as complete, created false, and leaves it unchanged', async () => {
    const { id } = await reportableWithInvoice(inv('59'))
    const first = await startTtr(t1, { purchaseId: id })
    const ttrId = first.body.ttrs[0].id
    await sql`update ttr.transactions set status = 'complete', completed_at = now() where id = ${ttrId}`
    const before = await txRow(ttrId)
    const again = await startTtr(t1, { purchaseId: id })
    expect(again.status, again.text).toBe(200)
    expect(again.body.ttrs).toEqual([
      { id: ttrId, type: 'scrap', scenario: 'precious_metal_buy', status: 'complete', created: false, case: null },
    ])
    expect(await txRow(ttrId)).toEqual(before)
  })

  test('9.60 (added by UAT, spec 3.4 $10,000 boundary) — exactly $10,000 is reportable; two parts totalling $9,999.99 are not', async () => {
    const c = await customer()
    const exact = await save(t1, { customerId: c.id, cash10k: 'true', cashAmount: '10000', ...yes, erpInvoiceNo: inv('60a') })
    expect(exact.status, exact.text).toBe(201)
    expect((await startTtr(t1, { purchaseId: exact.body.purchaseId })).status).toBe(200)

    const number = inv('60b')
    const a = await save(t1, { customerId: c.id, cash10k: 'true', cashAmount: '5000', erpInvoiceNo: number })
    const b = await save(t1, { customerId: c.id, partAmount: '4999.99', erpInvoiceNo: number })
    expect([a.status, b.status]).toEqual([201, 201])
    const before = await ttrSnap()
    for (const p of [a, b]) {
      const r = await startTtr(t1, { purchaseId: p.body.purchaseId })
      expect([r.status, r.body.error]).toEqual([422, 'not_reportable'])
    }
    expect(await ttrSnap()).toEqual(before)
  })

  test('9.71 (added by UAT, spec 3.4 and 4.3 "recalculated on the server") — the $10,000 total is worked out from the linked cash, whatever the stored flags say', async () => {
    const c = await customer()
    const part = (number, amount) => {
      const id = randomUUID()
      return sql`
        insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band,
            cash_10k_or_more, cash_amount, erp_invoice_no, sale_date, phone, id_sighted, created_by_staff_id)
        values (${id}, ${E1}, ${c.id}, ${c.verId}, 'scrap', 'under_10k', false, ${amount}, ${number},
            (now() at time zone 'Australia/Melbourne')::date, '0411 111 111', true, ${S1})
        returning id`.then(([r]) => r.id)
    }
    const started = async (...amounts) => {
      const number = inv('71')
      const ids = []
      for (const a of amounts) ids.push(await part(number, a))
      return startTtr(t1, { purchaseId: ids[0] })
    }
    // Written directly, with every flag false: gold-save-purchase would have flagged the part that reaches $10,000.
    const single = await started(10000)
    expect(single.status, single.text).toBe(200)
    expect(await txRow(single.body.ttrs[0].id)).toMatchObject({ cash_amount: 10000 })
    const two = await started(5000, 5000)
    expect(two.status, two.text).toBe(200)
    expect(await txRow(two.body.ttrs[0].id)).toMatchObject({ cash_amount: 10000 })
    const before = await ttrSnap()
    for (const amounts of [[9999.99], [5000, 4999.99]]) {
      const r = await started(...amounts)
      expect([r.status, r.body.error], amounts.join('+')).toEqual([422, 'not_reportable'])
    }
    expect(await ttrSnap()).toEqual(before)
  })

  test('9.61 (added by UAT, spec 3.4 linking) — a part of the same type on another day or another invoice is not linked, and does not change the TTR cash', async () => {
    const c = await customer()
    const number = inv('61')
    const a = await save(t1, { customerId: c.id, cashAmount: '12000', ...reportable, erpInvoiceNo: number })
    const other = await save(t1, { customerId: c.id, cash10k: 'true', cashAmount: '300', erpInvoiceNo: inv('61x') })
    const otherInvoice = await saved(t1, { customerId: c.id, cash10k: 'true', cashAmount: '400', erpInvoiceNo: inv('61y') })
    // A same-invoice part dated yesterday: written directly, since the server dates every sale today.
    const yday = randomUUID()
    await sql`
      insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band,
          cash_10k_or_more, cash_amount, erp_invoice_no, sale_date, phone, id_sighted, created_by_staff_id)
      values (${yday}, ${E1}, ${c.id}, ${c.verId}, 'scrap', '10k_plus', true, 500, ${number},
          ((now() at time zone 'Australia/Melbourne')::date - 1), '0411 111 111', true, ${S1})`
    const r = await startTtr(t1, { purchaseId: a.body.purchaseId })
    expect(r.status, r.text).toBe(200)
    const ttrId = r.body.ttrs[0].id
    expect(await linkOf(a.body.purchaseId)).toBe(ttrId)
    for (const id of [other.body.purchaseId, otherInvoice, yday]) expect(await linkOf(id), id).toBeNull()
    expect(await txRow(ttrId)).toMatchObject({ cash_amount: 12000 })
  })
})
