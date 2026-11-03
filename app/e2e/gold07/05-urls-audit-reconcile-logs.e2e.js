// Gold Phase 7 UAT, sections K, L (the function-driven rows), M and N of docs/uat-gold-07-purchase-writes.md:
// signed photo URLs, audit rows written by the functions, the browser's read-only access, the reconcile sweep of
// orphaned goods photos, and what the functions log. Rows 7.116 and 7.137 were added by UAT from spec 4.4 and 6.1.
// Rows 7.120 to 7.123, 7.126 and the table-level checks are pgTAP (supabase/tests/gold07_uat.test.sql).
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { sql } from '../support/db.js'
import { localEnv } from '../support/env.js'
import {
  auditRows,
  complete,
  customer,
  E1,
  goodsObjects,
  inv,
  jpeg,
  NIL,
  photoRows,
  photoUrls,
  reconcile,
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

const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = localEnv()
const reach = (url) => url.replace('http://kong:8000', API_URL)
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const tokenClaims = (url) => JSON.parse(Buffer.from(new URL(reach(url)).searchParams.get('token').split('.')[1], 'base64url').toString())
const DOCKER = (suffix) => `supabase_${suffix}_compliance-capture-platform`

const rest = (method, path, tok, { body, profile = 'gold', write = true } = {}) =>
  fetch(`${API_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${tok}`,
      'Content-Type': 'application/json',
      [write ? 'Content-Profile' : 'Accept-Profile']: profile,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const putGoods = async (path, bytes) => {
  const res = await fetch(`${API_URL}/storage/v1/object/gold-goods/${path}`, {
    method: 'POST',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'image/jpeg' },
    body: bytes,
  })
  if (!res.ok) throw new Error(`upload ${path}: ${res.status} ${await res.text()}`)
}
const ageObject = (path) =>
  sql`update storage.objects set created_at = now() - interval '2 hours' where bucket_id = 'gold-goods' and name = ${path}`
const objectCount = async (bucket) =>
  (await sql`select count(*)::int as n from storage.objects where bucket_id = ${bucket}`)[0].n

test.describe('K · signed photo URLs', () => {
  test('7.110 ⚠ — three photos come back in order, each URL returns the exact file', async () => {
    const ruth = await customer()
    const files = [jpeg(1), jpeg(2, 100), jpeg(3, 100)]
    const p = await saved(t1, { customerId: ruth.id }, files)
    const r = await photoUrls(t1, p)
    expect(r.status, r.text).toBe(200)
    const rows = await photoRows(p)
    expect(r.body.urls.map((u) => u.sortOrder)).toEqual([0, 1, 2])
    expect(r.body.urls.map((u) => u.id)).toHaveLength(3)
    for (const [i, u] of r.body.urls.entries()) {
      const res = await fetch(reach(u.url))
      expect(res.status, `photo ${i}`).toBe(200)
      const bytes = Buffer.from(await res.arrayBuffer())
      expect(bytes.equals(files[i])).toBe(true)
      expect(sha(bytes)).toBe(rows[i].content_hash_sha256)
    }
  })

  test('7.111 ⚠ — the URL lives 300 seconds or less, and an expired URL stops working', async () => {
    const ruth = await customer()
    const p = await saved(t1, { customerId: ruth.id })
    const [u] = (await photoUrls(t1, p)).body.urls
    const claims = tokenClaims(u.url)
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(300)
    expect(claims.exp - claims.iat).toBeGreaterThan(0)
    // Waiting five minutes is not practical here: prove the platform refuses an expired signed URL with a 1-second one.
    const [{ object_path: path }] = await photoRows(p)
    const res = await fetch(`${API_URL}/storage/v1/object/sign/gold-goods/${path}`, {
      method: 'POST',
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 1 }),
    })
    const short = `${API_URL}/storage/v1${(await res.json()).signedURL}`
    expect((await fetch(short)).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 3000))
    expect([400, 403]).toContain((await fetch(short)).status)
  })

  test('7.112 ⚠ — another business\'s purchase and an unknown one are the same 404 with no urls; a malformed id is 400', async () => {
    const ruth = await customer()
    const p = await saved(t1, { customerId: ruth.id })
    const foreign = await photoUrls(await token('t2'), p)
    const unknown = await photoUrls(t1, NIL)
    expect([foreign.status, foreign.body]).toEqual([404, { error: 'purchase_not_found' }])
    expect(unknown.body).toEqual(foreign.body)
    const bad = await photoUrls(t1, 'nope')
    expect([bad.status, bad.body]).toEqual([400, { error: 'bad_request', field: 'purchaseId' }])
  })

  test('7.113 — the bucket is private: no public URL, no direct read or listing as a signed-in staff member', async () => {
    const ruth = await customer()
    const p = await saved(t1, { customerId: ruth.id })
    const path = `${p}/goods-1.jpg`
    const pub = await fetch(`${API_URL}/storage/v1/object/public/gold-goods/${path}`)
    expect([400, 404]).toContain(pub.status)
    const direct = await fetch(`${API_URL}/storage/v1/object/gold-goods/${path}`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${t1}` },
    })
    expect([400, 404]).toContain(direct.status)
    const list = await fetch(`${API_URL}/storage/v1/object/list/gold-goods`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${t1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 10 }),
    })
    const names = list.ok ? (await list.json()).map((o) => o.name) : []
    expect(names).toEqual([])
  })

  test('7.114 — a purchase with no photos returns an empty list', async () => {
    const ruth = await customer()
    const id = randomUUID()
    await sql`
      insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band,
          cash_10k_or_more, phone, id_sighted, created_by_staff_id)
      values (${id}, ${E1}, ${ruth.id}, ${ruth.verId}, 'scrap', 'under_10k', false, '0411 111 111', true, ${S1})`
    const r = await photoUrls(t1, id)
    expect([r.status, r.body]).toEqual([200, { urls: [] }])
  })

  test('7.116 (added by UAT, spec 6.1 "short-lived signed URLs") — signed URLs are for the purchase asked about, not another purchase of the business', async () => {
    const ruth = await customer()
    const a = await saved(t1, { customerId: ruth.id }, [jpeg(1)])
    const b = await saved(t1, { customerId: ruth.id }, [jpeg(7, 50)])
    const ua = (await photoUrls(t1, a)).body.urls
    const ub = (await photoUrls(t1, b)).body.urls
    expect(ua).toHaveLength(1)
    expect(ub).toHaveLength(1)
    expect(ua[0].id).not.toBe(ub[0].id)
    const fa = Buffer.from(await (await fetch(reach(ua[0].url))).arrayBuffer())
    const fb = Buffer.from(await (await fetch(reach(ub[0].url))).arrayBuffer())
    expect(fa.equals(jpeg(1))).toBe(true)
    expect(fb.equals(jpeg(7, 50))).toBe(true)
  })
})

test.describe('L · audit and the browser\'s read-only access', () => {
  test('7.124 ⚠ — a plain save writes no audit row; fills and completions are audited with the session\'s staff member and old → new', async () => {
    const ruth = await customer()
    const number = inv('124')
    const a = await saved(t1, { customerId: ruth.id, erpInvoiceNo: number })
    expect(await auditRows(a)).toHaveLength(0)
    const b = await save(t1, { customerId: ruth.id, partAmount: '10', erpInvoiceNo: number, linkedAmounts: { [a]: '20' } })
    expect(b.status, b.text).toBe(201)
    const c = await saved(t1, { customerId: ruth.id })
    await complete(t1, { purchaseId: c, erpInvoiceNo: inv('124c') })
    expect(await auditRows(b.body.purchaseId)).toHaveLength(0)
    const forA = await auditRows(a)
    const forC = await auditRows(c)
    expect(forA.map((r) => r.source)).toEqual(['save_purchase'])
    expect(forC.map((r) => r.source)).toEqual(['complete_purchase'])
    for (const r of [...forA, ...forC]) {
      expect(r.changed_by).toBe(S1)
      expect(Math.abs(Date.now() - new Date(r.changed_at).getTime())).toBeLessThan(120_000)
      expect(Object.keys(r.changes)).not.toContain('updated_at')
      expect(Object.keys(r.changes)).not.toContain('erp_invoice_norm')
      for (const change of Object.values(r.changes)) expect(Object.keys(change).sort()).toEqual(['new', 'old'])
    }
  })

  test('7.125 ⚠ — the browser session reads gold but cannot write purchases, photos or call the write functions', async () => {
    const ruth = await customer()
    const p = await saved(t1, { customerId: ruth.id })
    const read = await rest('GET', `purchases?id=eq.${p}&select=id`, t1, { profile: 'gold', write: false })
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual([{ id: p }])

    const before = await snap()
    // Complete, valid bodies: if the browser were allowed to write, these would succeed and change something.
    const newId = randomUUID()
    const purchaseRow = {
      id: newId,
      reporting_entity_id: E1,
      customer_id: ruth.id,
      main_id_verification_id: ruth.verId,
      purchase_type: 'scrap',
      cash_band: 'under_10k',
      cash_10k_or_more: false,
      sale_date: '2026-01-01',
      phone: '0412 345 678',
      id_sighted: true,
      id_expired_at_time: false,
      id_outside_window_at_time: false,
      created_by_staff_id: S1,
    }
    const photoRow = {
      purchase_id: p,
      reporting_entity_id: E1,
      object_path: `${p}/goods-9.jpg`,
      content_hash_sha256: 'h',
      byte_size: 1,
      captured_by_staff_id: S1,
      sort_order: 5,
    }
    const attempts = [
      ['POST', 'purchases', purchaseRow],
      ['PATCH', `purchases?id=eq.${p}`, { phone: '0400000000' }],
      ['DELETE', `purchases?id=eq.${p}`, undefined],
      ['POST', 'goods_photos', photoRow],
      [
        'POST',
        'rpc/save_purchase',
        {
          p_entity: E1,
          p_staff: S1,
          p_purchase: purchaseRow,
          p_photos: [{ object_path: `${newId}/goods-1.jpg`, content_hash_sha256: 'h', byte_size: 1 }],
          p_fills: [],
        },
      ],
      [
        'POST',
        'rpc/complete_purchase',
        { p_entity: E1, p_staff: S1, p_purchase_id: p, p_invoice: 'BROWSER-WRITE', p_part_amount: null, p_fills: [] },
      ],
    ]
    for (const [method, path, body] of attempts) {
      const res = await rest(method, path, t1, { body })
      const text = await res.text()
      // Inserts and function calls must be refused outright; an update or delete that row security filters away may
      // answer 2xx with no rows, so those are judged by the unchanged state below.
      if (method === 'POST') expect(res.status >= 400, `${method} ${path} -> ${res.status} ${text}`).toBe(true)
    }
    const after = await row(p)
    expect(after.phone).toBe('0412 345 678')
    expect(after.erp_invoice_no).toBeNull()
    expect(await snap()).toEqual(before)
  })
})

test.describe('M · reconcile-stored-images: orphaned goods photos', () => {
  const orphan = `${randomUUID()}/goods-1.jpg`

  test('7.130 ⚠ — a dry run reports goldGoods and does not call a brand-new object an orphan', async () => {
    await putGoods(orphan, jpeg(1))
    const r = await reconcile({})
    expect(r.status, r.text).toBe(200)
    expect(r.body.mode).toBe('dry-run')
    expect(r.body.goldGoods).toEqual(
      expect.objectContaining({
        objectsInspected: expect.any(Number),
        orphanObjects: expect.objectContaining({ count: expect.any(Number), paths: expect.any(Array) }),
        missingObjects: expect.objectContaining({ count: expect.any(Number), photoIds: expect.any(Array) }),
      }),
    )
    expect(r.body.goldGoods.objectsInspected).toBe(await objectCount('gold-goods'))
    expect(r.body.goldGoods.orphanObjects.paths).not.toContain(orphan)
    expect(await objectCount('gold-goods')).toBeGreaterThan(0)
    expect(await goodsObjects(orphan.split('/')[0])).toEqual([orphan])
  })

  test('7.131 ⚠ — an orphan older than an hour is reported by a dry run and left in place', async () => {
    await ageObject(orphan)
    const r = await reconcile({})
    expect(r.body.goldGoods.orphanObjects).toEqual({ count: 1, paths: [orphan], deleted: 0 })
    expect(await goodsObjects(orphan.split('/')[0])).toEqual([orphan])
  })

  test('7.132 ⚠ — apply removes only the orphan; every object with a photo row, the rows and compliance-media are untouched', async () => {
    const [{ n: rowsBefore }] = await sql`select count(*)::int as n from gold.goods_photos`
    const mediaBefore = await objectCount('compliance-media')
    const r = await reconcile({ apply: true })
    expect(r.body.mode).toBe('apply')
    expect(r.body.goldGoods.orphanObjects.deleted).toBe(1)
    expect(await goodsObjects(orphan.split('/')[0])).toEqual([])
    const [{ n: rowsAfter }] = await sql`select count(*)::int as n from gold.goods_photos`
    expect(rowsAfter).toBe(rowsBefore)
    const [{ n: unbacked }] = await sql`
      select count(*)::int as n from gold.goods_photos g
      where not exists (select 1 from storage.objects o where o.bucket_id = 'gold-goods' and o.name = g.object_path)`
    expect(unbacked).toBe(0)
    expect(await objectCount('compliance-media')).toBe(mediaBefore)
  })

  test('7.133 ⚠ — a photo row whose object is missing is reported, and apply never deletes the row', async () => {
    const ruth = await customer()
    const p = await saved(t1, { customerId: ruth.id }, [jpeg(1), jpeg(2, 100)])
    const rows = await photoRows(p)
    const del = await fetch(`${API_URL}/storage/v1/object/gold-goods/${p}/goods-2.jpg`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    })
    expect(del.ok).toBe(true)
    const [{ id: missingId }] = await sql`select id from gold.goods_photos where purchase_id = ${p} and sort_order = 1`
    const [{ n: rowsBefore }] = await sql`select count(*)::int as n from gold.goods_photos`
    const r = await reconcile({ apply: true })
    expect(r.body.goldGoods.missingObjects.count).toBeGreaterThanOrEqual(1)
    expect(r.body.goldGoods.missingObjects.photoIds).toContain(missingId)
    expect((await photoRows(p)).length).toBe(rows.length)
    const [{ n: rowsAfter }] = await sql`select count(*)::int as n from gold.goods_photos`
    expect(rowsAfter).toBe(rowsBefore)
    expect(await goodsObjects(p)).toEqual([`${p}/goods-1.jpg`])
    // Put the object back so later checks about stray or missing objects stay clean.
    await putGoods(`${p}/goods-2.jpg`, jpeg(2, 100))
  })

  test('7.134 ⚠ — if storage cannot be listed the sweep fails and removes nothing; it works again once storage is back', async () => {
    const stray = `${randomUUID()}/goods-1.jpg`
    await putGoods(stray, jpeg(5))
    await ageObject(stray)
    const stop = spawnSync('docker', ['stop', DOCKER('storage')], { encoding: 'utf8' })
    expect(stop.status, stop.stderr).toBe(0)
    let down
    try {
      down = await reconcile({ apply: true })
    } finally {
      const start = spawnSync('docker', ['start', DOCKER('storage')], { encoding: 'utf8' })
      expect(start.status, start.stderr).toBe(0)
    }
    expect(down.status).not.toBe(200)
    let up
    for (let i = 0; i < 45 && up?.status !== 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      up = await reconcile({})
    }
    expect(up.status, up.text).toBe(200)
    // Nothing was deleted while it was down: the orphan was still there for the next sweep to find.
    expect(up.body.goldGoods.orphanObjects.paths).toContain(stray)
    expect(await goodsObjects(stray.split('/')[0])).toEqual([stray])
    const clean = await reconcile({ apply: true })
    expect(clean.status).toBe(200)
    expect(await goodsObjects(stray.split('/')[0])).toEqual([])
  })

  test('7.135 — only the service-role key may run the sweep; a staff session is 401', async () => {
    const res = await fetch(`${API_URL}/functions/v1/reconcile-stored-images`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${t1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apply: true }),
    })
    expect(res.status).toBe(401)
  })

  test('7.136 — the existing ID-image sections are still in the report', async () => {
    const r = await reconcile({})
    expect(r.status).toBe(200)
    for (const key of ['orphanObjects', 'missingObjects', 'unsupersededCopies', 'danglingFolders']) {
      expect(r.body, key).toHaveProperty(key)
    }
    expect(r.body.orphanObjects.count).toBe(0)
    expect(r.body.unsupersededCopies.count).toBe(0)
    expect(r.body.danglingFolders.count).toBe(0)
  })

  test('7.137 (added by UAT, spec 4.4 "never deletes a row") — apply with nothing wrong deletes no goods photo row and no object', async () => {
    const [{ n: rows }] = await sql`select count(*)::int as n from gold.goods_photos`
    const objects = await objectCount('gold-goods')
    const r = await reconcile({ apply: true })
    expect(r.status).toBe(200)
    expect(r.body.goldGoods.orphanObjects.deleted).toBe(0)
    expect((await sql`select count(*)::int as n from gold.goods_photos`)[0].n).toBe(rows)
    expect(await objectCount('gold-goods')).toBe(objects)
  })
})

test.describe('N · logs', () => {
  const logs = (sinceSeconds) => {
    const r = spawnSync('docker', ['logs', '--since', `${sinceSeconds}s`, DOCKER('edge_runtime')], { encoding: 'utf8' })
    return `${r.stdout}\n${r.stderr}`
  }

  test('7.140 ⚠ — a failed save logs its purchase id and an error code, and none of the customer\'s details', async () => {
    const zelda = await customer({ first: 'Zelda', last: 'Quokka' })
    const started = Date.now()
    await sql`alter table gold.goods_photos add constraint uat_block check (sort_order < 0) not valid`
    let r
    try {
      r = await save(t1, {
        customerId: zelda.id,
        phone: '0498 765 432',
        cash10k: 'true',
        cashAmount: '12345.67',
        erpInvoiceNo: 'INV-UAT-SECRET-77',
        ...{ ttrSelfConducted: 'true', ttrDetailsConfirmed: 'true' },
      })
    } finally {
      await sql`alter table gold.goods_photos drop constraint if exists uat_block`
    }
    expect(r.status, r.text).toBe(500)
    let text = ''
    for (let i = 0; i < 10 && !/save failed/.test(text); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      text = logs(Math.ceil((Date.now() - started) / 1000) + 5)
    }
    expect(text).toMatch(/gold-save-purchase: save failed: [0-9a-f-]{36} \S+/)
    for (const secret of ['Zelda', 'Quokka', '0498', '765 432', 'INV-UAT-SECRET', '12345', '12,345']) {
      expect(text, secret).not.toContain(secret)
    }
  })

  test('7.141 — the three functions write nothing to the log for successful calls', async () => {
    const ruth = await customer()
    const lines = () => logs(1800).split('\n')
    const baseline = lines().length
    const p = await saved(t1, { customerId: ruth.id })
    const c = await complete(t1, { purchaseId: p, erpInvoiceNo: inv('141') })
    const u = await photoUrls(t1, p)
    expect([c.status, u.status]).toEqual([200, 200])
    await new Promise((resolve) => setTimeout(resolve, 2000))
    // Only the lines written since the baseline (the failed save of 7.140 is earlier in the same log).
    const text = lines().slice(baseline).join('\n')
    // The edge runtime itself prints "serving the request with supabase/functions/<name>" for every call; that is not
    // the function logging. Anything else the three functions would print (console.log or console.error) is.
    const own = text.split(/\r?\n/).filter((l) => l.trim() && !/serving the request with supabase\/functions\//.test(l))
    expect(own, 'lines written by the functions on success').toEqual([])
  })
})
