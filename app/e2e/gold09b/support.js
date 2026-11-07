// Shared fixtures for the Gold Phase 9b UAT (docs/uat-gold-09b-exports.md). The business, staff and sign-in come from the
// Phase 8a/8b support (business One: staff s1, manager m1, admin a1; business Two: staff s2). This adds a manager of
// business Two (m2) and an inactive manager of business One (i1), the sheet's P1/P2/P3 purchases saved through the real
// gold-save-purchase, calls to gold-export, and a reader for the downloaded zip.
import { inflateRawSync } from 'node:zlib'
import { localEnv } from '../support/env.js'
import { photo } from '../gold06/support.js'
import { jpeg, save } from '../gold07/support.js'
import { ACCOUNTS, E1, E2, jane, login, sql, startTtr, tokenOf, uniq, completeTtr, inv, world, makeImage } from '../gold08b/support.js'

export * from '../gold08b/support.js'
export { photo }

// Two more accounts, added before any world() runs: world() creates them, enrols their TOTP and makes them active.
ACCOUNTS.m2 = { id: 'a8000000-0000-4000-8000-000000000006', email: 'uat9b-manager-two@example.test', name: 'UAT9b Manager Two', role: 'manager', entity: E2 }
ACCOUNTS.i1 = { id: 'a8000000-0000-4000-8000-000000000007', email: 'uat9b-inactive@example.test', name: 'UAT9b Inactive Ian', role: 'manager', entity: E1 }

const env = () => localEnv()
export const fnUrl = (name) => `${env().API_URL}/functions/v1/${name}`

/** The sheet's "Request": POST /functions/v1/gold-export. body is an object, or a string sent as is. token null = no header. */
export const exportReq = async (token, body, { method = 'POST', key } = {}) => {
  const headers = { apikey: key ?? env().ANON_KEY, 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(fnUrl('gold-export'), { method, headers, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined })
  const text = await res.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed, text }
}
export const zipReq = (token, ids, filters = null) => exportReq(token, { kind: 'zip', filters, purchaseIds: ids })
export const recordReq = (token, id, filters = null) => exportReq(token, { kind: 'record', filters, purchaseIds: [id] })

/** A token for the inactive manager: the account is made inactive after world() has enrolled it. */
export const ianToken = async () => {
  await world()
  await sql`update public.staff_members set is_active = false where id = ${ACCOUNTS.i1.id}`
  return (await login('i1')).access_token
}

export const auditRows = (entity) =>
  entity
    ? sql`select * from gold.export_audit_log where reporting_entity_id = ${entity} order by exported_at, id`
    : sql`select * from gold.export_audit_log order by exported_at, id`
export const auditCount = async () => (await sql`select count(*)::int as n from gold.export_audit_log`)[0].n
export const accessLogCount = async () => (await sql`select count(*)::int as n from ttr.access_log`)[0].n

/** Fetches a signed URL. Locally the functions see Docker's http://kong:8000, so the host is rewritten to the API URL. */
export const fetchSigned = (url, init) => fetch(url.replace('http://kong:8000', env().API_URL), init)
export const signedExp = (url) => JSON.parse(Buffer.from(new URL(url).searchParams.get('token').split('.')[1], 'base64url').toString()).exp

// ─── The downloaded zip ──────────────────────────────────────────────────────────────────

/** Reads a zip from its central directory. Returns { name: Buffer }. */
export const unzip = (buf) => {
  let e = buf.length - 22
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--
  if (e < 0) throw new Error('not a zip: no end-of-central-directory record')
  const count = buf.readUInt16LE(e + 10)
  let p = buf.readUInt32LE(e + 16)
  const files = {}
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory')
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + size)
    files[name] = method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
    p += 46 + nameLen + extraLen + commentLen
  }
  return files
}

/** CSV text (without its BOM) to rows of cells. Quoted cells, doubled quotes, CRLF. */
export const parseCsv = (text) => {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"', i++)
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') (row.push(cell), (cell = ''))
    else if (c === '\r' && text[i + 1] === '\n') (row.push(cell), rows.push(row), (row = []), (cell = ''), i++)
    else cell += c
  }
  if (cell !== '' || row.length) (row.push(cell), rows.push(row))
  return rows
}

/** The zip's purchases.csv as { header, rows: [{column: value}], bytes }. */
export const csvOf = (files) => {
  const bytes = files['purchases.csv']
  const rows = parseCsv(bytes.toString('utf8').replace(/^﻿/, ''))
  const header = rows[0]
  return { bytes, header, rows: rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))) }
}

// ─── Fixtures: the sheet's P1, P2, P3 ────────────────────────────────────────────────────

export const goodsJpeg = (n) => jpeg(n)
const YES = { ttrSelfConducted: 'true', ttrDetailsConfirmed: 'true' }

const saveAs = async (label, fields, photos) => {
  const r = await save(await tokenOf(label), fields, photos)
  if (r.status !== 201) throw new Error(`setup save refused: ${r.status} ${r.text}`)
  return r.body.purchaseId
}

/**
 * Jane (driver licence with a front and back photo) and Joan (the joint seller, licence with a front photo only), then:
 *   P1 scrap by Jane, invoice, cash $12,000, 2 goods photos, TTR complete (reference = the invoice)
 *   P2 bullion by Jane and Joan, invoice, 1 goods photo, TTR draft
 *   P3 scrap by Pat (a licence on file, no ID photos), no invoice, no goods photos, no TTR
 * saved as the signed-in account `label`.
 */
export const world9b = async (label, page, { entity = E1 } = {}) => {
  const front = await makeImage(page, { width: 300, height: 200, label: 'JANE-FRONT' })
  const back = await makeImage(page, { width: 300, height: 200, label: 'JANE-BACK' })
  const joanFront = await makeImage(page, { width: 300, height: 200, label: 'JOAN-FRONT' })
  const joanBack = await makeImage(page, { width: 300, height: 200, label: 'JOAN-BACK' })
  const janeNumber = `DL9B${uniq()}`
  const joanNumber = `DJ9B${uniq()}`
  const j = await jane({ entity, id: { front, back, number: janeNumber, expiry: '2031-03-04' } })
  const joan = await jane({ entity, first: 'Joan', id: { front: joanFront, back: joanBack, number: joanNumber, expiry: '2029-06-07' } })
  const n1 = inv('E1')
  const n2 = inv('E2')
  const p1 = await saveAs(label, { customerId: j.id, cash10k: 'true', cashAmount: '12000', erpInvoiceNo: n1, ...YES }, [goodsJpeg(1), goodsJpeg(2)])
  const t1 = await startTtr(await tokenOf(label), { purchaseId: p1 })
  if (t1.status !== 200) throw new Error(`start ttr P1: ${t1.status} ${t1.text}`)
  await completeTtr(t1.body.ttrs[0].id)
  const p2 = await saveAs(
    label,
    { customerId: j.id, jointCustomerId: joan.id, purchaseType: 'bullion', cash10k: undefined, bullionBand: '10k_plus', cashAmount: '12000', erpInvoiceNo: n2, ...YES },
    [goodsJpeg(3)],
  )
  const t2 = await startTtr(await tokenOf(label), { purchaseId: p2 })
  if (t2.status !== 200) throw new Error(`start ttr P2: ${t2.status} ${t2.text}`)
  // gold-save-purchase requires a goods photo, so P3 is saved with one and its row is then removed (triggers off for this delete only).
  // P3's seller (Pat) has a licence on file but no ID photos, so P3 has no photos at all.
  const pat = await jane({ entity, first: 'Pat', last: j.last, id: { number: `DP9B${uniq()}` } })
  const p3 = await saveAs(label, { customerId: pat.id })
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`
    await tx`delete from gold.goods_photos where purchase_id = ${p3}`
  })
  return { jane: j, joan, pat, front, back, joanFront, joanBack, janeNumber, joanNumber, n1, n2, p1, p2, p3, ttr1: t1.body.ttrs[0].id, ttr2: t2.body.ttrs[0].id }
}
