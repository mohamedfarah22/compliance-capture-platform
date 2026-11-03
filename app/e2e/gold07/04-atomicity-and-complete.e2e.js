// Gold Phase 7 UAT, sections I and J of docs/uat-gold-07-purchase-writes.md: a failed save leaves nothing behind
// (rows and storage), and gold-complete-purchase adds the ERP invoice once, with the same rules.
// Rows 7.101 and 7.102 were added by UAT from spec 4.3, 3.3 and 3.5.
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { sql } from '../support/db.js'
import {
  auditRows,
  complete,
  customer,
  E1,
  inv,
  jpeg,
  row,
  S1,
  save,
  saved,
  snap,
  token,
  world,
} from './support.js'

test.describe.configure({ mode: 'serial' })

let t1
test.beforeAll(async () => {
  await world()
})
test.beforeEach(async () => {
  t1 = await token('t1')
})

const yes = { ttrSelfConducted: 'true', ttrDetailsConfirmed: 'true' }
const reportable = { cash10k: 'true', ...yes }
const bullion = (band, extra = {}) => ({ purchaseType: 'bullion', cash10k: undefined, bullionBand: band, ...extra })
const used = (invoice) => `The ERP invoice number ${invoice} is already used by another purchase. A reportable purchase needs its own invoice number.`
const finished = (invoice) => `The AUSTRAC report for ${invoice} is already finished. Use a new ERP invoice number for this purchase.`
const tidy = (r) => [r.status, r.body]

const linkCompleteTtr = async (purchaseId, ref) => {
  const id = randomUUID()
  await sql`
    insert into ttr.transactions (id, reporting_entity_id, scenario, transaction_ref, transaction_datetime, designated_service,
        location_snapshot, staff_member_name, staff_member_email, cash_currency, cash_amount, aud_value, status, completed_at)
    values (${id}, ${E1}, 'precious_metal_buy', ${ref}, now(), 'Purchase of precious metal for cash', 'Coburg, VIC', 'UAT',
        'uat@example.test', 'AUD', 12000, 12000, 'complete', now())`
  await sql`update gold.purchases set ttr_transaction_id = ${id} where id = ${purchaseId}`
}

test.describe('I · atomicity: rows and storage', () => {
  test('7.80 ⚠ — if the database refuses the photo rows, nothing is left: no purchase, photo, object, audit row or fill', async () => {
    const ruth = await customer()
    const number = inv('80')
    const a = await saved(t1, { customerId: ruth.id, erpInvoiceNo: number })
    const call = () =>
      save(t1, { customerId: ruth.id, partAmount: '500', erpInvoiceNo: number, linkedAmounts: { [a]: '700' } }, [jpeg(1), jpeg(2, 100)])
    await sql`alter table gold.goods_photos add constraint uat_block check (sort_order < 0) not valid`
    let failed
    let before
    let after
    try {
      before = await snap()
      failed = await call()
      after = await snap()
    } finally {
      await sql`alter table gold.goods_photos drop constraint if exists uat_block`
    }
    expect(tidy(failed)).toEqual([500, { error: 'save_failed' }])
    expect(after).toEqual(before)
    expect((await row(a)).cash_amount).toBeNull()
    const again = await call()
    expect(again.status, again.text).toBe(201)
  })

  test('7.81 ⚠ — if storage refuses the second photo, the first is removed again and no purchase exists', async () => {
    const ruth = await customer()
    await sql`update storage.buckets set file_size_limit = 40 where id = 'gold-goods'`
    let failed
    let before
    let after
    try {
      before = await snap()
      failed = await save(t1, { customerId: ruth.id }, [jpeg(1), jpeg(2, 100)])
      after = await snap()
    } finally {
      await sql`update storage.buckets set file_size_limit = null where id = 'gold-goods'`
    }
    expect(tidy(failed)).toEqual([500, { error: 'storage_failed' }])
    expect(after).toEqual(before)
    const again = await save(t1, { customerId: ruth.id }, [jpeg(1), jpeg(2, 100)])
    expect(again.status, again.text).toBe(201)
  })
})

test.describe('J · completing a purchase', () => {
  test('7.90 ⚠ — the invoice is added trimmed, with completed_at and completed_by in the same audited update', async () => {
    const ruth = await customer()
    const p = await saved(t1, { customerId: ruth.id })
    const number = inv('90')
    const r = await complete(t1, { purchaseId: p, erpInvoiceNo: ` ${number} ` })
    expect(tidy(r)).toEqual([200, { purchaseId: p, ttr: null, warnings: {} }])
    expect(await row(p)).toMatchObject({
      erp_invoice_no: number,
      erp_invoice_norm: number.toUpperCase(),
      completed_by_staff_id: S1,
      completed_at: expect.any(String),
    })
    const log = await auditRows(p)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ source: 'complete_purchase', changed_by: S1 })
    expect(Object.keys(log[0].changes).sort()).toEqual(['completed_at', 'completed_by_staff_id', 'erp_invoice_no'])
    expect(log[0].changes.erp_invoice_no).toEqual({ old: null, new: number })
  })

  test('7.91 — a blank or missing invoice is refused on erp_invoice_no; nothing changes', async () => {
    const ruth = await customer()
    const p = await saved(t1, { customerId: ruth.id })
    const before = await snap()
    for (const body of [{ erpInvoiceNo: '' }, { erpInvoiceNo: '   ' }, {}]) {
      const r = await complete(t1, { purchaseId: p, ...body })
      expect(r.status, JSON.stringify(body)).toBe(422)
      expect(r.body.errors.erp_invoice_no).toBe('Enter the ERP invoice number for this purchase.')
    }
    expect((await row(p)).erp_invoice_no).toBeNull()
    expect(await snap()).toEqual(before)
  })

  test('7.92 ⚠ — an invoice already set (at completion or at the counter) is never changed: 409 already_has_invoice', async () => {
    const ruth = await customer()
    const completed = await saved(t1, { customerId: ruth.id })
    const first = inv('92a')
    await complete(t1, { purchaseId: completed, erpInvoiceNo: first })
    const gina = await customer({ ready: false, first: 'Gina', last: 'Goldonly' })
    const atCounter = inv('92b')
    const counter = await saved(t1, { customerId: gina.id, cash10k: 'true', erpInvoiceNo: atCounter })
    for (const p of [completed, counter]) {
      const r = await complete(t1, { purchaseId: p, erpInvoiceNo: inv('92c') })
      expect(tidy(r), p).toEqual([409, { error: 'already_has_invoice' }])
    }
    expect((await row(completed)).erp_invoice_no).toBe(first)
    expect((await row(counter)).erp_invoice_no).toBe(atCounter)
  })

  test('7.93 ⚠ — case A: the invoice is added with completed_*, and no TTR is started', async () => {
    const ruth = await customer()
    const p = await saved(t1, { customerId: ruth.id, ...reportable })
    const [{ n: before }] = await sql`select count(*)::int as n from ttr.transactions`
    const number = inv('93')
    const r = await complete(t1, { purchaseId: p, erpInvoiceNo: number })
    expect(r.status, r.text).toBe(200)
    expect(r.body.ttr).toBe('A')
    expect(await row(p)).toMatchObject({
      erp_invoice_no: number,
      completed_by_staff_id: S1,
      completed_at: expect.any(String),
      ttr_transaction_id: null,
    })
    const log = await auditRows(p)
    expect(log).toHaveLength(1)
    expect(Object.keys(log[0].changes).sort()).toEqual(['completed_at', 'completed_by_staff_id', 'erp_invoice_no'])
    const [{ n: after }] = await sql`select count(*)::int as n from ttr.transactions`
    expect(after).toBe(before)
  })

  test('7.94 — a reportable purchase cannot take a used invoice; a non-reportable one saves with a warning', async () => {
    const gina = await customer({ ready: false, first: 'Gina', last: 'Goldonly' })
    const number = inv('94')
    await saved(t1, { customerId: gina.id, cash10k: 'true', erpInvoiceNo: number })
    const ruth = await customer()
    const rep = await saved(t1, { customerId: ruth.id, cashAmount: '10000', ...reportable })
    const r1 = await complete(t1, { purchaseId: rep, erpInvoiceNo: number })
    expect(r1.status).toBe(422)
    expect(r1.body.errors.erp_invoice_no).toBe(used(number))
    expect((await row(rep)).erp_invoice_no).toBeNull()
    expect(await auditRows(rep)).toHaveLength(0)

    const plain = await saved(t1, { customerId: ruth.id, cash10k: 'false', ...yes })
    const r2 = await complete(t1, { purchaseId: plain, erpInvoiceNo: number })
    expect(r2.status, r2.text).toBe(200)
    expect(r2.body.warnings.duplicateInvoice).toBe(`The ERP invoice number ${number} is already recorded on another purchase.`)
    expect((await row(plain)).erp_invoice_no).toBe(number)
  })

  test('7.95 ⚠ — adding an invoice whose TTR (of this type) is complete is refused (3.5)', async () => {
    const ruth = await customer()
    const number = inv('95')
    const p54 = await saved(t1, { customerId: ruth.id, cash10k: 'true', cashAmount: '9000', erpInvoiceNo: number })
    await linkCompleteTtr(p54, number)
    const p95 = await saved(t1, { customerId: ruth.id })
    const r = await complete(t1, { purchaseId: p95, erpInvoiceNo: number, partAmount: '100' })
    expect(r.status).toBe(422)
    expect(r.body.errors.erp_invoice_no).toBe(finished(number))
    expect((await row(p95)).erp_invoice_no).toBeNull()
  })

  test('7.96 ⚠ — a purchase saved with an expired ID that becomes reportable at completion is blocked (C2)', async () => {
    const eddie = await customer({ id: 'expired', first: 'Eddie', last: 'Expired' })
    const p = await saved(t1, { customerId: eddie.id })
    expect((await row(p)).id_expired_at_time).toBe(true)
    const number = inv('96')
    await saved(t1, { customerId: eddie.id, cash10k: 'true', cashAmount: '9000', erpInvoiceNo: number })
    const r = await complete(t1, { purchaseId: p, erpInvoiceNo: number, partAmount: '2000' })
    expect(r.status).toBe(422)
    expect(r.body.blocked).toBe(true)
    const after = await row(p)
    expect(after.erp_invoice_no).toBeNull()
    expect(after.cash_amount).toBeNull()
  })

  test('7.97 — amounts on completion: part and earlier part both required; all or nothing; each change audited', async () => {
    const ruth = await customer()
    const number = inv('97')
    const a = await saved(t1, { customerId: ruth.id, erpInvoiceNo: number })
    const b = await saved(t1, { customerId: ruth.id })
    const none = await complete(t1, { purchaseId: b, erpInvoiceNo: number })
    expect(none.status).toBe(422)
    expect(Object.keys(none.body.errors).sort()).toEqual(['partAmount', `linked_${a}`].sort())
    const partOnly = await complete(t1, { purchaseId: b, erpInvoiceNo: number, partAmount: '700' })
    expect(partOnly.status).toBe(422)
    expect(Object.keys(partOnly.body.errors)).toEqual([`linked_${a}`])
    expect((await row(a)).cash_amount).toBeNull()
    expect((await row(b)).cash_amount).toBeNull()

    const ok = await complete(t1, { purchaseId: b, erpInvoiceNo: number, partAmount: '700', linkedAmounts: { [a]: '300' } })
    expect(ok.status, ok.text).toBe(200)
    expect(await row(b)).toMatchObject({ erp_invoice_no: number, cash_amount: 700, completed_by_staff_id: S1 })
    const logB = await auditRows(b)
    expect(logB).toHaveLength(1)
    expect(Object.keys(logB[0].changes).sort()).toEqual(['cash_amount', 'completed_at', 'completed_by_staff_id', 'erp_invoice_no'])
    expect((await row(a)).cash_amount).toBe(300)
    const logA = await auditRows(a)
    expect(logA).toHaveLength(1)
    expect(logA[0]).toMatchObject({ source: 'complete_purchase', changed_by: S1 })
    expect(logA[0].changes).toEqual({ cash_amount: { old: null, new: 300 } })
  })

  test('7.98 — a purchase that becomes reportable at completion (no counter answers) is case B', async () => {
    const ruth = await customer()
    const number = inv('98')
    const a = await saved(t1, { customerId: ruth.id, erpInvoiceNo: number })
    const b = await saved(t1, { customerId: ruth.id })
    const r = await complete(t1, { purchaseId: b, erpInvoiceNo: number, partAmount: '6000', linkedAmounts: { [a]: '5000' } })
    expect(r.status, r.text).toBe(200)
    expect(r.body.ttr).toBe('B')
  })

  test('7.99 ⚠ — a client cannot change anything but the invoice: forged band, answers, completed_*, type and flags are ignored', async () => {
    const ruth = await customer()
    const p = await saved(t1, { customerId: ruth.id })
    const r = await complete(t1, {
      purchaseId: p,
      erpInvoiceNo: inv('99'),
      cashBand: '10k_plus',
      ttrSelfConducted: true,
      completedAt: '2001-01-01',
      completedByStaffId: 'a0000000-0000-4000-8000-000000000002',
      purchaseType: 'bullion',
      idExpiredAtTime: true,
    })
    expect(r.status, r.text).toBe(200)
    expect(r.body.ttr).toBeNull()
    const after = await row(p)
    expect(after).toMatchObject({
      completed_by_staff_id: S1,
      purchase_type: 'scrap',
      cash_band: 'under_10k',
      id_expired_at_time: false,
      ttr_self_conducted: null,
    })
    expect(Math.abs(Date.now() - new Date(after.completed_at).getTime())).toBeLessThan(120_000)
  })

  test('7.100 — an unknown purchase is 404; a malformed id or body is a 400 naming the field', async () => {
    const unknown = await complete(t1, { purchaseId: '00000000-0000-4000-8000-000000000000', erpInvoiceNo: 'INV-X' })
    expect(tidy(unknown)).toEqual([404, { error: 'purchase_not_found' }])
    const nope = await complete(t1, { purchaseId: 'nope', erpInvoiceNo: 'INV-X' })
    expect(tidy(nope)).toEqual([400, { error: 'bad_request', field: 'purchaseId' }])
    const raw = await complete(t1, 'not json', { raw: true })
    expect(tidy(raw)).toEqual([400, { error: 'bad_request', field: 'body' }])
  })

  test('7.101 (added by UAT, spec 3.3 / 3.5) — a case A purchase needs an invoice to complete, and a used invoice is found whatever its case', async () => {
    const gina = await customer({ ready: false, first: 'Gina', last: 'Goldonly' })
    const number = inv('101')
    await saved(t1, { customerId: gina.id, cash10k: 'true', erpInvoiceNo: number })
    const ruth = await customer()
    const p = await saved(t1, { customerId: ruth.id, cashAmount: '10000', ...reportable })
    const blank = await complete(t1, { purchaseId: p, erpInvoiceNo: '  ' })
    expect(blank.status).toBe(422)
    expect(blank.body.errors.erp_invoice_no).toBe('Enter the ERP invoice number for this purchase.')
    const dup = await complete(t1, { purchaseId: p, erpInvoiceNo: ` ${number.toLowerCase()} ` })
    expect(dup.status).toBe(422)
    expect(dup.body.errors.erp_invoice_no).toBe(used(number.toLowerCase()))
    expect((await row(p)).erp_invoice_no).toBeNull()
  })

  test('7.102 (added by UAT, spec 3.5 "the other type is not blocked") — a bullion purchase can take an invoice whose scrap TTR is complete', async () => {
    const ruth = await customer()
    const number = inv('102')
    const scrap = await saved(t1, { customerId: ruth.id, cash10k: 'true', cashAmount: '9000', erpInvoiceNo: number })
    await linkCompleteTtr(scrap, number)
    const gold = await saved(t1, { customerId: ruth.id, ...bullion('under_5k') })
    const r = await complete(t1, { purchaseId: gold, erpInvoiceNo: number, partAmount: '100' })
    expect(r.status, r.text).toBe(200)
    expect((await row(gold)).erp_invoice_no).toBe(number)
  })

  test('7.103 (added by UAT, spec 4.3 invoice set once) — two completions racing on one purchase: one wins, the other is 409 already_has_invoice', async () => {
    const ruth = await customer()
    const p = await saved(t1, { customerId: ruth.id })
    const [x, y] = await Promise.all([
      complete(t1, { purchaseId: p, erpInvoiceNo: inv('103a') }),
      complete(t1, { purchaseId: p, erpInvoiceNo: inv('103b') }),
    ])
    expect([x.status, y.status].sort()).toEqual([200, 409])
    expect((x.status === 409 ? x : y).body).toEqual({ error: 'already_has_invoice' })
    expect(await auditRows(p)).toHaveLength(1)
  })
})

test.describe('I · storage after everything above', () => {
  test('7.83 — a clean run leaves no stray goods objects: every object has a goods_photos row', async () => {
    const [{ n }] = await sql`
      select count(*)::int as n from storage.objects
      where bucket_id = 'gold-goods' and name not in (select object_path from gold.goods_photos)`
    expect(n).toBe(0)
  })
})
