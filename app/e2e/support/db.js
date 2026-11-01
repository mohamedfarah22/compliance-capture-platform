import postgres from 'postgres'
import { localEnv } from './env.js'

// Superuser connection to the local database, for running the matrix's SQL checks as written.
export const sql = postgres(localEnv().DB_URL, { max: 1, idle_timeout: 5, onnotice: () => {} })

// Calls an edge function with the local service-role key. Locally the functions'
// SUPABASE_SERVICE_ROLE_KEY is the legacy JWT (SERVICE_ROLE_KEY), not the sb_secret_ key.
export const invokeFunction = async (name, body = {}) => {
  const { API_URL, SERVICE_ROLE_KEY } = localEnv()
  const res = await fetch(`${API_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // Not JSON; keep the raw text for the assertion message.
  }
  return { status: res.status, body: json ?? text }
}

export const transactionId = async (ref) => (await sql`select id from ttr.transactions where transaction_ref = ${ref}`)[0]?.id

// The calendar day generate-austrac-report files a transaction under: completed_at in AEST (UTC+10).
export const reportDateOf = async (ref) =>
  (
    await sql`select to_char(completed_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD') as d
              from ttr.transactions where transaction_ref = ${ref}`
  )[0].d

// Direct bucket access for F12's drift setup, with the service role.
const storageRequest = async (method, objectPath, body) => {
  const { API_URL, SERVICE_ROLE_KEY } = localEnv()
  const res = await fetch(`${API_URL}/storage/v1/object/compliance-media/${objectPath}`, {
    method,
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'image/jpeg' },
    body,
  })
  if (!res.ok) throw new Error(`${method} ${objectPath} failed: ${res.status} ${await res.text()}`)
}

export const putObject = (objectPath) => storageRequest('POST', objectPath, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
export const deleteObject = (objectPath) => storageRequest('DELETE', objectPath)

export const objectExists = async (objectPath) =>
  (await sql`select count(*)::int as n from storage.objects where bucket_id = 'compliance-media' and name = ${objectPath}`)[0].n === 1
