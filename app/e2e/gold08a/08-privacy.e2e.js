// Gold Phase 8a UAT, privacy and context (spec 2.2, 2.3): no customer data left on the device, nothing carried to the next person.
import { expect, test } from '@playwright/test'
import { dmy, fillId, fillPerson, login, makeImage, melbourneDate, openAs, seed, sighted, storageKey, uniq, upload } from './support.js'

const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('')

let ctx
let page
let photo

test.beforeAll(async ({ browser }) => {
  ctx = await openAs(browser, 's1')
  page = ctx.page
  await page.goto('/gold')
  photo = await makeImage(page, { width: 800, height: 500 })
})
test.afterAll(async () => ctx?.context.close())

const storageDump = () =>
  page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))

test('8a.57 — after search, create, update ID and the customer page, no name, phone, date of birth, ID number or photo is in localStorage or sessionStorage; a reload loads the customer from the server', async () => {
  const T = uniq()
  const p = { first: `Privfirst${T}`, last: `Privlast${T}`, dob: '1962-07-23', phone: `04${digits(2)} ${digits(3)} ${digits(3)}`, number: `PV${digits(8)}` }
  const secrets = [p.first, p.last, p.phone, p.phone.replace(/\s/g, ''), '1962-07-23', '23/07/1962', p.number]

  await page.goto('/gold')
  await page.getByLabel('Search').fill(p.last)
  await expect(page.getByText(/No customer matches/)).toBeVisible()
  await page.getByRole('button', { name: 'New customer' }).click()
  await fillPerson(page, p)
  await fillId(page, { number: p.number, hasExpiry: true, expiry: melbourneDate(900) })
  await upload(page, 'ID front', photo)
  await upload(page, 'ID back', photo)
  await sighted(page).check()
  const midForm = await storageDump()
  await page.getByRole('button', { name: 'Create customer' }).click()
  await expect(page).toHaveURL(/\/gold\/customers\/[0-9a-f-]{36}$/)
  const customerUrl = page.url()
  await expect(page.getByRole('heading', { name: `${p.first} ${p.last}` })).toBeVisible()
  await expect(page.getByRole('button', { name: 'ID front' }).getByRole('img')).toBeVisible()

  await page.getByRole('button', { name: 'Update ID' }).click()
  await page.getByRole('radio', { name: /^Renewed/ }).check()
  await page.getByLabel('ID expiry date').fill(dmy(melbourneDate(1500)))
  await upload(page, 'ID front', photo)
  await upload(page, 'ID back', photo)
  await sighted(page).check()
  const midUpdate = await storageDump()
  await page.getByRole('button', { name: 'Save new ID' }).click()
  await expect(page).toHaveURL(customerUrl)
  await expect(page.getByRole('status')).toHaveText('ID updated')

  for (const dump of [midForm, midUpdate, await storageDump()]) {
    for (const secret of secrets) expect(dump, `storage must not hold ${secret}`).not.toContain(secret)
    expect(dump).not.toContain('data:image')
    expect(dump).not.toContain('/9j/')
  }

  await page.reload()
  await expect(page.getByRole('heading', { name: `${p.first} ${p.last}` })).toBeVisible()
  await expect(page.getByText(p.number)).toBeVisible()
})

test('8a.58 — after sign-out, and after the idle limit, the next staff member sees an empty search and no earlier customer, text or form value', async () => {
  const T = uniq()
  const c = await seed({ first: `Carry${T}`, last: `Over${T}`, id: false })
  const swapIn = async (label) => {
    const session = await login(label)
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [storageKey(), JSON.stringify(session)])
  }

  await page.goto('/gold')
  await page.getByLabel('Search').fill(`over${T}`)
  await expect(page.getByRole('button', { name: new RegExp(`Carry${T}`) })).toBeVisible()
  await page.getByRole('button', { name: 'New customer' }).click()
  await page.getByLabel('First name').fill(`Typed${T}`)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login/)

  // A different staff member signs in on the same browser.
  await swapIn('m1')
  await page.goto('/gold')
  await expect(page.getByText('UAT8a Manager')).toBeVisible()
  await expect(page.getByLabel('Search')).toHaveValue('')
  const gone = async () => {
    const text = await page.locator('body').innerText()
    for (const s of [`Carry${T}`, `Over${T}`, `Typed${T}`]) expect(text).not.toContain(s)
  }
  await gone()
  await page.getByRole('button', { name: 'New customer' }).click()
  await expect(page.getByLabel('First name')).toHaveValue('')

  // Idle: the last activity was 11 minutes ago, so the next check signs the session out.
  await page.goto(`/gold/customers/${c.id}`)
  await expect(page.getByRole('heading', { name: `Carry${T} Over${T}` })).toBeVisible()
  await page.evaluate(() => {
    localStorage.setItem('ccp.lastActivity', String(Date.now() - 11 * 60 * 1000))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page).toHaveURL(/\/login/)
  expect(await page.locator('body').innerText()).not.toContain(`Carry${T}`)

  await swapIn('a1')
  await page.goto('/gold')
  await expect(page.getByText('UAT8a Admin')).toBeVisible()
  await expect(page.getByLabel('Search')).toHaveValue('')
  await gone()
})
