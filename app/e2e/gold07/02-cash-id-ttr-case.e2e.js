// Gold Phase 7 UAT, sections C, D and E of docs/uat-gold-07-purchase-writes.md: cash thresholds, the ID rules (C2)
// and the TTR case with its counter answers (3.3, 3.3a). The server works all of it out again from data it loads.
// Rows 7.28, 7.37, 7.38 and 7.39 were added by UAT from spec C2 and 3.3.
import { expect, test } from '@playwright/test'
import { sql } from '../support/db.js'
import { addId, customer, E1, inv, melbourneToday, row, save, snap, token, world } from './support.js'

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
const blockedOf = (r) => r.body.blocked

test.describe('C · cash thresholds', () => {
  test('7.20 ⚠ — scrap, Yes, $9,999.99 is not reportable', async () => {
    const c = await customer()
    const r = await save(t1, { customerId: c.id, cash10k: 'true', cashAmount: '9,999.99' })
    expect(r.status, r.text).toBe(201)
    expect(r.body.ttr).toBeNull()
    expect(await row(r.body.purchaseId)).toMatchObject({ cash_band: 'under_10k', cash_10k_or_more: false, cash_amount: 9999.99 })
  })

  test('7.21 ⚠ — scrap, Yes, exactly $10,000 is reportable (case A for a ready customer)', async () => {
    const c = await customer()
    const r = await save(t1, { customerId: c.id, cashAmount: '10000', ...reportable })
    expect(r.status, r.text).toBe(201)
    expect(r.body.ttr).toBe('A')
    expect(await row(r.body.purchaseId)).toMatchObject({ cash_band: '10k_plus', cash_10k_or_more: true, cash_amount: 10000 })
  })

  test('7.22 — scrap, Yes with no amount is reportable (case B for a customer only seen in gold)', async () => {
    const c = await customer({ ready: false, first: 'Gina', last: 'Goldonly' })
    const r = await save(t1, { customerId: c.id, cash10k: 'true', erpInvoiceNo: inv('22') })
    expect(r.status, r.text).toBe(201)
    expect(r.body.ttr).toBe('B')
    expect(await row(r.body.purchaseId)).toMatchObject({ cash_band: '10k_plus', cash_10k_or_more: true, cash_amount: null })
  })

  test('7.23 — scrap, Yes but $8,000: the amount decides, not reportable', async () => {
    const c = await customer()
    const r = await save(t1, { customerId: c.id, cash10k: 'true', cashAmount: '8000' })
    expect(r.status, r.text).toBe(201)
    expect(r.body.ttr).toBeNull()
    expect(await row(r.body.purchaseId)).toMatchObject({ cash_band: 'under_10k', cash_10k_or_more: false, cash_amount: 8000 })
  })

  test('7.24 — scrap paid by bank transfer with a stray amount: amount ignored, not reportable', async () => {
    const c = await customer()
    const r = await save(t1, { customerId: c.id, cash10k: 'false', cashAmount: '50000' })
    expect(r.status, r.text).toBe(201)
    expect(r.body.ttr).toBeNull()
    expect(await row(r.body.purchaseId)).toMatchObject({ cash_band: 'under_10k', cash_10k_or_more: false, cash_amount: null })
  })

  test('7.25 — bullion under $5,000 saves, not reportable', async () => {
    const c = await customer()
    const r = await save(t1, { customerId: c.id, ...bullion('under_5k') })
    expect(r.status, r.text).toBe(201)
    expect(await row(r.body.purchaseId)).toMatchObject({ cash_band: 'under_5k', cash_10k_or_more: false })
  })

  test('7.26 ⚠ — bullion $5,000 to $9,999 needs a current ID: saves with a current ID, blocked with an expired one (C2)', async () => {
    const good = await customer()
    const ok = await save(t1, { customerId: good.id, ...bullion('5k_to_10k') })
    expect(ok.status, ok.text).toBe(201)
    expect(ok.body.ttr).toBeNull()
    expect(await row(ok.body.purchaseId)).toMatchObject({ cash_band: '5k_to_10k', cash_10k_or_more: false })

    const expired = await customer({ id: 'expired', first: 'Eddie', last: 'Expired' })
    const before = await snap()
    const r = await save(t1, { customerId: expired.id, ...bullion('5k_to_10k') })
    expect(r.status).toBe(422)
    expect(blockedOf(r)).toEqual([{ customerId: expired.id, role: 'main', status: 'expired' }])
    expect(await snap()).toEqual(before)
  })

  test('7.27 — bullion $10,000+ is reportable; Yes with $7,000 is $5,000 to $9,999, not reportable', async () => {
    const gina = await customer({ ready: false, first: 'Gina', last: 'Goldonly' })
    const a = await save(t1, { customerId: gina.id, ...bullion('10k_plus', { erpInvoiceNo: inv('27') }) })
    expect(a.status, a.text).toBe(201)
    expect(a.body.ttr).toBe('B')
    expect(await row(a.body.purchaseId)).toMatchObject({ cash_band: '10k_plus', cash_10k_or_more: true })

    const ruth = await customer()
    const b = await save(t1, { customerId: ruth.id, ...bullion('10k_plus', { cashAmount: '7000' }) })
    expect(b.status, b.text).toBe(201)
    expect(b.body.ttr).toBeNull()
    expect(await row(b.body.purchaseId)).toMatchObject({ cash_band: '5k_to_10k', cash_10k_or_more: false, cash_amount: 7000 })
  })

  test('7.28 (added by UAT, C2 / 5.1 boundaries) — bullion: $4,999.99 needs no current ID, $5,000 does, $9,999.99 is not reportable, $10,000 is', async () => {
    const expired = await customer({ id: 'expired', first: 'Eddie', last: 'Expired' })
    const under = await save(t1, { customerId: expired.id, ...bullion('10k_plus', { cashAmount: '4999.99' }) })
    expect(under.status, under.text).toBe(201)
    expect(await row(under.body.purchaseId)).toMatchObject({ cash_band: 'under_5k', id_expired_at_time: true })

    const before = await snap()
    const exact = await save(t1, { customerId: expired.id, ...bullion('10k_plus', { cashAmount: '5000' }) })
    expect(exact.status).toBe(422)
    expect(blockedOf(exact)).toEqual([{ customerId: expired.id, role: 'main', status: 'expired' }])
    expect(await snap()).toEqual(before)

    const ruth = await customer()
    const nine = await save(t1, { customerId: ruth.id, ...bullion('10k_plus', { cashAmount: '9999.99' }) })
    expect(nine.status, nine.text).toBe(201)
    expect(nine.body.ttr).toBeNull()
    expect(await row(nine.body.purchaseId)).toMatchObject({ cash_band: '5k_to_10k', cash_10k_or_more: false })

    const ten = await save(t1, { customerId: ruth.id, ...bullion('10k_plus', { cashAmount: '10000', ...yes }) })
    expect(ten.status, ten.text).toBe(201)
    expect(ten.body.ttr).toBe('A')
    expect(await row(ten.body.purchaseId)).toMatchObject({ cash_band: '10k_plus', cash_10k_or_more: true })
  })
})

test.describe('D · ID rules (C2) and the ID used', () => {
  test('7.30 ⚠ — a reportable purchase with an expired ID is blocked, naming the seller', async () => {
    const c = await customer({ id: 'expired' })
    const before = await snap()
    const r = await save(t1, { customerId: c.id, ...reportable, erpInvoiceNo: inv('30') })
    expect(r.status).toBe(422)
    expect(r.body.error).toBe('validation_failed')
    expect(blockedOf(r)).toEqual([{ customerId: c.id, role: 'main', status: 'expired' }])
    expect(await snap()).toEqual(before)
  })

  test('7.31 ⚠ — a reportable purchase with an ID photographed 800 days ago (window 730) is blocked as reverify', async () => {
    const c = await customer({ capturedDaysAgo: 800 })
    const before = await snap()
    const r = await save(t1, { customerId: c.id, ...reportable, erpInvoiceNo: inv('31') })
    expect(r.status).toBe(422)
    expect(blockedOf(r)).toEqual([{ customerId: c.id, role: 'main', status: 'reverify' }])
    expect(await snap()).toEqual(before)
  })

  test('7.32 ⚠ — the window is the business setting: 5 days blocks a 10-day-old ID, 730 days saves it', async () => {
    const c = await customer({ capturedDaysAgo: 10 })
    try {
      await sql`update public.reporting_entities set idv_max_reliance_days = 5 where id = ${E1}`
      const tight = await save(t1, { customerId: c.id, ...reportable })
      expect(tight.status).toBe(422)
      expect(blockedOf(tight)).toEqual([{ customerId: c.id, role: 'main', status: 'reverify' }])
    } finally {
      await sql`update public.reporting_entities set idv_max_reliance_days = 730 where id = ${E1}`
    }
    const loose = await save(t1, { customerId: c.id, ...reportable })
    expect(loose.status, loose.text).toBe(201)
    expect(loose.body.ttr).toBe('A')
  })

  test('7.33 ⚠ — where no current ID is needed the sale saves and the ID state is recorded', async () => {
    const expired = await customer({ id: 'expired' })
    const old = await customer({ capturedDaysAgo: 800 })
    const good = await customer()
    const flags = async (c) => {
      const r = await save(t1, { customerId: c.id })
      expect(r.status, r.text).toBe(201)
      const p = await row(r.body.purchaseId)
      return [p.id_expired_at_time, p.id_outside_window_at_time]
    }
    expect(await flags(expired)).toEqual([true, false])
    expect(await flags(old)).toEqual([false, true])
    expect(await flags(good)).toEqual([false, false])
  })

  test('7.34 — a reportable joint sale whose joint seller has an expired ID is blocked for the joint seller only', async () => {
    const main = await customer()
    const joint = await customer({ id: 'expired', first: 'Eddie', last: 'Expired' })
    const before = await snap()
    const r = await save(t1, { customerId: main.id, jointCustomerId: joint.id, cash10k: 'true', erpInvoiceNo: inv('34') })
    expect(r.status).toBe(422)
    expect(blockedOf(r)).toEqual([{ customerId: joint.id, role: 'joint', status: 'expired' }])
    expect(await snap()).toEqual(before)
  })

  test('7.35 — a seller with no ID on file is refused: no ID, no transaction', async () => {
    const c = await customer({ id: 'none', first: 'Nina', last: 'Noid' })
    const before = await snap()
    const r = await save(t1, { customerId: c.id })
    expect([r.status, r.body]).toEqual([422, { error: 'no_id_on_file', role: 'main' }])
    expect(await snap()).toEqual(before)
  })

  test('7.36 — the purchase records the newest ID capture; an earlier purchase keeps the one it used', async () => {
    const c = await customer()
    const first = await save(t1, { customerId: c.id })
    expect((await row(first.body.purchaseId)).main_id_verification_id).toBe(c.verId)
    const passport = await addId(c.id, { documentType: 'Passport', reason: 'different_document' })
    const second = await save(t1, { customerId: c.id })
    expect(second.status, second.text).toBe(201)
    expect((await row(second.body.purchaseId)).main_id_verification_id).toBe(passport)
    expect((await row(first.body.purchaseId)).main_id_verification_id).toBe(c.verId)
  })

  test('7.37 (added by UAT, C2 boundaries) — an ID expiring today and an ID photographed exactly 730 days ago are current; expired yesterday and 731 days are not', async () => {
    const today = await melbourneToday()
    const [{ d: yesterday }] = await sql`select (${today}::date - 1)::text as d`
    const expiresToday = await customer({ expiry: today })
    const ok1 = await save(t1, { customerId: expiresToday.id, ...reportable })
    expect(ok1.status, ok1.text).toBe(201)
    const expiredYesterday = await customer({ expiry: yesterday })
    const no1 = await save(t1, { customerId: expiredYesterday.id, ...reportable })
    expect(no1.status).toBe(422)
    expect(blockedOf(no1)).toEqual([{ customerId: expiredYesterday.id, role: 'main', status: 'expired' }])

    const at730 = await customer({ capturedDaysAgo: 730 })
    const ok2 = await save(t1, { customerId: at730.id, ...reportable })
    expect(ok2.status, ok2.text).toBe(201)
    const at731 = await customer({ capturedDaysAgo: 731 })
    const no2 = await save(t1, { customerId: at731.id, ...reportable })
    expect(no2.status).toBe(422)
    expect(blockedOf(no2)).toEqual([{ customerId: at731.id, role: 'main', status: 'reverify' }])
  })

  test('7.38 (added by UAT, spec 2 "no ID, no transaction") — a joint seller with no ID on file is refused, naming the joint role', async () => {
    const main = await customer()
    const joint = await customer({ id: 'none', first: 'Nina', last: 'Noid' })
    const before = await snap()
    const r = await save(t1, { customerId: main.id, jointCustomerId: joint.id })
    expect([r.status, r.body]).toEqual([422, { error: 'no_id_on_file', role: 'joint' }])
    expect(await snap()).toEqual(before)
  })

  test('7.39 (added by UAT, C2) — a reportable joint sale whose joint seller is outside the window is blocked as reverify for the joint seller', async () => {
    const main = await customer()
    const joint = await customer({ capturedDaysAgo: 800, first: 'Olive', last: 'Old' })
    const r = await save(t1, { customerId: main.id, jointCustomerId: joint.id, cash10k: 'true', erpInvoiceNo: inv('39') })
    expect(r.status).toBe(422)
    expect(blockedOf(r)).toEqual([{ customerId: joint.id, role: 'joint', status: 'reverify' }])
  })
})

test.describe('E · TTR case and counter answers', () => {
  test('7.40 ⚠ — case A: ready customer, reportable, both answers Yes, no invoice; no TTR is started', async () => {
    const c = await customer()
    const [{ n: before }] = await sql`select count(*)::int as n from ttr.transactions`
    const r = await save(t1, { customerId: c.id, ...reportable })
    expect(r.status, r.text).toBe(201)
    expect(r.body.ttr).toBe('A')
    expect(await row(r.body.purchaseId)).toMatchObject({
      ttr_self_conducted: true,
      ttr_details_confirmed: true,
      erp_invoice_no: null,
      ttr_transaction_id: null,
    })
    const [{ n: after }] = await sql`select count(*)::int as n from ttr.transactions`
    expect(after).toBe(before)
  })

  test('7.41 ⚠ — case B: a customer with details missing needs the invoice; with one it saves trimmed and without answers', async () => {
    const c = await customer({ ready: false, first: 'Gina', last: 'Goldonly' })
    const before = await snap()
    const no = await save(t1, { customerId: c.id, cash10k: 'true' })
    expect(no.status).toBe(422)
    expect(no.body.errors.erp_invoice_no).toBe(
      "Enter the ERP invoice number. Gina Goldonly's AUSTRAC details are incomplete, so the report must be started now.",
    )
    expect(no.body.errors.ttrSelfConducted).toBeUndefined()
    expect(no.body.errors.ttrDetailsConfirmed).toBeUndefined()
    expect(await snap()).toEqual(before)

    const number = inv('41')
    const yesInv = await save(t1, { customerId: c.id, cash10k: 'true', erpInvoiceNo: ` ${number} ` })
    expect(yesInv.status, yesInv.text).toBe(201)
    expect(yesInv.body.ttr).toBe('B')
    expect(await row(yesInv.body.purchaseId)).toMatchObject({
      erp_invoice_no: number,
      completed_at: null,
      ttr_self_conducted: null,
      ttr_details_confirmed: null,
    })
  })

  test('7.42 — any No answer is case B: invoice required, answers stored as given', async () => {
    const c = await customer()
    const no = await save(t1, { customerId: c.id, cash10k: 'true', ttrSelfConducted: 'true', ttrDetailsConfirmed: 'false' })
    expect(no.status).toBe(422)
    expect(no.body.errors.erp_invoice_no).toMatch(/The AUSTRAC report for Ruth Ready must be started now\.$/)
    const r = await save(t1, {
      customerId: c.id,
      cash10k: 'true',
      ttrSelfConducted: 'true',
      ttrDetailsConfirmed: 'false',
      erpInvoiceNo: inv('42'),
    })
    expect(r.status, r.text).toBe(201)
    expect(r.body.ttr).toBe('B')
    expect(await row(r.body.purchaseId)).toMatchObject({ ttr_self_conducted: true, ttr_details_confirmed: false })
  })

  test('7.43 — when the counter questions are asked, both must be answered', async () => {
    const c = await customer()
    const before = await snap()
    const none = await save(t1, { customerId: c.id, cash10k: 'true' })
    expect(none.status).toBe(422)
    expect(Object.keys(none.body.errors)).toEqual(expect.arrayContaining(['ttrSelfConducted', 'ttrDetailsConfirmed']))
    const one = await save(t1, { customerId: c.id, cash10k: 'true', ttrSelfConducted: 'true' })
    expect(one.status).toBe(422)
    expect(one.body.errors.ttrDetailsConfirmed).toBeTruthy()
    expect(one.body.errors.ttrSelfConducted).toBeUndefined()
    expect(await snap()).toEqual(before)
  })

  test('7.44 ⚠ — answers sent on a non-reportable sale are not stored', async () => {
    const c = await customer()
    const r = await save(t1, { customerId: c.id, cash10k: 'false', ...yes })
    expect(r.status, r.text).toBe(201)
    expect(r.body.ttr).toBeNull()
    expect(await row(r.body.purchaseId)).toMatchObject({ ttr_self_conducted: null, ttr_details_confirmed: null })
  })

  test('7.45 ⚠ — a reportable joint sale is always case B: invoice required, answers not stored', async () => {
    const main = await customer()
    const joint = await customer({ first: 'Jack', last: 'Joint' })
    const base = { customerId: main.id, jointCustomerId: joint.id, ...reportable }
    const no = await save(t1, base)
    expect(no.status).toBe(422)
    expect(no.body.errors.erp_invoice_no).toBeTruthy()
    const r = await save(t1, { ...base, erpInvoiceNo: inv('45') })
    expect(r.status, r.text).toBe(201)
    expect(r.body.ttr).toBe('B')
    expect(await row(r.body.purchaseId)).toMatchObject({
      joint_customer_id: joint.id,
      joint_id_verification_id: joint.verId,
      ttr_self_conducted: null,
      ttr_details_confirmed: null,
    })
  })

  test('7.46 — the second person must be a different customer', async () => {
    const c = await customer()
    const before = await snap()
    const r = await save(t1, { customerId: c.id, jointCustomerId: c.id })
    expect(r.status).toBe(422)
    expect(r.body.errors.joint).toBe('The second person must be a different customer.')
    expect(await snap()).toEqual(before)
  })

  test('7.47 — a non-reportable joint sale stores both IDs used', async () => {
    const main = await customer()
    const joint = await customer({ first: 'Jack', last: 'Joint' })
    const r = await save(t1, { customerId: main.id, jointCustomerId: joint.id })
    expect(r.status, r.text).toBe(201)
    expect(r.body.ttr).toBeNull()
    expect(await row(r.body.purchaseId)).toMatchObject({
      main_id_verification_id: main.verId,
      joint_id_verification_id: joint.verId,
    })
  })
})
