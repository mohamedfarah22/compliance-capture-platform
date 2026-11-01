// UAT matrix Part 0, Phase 1 — MFA (R3–R10). Needs accounts that have never enrolled,
// so it must run first after a db reset.
import { expect, test } from '@playwright/test'
import { ACCOUNTS, CONTEXT_OPTIONS, completeMfa, signIn, totpCode } from '../support/auth.js'

test.describe.configure({ mode: 'serial' })

const admin = ACCOUNTS.admin
let context
let page
let enrolResponse

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext(CONTEXT_OPTIONS)
  page = await context.newPage()
})

test.afterAll(async () => {
  await context.close()
})

test('R3 — an account that has never enrolled is sent to /mfa with a QR code', async () => {
  const enrol = page.waitForResponse((r) => r.url().endsWith('/auth/v1/factors') && r.request().method() === 'POST')
  await signIn(page, admin)
  enrolResponse = await (await enrol).json()
  await expect(page.getByRole('heading', { name: 'Set up two-factor authentication' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Scan this QR code with your authenticator app' })).toBeVisible()
})

test('R4 — scanning and entering the code lands on /start; the issuer is the product name', async () => {
  expect(new URL(enrolResponse.totp.uri).searchParams.get('issuer')).toBe('Compliance Capture Platform')
  expect(await completeMfa(page, admin)).toBe('enroll')
  await expect(page.getByRole('heading', { name: 'Start TTR Transaction' })).toBeVisible()
})

test('R5 — signing in again asks for a code only, with no re-enrolment', async () => {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login/)
  await signIn(page, admin)
  await expect(page.getByRole('heading', { name: 'Enter your authentication code' })).toBeVisible()
  await expect(page.getByRole('img', { name: /QR code/ })).toHaveCount(0)
})

test('R6 — a wrong code is rejected and the page stays on /mfa', async () => {
  await page.getByLabel('6-digit code').fill('000000')
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByText('Invalid code. Please try again.')).toBeVisible()
  await expect(page).toHaveURL(/\/mfa/)
})

test('R7 ⚠ critical / R8 — a half-authenticated session opening a protected page is signed out everywhere', async () => {
  // R8 needs a second tab sharing this session, opened while it is still half-authenticated.
  const otherTab = await context.newPage()
  await otherTab.goto('/mfa')
  await expect(otherTab.getByLabel('6-digit code')).toBeVisible()

  for (const path of ['/reports', '/id-verification', '/customers']) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/login/)
    // Ended, not just redirected: the code-entry shortcut must be gone too.
    await page.goto('/mfa')
    await expect(page).toHaveURL(/\/login/)
    if (path !== '/customers') await signIn(page, admin)
  }

  // R8 — the sign-out is global, so the other tab is signed out as well.
  await otherTab.reload()
  await expect(otherTab).toHaveURL(/\/login/)
  await otherTab.close()
})

test('R9 — the requested page survives both factors', async () => {
  await page.goto('/reports')
  await expect(page).toHaveURL(/\/login/)
  await page.getByLabel('Email address').fill(admin.email)
  await page.getByLabel('Password').fill(admin.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/mfa/)
  await page.getByLabel('6-digit code').fill(await totpCode(admin))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page).toHaveURL(/\/reports$/)
})

test('R10 — the role check still runs after MFA; a full session survives a hard refresh', async ({ browser }) => {
  const staffContext = await browser.newContext(CONTEXT_OPTIONS)
  const staffPage = await staffContext.newPage()
  await signIn(staffPage, ACCOUNTS.staff)
  await completeMfa(staffPage, ACCOUNTS.staff)
  await staffPage.goto('/reports')
  await expect(staffPage.getByText('You are not authorised to view this page')).toBeVisible()

  await staffPage.goto('/')
  await staffPage.reload()
  await expect(staffPage.getByRole('heading', { name: 'Start TTR Transaction' })).toBeVisible()
  await staffContext.close()
})
