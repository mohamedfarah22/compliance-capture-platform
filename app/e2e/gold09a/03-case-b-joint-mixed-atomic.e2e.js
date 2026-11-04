// Gold Phase 9a UAT, sections D and E of docs/uat-gold-09a-ttr-handoff.md: case B, joint sales and mixed invoices
// (spec 3.3, 3.3a, 3.4), and atomicity, concurrency and logs (spec 3.2, 6.1). 9.28 (grants) is pgTAP.
// Rows 9.63 and 9.64 were added by UAT from spec 3.3a and 3.2.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { sql } from '../support/db.js'
import {
  bullion, customer, E1, idvOf, inv, linkOf, partiesOf, reportable, S1, save, settledAfter, startTtr, token, ttrSnap, txByRef,
  txRow, withInvoiceLock, world, yes,
} from './support.js'

let t1
test.beforeAll(async () => {
  await world()
})
test.beforeEach(async () => {
  t1 = await token('t1')
})

test.describe('D · case B, joint sales, mixed invoices', () => {
  test('9.21 ⚠ — a No on the details question, and a customer who is not ready, start case B: reliance not complete, reason prior_id_reviewed_still_valid, confirmation still copied', async () => {
    const jane = await customer({ first: 'Jane', last: 'Citizen' })
    const no = await save(t1, { customerId: jane.id, cashAmount: '12000', ...reportable, ttrDetailsConfirmed: 'false', erpInvoiceNo: inv('21a') })
    expect(no.status, no.text).toBe(201)
    expect(no.body.ttr).toBe('B')
    const a = await startTtr(t1, { purchaseId: no.body.purchaseId })
    expect(a.status, a.text).toBe(200)
    expect(a.body.ttrs[0]).toMatchObject({ created: true, case: 'B' })

    const gina = await customer({ ready: false, first: 'Gina', last: 'Goldonly' })
    const g = await save(t1, { customerId: gina.id, cashAmount: '12000', ...reportable, erpInvoiceNo: inv('21b') })
    expect(g.status, g.text).toBe(201)
    expect(g.body.ttr).toBe('B')
    const b = await startTtr(t1, { purchaseId: g.body.purchaseId })
    expect(b.status, b.text).toBe(200)
    expect(b.body.ttrs[0]).toMatchObject({ created: true, case: 'B' })

    for (const [entry, purchaseId] of [[a.body.ttrs[0], no.body.purchaseId], [b.body.ttrs[0], g.body.purchaseId]]) {
      const [v] = await idvOf(entry.id)
      expect(v).toMatchObject({ reliance_reason: 'prior_id_reviewed_still_valid', is_complete: false, verification_basis: 'relied_on_prior_identification' })
      const [p] = await sql`select created_at, created_by_staff_id from gold.purchases where id = ${purchaseId}`
      expect(v.counter_confirmed_by_staff_id).toBe(p.created_by_staff_id)
      expect(new Date(v.counter_confirmed_at).getTime()).toBe(new Date(p.created_at).getTime())
    }
    const [gp] = await partiesOf(b.body.ttrs[0].id)
    expect(gp).toMatchObject({ customer_id: gina.id, is_complete: false, first_name: 'Gina', occupation: null, gender: null, citizenship_country_code: null })
    expect(gp.tax_residency_country_code).toBeNull()
    const [jp] = await partiesOf(a.body.ttrs[0].id)
    expect(jp.is_complete).toBe(true) // Jane's details are all on file; the No alone makes it case B
  })

  test('9.22 ⚠ — a joint purchase gives one TTR with two parties and two reliance rows (one per capture), case B, rows not complete', async () => {
    const jane = await customer({ first: 'Jane', last: 'Citizen' })
    const joan = await customer({ first: 'Joan', last: 'Smith' })
    const r = await save(t1, { customerId: jane.id, jointCustomerId: joan.id, cashAmount: '12000', ...reportable, erpInvoiceNo: inv('22') })
    expect(r.status, r.text).toBe(201)
    expect(r.body.ttr).toBe('B')
    const s = await startTtr(t1, { purchaseId: r.body.purchaseId })
    expect(s.status, s.text).toBe(200)
    expect(s.body.ttrs).toHaveLength(1)
    expect(s.body.ttrs[0]).toMatchObject({ created: true, case: 'B' })
    const id = s.body.ttrs[0].id
    const parties = await partiesOf(id)
    expect(parties.map((p) => p.customer_id).sort()).toEqual([jane.id, joan.id].sort())
    const rows = await idvOf(id)
    expect(rows).toHaveLength(2)
    const byCustomer = (cid) => rows.find((v) => v.party_id === parties.find((p) => p.customer_id === cid).id)
    expect(byCustomer(jane.id)).toMatchObject({ prior_verification_id: jane.verId, is_complete: false, reliance_reason: 'prior_id_reviewed_still_valid' })
    expect(byCustomer(joan.id)).toMatchObject({ prior_verification_id: joan.verId, is_complete: false, reliance_reason: 'prior_id_reviewed_still_valid' })
  })

  test('9.23 ⚠ — a mixed invoice (scrap $6,000 + bullion $6,000): two TTRs on the same reference, bullion first, each with its own cash and its own part', async () => {
    const jane = await customer({ first: 'Jane', last: 'Citizen' })
    const number = inv('900')
    const a = await save(t1, { customerId: jane.id, cash10k: 'true', cashAmount: '6000', erpInvoiceNo: number })
    const b = await save(t1, { customerId: jane.id, ...bullion('5k_to_10k', { partAmount: '6000', erpInvoiceNo: number }), ...yes })
    expect([a.status, b.status]).toEqual([201, 201])
    const r = await startTtr(t1, { purchaseId: b.body.purchaseId }) // the bullion part
    expect(r.status, r.text).toBe(200)
    expect(r.body.ttrs.map((e) => e.type)).toEqual(['bullion', 'scrap'])
    expect(r.body.ttrs.map((e) => e.scenario)).toEqual(['bullion_buy', 'precious_metal_buy'])
    expect(new Set(r.body.ttrs.map((e) => e.case)).size).toBe(1)
    const txs = await txByRef(number)
    expect(txs).toHaveLength(2)
    const bullionTx = await txRow(r.body.ttrs[0].id)
    const scrapTx = await txRow(r.body.ttrs[1].id)
    expect(bullionTx).toMatchObject({ transaction_ref: number, scenario: 'bullion_buy', cash_amount: 6000 })
    expect(scrapTx).toMatchObject({ transaction_ref: number, scenario: 'precious_metal_buy', cash_amount: 6000 })
    expect(Number(bullionTx.cash_amount) + Number(scrapTx.cash_amount)).toBe(12000)
    expect(await linkOf(b.body.purchaseId)).toBe(bullionTx.id)
    expect(await linkOf(a.body.purchaseId)).toBe(scrapTx.id)
  })

  test('9.24 — a type paid only by bank transfer (a known $0) gets no TTR', async () => {
    const jane = await customer({ first: 'Jane', last: 'Citizen' })
    const number = inv('24')
    const a = await save(t1, { customerId: jane.id, cashAmount: '12000', ...reportable, erpInvoiceNo: number })
    const b = await save(t1, { customerId: jane.id, ...bullion('under_5k', { partAmount: '0', erpInvoiceNo: number }), ...yes })
    expect([a.status, b.status]).toEqual([201, 201])
    const r = await startTtr(t1, { purchaseId: a.body.purchaseId })
    expect(r.status, r.text).toBe(200)
    expect(r.body.ttrs).toHaveLength(1)
    expect(r.body.ttrs[0]).toMatchObject({ type: 'scrap', scenario: 'precious_metal_buy' })
    expect(await linkOf(b.body.purchaseId)).toBeNull()
    expect(await txByRef(number)).toHaveLength(1)
  })

  test('9.63 (added by UAT, spec 3.3a question 1) — a No on "acting on their own behalf" starts case B', async () => {
    const jane = await customer({ first: 'Jane', last: 'Citizen' })
    const no = await save(t1, { customerId: jane.id, cashAmount: '12000', ...reportable, ttrSelfConducted: 'false', erpInvoiceNo: inv('63') })
    expect(no.status, no.text).toBe(201)
    const r = await startTtr(t1, { purchaseId: no.body.purchaseId })
    expect(r.status, r.text).toBe(200)
    expect(r.body.ttrs[0]).toMatchObject({ created: true, case: 'B' })
    expect((await idvOf(r.body.ttrs[0].id))[0]).toMatchObject({ reliance_reason: 'prior_id_reviewed_still_valid', is_complete: false })
  })

  test('9.64 (added by UAT, spec 3.2 staff) — the TTR carries the staff member who calls; the counter confirmation carries the one who recorded the purchase', async () => {
    const other = randomUUID()
    await sql`insert into auth.users (id, email) values (${other}, ${`uat-9a-${other.slice(0, 6)}@example.test`})`
    await sql`insert into public.staff_members (id, reporting_entity_id, full_name, email, role)
              values (${other}, ${E1}, 'UAT Recorder', ${`uat-9a-${other.slice(0, 6)}@example.test`}, 'staff')`
    const jane = await customer({ first: 'Jane', last: 'Citizen' })
    const r = await save(t1, { customerId: jane.id, cashAmount: '12000', ...reportable, erpInvoiceNo: inv('64') })
    // Another person recorded the sale: the creator is immutable through the app, so it is rewritten without triggers.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`
      await tx`update gold.purchases set created_by_staff_id = ${other} where id = ${r.body.purchaseId}`
    })
    const s = await startTtr(t1, { purchaseId: r.body.purchaseId })
    expect(s.status, s.text).toBe(200)
    const [caller] = await sql`select full_name, email from public.staff_members where id = ${S1}`
    expect(await txRow(s.body.ttrs[0].id)).toMatchObject({
      created_by_staff_id: S1,
      staff_member_name: caller.full_name,
      staff_member_email: caller.email,
    })
    expect((await idvOf(s.body.ttrs[0].id))[0].counter_confirmed_by_staff_id).toBe(other)
  })
})

test.describe('E · atomicity, concurrency, logs', () => {
  test('9.25 ⚠ — another TTR already holds the reference for the scrap scenario: 409 ttr_reference_in_use, and the bullion TTR of the same call is not left behind', async () => {
    const jane = await customer({ first: 'Jane', last: 'Citizen' })
    const number = inv('CLASH')
    const a = await save(t1, { customerId: jane.id, cash10k: 'true', cashAmount: '6000', erpInvoiceNo: number })
    const b = await save(t1, { customerId: jane.id, ...bullion('5k_to_10k', { partAmount: '6000', erpInvoiceNo: number }), ...yes })
    expect([a.status, b.status]).toEqual([201, 201])
    await sql`
      insert into ttr.transactions (reporting_entity_id, created_by_staff_id, scenario, transaction_ref, transaction_datetime,
          designated_service, location_snapshot, staff_member_name, staff_member_email, staff_member_role, cash_currency, cash_amount, aud_value)
      values (${E1}, ${S1}, 'precious_metal_buy', ${number}, now(), 'Purchase of precious metal for physical cash', 'Coburg, VIC',
          'UAT Staff One', 'uat-gold-staff1@example.test', 'staff', 'AUD', 500, 500)`
    const before = await ttrSnap()
    const r = await startTtr(t1, { purchaseId: b.body.purchaseId }) // bullion first, then the clashing scrap
    expect(r.status, r.text).toBe(409)
    expect(r.body).toEqual({ error: 'ttr_reference_in_use' })
    expect(await ttrSnap()).toEqual(before)
    expect(await txByRef(number)).toHaveLength(1) // only the other TTR
    expect([await linkOf(a.body.purchaseId), await linkOf(b.body.purchaseId)]).toEqual([null, null])
  })

  test('9.26 ⚠ — two parts started at once while the invoice lock is held wait, then exactly one TTR exists and both calls return it', async () => {
    const jane = await customer({ first: 'Jane', last: 'Citizen' })
    const number = inv('26')
    const a = await save(t1, { customerId: jane.id, cash10k: 'true', cashAmount: '6000', erpInvoiceNo: number })
    const b = await save(t1, { customerId: jane.id, partAmount: '6000', erpInvoiceNo: number, ...yes })
    let pending
    await withInvoiceLock(E1, number, async () => {
      pending = Promise.all([startTtr(t1, { purchaseId: a.body.purchaseId }), startTtr(t1, { purchaseId: b.body.purchaseId })])
      expect(await settledAfter(pending, 4000), 'a call finished while the invoice lock was held').toBe(false)
    })
    const [ra, rb] = await pending
    expect([ra.status, rb.status], `${ra.text} ${rb.text}`).toEqual([200, 200])
    expect(ra.body.ttrs[0].id).toBe(rb.body.ttrs[0].id)
    expect(new Set([ra.body.ttrs[0].created, rb.body.ttrs[0].created])).toEqual(new Set([true, false]))
    expect(await txByRef(number)).toHaveLength(1)
    expect(await partiesOf(ra.body.ttrs[0].id)).toHaveLength(1)
    expect(await idvOf(ra.body.ttrs[0].id)).toHaveLength(1)
  })

  test('9.26 (race) — two parts started at the same moment give one TTR and no 409', async () => {
    const jane = await customer({ first: 'Jane', last: 'Citizen' })
    const number = inv('26r')
    const a = await save(t1, { customerId: jane.id, cash10k: 'true', cashAmount: '6000', erpInvoiceNo: number })
    const b = await save(t1, { customerId: jane.id, partAmount: '6000', erpInvoiceNo: number, ...yes })
    const [ra, rb] = await Promise.all([startTtr(t1, { purchaseId: a.body.purchaseId }), startTtr(t1, { purchaseId: b.body.purchaseId })])
    expect([ra.status, rb.status], `${ra.text} ${rb.text}`).toEqual([200, 200])
    expect(ra.body.ttrs[0].id).toBe(rb.body.ttrs[0].id)
    expect(await txByRef(number)).toHaveLength(1)
  })

  // docker logs prints the container's stdout and stderr on separate streams, so count lines per stream.
  const DOCKER = 'supabase_edge_runtime_compliance-capture-platform'
  const capture = () => {
    const r = spawnSync('docker', ['logs', '--since', '1800s', DOCKER], { encoding: 'utf8' })
    return { out: r.stdout.split('\n'), err: r.stderr.split('\n') }
  }
  const newSince = (base) => {
    const now = capture()
    return [...now.out.slice(base.out.length), ...now.err.slice(base.err.length)].join('\n')
  }

  test('9.27 — a refusal and a success log only the purchase id and an error code: no name, phone, ID number, invoice or amount', async () => {
    const zelda = await customer({ first: 'Zelda', last: 'Quokka' })
    const [{ document_number: docNumber }] = await sql`select document_number from ttr.id_verifications where id = ${zelda.verId}`
    const number = 'INV-UAT-SECRET-91'
    const small = await save(t1, { customerId: zelda.id, cash10k: 'true', cashAmount: '9876.54', phone: '0498 765 432', erpInvoiceNo: number })
    const big = await save(t1, { customerId: zelda.id, cashAmount: '23456.78', ...reportable, phone: '0498 765 432', erpInvoiceNo: 'INV-UAT-SECRET-92' })
    expect([small.status, big.status]).toEqual([201, 201])
    const baseline = capture()
    const refused = await startTtr(t1, { purchaseId: small.body.purchaseId })
    const started = await startTtr(t1, { purchaseId: big.body.purchaseId })
    expect([refused.status, started.status]).toEqual([422, 200])
    let text = ''
    for (let i = 0; i < 10 && !/start failed/.test(text); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      text = newSince(baseline)
    }
    expect(text).toMatch(new RegExp(`gold-start-ttr: start failed: ${small.body.purchaseId} GD004`))
    for (const secret of ['Zelda', 'Quokka', '0498', '765 432', docNumber, 'INV-UAT-SECRET', '9876', '23456', '23,456']) {
      expect(text, secret).not.toContain(secret)
    }
    // Apart from the runtime's own "serving the request" lines, the only line is the refusal's.
    const own = text.split(/\r?\n/).filter((l) => l.trim() && !/serving the request with supabase\/functions\//.test(l))
    expect(own).toHaveLength(1)
  })
})
