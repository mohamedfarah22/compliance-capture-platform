// Gold Phase 8a UAT, access and shell (spec 2.2, 2.3, 5.4): sign-in redirects, aal1, the picker card, the gold header, layout and a11y.
// Row 8a.1 (flag off) is a Vitest test: src/__tests__/gold08aFlagOff.test.jsx, because the running app is built with the flag on.
import { expect, test } from '@playwright/test'
import { CONTEXT_OPTIONS, completeMfa, signIn } from '../support/auth.js'
import { ACCOUNTS, makeImage, melbourneDate, openAs, seed, storageKey, uniq, world } from './support.js'

const UI = { email: ACCOUNTS.ui.email, password: 'uat-password-8' }

test('8a.2 — signed out, /gold and /gold/customers/new go to /login with the path kept; after sign-in and MFA the staff member lands on the page they asked for', async ({ browser }) => {
  await world()
  for (const path of ['/gold', '/gold/customers/new']) {
    const context = await browser.newContext(CONTEXT_OPTIONS)
    const page = await context.newPage()
    await page.goto(path)
    await expect(page).toHaveURL(new RegExp(`/login\\?redirect=${encodeURIComponent(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
    await signIn(page, UI, { redirect: path })
    await completeMfa(page, UI)
    await expect(page).toHaveURL(new RegExp(`${path.replace('/', '\\/')}$`))
    await expect(page.getByRole('heading', { name: path === '/gold' ? 'Find customer' : 'New customer' })).toBeVisible()
    await context.close()
  }
})

test('8a.3 — a password-only (aal1) session visiting /gold is ended and sent to login, and no gold data is requested', async ({ browser }) => {
  const { context, page } = await openAs(browser, 's1', { aal1: true })
  const rest = []
  page.on('request', (r) => r.url().includes('/rest/v1/') && rest.push(r.url()))
  await page.goto('/gold')
  await expect(page).toHaveURL(/\/login/)
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), storageKey())).toBeNull()
  expect(rest.filter((u) => /customers|search_customers|customer_current_id|find_possible|get_verification/.test(u))).toEqual([])
  await context.close()
})

test('8a.4 — at aal2 with the flag on, the picker\'s "Gold due diligence" card opens "Find customer" with the name, "Switch journey" and "Sign out"', async ({ browser }) => {
  const { context, page } = await openAs(browser, 's1')
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'What would you like to do?' })).toBeVisible()
  await page.getByRole('link', { name: /gold due diligence/i }).click()
  await expect(page).toHaveURL(/\/gold$/)
  await expect(page.getByRole('heading', { name: 'Find customer' })).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Gold' })
  await expect(nav.getByText(ACCOUNTS.s1.name)).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Switch journey' })).toBeVisible()
  await expect(nav.getByRole('button', { name: 'Sign out' })).toBeVisible()
  await context.close()
})

test('8a.5 — "Switch journey" goes to the picker; "Sign out" ends the session and the back button shows no gold screen', async ({ browser }) => {
  const { context, page } = await openAs(browser, 's1')
  await page.goto('/gold')
  await page.getByRole('link', { name: 'Switch journey' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: 'What would you like to do?' })).toBeVisible()
  await page.getByRole('link', { name: /gold due diligence/i }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login/)
  await page.goBack()
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole('heading', { name: 'Find customer' })).toHaveCount(0)
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), storageKey())).toBeNull()
  await context.close()
})

test('8a.6 — /gold/nonsense redirects to /gold', async ({ browser }) => {
  const { context, page } = await openAs(browser, 's1')
  await page.goto('/gold/nonsense')
  await expect(page).toHaveURL(/\/gold$/)
  await expect(page.getByRole('heading', { name: 'Find customer' })).toBeVisible()
  await context.close()
})

test('8a.7 — at 1280 px and 390 px every screen has no horizontal scroll, labelled controls, a visible focus ring, and role=alert / radiogroup where the spec says', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'm1')
  await page.goto('/gold')
  const photo = await makeImage(page, { width: 800, height: 500 })
  const c = await seed({ first: 'Axe', last: `Access${uniq()}`, id: { front: photo, back: photo, expiry: melbourneDate(300) } })
  const screens = [
    ['Find customer', '/gold', async () => page.getByLabel('Search').fill(`access${c.last.slice(6)}`)],
    ['New customer', '/gold/customers/new', null],
    ['Update ID', `/gold/customers/${c.id}/update-id`, async () => page.getByRole('radio', { name: /^Renewed/ }).check()],
    ['Edit details', `/gold/customers/${c.id}/edit`, null],
    ['Customer page', `/gold/customers/${c.id}`, async () => expect(page.getByRole('button', { name: 'ID front' }).getByRole('img')).toBeVisible()],
  ]
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const [name, path, prepare] of screens) {
      const at = `${name} at ${width}px`
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
      if (prepare) await prepare()
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(wide, `${at}: horizontal scroll`).toBeLessThanOrEqual(0)

      const unlabelled = await page.evaluate(() =>
        [...document.querySelectorAll('input:not([type=hidden]), select, textarea, button, a[href]')]
          .filter((el) => {
            const named = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.labels && el.labels.length) || el.textContent.trim() || el.getAttribute('alt')
            return !named && !el.querySelector('img[alt]')
          })
          .map((el) => el.outerHTML.slice(0, 120)),
      )
      expect(unlabelled, `${at}: controls without a name`).toEqual([])

      const noRing = []
      await page.evaluate(() => document.activeElement?.blur())
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab')
        const info = await page.evaluate(() => {
          const el = document.activeElement
          if (!el || el === document.body) return null
          const s = getComputedStyle(el)
          const ringed = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none')
          // a custom control may draw its ring on a wrapper (the date picker box)
          const wrapper = el.closest('span')
          const ws = wrapper ? getComputedStyle(wrapper) : null
          const wrapped = ws && ((ws.outlineStyle !== 'none' && parseFloat(ws.outlineWidth) > 0) || ws.boxShadow !== 'none')
          return { ringed: Boolean(ringed || wrapped), desc: `${el.tagName.toLowerCase()}#${el.id}.${String(el.className).slice(0, 30)}` }
        })
        if (info && !info.ringed) noRing.push(info.desc)
      }
      expect([...new Set(noRing)], `${at}: focused controls with no visible ring`).toEqual([])
    }
  }

  // announcements: errors role=alert, the Yes/No question a radiogroup
  await page.goto('/gold/customers/new')
  await page.getByRole('button', { name: 'Create customer' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Check the highlighted fields.' })).toBeVisible()
  await expect(page.getByRole('radiogroup', { name: 'Does the ID have an expiry date?' })).toBeVisible()
  await context.close()
})
