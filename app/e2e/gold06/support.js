// Shared helpers for the Gold Phase 6 UAT (docs/uat-gold-06-customer-writes.md): staff accounts with
// real aal1 / aal2 tokens, raw calls to the three gold customer functions, payload builders and the
// sheet's SQL checks (Q1 to Q6). Everything goes through the public boundary with real JWTs.
import { execSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Secret, TOTP } from 'otpauth'
import { AUTH_DIR, ENTITY_ID } from '../support/auth.js'
import { sql } from '../support/db.js'
import { localEnv, repoRoot } from '../support/env.js'

export { sql, ENTITY_ID }
export const ENTITY_TWO = '00000000-0000-4000-8000-0000000000e2'

const FIXTURE_FILE = path.join(AUTH_DIR, 'gold06.json')
const PASSWORD = 'uat-password-6'

// label -> [role, entity, active]. S1 staff, M1 manager, A1 admin, I1 inactive staff, X1 manager of Entity Two.
// IM / IA are inactive manager / admin (added by UAT): they isolate the is_active check on the manager-only function.
const ACCOUNTS = {
  s1: ['staff', ENTITY_ID, true],
  m1: ['manager', ENTITY_ID, true],
  a1: ['admin', ENTITY_ID, true],
  i1: ['staff', ENTITY_ID, false],
  im: ['manager', ENTITY_ID, false],
  ia: ['admin', ENTITY_ID, false],
  x1: ['manager', ENTITY_TWO, true],
}

// ─── Accounts and tokens ──────────────────────────────────────────────────────────────────────

const authRequest = async (route, body, { token, key } = {}) => {
  const { API_URL, ANON_KEY } = localEnv()
  const res = await fetch(`${API_URL}/auth/v1${route}`, {
    method: 'POST',
    headers: { apikey: key ?? ANON_KEY, Authorization: `Bearer ${token ?? key ?? ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${route} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

// Creates the five (plus three) staff accounts, enrols a TOTP factor for each and keeps both the
// password-only token (aal1) and the second-factor token (aal2). Inactive accounts are switched off
// after their tokens exist, like the sheet's I1.
export const createFixtures = async () => {
  const { SERVICE_ROLE_KEY } = localEnv()
  await sql`insert into public.reporting_entities (id, legal_name, trading_name, abn, austrac_account_number,
              address_street, address_suburb, address_state, address_postcode, address_country)
            values (${ENTITY_TWO}, 'UAT Entity Two Pty Ltd', 'UAT Two', '51824753556', '123456780',
              '2 Test St', 'Coburg', 'VIC', '3058', 'Australia') on conflict (id) do nothing`
  const out = { entityOne: ENTITY_ID, entityTwo: ENTITY_TWO, startedAt: new Date().toISOString(), staff: {} }
  for (const [label, [role, entity, active]] of Object.entries(ACCOUNTS)) {
    const email = `uat6-${label}@example.test`
    const user = await authRequest('/admin/users', { email, password: PASSWORD, email_confirm: true }, { key: SERVICE_ROLE_KEY })
    await sql`insert into public.staff_members (id, reporting_entity_id, full_name, email, role)
              values (${user.id}, ${entity}, ${'UAT6 ' + label}, ${email}, ${role})`
    const aal1 = (await authRequest('/token?grant_type=password', { email, password: PASSWORD })).access_token
    const factor = await authRequest('/factors', { factor_type: 'totp', friendly_name: 'uat6' }, { token: aal1 })
    const challenge = await authRequest(`/factors/${factor.id}/challenge`, {}, { token: aal1 })
    const code = new TOTP({ secret: Secret.fromBase32(factor.totp.secret) }).generate()
    const verified = await authRequest(`/factors/${factor.id}/verify`, { challenge_id: challenge.id, code }, { token: aal1 })
    if (!active) await sql`update public.staff_members set is_active = false where id = ${user.id}`
    out.staff[label] = { id: user.id, email, aal1, aal2: verified.access_token }
  }
  mkdirSync(AUTH_DIR, { recursive: true })
  writeFileSync(FIXTURE_FILE, JSON.stringify(out))
  return out
}

let cached
export const fixtures = () => {
  if (!cached) {
    if (!existsSync(FIXTURE_FILE)) throw new Error('Run 00-setup.e2e.js first (it creates the staff accounts).')
    cached = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8'))
  }
  return cached
}
export const staff = (label) => fixtures().staff[label]
export const AAL2 = (label) => staff(label).aal2
export const AAL1 = (label) => staff(label).aal1

// ─── Calls ────────────────────────────────────────────────────────────────────────────────────

const parse = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const send = async (url, init) => {
  const res = await fetch(url, init)
  const text = await res.text()
  return { status: res.status, body: parse(text), text, headers: res.headers }
}

const headersFor = (token) => {
  const { ANON_KEY } = localEnv()
  return { apikey: ANON_KEY, ...(token === null ? {} : { Authorization: `Bearer ${token ?? ANON_KEY}` }) }
}

/** Runs fn once, on first use, and gives every caller the same result (a shared fixture for independent rows). */
export const memo = (fn) => {
  let promise
  return () => (promise ??= fn())
}

/** A JPEG-looking file. Different seeds give different bytes (so different SHA-256). */
export const photo = (seed, size = 2048, type = 'image/jpeg') => {
  const bytes = Buffer.alloc(size, 0)
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(bytes)
  createHash('sha256').update(String(seed)).digest().copy(bytes, 8)
  bytes[size - 2] = 0xff
  bytes[size - 1] = 0xd9
  return { bytes, type, size, sha: createHash('sha256').update(bytes).digest('hex') }
}

const blob = (p, name) => [new Blob([p.bytes], { type: p.type }), name]

/** multipart: payload (object or raw string) plus optional front/back photos. */
export const multipartForm = (payload, { front, back } = {}) => {
  const form = new FormData()
  form.set('payload', typeof payload === 'string' ? payload : JSON.stringify(payload))
  if (front) form.set('front', ...blob(front, 'front.jpg'))
  if (back) form.set('back', ...blob(back, 'back.jpg'))
  return form
}

const FN = (name) => `${localEnv().API_URL}/functions/v1/${name}`

/** POST multipart to gold-create-customer / gold-update-customer-id. token null = no Authorization header. */
export const postMultipart = (name, token, payload, photos) =>
  send(FN(name), { method: 'POST', headers: headersFor(token), body: multipartForm(payload, photos) })

export const create = (token, payload, photos) => postMultipart('gold-create-customer', token, payload, photos)
export const updateId = (token, payload, photos) => postMultipart('gold-update-customer-id', token, payload, photos)

/** gold-update-customer takes JSON. */
export const edit = (token, body) =>
  send(FN('gold-update-customer'), {
    method: 'POST',
    headers: { ...headersFor(token), 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

/** Any method/headers/body against a function, for the request-shape rows. */
export const raw = (name, init) => send(FN(name), init)

/** PostgREST. schema sets Content-Profile / Accept-Profile. */
export const rest = (method, route, token, { body, schema, prefer } = {}) => {
  const { API_URL } = localEnv()
  return send(`${API_URL}/rest/v1${route}`, {
    method,
    headers: {
      ...headersFor(token),
      'Content-Type': 'application/json',
      ...(schema ? { 'Content-Profile': schema, 'Accept-Profile': schema } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export const rpc = (name, token, args) => rest('POST', `/rpc/${name}`, token, { body: args })
export const phoneRpc = (token, customerId, phone) => rpc('update_customer_phone', token, { p_customer_id: customerId, p_phone: phone })

// ─── Payload builders ─────────────────────────────────────────────────────────────────────────

export const tag = () => randomBytes(4).toString('hex')
const digits = (n) => Array.from(randomBytes(n), (b) => b % 10).join('')
export const randPhone = () => `04${digits(8)}`
export const randDob = () => {
  const d = new Date(Date.UTC(1950, 0, 1) + (randomBytes(2).readUInt16BE() % 18000) * 86400000)
  return d.toISOString().slice(0, 10)
}

/** Sets a dotted path on a copy; a value of undefined removes the key. mod(B, {'id.hasExpiry': false, phone: undefined}) */
export const mod = (base, changes) => {
  const out = structuredClone(base)
  for (const [dotted, value] of Object.entries(changes)) {
    const keys = dotted.split('.')
    let o = out
    for (const k of keys.slice(0, -1)) o = o[k] ??= {}
    if (value === undefined) delete o[keys.at(-1)]
    else o[keys.at(-1)] = value
  }
  return out
}

/** The sheet's B1 (Alice), made unique so a payload never trips a duplicate by accident. */
export const newCustomer = (changes = {}) => {
  const t = tag()
  return mod(
    {
      firstName: `Al${t}`,
      middleName: 'Q',
      lastName: 'Uatsix',
      dateOfBirth: randDob(),
      phone: randPhone(),
      email: `${t}@example.test`,
      aliases: ['Ally Uatsix', 'A. Uatsix'],
      residentialAddress: { street: '10 Test Street', suburb: 'Coburg', state: 'VIC', postcode: '3058' },
      id: { documentType: 'Driver licence', documentNumber: `UAT6-DL-${t}`, issuer: 'VIC', idCountryCode: 'AU', hasExpiry: true, expiryDate: '2030-06-30' },
    },
    changes,
  )
}

export const FRONT = () => photo('front')
export const BACK = () => photo('back')
export const BOTH = () => ({ front: FRONT(), back: BACK() })

/** Creates a customer as S1 (or the given token) and returns { body, payload, id }. */
export const makeCustomer = async (changes = {}, { token = AAL2('s1'), photos = BOTH() } = {}) => {
  const payload = newCustomer(changes)
  const res = await create(token, payload, photos)
  if (res.status !== 201) throw new Error(`makeCustomer failed: ${res.status} ${res.text}`)
  return { res, payload, id: res.body.customerId, verificationId: res.body.verificationId }
}

/** The update-ID payload for a customer (the sheet's U1), top level document fields. */
export const idPayload = (customerId, changes = {}) =>
  mod(
    { customerId, reason: 'renewed', documentType: 'Driver licence', documentNumber: 'X', issuer: 'VIC', idCountryCode: 'AU', hasExpiry: true, expiryDate: '2035-06-30' },
    changes,
  )

/** Today's date in Melbourne, as the server's businessDate(). */
export const melbourneToday = (offsetDays = 0) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(Date.now() + offsetDays * 86400000))
      .map((p) => [p.type, p.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

// ─── The sheet's SQL checks ───────────────────────────────────────────────────────────────────

export const q1 = async (id) => (await sql`select * from public.customers where id = ${id}`)[0]
export const q2 = (id) => sql`select alias, sort_order from public.customer_aliases where customer_id = ${id} order by sort_order`
export const q3 = (id) => sql`select * from ttr.id_verifications where customer_id = ${id} order by created_at, id`
export const q4 = (id) => sql`
  select i.id, i.object_path, i.content_hash_sha256, i.byte_size, i.captured_by_staff_id, i.superseded_at,
         i.superseded_by_image_id, i.created_at,
         (select count(*)::int from storage.objects o where o.bucket_id = i.storage_bucket and o.name = i.object_path) as object_exists
  from ttr.stored_images i where i.customer_id = ${id} order by i.created_at, i.id`
export const q5 = (id) => sql`select source, changed_by, changed_at, changes from public.customer_audit_log where customer_id = ${id} order by changed_at, id`

/** Q6: the four totals that must not move on a refused call (plus ID rows and every customer). */
export const totals = async () =>
  (
    await sql`select
      (select count(*)::int from public.customers) as customers,
      (select count(*)::int from public.customer_aliases) as aliases,
      (select count(*)::int from ttr.stored_images where customer_id is not null) as images,
      (select count(*)::int from ttr.id_verifications where customer_id is not null) as captures,
      (select count(*)::int from storage.objects where bucket_id = 'compliance-media' and name like 'customers/%') as objects,
      (select count(*)::int from public.customer_audit_log) as audit_rows`
  )[0]

/** md5 of the ID rows of a customer (the sheet's <erin-id-hash>). */
export const idHash = async (id) =>
  (await sql`select md5(coalesce(string_agg(to_jsonb(v)::text, '|' order by id), '')) as h from ttr.id_verifications v where customer_id = ${id}`)[0].h

// ─── Edge runtime logs ────────────────────────────────────────────────────────────────────────

export const edgeLogs = (sinceIso) => {
  const config = readFileSync(path.join(repoRoot, 'supabase', 'config.toml'), 'utf8')
  const projectId = config.match(/^project_id\s*=\s*"([^"]+)"/m)[1]
  // docker writes the container's stdout and stderr to the matching streams; merge them.
  return execSync(`docker logs --since ${sinceIso} supabase_edge_runtime_${projectId} 2>&1`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}
