// Gold Phase 6 UAT section H and J rows that need no browser (spec 1.6, 2.2, 6.1): bucket privacy, the lookups the TTR
// wizard uses to see gold's ID store, and where GOLD_JOURNEY_ENABLED is set. Each row is independent.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { localEnv, repoRoot } from '../support/env.js'
import { AAL2, makeCustomer, q4, rpc, sql } from './support.js'

const S1 = () => AAL2('s1')

test('6.132 ⚠ — the compliance-media bucket is private: a stored photo is not served by a public or anon URL', async () => {
  const [{ object_path: objectPath }] = await q4((await makeCustomer()).id)
  const { API_URL, ANON_KEY } = localEnv()
  const publicUrl = await fetch(`${API_URL}/storage/v1/object/public/compliance-media/${objectPath}`)
  expect(publicUrl.status).not.toBe(200)
  const anon = await fetch(`${API_URL}/storage/v1/object/authenticated/compliance-media/${objectPath}`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } })
  expect(anon.status).not.toBe(200)
  expect((await sql`select public from storage.buckets where id = 'compliance-media'`)[0].public).toBe(false)
})

test('6.133 ⚠ — the collision lookup the TTR wizard uses finds a gold-captured licence and names the gold customer', async () => {
  const made = await makeCustomer({ firstName: 'Alice', middleName: 'Q' })
  const res = await rpc('get_verification_for_document', S1(), { p_document_type: 'Driver licence', p_document_number: made.payload.id.documentNumber })
  expect(res.status, res.text).toBe(200)
  expect(res.body).toHaveLength(1)
  expect(res.body[0]).toMatchObject({ customer_id: made.id, owner_name: 'Alice Q Uatsix' })
})

test('6.134 — a licence number nobody holds finds nothing', async () => {
  const res = await rpc('get_verification_for_document', S1(), { p_document_type: 'Driver licence', p_document_number: 'UAT6-DL-8888-NOBODY' })
  expect([res.status, res.body]).toEqual([200, []])
})

test('6.135 — the prior-ID lookup for the same name and date of birth returns the gold-captured ID', async () => {
  const made = await makeCustomer({ firstName: 'Priya', dateOfBirth: '1975-02-03' })
  const res = await rpc('get_prior_verifications_individual', S1(), { p_last_name: 'Uatsix', p_first_name: 'Priya', p_dob: '1975-02-03' })
  expect(res.status, res.text).toBe(200)
  expect(res.body.map((r) => r.document_number)).toContain(made.payload.id.documentNumber)
})

// ─── J: hosted settings that can be read from the repository ──────────────────────────────────

test('6.153 — only supabase/config.toml (local) mentions GOLD_JOURNEY_ENABLED among the config and workflow files', async () => {
  const hits = execSync('git grep -n GOLD_JOURNEY_ENABLED -- supabase/config.toml .github', { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  expect(hits.length).toBeGreaterThan(0)
  for (const line of hits) expect(line.startsWith('supabase/config.toml:'), line).toBe(true)
  expect(readFileSync(path.join(repoRoot, 'supabase', 'config.toml'), 'utf8')).toMatch(/\[edge_runtime\.secrets\][\s\S]*GOLD_JOURNEY_ENABLED = "true"/)
})

