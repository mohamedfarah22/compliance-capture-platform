// Gold Phase 7 UAT, sections F, G and H of docs/uat-gold-07-purchase-writes.md: duplicate invoices and a completed
// TTR (3.3, 3.5), linked parts and totals (3.4, 4.2), and values a lying client sends (4.3).
// Rows 7.56 to 7.59, 7.67 and 7.73 were added by UAT from spec 3.5 and 4.3.
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { sql } from '../support/db.js'
import { localEnv } from '../support/env.js'
import { auditRows, complete, customer, E1, inv, melbourneToday, row, S1, S2, save, saved, snap, token, world } from './support.js'

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

/** A purchase written straight into the table (another day, no photos): the setup the sheet does with SQL. */
const insertPurchase = async ({ c, invoice, daysAgo = 0, type = 'scrap', band = 'under_10k' }) => {
  const id = randomUUID()
  await sql`
    insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band,
        cash_10k_or_more, erp_invoice_no, sale_date, phone, id_sighted, created_by_staff_id)
    values (${id}, ${E1}, ${c.id}, ${c.verId}, ${type}, ${band}, false, ${invoice},
        (now() at time zone 'Australia/Melbourne')::date - ${daysAgo}::int, '0411 111 111', true, ${S1})`
  return id
}

/** A TTR for `ref` of the given scenario and status, linked to a gold purchase. */
const linkTtr = async (purchaseId, ref, { status = 'complete', scenario = 'precious_metal_buy' } = {}) => {
  const id = randomUUID()
  await sql`
    insert into ttr.transactions (id, reporting_entity_id, scenario, transaction_ref, transaction_datetime, designated_service,
        location_snapshot, staff_member_name, staff_member_email, cash_currency, cash_amount, aud_value, status, completed_at)
    values (${id}, ${E1}, ${scenario}, ${ref}, now(), 'Purchase of precious metal for cash', 'Coburg, VIC', 'UAT', 'uat@example.test',
        'AUD', 12000, 12000, ${status}, ${status === 'complete' ? sql`now()` : null})`
  await sql`update gold.purchases set ttr_transaction_id = ${id} where id = ${purchaseId}`
  return id
}

test.describe('F · duplicate invoices and a completed TTR', () => {
  test('7.50 ⚠ — a reportable purchase on an invoice another customer already used is refused; case and spaces do not hide it', async () => {
    const gina = await customer({ ready: false, first: 'Gina', last: 'Goldonly' })
    const number = inv('50')
    const first = await save(t1, { customerId: gina.id, cash10k: 'true', erpInvoiceNo: number })
    expect(first.status, first.text).toBe(201)
    const ruth = await customer()
    const before = await snap()
    const same = await save(t1, { customerId: ruth.id, ...reportable, erpInvoiceNo: number })
    expect(same.status).toBe(422)
    expect(same.body.errors.erp_invoice_no).toBe(used(number))
    const lower = await save(t1, { customerId: ruth.id, ...reportable, erpInvoiceNo: ` ${number.toLowerCase()} ` })
    expect(lower.status).toBe(422)
    expect(lower.body.errors.erp_invoice_no).toBe(used(number.toLowerCase()))
    expect(await snap()).toEqual(before)
  })

  test('7.51 — a non-reportable purchase on a used invoice saves with a warning only', async () => {
    const gina = await customer({ ready: false, first: 'Gina', last: 'Goldonly' })
    const number = inv('51')
    await save(t1, { customerId: gina.id, cash10k: 'true', erpInvoiceNo: number })
    const ruth = await customer()
    const r = await save(t1, { customerId: ruth.id, erpInvoiceNo: number })
    expect(r.status, r.text).toBe(201)
    expect(r.body.warnings.duplicateInvoice).toBe(`The ERP invoice number ${number} is already recorded on another purchase.`)
    expect((await row(r.body.purchaseId)).erp_invoice_no).toBe(number)
  })

  test('7.53 ⚠ — a part from another day is not a linked part, so reusing its invoice on a reportable purchase is a duplicate', async () => {
    const ruth = await customer()
    const number = inv('53')
    await insertPurchase({ c: ruth, invoice: number, daysAgo: 1 })
    const r = await save(t1, { customerId: ruth.id, ...reportable, erpInvoiceNo: number })
    expect(r.status).toBe(422)
    expect(r.body.errors.erp_invoice_no).toBe(used(number))
  })

  test('7.54 ⚠ — a new part of the same type on an invoice whose TTR is complete is blocked; the other type is not', async () => {
    const ruth = await customer()
    const number = inv('54')
    const p54 = await save(t1, { customerId: ruth.id, cash10k: 'true', cashAmount: '9000', erpInvoiceNo: number })
    expect(p54.status, p54.text).toBe(201)
    await linkTtr(p54.body.purchaseId, number, { status: 'complete' })
    const before = await snap()
    const scrap = await save(t1, { customerId: ruth.id, ...reportable, partAmount: '3000', erpInvoiceNo: number })
    expect(scrap.status).toBe(422)
    expect(scrap.body.errors.erp_invoice_no).toBe(finished(number))
    expect(await snap()).toEqual(before)
    const gold = await save(t1, { customerId: ruth.id, ...bullion('under_5k', { partAmount: '100', erpInvoiceNo: number }) })
    expect(gold.status, gold.text).toBe(201)
    const after = await snap()
    expect(after.purchases).toBe(before.purchases + 1)
  })

  test('7.55 — a draft TTR on the invoice does not block a new part', async () => {
    const ruth = await customer()
    const number = inv('55')
    const p = await save(t1, { customerId: ruth.id, cash10k: 'true', cashAmount: '9000', erpInvoiceNo: number })
    await linkTtr(p.body.purchaseId, number, { status: 'draft' })
    const r = await save(t1, { customerId: ruth.id, ...reportable, partAmount: '3000', erpInvoiceNo: number })
    expect(r.status, r.text).toBe(201)
  })

  test('7.56 (added by UAT, spec 3.5) — the completed-TTR block finds the invoice whatever its case or spacing', async () => {
    const ruth = await customer()
    const number = inv('56')
    const p = await save(t1, { customerId: ruth.id, cash10k: 'true', cashAmount: '9000', erpInvoiceNo: number })
    await linkTtr(p.body.purchaseId, number, { status: 'complete' })
    const r = await save(t1, { customerId: ruth.id, ...reportable, partAmount: '3000', erpInvoiceNo: `  ${number.toLowerCase()}` })
    expect(r.status).toBe(422)
    expect(r.body.errors.erp_invoice_no).toBe(finished(number.toLowerCase()))
  })
})

test.describe('F2 · simultaneous saves', () => {
  test('7.57 (added by UAT, spec 4.3 / 3.3) — two reportable saves racing for one invoice cannot both succeed', async () => {
    // Defect D1 (fixed in 0105b69, advisory lock): the check used to read, then write, so both saves passed.
    const gina = await customer({ ready: false, first: 'Gina', last: 'Goldonly' })
    const ruth = await customer()
    const results = []
    for (let i = 0; i < 4; i++) {
      const number = inv('57')
      const pair = await Promise.all([
        save(t1, { customerId: gina.id, cash10k: 'true', erpInvoiceNo: number }),
        save(t1, { customerId: ruth.id, ...reportable, erpInvoiceNo: number }),
      ])
      results.push(pair.map((r) => r.status).sort())
    }
    // Spec 4.3: a duplicate invoice blocks a reportable purchase. Exactly one of each pair may be saved.
    expect(results).toEqual(Array(4).fill([201, 422]))
  })
})

// 7.58 and 7.59 (added by UAT, spec 4.3 / 3.3): the invoice lock itself, made deterministic. A second database
// connection takes the same lock the write functions take, and inserts a conflicting purchase it has not committed
// yet. The function under test must wait for the lock, and once the other transaction commits it must see the
// committed row and refuse. Without the lock it would finish at once, before the commit, with a 201 / 200.
const settledAfter = async (promise, ms) => {
  let done = false
  promise.then(() => (done = true))
  await new Promise((resolve) => setTimeout(resolve, ms))
  return done
}

const holdInvoice = async (number, other, during) => {
  const second = postgres(localEnv().DB_URL, { max: 1, idle_timeout: 5, onnotice: () => {} })
  try {
    await second.begin(async (tx) => {
      await tx`select gold._lock_invoice(${E1}, ${number})`
      await tx`
        insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band,
            cash_10k_or_more, erp_invoice_no, sale_date, phone, id_sighted, created_by_staff_id)
        values (${randomUUID()}, ${E1}, ${other.id}, ${other.verId}, 'scrap', '10k_plus', true, ${number},
            (now() at time zone 'Australia/Melbourne')::date, '0411 111 111', true, ${S1})`
      await during()
    })
  } finally {
    await second.end()
  }
}

test.describe('F3 · the invoice lock', () => {
  test('7.58 (added by UAT, spec 4.3 / 3.3) — a save waits for the invoice lock, then refuses the invoice another purchase has just committed', async () => {
    const ruth = await customer()
    const gina = await customer({ ready: false, first: 'Gina', last: 'Goldonly' })
    const number = inv('58')
    const before = await snap()
    let pending
    await holdInvoice(number, gina, async () => {
      pending = save(t1, { customerId: ruth.id, ...reportable, erpInvoiceNo: number })
      expect(await settledAfter(pending, 4000), 'the save finished while the invoice lock was held').toBe(false)
    })
    const r = await pending
    expect(r.status, r.text).toBe(422)
    expect(r.body.errors.erp_invoice_no).toBe(used(number))
    const after = await snap()
    expect(after.purchases).toBe(before.purchases + 1) // only the other connection's row
    expect(after.photos).toBe(before.photos)
    expect(after.objects).toBe(before.objects) // the photo the save had already uploaded was removed again
  })

  test('7.59 (added by UAT, spec 4.3 / 3.3) — a completion waits for the invoice lock, then refuses the invoice another purchase has just committed', async () => {
    const ruth = await customer()
    const gina = await customer({ ready: false, first: 'Gina', last: 'Goldonly' })
    const number = inv('59')
    const p = await saved(t1, { customerId: ruth.id, cashAmount: '10000', ...reportable })
    let pending
    await holdInvoice(number, gina, async () => {
      pending = complete(t1, { purchaseId: p, erpInvoiceNo: number })
      expect(await settledAfter(pending, 4000), 'the completion finished while the invoice lock was held').toBe(false)
    })
    const r = await pending
    expect(r.status, r.text).toBe(422)
    expect(r.body.errors.erp_invoice_no).toBe(used(number))
    expect((await row(p)).erp_invoice_no).toBeNull()
  })
})

test.describe('G · linked parts and totals', () => {
  test('7.67 (added by UAT, spec 4.5 one transaction) — two saves both filling the same earlier part: one wins, the other is a 409 and leaves nothing behind', async () => {
    const ruth = await customer()
    const number = inv('67')
    const a = await save(t1, { customerId: ruth.id, erpInvoiceNo: number })
    const part = a.body.purchaseId
    const fill = (amount) => save(t1, { customerId: ruth.id, partAmount: '10', erpInvoiceNo: number, linkedAmounts: { [part]: amount } })
    const before = await snap()
    const [x, y] = await Promise.all([fill('100'), fill('200')])
    expect([x.status, y.status].sort()).toEqual([201, 409])
    expect((x.status === 409 ? x : y).body).toEqual({ error: 'linked_part_changed' })
    const after = await snap()
    expect(after.purchases).toBe(before.purchases + 1)
    expect(after.photos).toBe(before.photos + 1)
    expect(after.objects).toBe(before.objects + 1)
    expect([100, 200]).toContain((await row(part)).cash_amount)
    expect(await auditRows(part)).toHaveLength(1)
  })

  test('7.60 ⚠ — an earlier part with no amount is filled in the same save; the total makes the sale reportable; the fill is audited', async () => {
    const ruth = await customer()
    const number = inv('60')
    const a = await save(t1, { customerId: ruth.id, erpInvoiceNo: number })
    expect(a.status, a.text).toBe(201)
    const pa = a.body.purchaseId
    const part2 = { customerId: ruth.id, ...bullion('5k_to_10k', { erpInvoiceNo: number.toLowerCase() }) }

    const none = await save(t1, part2)
    expect(none.status).toBe(422)
    expect(none.body.errors.partAmount).toBe('Enter the cash paid for this part. Enter 0 if none was cash.')
    const partOnly = await save(t1, { ...part2, partAmount: '6000' })
    expect(partOnly.status).toBe(422)
    expect(partOnly.body.errors[`linked_${pa}`]).toBe('Enter the cash paid on that part. Enter 0 if none was cash.')

    const both = await save(t1, { ...part2, partAmount: '6000', linkedAmounts: { [pa]: '5000' }, ...yes })
    expect(both.status, both.text).toBe(201)
    expect(both.body.ttr).toBe('A')
    expect(await row(both.body.purchaseId)).toMatchObject({
      cash_amount: 6000,
      invoice_cash_total: 11000,
      cash_10k_or_more: true,
      cash_band: '5k_to_10k',
    })
    expect((await row(pa)).cash_amount).toBe(5000)
    const log = await auditRows(pa)
    expect(log).toHaveLength(1)
    expect(log[0].source).toBe('save_purchase')
    expect(log[0].changed_by).toBe(S1)
    expect(log[0].changes).toEqual({ cash_amount: { old: null, new: 5000 } })
    expect(Math.abs(Date.now() - new Date(log[0].changed_at).getTime())).toBeLessThan(120_000)
  })

  test('7.61 — the total decides: $2,000 + $3,000 is not reportable, and an earlier amount already saved is not touched', async () => {
    const ruth = await customer()
    const number = inv('61')
    const a = await save(t1, { customerId: ruth.id, cash10k: 'true', cashAmount: '2000', erpInvoiceNo: number })
    const r = await save(t1, { customerId: ruth.id, partAmount: '3000', erpInvoiceNo: number })
    expect(r.status, r.text).toBe(201)
    expect(r.body.ttr).toBeNull()
    expect(await row(r.body.purchaseId)).toMatchObject({ invoice_cash_total: 5000, cash_10k_or_more: false, cash_amount: 3000 })
    expect(await auditRows(a.body.purchaseId)).toHaveLength(0)
  })

  test('7.62 ⚠ — mixed scrap + bullion: $6,000 + $6,000 on one invoice is reportable, each part keeps its own amount', async () => {
    const ruth = await customer()
    const number = inv('62')
    const a = await save(t1, { customerId: ruth.id, cash10k: 'true', cashAmount: '6000', erpInvoiceNo: number })
    expect(a.status, a.text).toBe(201)
    expect(a.body.ttr).toBeNull()
    const b = await save(t1, { customerId: ruth.id, ...bullion('5k_to_10k', { partAmount: '6000', erpInvoiceNo: number }), ...yes })
    expect(b.status, b.text).toBe(201)
    expect(b.body.ttr).toBe('A')
    expect(await row(b.body.purchaseId)).toMatchObject({ invoice_cash_total: 12000, cash_10k_or_more: true, cash_amount: 6000 })
    expect(await auditRows(a.body.purchaseId)).toHaveLength(0)
  })

  test('7.63 — a later part adds to the total; earlier snapshots are never rewritten', async () => {
    const ruth = await customer()
    const number = inv('63')
    const a = await save(t1, { customerId: ruth.id, cash10k: 'true', cashAmount: '6000', erpInvoiceNo: number })
    const b = await save(t1, { customerId: ruth.id, ...bullion('5k_to_10k', { partAmount: '6000', erpInvoiceNo: number }), ...yes })
    const c = await save(t1, { customerId: ruth.id, partAmount: '1000', erpInvoiceNo: number, ...yes })
    expect(c.status, c.text).toBe(201)
    expect((await row(c.body.purchaseId)).invoice_cash_total).toBe(13000)
    expect((await row(b.body.purchaseId)).invoice_cash_total).toBe(12000)
    expect((await row(a.body.purchaseId)).invoice_cash_total).toBeNull()
  })

  test('7.64 ⚠ — the total uses the saved amounts, an earlier amount is never overwritten, and a part that is not linked cannot be filled', async () => {
    const ruth = await customer()
    const number = inv('64')
    const a = await save(t1, { customerId: ruth.id, cash10k: 'true', cashAmount: '6000', erpInvoiceNo: number })
    const b = await save(t1, { customerId: ruth.id, ...bullion('5k_to_10k', { partAmount: '6000', erpInvoiceNo: number }), ...yes })
    const c = await save(t1, { customerId: ruth.id, partAmount: '1000', erpInvoiceNo: number, ...yes })
    expect(c.status, c.text).toBe(201)
    const elsewhere = await insertPurchase({ c: ruth, invoice: inv('64-other'), daysAgo: 1 })
    const r = await save(t1, {
      customerId: ruth.id,
      partAmount: '500',
      erpInvoiceNo: number,
      linkedAmounts: { [a.body.purchaseId]: '1', [elsewhere]: '1' },
      ...yes,
    })
    expect(r.status, r.text).toBe(201)
    expect((await row(a.body.purchaseId)).cash_amount).toBe(6000)
    expect((await row(elsewhere)).cash_amount).toBeNull()
    expect((await row(r.body.purchaseId)).invoice_cash_total).toBe(13500)
    expect(b.status).toBe(201)
  })

  test('7.65 — a different customer on the same invoice is not a linked part: a warning, not a total', async () => {
    const ruth = await customer()
    const gina = await customer({ ready: false, first: 'Gina', last: 'Goldonly' })
    const number = inv('65')
    await save(t1, { customerId: ruth.id, cash10k: 'true', cashAmount: '6000', erpInvoiceNo: number })
    const r = await save(t1, { customerId: gina.id, erpInvoiceNo: number })
    expect(r.status, r.text).toBe(201)
    expect(r.body.warnings.duplicateInvoice).toBeTruthy()
    expect((await row(r.body.purchaseId)).invoice_cash_total).toBeNull()
  })

  test("7.66 — a joint seller's earlier part is linked to the joint sale", async () => {
    const ruth = await customer()
    const jack = await customer({ first: 'Jack', last: 'Joint' })
    const number = inv('66')
    const a = await save(t1, { customerId: jack.id, erpInvoiceNo: number })
    expect(a.status, a.text).toBe(201)
    const r = await save(t1, {
      customerId: ruth.id,
      jointCustomerId: jack.id,
      partAmount: '100',
      erpInvoiceNo: number,
      linkedAmounts: { [a.body.purchaseId]: '50' },
    })
    expect(r.status, r.text).toBe(201)
    expect((await row(r.body.purchaseId)).invoice_cash_total).toBe(150)
    expect((await row(a.body.purchaseId)).cash_amount).toBe(50)
  })
})

test.describe('H · values a client sends that lie', () => {
  test('7.70 ⚠ — every server-computed value a client forges is ignored', async () => {
    const ruth = await customer()
    const jack = await customer({ first: 'Jack', last: 'Joint' })
    const forged = {
      cashBand: '10k_plus',
      cash_band: '10k_plus',
      cash10kOrMore: 'true',
      cash_10k_or_more: 'true',
      saleDate: '2001-01-01',
      sale_date: '2001-01-01',
      createdByStaffId: S2,
      created_by_staff_id: S2,
      idExpiredAtTime: 'true',
      id_expired_at_time: 'true',
      idOutsideWindowAtTime: 'true',
      mainIdVerificationId: jack.verId,
      main_id_verification_id: jack.verId,
      invoiceCashTotal: '99999',
      invoice_cash_total: '99999',
      reportingEntityId: '00000000-0000-4000-8000-0000000000e2',
      reporting_entity_id: 'e0000000-0000-4000-8000-000000000002',
      id: '11111111-1111-4111-8111-111111111111',
      completedAt: '2001-01-01',
      completedByStaffId: S2,
      ...yes,
    }
    const r = await save(t1, { customerId: ruth.id, ...forged })
    expect(r.status, r.text).toBe(201)
    expect(r.body.purchaseId).not.toBe('11111111-1111-4111-8111-111111111111')
    expect(await row(r.body.purchaseId)).toMatchObject({
      cash_band: 'under_10k',
      cash_10k_or_more: false,
      sale_date: await melbourneToday(),
      created_by_staff_id: S1,
      reporting_entity_id: E1,
      main_id_verification_id: ruth.verId,
      id_expired_at_time: false,
      id_outside_window_at_time: false,
      invoice_cash_total: null,
      ttr_self_conducted: null,
      completed_at: null,
      completed_by_staff_id: null,
    })
  })

  test('7.71 ⚠ — sale_date is the Melbourne calendar date, set by the server', async () => {
    const ruth = await customer()
    const r = await save(t1, { customerId: ruth.id })
    const [{ same }] = await sql`
      select sale_date = (now() at time zone 'Australia/Melbourne')::date as same from gold.purchases where id = ${r.body.purchaseId}`
    expect(same).toBe(true)
  })

  test('7.72 — a client that says "not cash" with a forged amount cannot make a sale reportable or hide one', async () => {
    const gina = await customer({ ready: false, first: 'Gina', last: 'Goldonly' })
    const r = await save(t1, { customerId: gina.id, cash10k: 'false', cashAmount: '20000' })
    expect(r.status, r.text).toBe(201)
    expect(r.body.ttr).toBeNull()
    expect(await row(r.body.purchaseId)).toMatchObject({ cash_amount: null, cash_10k_or_more: false })
  })

  test('7.73 (added by UAT, spec 4.3) — a part amount sent with no linked part is ignored', async () => {
    const ruth = await customer()
    const r = await save(t1, { customerId: ruth.id, partAmount: '99999', erpInvoiceNo: inv('73') })
    expect(r.status, r.text).toBe(201)
    expect(r.body.ttr).toBeNull()
    expect(await row(r.body.purchaseId)).toMatchObject({ cash_amount: null, cash_10k_or_more: false, invoice_cash_total: null })
  })
})
