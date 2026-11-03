// Shared fixtures for the Gold Phase 8a UAT (docs/uat-gold-08a-customer-screens.md): two businesses, staff of every role
// with real aal2 sessions, customers and ID captures seeded through SQL, and a browser context that is already signed in.
//
// Sign-in: the browser session is made through the Auth API (password, then TOTP) and written into the page's
// localStorage, so a test does not wait 30 s for a fresh code. Row 8a.2 signs in through the real login screens.
// Every TOTP secret lives in .auth/gold08a.json, so a restarted Playwright worker reuses it.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AuthClient } from '@supabase/auth-js'
import { Secret, TOTP } from 'otpauth'
import { AUTH_DIR, CONTEXT_OPTIONS } from '../support/auth.js'
import { sql } from '../support/db.js'
import { localEnv } from '../support/env.js'

export { sql }

export const E1 = 'e8000000-0000-4000-8000-000000000001'
export const E2 = 'e8000000-0000-4000-8000-000000000002'
const PASSWORD = 'uat-password-8'
const FILE = path.join(AUTH_DIR, 'gold08a.json')

// label -> account. s1 staff, m1 manager, a1 admin (all business One), s2 staff of business Two,
// ui is only used to sign in through the real screens (8a.2).
export const ACCOUNTS = {
  s1: { id: 'a8000000-0000-4000-8000-000000000001', email: 'uat8a-staff@example.test', name: 'UAT8a Staff', role: 'staff', entity: E1 },
  m1: { id: 'a8000000-0000-4000-8000-000000000002', email: 'uat8a-manager@example.test', name: 'UAT8a Manager', role: 'manager', entity: E1 },
  a1: { id: 'a8000000-0000-4000-8000-000000000003', email: 'uat8a-admin@example.test', name: 'UAT8a Admin', role: 'admin', entity: E1 },
  s2: { id: 'a8000000-0000-4000-8000-000000000004', email: 'uat8a-staff-two@example.test', name: 'UAT8a Staff Two', role: 'staff', entity: E2 },
  ui: { id: 'a8000000-0000-4000-8000-000000000005', email: 'uat8a-login@example.test', name: 'UAT8a Login', role: 'staff', entity: E1 },
}
export const accountOf = (label) => ACCOUNTS[label]

const env = () => localEnv()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readState = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {})
const writeState = (s) => {
  mkdirSync(AUTH_DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(s))
}

// The auth client alone: supabase-js also builds a realtime client, which needs a WebSocket that Node 20 (CI) lacks.
const newClient = () =>
  new AuthClient({ url: `${env().API_URL}/auth/v1`, headers: { apikey: env().ANON_KEY }, persistSession: false, autoRefreshToken: false })

let ready
/** Idempotent: both businesses, every staff account, and (for the accounts that sign in by API) one enrolled TOTP factor. */
export const world = () => {
  ready ??= (async () => {
    const { API_URL, SERVICE_ROLE_KEY } = env()
    await sql`
      insert into public.reporting_entities (id, legal_name, idv_max_reliance_days) values
        (${E1}, 'UAT8a One Pty Ltd', 730), (${E2}, 'UAT8a Two Pty Ltd', 730)
      on conflict (id) do update set idv_max_reliance_days = 730`
    for (const a of Object.values(ACCOUNTS)) {
      const [existing] = await sql`select id from auth.users where id = ${a.id}`
      if (!existing) {
        const res = await fetch(`${API_URL}/auth/v1/admin/users`, {
          method: 'POST',
          headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: a.id, email: a.email, password: PASSWORD, email_confirm: true }),
        })
        if (!res.ok) throw new Error(`create ${a.email}: ${res.status} ${await res.text()}`)
      }
      await sql`
        insert into public.staff_members (id, reporting_entity_id, full_name, email, role, is_active)
        values (${a.id}, ${a.entity}, ${a.name}, ${a.email}, ${a.role}, true)
        on conflict (id) do update set role = ${a.role}, reporting_entity_id = ${a.entity}, is_active = true, full_name = ${a.name}`
    }
    // A factor whose secret this run does not hold (a database reset, or a half-finished run) is deleted and enrolled afresh.
    const state = readState()
    for (const [label, a] of Object.entries(ACCOUNTS)) {
      if (label === 'ui') continue
      const [factor] = await sql`select id from auth.mfa_factors where user_id = ${a.id} and status = 'verified'`
      if (state[a.email] && factor?.id === state[a.email].factorId) continue
      await sql`delete from auth.mfa_factors where user_id = ${a.id}`
      const c = newClient()
      const { error } = await c.signInWithPassword({ email: a.email, password: PASSWORD })
      if (error) throw error
      const { data: f, error: e1 } = await c.mfa.enroll({ factorType: 'totp', friendlyName: randomUUID() })
      if (e1) throw e1
      const { data: ch, error: e2 } = await c.mfa.challenge({ factorId: f.id })
      if (e2) throw e2
      const step = Math.floor(Date.now() / 30_000)
      const code = new TOTP({ secret: Secret.fromBase32(f.totp.secret) }).generate()
      const { error: e3 } = await c.mfa.verify({ factorId: f.id, challengeId: ch.id, code })
      if (e3) throw e3
      state[a.email] = { secret: f.totp.secret, factorId: f.id, lastStep: step }
    }
    writeState(state)
  })()
  return ready
}

/** A fresh session for the account. aal1 = password only; otherwise password then TOTP (aal2). */
export const login = async (label, { aal1 = false } = {}) => {
  await world()
  const a = ACCOUNTS[label]
  const c = newClient()
  const { error } = await c.signInWithPassword({ email: a.email, password: PASSWORD })
  if (error) throw error
  if (!aal1) {
    const state = readState()
    const entry = state[a.email]
    const { data: ch, error: e2 } = await c.mfa.challenge({ factorId: entry.factorId })
    if (e2) throw e2
    let step = Math.floor(Date.now() / 30_000)
    if (step <= entry.lastStep) {
      await sleep((entry.lastStep + 1) * 30_000 - Date.now() + 250)
      step = Math.floor(Date.now() / 30_000)
    }
    writeState({ ...readState(), [a.email]: { ...entry, lastStep: step } })
    const code = new TOTP({ secret: Secret.fromBase32(entry.secret) }).generate()
    const { error: e3 } = await c.mfa.verify({ factorId: entry.factorId, challengeId: ch.id, code })
    if (e3) throw e3
  }
  const { data } = await c.getSession()
  return data.session
}

export const storageKey = () => `sb-${new URL(env().API_URL).hostname.split('.')[0]}-auth-token`

// Locally, edge functions see SUPABASE_URL as Docker's internal http://kong:8000, so signed image URLs point at a host
// the browser cannot reach. Rewrite to the local API (as e2e/support/auth.js does).
const reachSignedUrls = (context) =>
  context.route('http://kong:8000/**', (route) =>
    route.continue({ url: route.request().url().replace('http://kong:8000', env().API_URL) }),
  )

/**
 * A browser context already signed in as `label`, with its page. Use one page per context: the session is written
 * once per tab (a second tab would write the old, already-rotated refresh token).
 */
export const openAs = async (browser, label, { aal1 = false } = {}) => {
  const session = await login(label, { aal1 })
  const context = await browser.newContext({ ...CONTEXT_OPTIONS, viewport: { width: 1280, height: 900 } })
  await reachSignedUrls(context)
  await context.addInitScript(
    ([key, value]) => {
      if (sessionStorage.getItem('uat8a.injected')) return
      sessionStorage.setItem('uat8a.injected', '1')
      localStorage.setItem(key, value)
    },
    [storageKey(), JSON.stringify(session)],
  )
  const page = await context.newPage()
  return { context, page, session }
}

// ─── Images made in the browser ──────────────────────────────────────────────────────────

/** A picture of the given size and type, drawn on a canvas in `page` and returned as a Buffer. */
export const makeImage = async (page, { width, height, type = 'image/jpeg', label = 'UAT' }) => {
  const b64 = await page.evaluate(
    async ([w, h, t, text]) => {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      const g = ctx.createLinearGradient(0, 0, w, h)
      g.addColorStop(0, '#2563eb')
      g.addColorStop(1, '#f59e0b')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#fff'
      ctx.font = `${Math.round(h / 8)}px sans-serif`
      ctx.fillText(`${text} ${w}x${h}`, 20, h / 2)
      const blob = await new Promise((r) => canvas.toBlob(r, t, 0.9))
      const buf = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      return btoa(s)
    },
    [width, height, type, label],
  )
  return Buffer.from(b64, 'base64')
}

/** Width and height of a JPEG from its SOF marker, or null if the bytes are not a JPEG. */
export const jpegSize = (buf) => {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null
    const marker = buf[i + 1]
    const len = buf.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  return null
}

// ─── Seeding through SQL ─────────────────────────────────────────────────────────────────

let seq = 0
export const uniq = () => `${Date.now().toString(36).slice(-4)}${(++seq).toString(36)}`.toUpperCase()

const putObject = async (objectPath, bytes) => {
  const { API_URL, SERVICE_ROLE_KEY } = env()
  const res = await fetch(`${API_URL}/storage/v1/object/compliance-media/${objectPath}`, {
    method: 'POST',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
    body: bytes,
  })
  if (!res.ok) throw new Error(`put ${objectPath}: ${res.status} ${await res.text()}`)
}

const STAFF_OF = { [E1]: ACCOUNTS.s1.id, [E2]: ACCOUNTS.s2.id }

/**
 * One ID capture for a customer (a customer-level new_capture, like the gold functions write).
 *   photos: a Buffer (a real JPEG) stored for the front and, with back, for the back too; null = rows only
 */
export const addCapture = async (
  customerId,
  { entity = E1, type = 'Driver licence', number, expiry = '2031-01-01', hasExpiry = true, capturedDaysAgo = 10, reason = null, prior = null, front = null, back = null } = {},
) => {
  const verId = randomUUID()
  const frontId = randomUUID()
  const backId = back ? randomUUID() : null
  const staffId = STAFF_OF[entity]
  const frontPath = `customers/${customerId}/${verId}/front-uat.jpg`
  const backPath = `customers/${customerId}/${verId}/back-uat.jpg`
  if (front) await putObject(frontPath, front)
  if (back) await putObject(backPath, back)
  await sql`
    insert into ttr.stored_images (id, customer_id, object_path, content_hash_sha256, captured_by_staff_id)
    values (${frontId}, ${customerId}, ${frontPath}, ${`uat-hash-${frontId}`}, ${staffId})`
  if (backId) {
    await sql`
      insert into ttr.stored_images (id, customer_id, object_path, content_hash_sha256, captured_by_staff_id)
      values (${backId}, ${customerId}, ${backPath}, ${`uat-hash-${backId}`}, ${staffId})`
  }
  await sql`
    insert into ttr.id_verifications (id, customer_id, verification_method, document_type, document_number, issuer, id_country_code,
        has_expiry, expiry_date, verification_description, is_complete, front_image_id, back_image_id, created_at, new_capture_reason, prior_verification_id)
    values (${verId}, ${customerId}, 'Sighted original document', ${type}, ${number ?? `UAT8-${uniq()}`}, 'VIC', 'AU',
        ${hasExpiry}, ${hasExpiry ? expiry : null}, 'Sighted in person', true, ${frontId}, ${backId}, now() - make_interval(days => ${capturedDaysAgo}), ${reason}, ${prior})`
  return { verId, frontId, backId }
}

/**
 * A customer of `entity`. id: false = no ID on file, otherwise the options of addCapture.
 * Returns { id, first, last, ver }.
 */
export const seed = async ({
  entity = E1,
  first = 'Sam',
  middle = null,
  last = `Seed${uniq()}`,
  dob = '1985-11-02',
  phone = '0412 345 678',
  type = 'individual',
  aliases = [],
  createdDaysAgo = 0,
  profile = {}, // gender, email, occupation, citizenship, taxResidency
  id: idOptions = {},
} = {}) => {
  const id = randomUUID()
  if (type === 'company') {
    await sql`
      insert into public.customers (id, reporting_entity_id, customer_type, source, entity_name, reg_identifier, first_name, last_name, phone,
          biz_street, biz_suburb, biz_state, biz_postcode)
      values (${id}, ${entity}, 'company', 'ttr', ${last}, '51824753556', ${first}, ${last}, ${phone}, '1 Test St', 'Coburg', 'VIC', '3058')`
    return { id, first, last }
  }
  await sql`
    insert into public.customers (id, reporting_entity_id, customer_type, source, first_name, middle_name, last_name, date_of_birth, phone,
        res_street, res_suburb, res_state, res_postcode, res_country, created_at,
        gender, email, occupation, citizenship_country_code, tax_residency_country_code)
    values (${id}, ${entity}, 'individual', 'gold', ${first}, ${middle}, ${last}, ${dob}, ${phone},
        '1 Test St', 'Coburg', 'VIC', '3058', 'Australia', now() - make_interval(days => ${createdDaysAgo}),
        ${profile.gender ?? null}, ${profile.email ?? null}, ${profile.occupation ?? null}, ${profile.citizenship ?? null}, ${profile.taxResidency ?? null})`
  for (const [i, alias] of aliases.entries()) {
    await sql`insert into public.customer_aliases (customer_id, alias, sort_order) values (${id}, ${alias}, ${i})`
  }
  const ver = idOptions === false ? null : await addCapture(id, { entity, ...idOptions })
  return { id, first, last, ver }
}

// ─── Database checks ─────────────────────────────────────────────────────────────────────

export const customerRow = async (id) => (await sql`select * from public.customers where id = ${id}`)[0]
export const byLastName = (last) => sql`select * from public.customers where last_name = ${last} order by created_at`
export const captures = (customerId) => sql`select * from ttr.id_verifications where customer_id = ${customerId} order by created_at, id`
export const imageRows = (customerId) =>
  sql`select i.*, (select count(*)::int from storage.objects o where o.bucket_id = i.storage_bucket and o.name = i.object_path) as object_exists
      from ttr.stored_images i where i.customer_id = ${customerId} order by i.created_at, i.id`
export const auditRows = (customerId) =>
  sql`select source, changed_by, changed_at, changes from public.customer_audit_log where customer_id = ${customerId} order by changed_at, id`
export const totals = async () =>
  (
    await sql`select (select count(*)::int from public.customers) as customers,
      (select count(*)::int from ttr.stored_images where customer_id is not null) as images,
      (select count(*)::int from ttr.id_verifications where customer_id is not null) as captures,
      (select count(*)::int from storage.objects where bucket_id = 'compliance-media' and name like 'customers/%') as objects,
      (select count(*)::int from public.customer_audit_log) as audit_rows`
  )[0]

/** Downloads a stored object as the service role. */
export const getObject = async (objectPath) => {
  const { API_URL, SERVICE_ROLE_KEY } = env()
  const res = await fetch(`${API_URL}/storage/v1/object/compliance-media/${objectPath}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  })
  if (!res.ok) throw new Error(`get ${objectPath}: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

// ─── Screens ─────────────────────────────────────────────────────────────────────────────

/** Requests the page makes to a Supabase RPC, for counting. */
export const watchRpc = (page, name) => {
  const calls = []
  page.on('request', (req) => {
    if (req.url().includes(`/rest/v1/rpc/${name}`)) calls.push({ at: Date.now(), body: req.postData() })
  })
  return calls
}

/** DD/MM/YYYY, as the DatePicker takes it, from a YYYY-MM-DD date. */
export const dmy = (iso) => iso.split('-').reverse().join('/')

/** YYYY-MM-DD of a date `days` from now in Melbourne. */
export const melbourneDate = (days = 0) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(Date.now() + days * 86400000))
      .map((p) => [p.type, p.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

export const fillPerson = async (page, p) => {
  await page.getByLabel('First name').fill(p.first)
  if (p.middle) await page.getByLabel('Middle name (optional)').fill(p.middle)
  await page.getByLabel('Last name').fill(p.last)
  await page.getByLabel('Date of birth').fill(dmy(p.dob))
  await page.getByLabel('Phone', { exact: true }).fill(p.phone)
  await page.getByLabel('Street address').fill(p.street ?? '12 Test Street')
  await page.getByLabel('Suburb').fill(p.suburb ?? 'Coburg')
  await page.getByLabel('State').selectOption(p.state ?? 'VIC')
  await page.getByLabel('Postcode').fill(p.postcode ?? '3058')
}

export const fillId = async (page, d = {}) => {
  await page.getByLabel('ID type').selectOption(d.type ?? 'Driver licence')
  if (d.other) await page.getByLabel('Describe the document').fill(d.other)
  await page.getByLabel('ID number').fill(d.number)
  await page.getByLabel('Issuer').fill(d.issuer ?? 'VIC')
  if (d.country !== undefined) await page.getByLabel('Country of issue').fill(d.country)
  if (d.hasExpiry !== undefined) {
    await page.getByRole('radiogroup', { name: 'Does the ID have an expiry date?' }).getByRole('radio', { name: d.hasExpiry ? 'Yes' : 'No' }).click()
    if (d.hasExpiry && d.expiry) await page.getByLabel('ID expiry date').fill(dmy(d.expiry))
  }
}

export const upload = (page, label, buffer, { name = 'photo.jpg', mimeType = 'image/jpeg' } = {}) =>
  page.getByLabel(`${label} file`).setInputFiles({ name, mimeType, buffer })

export const sighted = (page) => page.getByRole('checkbox', { name: /I have sighted the original ID in person/ })
