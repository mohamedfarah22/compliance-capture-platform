// Gold Phase 8a UAT, row 8a.35 (second half): the dev-only "Fill with test data" button and its sample data are not in a production build.
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const filesIn = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? filesIn(full) : [full]
  })

test('8a.35 — "Fill with test data" and its sample code are absent from the production build', async () => {
  test.setTimeout(300_000)
  const out = mkdtempSync(path.join(os.tmpdir(), 'ccp-build-'))
  execSync(`npx vite build --outDir ${JSON.stringify(out)} --emptyOutDir`, {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      VITE_SUPABASE_URL: 'https://placeholder.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'placeholder-anon-key',
      VITE_GOLD_JOURNEY_ENABLED: 'true',
    },
  })
  const js = filesIn(out)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
  // The gold screens are in this build ...
  expect(js).toContain('Create customer')
  expect(js).toContain('Find customer')
  // ... and the dev-only button, its sample photo label and sample data are not.
  expect(js).not.toContain('Fill with test data')
  expect(js).not.toContain('TEST - ')
  expect(js).not.toContain('1 Test Street')
})
