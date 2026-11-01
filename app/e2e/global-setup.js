import { rmSync } from 'node:fs'
import { ACCOUNTS, AUTH_DIR, ENTITY_ID } from './support/auth.js'
import { sql } from './support/db.js'
import { latestMigrationVersion, localEnv } from './support/env.js'

const serviceRequest = async (path, body) => {
  const { API_URL, SERVICE_ROLE_KEY } = localEnv()
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

const createAuthUser = async ({ email, password }) =>
  (await serviceRequest('/auth/v1/admin/users', { email, password, email_confirm: true })).id

const createPrivateBucket = (id) => serviceRequest('/storage/v1/bucket', { id, name: id, public: false })

export default async () => {
  // Another local project's stack can hold the same port, so prove this is our database.
  const [{ version }] = await sql`select max(version) as version from supabase_migrations.schema_migrations`
  if (version !== latestMigrationVersion()) {
    throw new Error(
      `The database at ${localEnv().DB_URL} is not this project's freshly migrated database ` +
        `(latest migration ${version}, expected ${latestMigrationVersion()}). Run: npx supabase db reset`,
    )
  }

  // The cloud bucket was created by hand (go-live check), so no migration makes it locally.
  const [bucket] = await sql`select id from storage.buckets where id = 'compliance-media'`
  if (!bucket) await createPrivateBucket('compliance-media')

  // signup is disabled (config.toml) and there is no seed file, so create the entity and staff here.
  await sql`
    insert into public.reporting_entities
      (id, legal_name, trading_name, abn, austrac_account_number,
       address_street, address_suburb, address_state, address_postcode, address_country)
    values
      (${ENTITY_ID}, 'UAT Bullion Pty Ltd', 'UAT Bullion', '51824753556', '123456789',
       '1 Test St', 'Coburg', 'VIC', '3058', 'Australia')
    on conflict (id) do nothing`

  let created = false
  for (const account of Object.values(ACCOUNTS)) {
    const [existing] = await sql`select id from auth.users where email = ${account.email}`
    const id = existing?.id ?? (await createAuthUser(account))
    created ||= !existing
    await sql`
      insert into public.staff_members (id, reporting_entity_id, full_name, email, role)
      values (${id}, ${ENTITY_ID}, ${account.fullName}, ${account.email}, ${account.role})
      on conflict (id) do nothing`
  }

  // New accounts have no MFA factor, so saved secrets and sessions belong to deleted users.
  if (created) rmSync(AUTH_DIR, { recursive: true, force: true })

  await sql.end()
}
