import { execSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// A dedicated port, never reused: a dev server already running on 5173 may be pointed
// at a cloud project through .env.local.
export const BASE_URL = 'http://127.0.0.1:5199'

let cached

// URLs and keys of this project's local Supabase stack, read from `supabase status`.
// Never from app/.env.local: that file has pointed at both cloud projects, including the client's.
export const localEnv = () => {
  if (cached) return cached
  // Run from app/ so npx finds the pinned supabase devDependency; --workdir points the CLI at this repo's supabase/ folder.
  const out = execSync('npx supabase status -o env --workdir ' + JSON.stringify(repoRoot), {
    cwd: path.join(repoRoot, 'app'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const env = Object.fromEntries(
    out.split(/\r?\n/).map((line) => line.match(/^([A-Z_]+)="(.*)"$/)).filter(Boolean).map((m) => [m[1], m[2]]),
  )
  for (const key of ['API_URL', 'DB_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY']) {
    if (!env[key]) throw new Error(`supabase status did not report ${key}. Start the local stack: npx supabase start`)
  }
  for (const key of ['API_URL', 'DB_URL']) {
    const { hostname } = new URL(env[key])
    if (!['127.0.0.1', 'localhost'].includes(hostname)) {
      throw new Error(`Refusing to run UAT against ${env[key]}: the local stack only.`)
    }
  }
  cached = env
  return env
}

// Version prefix of the newest migration file, used to prove the database on the local
// port is this project's, freshly migrated (another project's stack can hold the same port).
export const latestMigrationVersion = () =>
  readdirSync(path.join(repoRoot, 'supabase', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .at(-1)
    .split('_')[0]
