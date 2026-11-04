// Shared fixtures for the Gold Phase 9a UAT (docs/uat-gold-09a-ttr-handoff.md). The business, staff, customers and
// the gold-save-purchase / gold-complete-purchase callers come from the Phase 7 support; this adds gold-start-ttr
// and the reads the TTR hand-off rows look at.
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { sql } from '../support/db.js'
import { localEnv } from '../support/env.js'
import { customer, E1, S1, save } from '../gold07/support.js'

export * from '../gold07/support.js'

const fnUrl = (name) => `${localEnv().API_URL}/functions/v1/${name}`

export const yes = { ttrSelfConducted: 'true', ttrDetailsConfirmed: 'true' }
export const reportable = { cash10k: 'true', ...yes }
export const bullion = (band, extra = {}) => ({ purchaseType: 'bullion', cash10k: undefined, bullionBand: band, ...extra })

const read = async (res) => {
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text), text }
  } catch {
    return { status: res.status, body: text, text }
  }
}

/** gold-start-ttr. `body` is sent as JSON (or as the raw string when `raw`). `key` overrides the apikey. */
export const startTtr = async (tok, body, { raw = false, key } = {}) => {
  const headers = { apikey: key ?? localEnv().ANON_KEY, 'Content-Type': 'application/json' }
  if (tok) headers.Authorization = `Bearer ${tok}`
  return read(await fetch(fnUrl('gold-start-ttr'), { method: 'POST', headers, body: raw ? body : JSON.stringify(body) }))
}

/** Any other function, JSON in, with a user token. */
export const callFunction = async (name, tok, body) =>
  read(
    await fetch(fnUrl(name), {
      method: 'POST',
      headers: { apikey: localEnv().ANON_KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

/** The function with the service-role key (cleanup-stale-drafts accepts nothing else). */
export const callAsService = async (name, body = {}) => {
  const { SERVICE_ROLE_KEY } = localEnv()
  return read(
    await fetch(fnUrl(name), {
      method: 'POST',
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

/** Counts that must not move when a call is refused ("nothing written") on the TTR side. */
export const ttrSnap = async () => {
  const [r] = await sql`
    select (select count(*) from ttr.transactions)::int as transactions,
           (select count(*) from ttr.parties)::int as parties,
           (select count(*) from ttr.id_verifications)::int as verifications,
           (select count(*) from ttr.stored_images)::int as images,
           (select count(*) from storage.objects)::int as objects,
           (select count(*) from gold.purchases where ttr_transaction_id is not null)::int as links,
           (select count(*) from gold.purchase_audit_log)::int as audit`
  return { ...r }
}

export const txRow = async (id) => (await sql`select to_jsonb(t) as j from ttr.transactions t where id = ${id}`)[0]?.j
export const txByRef = (ref, scenario) =>
  scenario
    ? sql`select * from ttr.transactions where transaction_ref = ${ref} and scenario = ${scenario}`
    : sql`select * from ttr.transactions where transaction_ref = ${ref} order by scenario`
export const partiesOf = (txId) => sql`select * from ttr.parties where transaction_id = ${txId} order by created_at, id`
export const idvOf = (txId) => sql`select * from ttr.id_verifications where transaction_id = ${txId} order by created_at, id`
export const linkOf = async (purchaseId) =>
  (await sql`select ttr_transaction_id as id from gold.purchases where id = ${purchaseId}`)[0].id

/** A ready customer plus a reportable $12,000 scrap purchase with the invoice, both counter answers Yes. */
export const reportableScrap = async (tok, number, { entity = E1, amount = '12000', who, extra = {} } = {}) => {
  const c = who ?? (await customer({ entity }))
  const r = await save(tok, { customerId: c.id, cashAmount: amount, ...reportable, erpInvoiceNo: number, ...extra })
  if (r.status !== 201) throw new Error(`setup save refused: ${r.status} ${r.text}`)
  return { c, purchaseId: r.body.purchaseId, ttrCase: r.body.ttr }
}

/** Holds the invoice lock in a second connection while `during` runs, then commits (the 7.58 pattern). */
export const withInvoiceLock = async (entity, number, during) => {
  const second = postgres(localEnv().DB_URL, { max: 1, idle_timeout: 5, onnotice: () => {} })
  try {
    await second.begin(async (tx) => {
      await tx`select gold._lock_invoice(${entity}, ${number})`
      await during()
    })
  } finally {
    await second.end()
  }
}

export const settledAfter = async (promise, ms) => {
  let done = false
  promise.then(() => (done = true))
  await new Promise((resolve) => setTimeout(resolve, ms))
  return done
}

export { randomUUID, S1 }
