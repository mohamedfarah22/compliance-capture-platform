// Gold Phase 7 UAT, sections A and B of docs/uat-gold-07-purchase-writes.md: who may call the three functions,
// and what a save writes. Every test name starts with its sheet row ID. Rows 7.18, 7.19, 7.84 and 7.85 were added
// by UAT from spec 4.3 / 4.5.
import { createHash, randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
  complete,
  customer,
  E1,
  E2,
  goodsObjects,
  inv,
  jpeg,
  melbourneToday,
  photoRows,
  photoUrls,
  row,
  S1,
  save,
  saved,
  snap,
  token,
  world,
} from './support.js'
import { sql } from '../support/db.js'
import { localEnv } from '../support/env.js'

test.describe.configure({ mode: 'serial' })

let ruth // a customer with a valid ID, ready for a TTR
let purchase // a saved purchase of business One, for the refusal rows that need one

test.beforeAll(async () => {
  await world()
  ruth = await customer()
  purchase = await saved(await token('t1'), { customerId: ruth.id })
})

// Calls every function with the same token. The refusal happens before the purchase is looked up.
const callAll = async (tok) => ({
  save: await save(tok, { customerId: ruth.id }),
  complete: await complete(tok, { purchaseId: purchase, erpInvoiceNo: inv('A') }),
  urls: await photoUrls(tok, purchase),
})

test.describe('A · refusals', () => {
  // 7.1 (gold off) is proved without a stack restart in supabase/functions/_shared/gold07_uat.test.ts.

  test('7.2 ⚠ — no token, and the anon key as a token, are 401 on every function; nothing is written', async () => {
    const before = await snap()
    for (const tok of [undefined, localEnv().ANON_KEY]) {
      const r = await callAll(tok)
      for (const [fn, res] of Object.entries(r)) expect(res.status, `${fn} with ${tok ? 'anon key' : 'no token'}`).toBe(401)
    }
    expect(await snap()).toEqual(before)
  })

  test('7.3 ⚠ — a password-only (aal1) session is 403 mfa_required on every function', async () => {
    const before = await snap()
    const r = await callAll(await token('t1aal1'))
    for (const [fn, res] of Object.entries(r)) {
      expect(res.status, fn).toBe(403)
      expect(res.body, fn).toEqual({ error: 'mfa_required' })
    }
    expect(await snap()).toEqual(before)
  })

  test('7.4 — a deactivated staff member (with MFA) is 403 forbidden on every function', async () => {
    const before = await snap()
    const r = await callAll(await token('t3'))
    for (const [fn, res] of Object.entries(r)) {
      expect(res.status, fn).toBe(403)
      expect(res.body, fn).toEqual({ error: 'forbidden' })
    }
    expect(await snap()).toEqual(before)
  })

  test('7.5 ⚠ — staff of another business saving for a customer of this one gets the same 404 as for an unknown customer', async () => {
    const before = await snap()
    const t2 = await token('t2')
    const foreign = await save(t2, { customerId: ruth.id })
    const unknown = await save(t2, { customerId: randomUUID() })
    expect(foreign.status).toBe(404)
    expect(foreign.body).toEqual({ error: 'customer_not_found' })
    expect(unknown.body).toEqual(foreign.body)
    expect(await snap()).toEqual(before)
  })

  test('7.6 ⚠ — staff of another business cannot complete or get photo URLs for this business\'s purchase (404, unchanged)', async () => {
    const t2 = await token('t2')
    const c = await complete(t2, { purchaseId: purchase, erpInvoiceNo: inv('B') })
    const u = await photoUrls(t2, purchase)
    expect([c.status, c.body]).toEqual([404, { error: 'purchase_not_found' }])
    expect([u.status, u.body]).toEqual([404, { error: 'purchase_not_found' }])
    expect((await row(purchase)).erp_invoice_no).toBeNull()
  })

  test('7.7 — staff of One saving for a customer of Two is 404 customer_not_found; nothing is written', async () => {
    const other = await customer({ entity: E2, first: 'Fiona', last: 'Foreign' })
    const before = await snap()
    const r = await save(await token('t1'), { customerId: other.id })
    expect([r.status, r.body]).toEqual([404, { error: 'customer_not_found' }])
    expect(await snap()).toEqual(before)
  })

  test('7.8 — a plain staff member (role staff) can save, complete and get URLs', async () => {
    const [{ role }] = await sql`select role from public.staff_members where id = ${S1}`
    expect(role).toBe('staff')
    const t1 = await token('t1')
    const p = await saved(t1, { customerId: ruth.id })
    const c = await complete(t1, { purchaseId: p, erpInvoiceNo: inv('C') })
    const u = await photoUrls(t1, p)
    expect([c.status, u.status]).toEqual([200, 200])
    expect(u.body.urls).toHaveLength(1)
  })
})

test.describe('B · saving a purchase, and the photo rule', () => {
  test('7.10 ⚠ — a non-reportable scrap sale is saved with server-set values', async () => {
    const t1 = await token('t1')
    const r = await save(t1, { customerId: ruth.id })
    expect(r.status, r.text).toBe(201)
    expect(r.body).toEqual({ purchaseId: expect.stringMatching(/^[0-9a-f-]{36}$/), ttr: null, warnings: {} })
    const p = await row(r.body.purchaseId)
    expect(p).toMatchObject({
      purchase_type: 'scrap',
      cash_band: 'under_10k',
      cash_10k_or_more: false,
      cash_amount: null,
      erp_invoice_no: null,
      id_sighted: true,
      phone: '0412 345 678',
      created_by_staff_id: S1,
      reporting_entity_id: E1,
      completed_at: null,
      main_id_verification_id: ruth.verId,
      joint_customer_id: null,
      joint_id_verification_id: null,
      sale_date: await melbourneToday(),
    })
  })

  test('7.11 ⚠ — three goods photos: rows, paths, hashes, objects and captured-by', async () => {
    const bytes = [jpeg(1), jpeg(2, 100), jpeg(3, 100)]
    const id = await saved(await token('t1'), { customerId: ruth.id }, bytes)
    const rows = await photoRows(id)
    expect(rows.map((r) => r.sort_order)).toEqual([0, 1, 2])
    expect(rows.map((r) => r.object_path)).toEqual([1, 2, 3].map((n) => `${id}/goods-${n}.jpg`))
    expect(rows.map((r) => r.content_type)).toEqual(Array(3).fill('image/jpeg'))
    expect(rows.map((r) => r.storage_bucket)).toEqual(Array(3).fill('gold-goods'))
    expect(rows.map((r) => r.byte_size)).toEqual(bytes.map((b) => b.length))
    expect(rows.map((r) => r.content_hash_sha256)).toEqual(bytes.map((b) => createHash('sha256').update(b).digest('hex')))
    expect(rows.map((r) => r.captured_by_staff_id)).toEqual(Array(3).fill(S1))
    expect(rows.map((r) => r.reporting_entity_id)).toEqual(Array(3).fill(E1))
    expect(await goodsObjects(id)).toEqual(rows.map((r) => r.object_path))
  })

  test('7.12 ⚠ — no photo is refused on the photos field; nothing is written', async () => {
    const before = await snap()
    const r = await save(await token('t1'), { customerId: ruth.id }, [])
    expect(r.status).toBe(422)
    expect(r.body.error).toBe('validation_failed')
    expect(r.body.errors.photos).toBe('Add at least one photo of the items purchased.')
    expect(await snap()).toEqual(before)
  })

  test('7.13 — a PNG, a text file named .jpg, an over-5-MiB photo and 11 photos are all refused; nothing is stored', async () => {
    const t1 = await token('t1')
    const before = await snap()
    const png = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n'), Buffer.from([0x1a, 0x0a]), Buffer.from('-not-a-jpeg')])
    const r1 = await save(t1, { customerId: ruth.id }, [{ bytes: png, type: 'image/png', name: 'x.png' }])
    expect([r1.status, r1.body]).toEqual([415, { error: 'photo_not_jpeg' }])
    const r2 = await save(t1, { customerId: ruth.id }, [{ bytes: Buffer.from('plain text pretending to be a jpeg') }])
    expect([r2.status, r2.body]).toEqual([415, { error: 'photo_not_jpeg' }])
    const big = jpeg(9, 5_300_000)
    const r3 = await save(t1, { customerId: ruth.id }, [jpeg(1), big])
    expect([r3.status, r3.body]).toEqual([413, { error: 'photo_too_large' }])
    const r4 = await save(t1, { customerId: ruth.id }, Array.from({ length: 11 }, () => jpeg(1)))
    expect([r4.status, r4.body]).toEqual([400, { error: 'bad_request', field: 'photos' }])
    expect(await snap()).toEqual(before)
  })

  test('7.14 ⚠ — the ID-sighted box must be ticked on every purchase (C3), with the right message for one or two sellers', async () => {
    const t1 = await token('t1')
    const before = await snap()
    const single =
      "ID must be sighted today and match the record on file. Doesn't match the record? Update ID first."
    for (const idSighted of [undefined, 'false', 'yes']) {
      const r = await save(t1, { customerId: ruth.id, idSighted })
      expect(r.status, `idSighted=${idSighted}`).toBe(422)
      expect(r.body.errors.idSighted, `idSighted=${idSighted}`).toBe(single)
    }
    const jack = await customer({ first: 'Jack', last: 'Joint' })
    const joint = await save(t1, { customerId: ruth.id, jointCustomerId: jack.id, idSighted: 'false' })
    expect(joint.status).toBe(422)
    expect(joint.body.errors.idSighted).toMatch(/^Both people's IDs must be sighted today and match the records on file\./)
    expect(await snap()).toEqual(before)
  })

  test('7.15 — a phone number is required; 7 digits is too short; punctuation does not count as digits', async () => {
    const t1 = await token('t1')
    const none = await save(t1, { customerId: ruth.id, phone: undefined })
    expect(none.status).toBe(422)
    expect(none.body.errors.phone).toBeTruthy()
    const short = await save(t1, { customerId: ruth.id, phone: '1234567' })
    expect(short.status).toBe(422)
    expect(short.body.errors.phone).toBe('Phone number looks too short.')
    const ok = await save(t1, { customerId: ruth.id, phone: '04 1234 5678' })
    expect(ok.status).toBe(201)
    expect((await row(ok.body.purchaseId)).phone).toBe('04 1234 5678')
  })

  test('7.16 — a cash amount that is not an AUD amount is refused on cashAmount; nothing is written', async () => {
    const before = await snap()
    const r = await save(await token('t1'), { customerId: ruth.id, cash10k: 'true', cashAmount: 'ten grand', erpInvoiceNo: inv('16') })
    expect(r.status).toBe(422)
    expect(r.body.errors.cashAmount).toBe('Enter an amount like 12,500 or 12500.50.')
    expect(await snap()).toEqual(before)
  })

  test('7.17 — a malformed purchase type, customer id or missing scrap cash answer is a 400 naming the field', async () => {
    const t1 = await token('t1')
    const before = await snap()
    const cases = [
      [{ customerId: ruth.id, purchaseType: 'diamonds' }, 'purchaseType'],
      [{ customerId: 'not-a-uuid' }, 'customerId'],
      [{ customerId: ruth.id, cash10k: undefined }, 'cash10k'],
    ]
    for (const [fields, field] of cases) {
      const r = await save(t1, fields)
      expect([r.status, r.body], field).toEqual([400, { error: 'bad_request', field }])
    }
    expect(await snap()).toEqual(before)
  })

  test('7.18 (added by UAT, spec 4.3 cash_amount >= 0 or null) — a negative amount is refused; zero is accepted and stored', async () => {
    const t1 = await token('t1')
    const before = await snap()
    const neg = await save(t1, { customerId: ruth.id, cash10k: 'true', cashAmount: '-500' })
    expect(neg.status).toBe(422)
    expect(neg.body.errors.cashAmount).toBe('Enter an amount like 12,500 or 12500.50.')
    expect(await snap()).toEqual(before)
    const zero = await save(t1, { customerId: ruth.id, cash10k: 'true', cashAmount: '0' })
    expect(zero.status).toBe(201)
    expect(await row(zero.body.purchaseId)).toMatchObject({ cash_amount: 0, cash_10k_or_more: false, cash_band: 'under_10k' })
  })

  test('7.19 (added by UAT, spec 4.3 phone 8+ digits) — exactly 8 digits is accepted; 7 digits and no digits are refused', async () => {
    const t1 = await token('t1')
    const eight = await save(t1, { customerId: ruth.id, phone: '0412 3456' })
    expect(eight.status).toBe(201)
    const seven = await save(t1, { customerId: ruth.id, phone: '0412 345' })
    expect(seven.status).toBe(422)
    expect(seven.body.errors.phone).toBeTruthy()
    const letters = await save(t1, { customerId: ruth.id, phone: 'call me' })
    expect(letters.status).toBe(422)
    expect(letters.body.errors.phone).toBeTruthy()
  })

  test('7.84 (added by UAT, spec 4.5 photos) — 10 photos and a photo of exactly 5 MiB are accepted; 5 MiB + 1 byte is 413', async () => {
    const t1 = await token('t1')
    const ten = await save(t1, { customerId: ruth.id }, Array.from({ length: 10 }, (_, i) => jpeg(i + 1)))
    expect(ten.status, ten.text).toBe(201)
    expect((await photoRows(ten.body.purchaseId)).map((r) => r.sort_order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const cap = 5 * 1024 * 1024
    const exact = await save(t1, { customerId: ruth.id }, [jpeg(1, cap - jpeg(1).length)])
    expect(exact.status, exact.text).toBe(201)
    const over = await save(t1, { customerId: ruth.id }, [jpeg(1, cap - jpeg(1).length + 1)])
    expect([over.status, over.body]).toEqual([413, { error: 'photo_too_large' }])
  })

  test('7.85 (added by UAT, spec 4.3 at least one photo) — an empty file does not count as a photo', async () => {
    const before = await snap()
    const r = await save(await token('t1'), { customerId: ruth.id }, [{ bytes: Buffer.alloc(0) }])
    expect(r.status).toBe(422)
    expect(r.body.errors.photos).toBe('Add at least one photo of the items purchased.')
    expect(await snap()).toEqual(before)
  })
})
