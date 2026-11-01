import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { BASE_URL, localEnv } from './env.js'

export const AUTH_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.auth')
const TOTP_FILE = path.join(AUTH_DIR, 'totp.json')

// Options every test context needs. browser.newContext() does not inherit the config's `use`.
export const CONTEXT_OPTIONS = { baseURL: BASE_URL, permissions: ['camera'] }

export const ENTITY_ID = '00000000-0000-4000-8000-0000000000e1'

// The two staff accounts Part 0 asks for: one admin, one plain staff.
export const ACCOUNTS = {
  admin: { email: 'uat-admin@example.test', password: 'uat-password-1', fullName: 'UAT Admin', role: 'admin' },
  staff: { email: 'uat-staff@example.test', password: 'uat-password-1', fullName: 'UAT Staff', role: 'staff' },
}

const readTotpState = () => (existsSync(TOTP_FILE) ? JSON.parse(readFileSync(TOTP_FILE, 'utf8')) : {})

const writeTotpState = (state) => {
  mkdirSync(AUTH_DIR, { recursive: true })
  writeFileSync(TOTP_FILE, JSON.stringify(state, null, 2))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A fresh code for the account's enrolled secret. Waits for the next 30-second window
// rather than reuse a code, so a replay-protected verifier never sees the same one twice.
export const totpCode = async (account) => {
  const state = readTotpState()
  const entry = state[account.email]
  if (!entry) throw new Error(`No TOTP secret saved for ${account.email}. Reset the database and rerun.`)
  let step = Math.floor(Date.now() / 30_000)
  if (step <= (entry.lastStep ?? -1)) {
    await sleep((entry.lastStep + 1) * 30_000 - Date.now() + 250)
    step = Math.floor(Date.now() / 30_000)
  }
  writeTotpState({ ...state, [account.email]: { ...entry, lastStep: step } })
  return new TOTP({ secret: Secret.fromBase32(entry.secret) }).generate({ timestamp: Date.now() })
}

export const signIn = async (page, account, { redirect } = {}) => {
  await page.goto(redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : '/login')
  await page.getByLabel('Email address').fill(account.email)
  await page.getByLabel('Password').fill(account.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/mfa/)
}

// Completes the second factor, enrolling first if the account has never enrolled.
// Returns 'enroll' or 'challenge' so callers can assert which screen they got.
export const completeMfa = async (page, account) => {
  // The heading defaults to the challenge wording while factors load, so wait for the
  // code field, which only renders once the page knows which mode it is in.
  await expect(page.getByLabel('6-digit code')).toBeVisible()
  const heading = await page.getByRole('heading', { level: 1 }).textContent()
  const mode = heading.startsWith('Set up') ? 'enroll' : 'challenge'
  if (mode === 'enroll') {
    const secret = (await page.getByText(/Enter this code manually/).locator('strong').textContent()).trim()
    writeTotpState({ ...readTotpState(), [account.email]: { secret, lastStep: -1 } })
  }
  await page.getByLabel('6-digit code').fill(await totpCode(account))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page).not.toHaveURL(/\/mfa/)
  return mode
}

// Locally, edge functions see SUPABASE_URL as Docker's internal http://kong:8000, so the
// signed image URLs get-id-image-urls returns point at a host the browser cannot reach.
// In the cloud it is the public project URL. Rewrite to the local API so thumbnails load.
const reachSignedUrls = (context) =>
  context.route('http://kong:8000/**', (route) =>
    route.continue({ url: route.request().url().replace('http://kong:8000', localEnv().API_URL) }),
  )

// A context already signed in with both factors. The session is cached per role for the
// run, so later files skip the login and the 30-second TOTP wait.
export const signedInContext = async (browser, role) => {
  const account = ACCOUNTS[role]
  const statePath = path.join(AUTH_DIR, `${role}.json`)
  if (existsSync(statePath)) {
    const context = await browser.newContext({ ...CONTEXT_OPTIONS, storageState: statePath })
    await reachSignedUrls(context)
    return context
  }

  const context = await browser.newContext(CONTEXT_OPTIONS)
  await reachSignedUrls(context)
  const page = await context.newPage()
  await signIn(page, account)
  await completeMfa(page, account)
  await context.storageState({ path: statePath })
  await page.close()
  return context
}
