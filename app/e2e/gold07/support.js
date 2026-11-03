// Shared fixtures for the Gold Phase 7 UAT (docs/uat-gold-07-purchase-writes.md): two businesses, staff with real
// aal2 sessions, customers with ID captures on demand, and thin callers for the three purchase functions.
// Everything is created through the Auth admin API and SQL; no screen is involved (Phase 8 builds the screens).
import { randomUUID } from 'node:crypto'
import { AuthClient } from '@supabase/auth-js'
import { Secret, TOTP } from 'otpauth'
import { sql } from '../support/db.js'
import { localEnv } from '../support/env.js'

export const E1 = 'e0000000-0000-4000-8000-000000000001'
export const E2 = 'e0000000-0000-4000-8000-000000000002'
export const S1 = 'a0000000-0000-4000-8000-000000000001' // active staff, business One
export const S2 = 'a0000000-0000-4000-8000-000000000002' // active staff, business Two
export const S3 = 'a0000000-0000-4000-8000-000000000003' // deactivated staff, business One
export const NIL = '00000000-0000-4000-8000-000000000000'

const PASSWORD = 'uat-password-1'
const LOGINS = {
  t1: { id: S1, email: 'uat-gold-staff1@example.test', entity: E1, name: 'UAT Staff One', active: true },
  t2: { id: S2, email: 'uat-gold-staff2@example.test', entity: E2, name: 'UAT Staff Two', active: true },
  t3: { id: S3, email: 'uat-gold-gone@example.test', entity: E1, name: 'UAT Staff Gone', active: false },
}

const env = () => localEnv()
const fnUrl = (name) => `${env().API_URL}/functions/v1/${name}`

const json = async (res) => {
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text), text }
  } catch {
    return { status: res.status, body: text, text }
  }
}

// ─── World: entities, staff, sessions ────────────────────────────────────────────────────

const clients = {}
let ready

const adminCreateUser = async ({ id, email }) => {
  const { API_URL, SERVICE_ROLE_KEY } = env()
  const [existing] = await sql`select id from auth.users where id = ${id}`
  if (existing) return
  const res = await fetch(`${API_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, email, password: PASSWORD, email_confirm: true }),
  })
  if (!res.ok) throw new Error(`create user ${email}: ${res.status} ${await res.text()}`)
}

// The auth client alone: supabase-js also builds a realtime client, which needs a WebSocket that Node 20 (CI) lacks.
const newClient = () => {
  const auth = new AuthClient({
    url: `${env().API_URL}/auth/v1`,
    headers: { apikey: env().ANON_KEY },
    persistSession: false,
    autoRefreshToken: false,
  })
  return { auth }
}

// A password sign-in, then (unless aal1 is wanted) a TOTP enrolment and verification, so the session is aal2.
const login = async (email, { mfa }) => {
  const c = newClient()
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw error
  if (mfa) {
    const { data: f, error: e1 } = await c.auth.mfa.enroll({ factorType: 'totp', friendlyName: randomUUID() })
    if (e1) throw e1
    const { data: ch, error: e2 } = await c.auth.mfa.challenge({ factorId: f.id })
    if (e2) throw e2
    const code = new TOTP({ secret: Secret.fromBase32(f.totp.secret) }).generate()
    const { error: e3 } = await c.auth.mfa.verify({ factorId: f.id, challengeId: ch.id, code })
    if (e3) throw e3
  }
  return c
}

const aalOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).aal

/** Access token for t1 | t2 | t3 (aal2) or t1aal1 (password only). Refreshes itself: locally tokens last 5 minutes. */
export const token = async (name) => {
  const { data, error } = await clients[name].auth.getSession()
  if (error || !data.session) throw new Error(`no session for ${name}: ${error?.message}`)
  const jwt = data.session.access_token
  const want = name === 't1aal1' ? 'aal1' : 'aal2'
  if (aalOf(jwt) !== want) throw new Error(`${name} token is ${aalOf(jwt)}, expected ${want}`)
  return jwt
}

/** Idempotent: seeds both businesses, staff and sessions once per worker. */
export const world = () => {
  ready ??= (async () => {
    await sql`
      insert into public.reporting_entities (id, legal_name, idv_max_reliance_days) values
        (${E1}, 'UAT Gold One Pty Ltd', 730), (${E2}, 'UAT Gold Two Pty Ltd', 730)
      on conflict (id) do update set idv_max_reliance_days = 730`
    for (const l of Object.values(LOGINS)) await adminCreateUser(l)
    for (const l of Object.values(LOGINS)) {
      await sql`
        insert into public.staff_members (id, reporting_entity_id, full_name, email, role, is_active)
        values (${l.id}, ${l.entity}, ${l.name}, ${l.email}, 'staff', ${l.active})
        on conflict (id) do update set is_active = ${l.active}, role = 'staff', reporting_entity_id = ${l.entity}`
    }
    // Playwright restarts the worker after a failed test and this runs again. A user that already has a factor can
    // only enrol another from an aal2 session, and the TOTP secret of the old one is gone with the old worker, so
    // start every login from no factors.
    await sql`delete from auth.mfa_factors where user_id in ${sql(Object.values(LOGINS).map((l) => l.id))}`
    for (const [name, l] of Object.entries(LOGINS)) clients[name] = await login(l.email, { mfa: true })
    clients.t1aal1 = await login(LOGINS.t1.email, { mfa: false })
  })()
  return ready
}

// ─── Customers and their ID captures ─────────────────────────────────────────────────────

let seq = 0
const nextSeq = () => ++seq

/**
 * A customer of `entity` with one ID capture.
 *   ready   every field a TTR needs is on file (case A possible); false = a customer only ever seen in gold
 *   id      'valid' (licence to 2031) | 'expired' (licence expired 2020-01-01) | 'none'
 *   capturedDaysAgo   when the ID was photographed
 *   expiry  'YYYY-MM-DD' overrides the licence expiry
 * Returns { id, verId, first, last }.
 */
export const customer = async ({
  entity = E1,
  first = 'Ruth',
  last = 'Ready',
  ready: isReady = true,
  id: idKind = 'valid',
  capturedDaysAgo = 10,
  expiry,
} = {}) => {
  const id = randomUUID()
  const verId = randomUUID()
  await sql`
    insert into public.customers (id, reporting_entity_id, customer_type, source, first_name, last_name, date_of_birth, phone,
        res_street, res_suburb, res_state, res_postcode, res_country,
        occupation, gender, citizenship_country_code, tax_residency_country_code, is_sole_trader)
    values (${id}, ${entity}, 'individual', 'gold', ${first}, ${last}, '1980-01-01', '0411 111 111',
        '1 Test St', 'Coburg', 'VIC', '3058', 'AU',
        ${isReady ? 'Jeweller' : null}, ${isReady ? 'F' : null}, ${isReady ? 'AU' : null}, ${isReady ? 'AU' : null}, ${isReady ? false : null})`
  if (idKind !== 'none') await addId(id, { verId, idKind, capturedDaysAgo, expiry, documentType: 'Driver licence', reason: null })
  return { id, verId: idKind === 'none' ? null : verId, first, last }
}

/** Another ID capture for a customer; the newest capture is the one purchases use. */
export const addId = async (
  customerId,
  { verId = randomUUID(), idKind = 'valid', capturedDaysAgo = 0, expiry, documentType = 'Passport', reason = 'different_document' } = {},
) => {
  const n = nextSeq()
  const imgId = randomUUID()
  const expiryDate = expiry ?? (idKind === 'expired' ? '2020-01-01' : '2031-01-01')
  await sql`
    insert into ttr.stored_images (id, customer_id, object_path, content_hash_sha256, captured_by_staff_id)
    values (${imgId}, ${customerId}, ${`customers/${customerId}/${verId}/front-uat.jpg`}, ${`uat-hash-${imgId}`}, ${S1})`
  await sql`
    insert into ttr.id_verifications (id, customer_id, verification_method, document_type, document_number, issuer, id_country_code,
        has_expiry, expiry_date, verification_description, is_complete, front_image_id, created_at, new_capture_reason)
    values (${verId}, ${customerId}, 'Sighted original document', ${documentType}, ${`UAT-DOC-${n}-${imgId.slice(0, 6)}`}, 'VIC', 'AU',
        true, ${expiryDate}, 'Sighted in person', true, ${imgId}, now() - make_interval(days => ${capturedDaysAgo}), ${reason})`
  return verId
}

// ─── Calls ───────────────────────────────────────────────────────────────────────────────

/** A tiny file that passes the server's JPEG check (signature FF D8 FF). `n` makes each distinct. */
export const jpeg = (n = 1, extra = 0) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(`UAT-goods-photo-${n}-0123456789`),
    Buffer.alloc(extra, 0x78),
    Buffer.from([0xff, 0xd9]),
  ])

const SAVE_DEFAULTS = { purchaseType: 'scrap', cash10k: 'false', phone: '0412 345 678', idSighted: 'true' }

/**
 * gold-save-purchase. `fields` are the form fields (undefined drops a default). `photos` is a list of Buffers, or
 * { bytes, type, name } objects; default is one tiny JPEG.
 */
export const save = async (tok, fields = {}, photoList = [jpeg(1)]) => {
  const form = new FormData()
  for (const [k, v] of Object.entries({ ...SAVE_DEFAULTS, ...fields })) {
    if (v !== undefined && v !== null) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  }
  for (const p of photoList) {
    const { bytes, type = 'image/jpeg', name = 'goods.jpg' } = Buffer.isBuffer(p) ? { bytes: p } : p
    form.append('photos', new Blob([bytes], { type }), name)
  }
  const headers = { apikey: env().ANON_KEY }
  if (tok) headers.Authorization = `Bearer ${tok}`
  return json(await fetch(fnUrl('gold-save-purchase'), { method: 'POST', headers, body: form }))
}

const postJson = async (name, tok, body, { raw = false, key } = {}) => {
  const headers = { apikey: key ?? env().ANON_KEY, 'Content-Type': 'application/json' }
  if (tok) headers.Authorization = `Bearer ${tok}`
  return json(await fetch(fnUrl(name), { method: 'POST', headers, body: raw ? body : JSON.stringify(body) }))
}

/** gold-complete-purchase */
export const complete = (tok, body, opts) => postJson('gold-complete-purchase', tok, body, opts)
/** get-gold-photo-urls */
export const photoUrls = (tok, purchaseId) => postJson('get-gold-photo-urls', tok, { purchaseId })
/** reconcile-stored-images with the service-role key (the only caller it accepts) */
export const reconcile = (body = {}) =>
  postJson('reconcile-stored-images', env().SERVICE_ROLE_KEY, body, { key: env().SERVICE_ROLE_KEY })

// ─── Database checks ─────────────────────────────────────────────────────────────────────

let invoiceSeq = 0
const RUN = randomUUID().slice(0, 6).toUpperCase()
/** A fresh ERP invoice number, unique across the run (duplicate rules look at every purchase of the business). */
export const inv = (tag = 'X') => `INV-G7-${RUN}-${tag}-${++invoiceSeq}`

/** The purchase row as JSON (numbers as numbers, dates and timestamps as text), or undefined. */
export const row = async (id) => (await sql`select to_jsonb(p) as j from gold.purchases p where id = ${id}`)[0]?.j

export const photoRows = (purchaseId) =>
  sql`select sort_order, object_path, content_type, storage_bucket, byte_size, content_hash_sha256, captured_by_staff_id, reporting_entity_id
      from gold.goods_photos where purchase_id = ${purchaseId} order by sort_order`

export const auditRows = (purchaseId) =>
  sql`select source, changed_by, changed_at, changes from gold.purchase_audit_log where purchase_id = ${purchaseId} order by changed_at, id`

export const goodsObjects = async (prefix) =>
  (await sql`select name from storage.objects where bucket_id = 'gold-goods' and name like ${`${prefix}/%`} order by name`).map((r) => r.name)

/** Counts that must not move when a call is refused ("nothing written"). */
export const snap = async () => {
  const [r] = await sql`
    select (select count(*) from gold.purchases)::int as purchases,
           (select count(*) from gold.goods_photos)::int as photos,
           (select count(*) from storage.objects where bucket_id = 'gold-goods')::int as objects,
           (select count(*) from gold.purchase_audit_log)::int as audit`
  return { ...r }
}

/** Melbourne's calendar date today, from the database. */
export const melbourneToday = async () =>
  (await sql`select ((now() at time zone 'Australia/Melbourne')::date)::text as d`)[0].d

/** A purchase saved through the real function; throws if it was refused. */
export const saved = async (tok, fields, photoList) => {
  const r = await save(tok, fields, photoList)
  if (r.status !== 201) throw new Error(`setup save refused: ${r.status} ${r.text}`)
  return r.body.purchaseId
}
