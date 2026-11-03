// Gold Phase 8a UAT, Find customer (spec 1.5, 1.7 C2, 5.2 Search, 6.1): the screen against the real search_customers RPC.
import { expect, test } from '@playwright/test'
import { E2, melbourneDate, openAs, seed, uniq, watchRpc } from './support.js'

let ctx
let page
const T = uniq()
const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('')
const phoneNo = () => `04${digits(8)}`
const spaced = (p) => `${p.slice(0, 4)} ${p.slice(4, 7)} ${p.slice(7)}`

test.beforeAll(async ({ browser }) => {
  ctx = await openAs(browser, 's1')
  page = ctx.page
})
test.afterAll(async () => ctx?.context.close())

test.beforeEach(async () => {
  await page.unroute('**/rest/v1/rpc/search_customers')
  await page.goto('/gold')
  await expect(page.getByRole('heading', { name: 'Find customer' })).toBeVisible()
})

/** Types a term and waits for its answer. */
const search = async (term) => {
  const answered = page.waitForResponse((r) => r.url().includes('/rpc/search_customers') && (r.request().postData() ?? '').includes(JSON.stringify(term).slice(1, -1)))
  await page.getByLabel('Search').fill(term)
  await answered
  await expect(page.getByText('Searching…')).toBeHidden()
}
const names = () => page.locator('ul li button span[class*="_name_"]').allTextContents()
const result = (name) => page.getByRole('button', { name: new RegExp(name) })

test('8a.8 — the search box has focus on load; 1 character requests nothing; 2 characters search', async () => {
  const calls = watchRpc(page, 'search_customers')
  await expect(page.getByLabel('Search')).toBeFocused()
  await page.getByLabel('Search').fill('a')
  await page.waitForTimeout(700)
  expect(calls).toHaveLength(0)
  await expect(page.locator('ul li')).toHaveCount(0)
  await expect(page.getByText(/No customer matches/)).toHaveCount(0)
  await page.getByLabel('Search').fill('ab')
  await expect.poll(() => calls.length).toBe(1)
})

test('8a.9 — typing "jane citizen" fast sends one request, ~250 ms after the last key, and the URL never holds the text', async () => {
  await seed({ first: 'Jane', last: `Citizen${T}` })
  const calls = watchRpc(page, 'search_customers')
  await page.getByLabel('Search').pressSequentially('jane citizen', { delay: 40 })
  const lastKeyAt = Date.now()
  await page.waitForTimeout(1200)
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0].body)).toEqual({ p_q: 'jane citizen' })
  const waited = calls[0].at - lastKeyAt
  expect(waited).toBeGreaterThanOrEqual(150)
  expect(waited).toBeLessThan(900)
  expect(page.url()).not.toMatch(/jane|citizen|\?/i)
})

test('8a.10 — found by part of the name in any case, by a middle name and by an alias; a term matching no name part finds nobody', async () => {
  await seed({ first: 'Janelle', middle: `Marigold${T}`, last: `Citizenx${T}`, aliases: [`Jenny Aliasone${T}`] })
  const full = `Janelle Marigold${T} Citizenx${T}`
  for (const term of [`CITIZENX${T}`, `janelle citizenx${T}`.slice(0, 40).toUpperCase(), `marigold${T}`, `aliasone${T}`]) {
    await search(term)
    await expect(result(full)).toBeVisible()
  }
  await search('janelle c')
  await expect(result(full)).toBeVisible()
  await search(`nomatchzz${T}`)
  await expect(page.getByText(/No customer matches/)).toBeVisible()
  await expect(page.locator('ul li')).toHaveCount(0)
})

test('8a.11 — phone found as 0412…, +61412…, 61412… and by 4 digits; 3 digits do not match by phone', async () => {
  const phone = phoneNo()
  const rest = phone.slice(1)
  await seed({ first: 'Phoebe', last: `Phonely${T}`, phone: spaced(phone), id: { number: `PH${digits(7)}` } })
  const full = `Phoebe Phonely${T}`
  for (const term of [spaced(phone), `+61${rest}`, `61${rest}`, phone.slice(-4)]) {
    await search(term)
    await expect(result(full), term).toBeVisible()
  }
  await search(phone.slice(0, 3))
  await expect(result(full)).toHaveCount(0)
})

test('8a.12 — an ID number is found as typed, in lower case, with spaces and with dashes', async () => {
  const number = `QX${digits(6)}`
  await seed({ first: 'Ida', last: `Idnumber${T}`, id: { number } })
  const full = `Ida Idnumber${T}`
  const variants = [number, number.toLowerCase(), `${number.slice(0, 2)} ${number.slice(2, 5)} ${number.slice(5)}`.toLowerCase(), `${number.slice(0, 2)}-${number.slice(2, 4)} ${number.slice(4)}`.toLowerCase()]
  for (const term of variants) {
    await search(term)
    await expect(result(full), term).toBeVisible()
  }
})

test('8a.13 — a result row shows name, date of birth (en-AU), ID type and number, phone and the ID badge', async () => {
  const phone = phoneNo()
  const number = `RW${digits(6)}`
  await seed({ first: 'Rowena', last: `Rowtest${T}`, dob: '1985-11-02', phone, id: { number, expiry: '2031-01-01' } })
  await search(`rowtest${T}`)
  const row = result(`Rowena Rowtest${T}`)
  await expect(row).toContainText(`Born 02 Nov 1985 | Driver licence ${number} | ${phone}`)
  await expect(row).toContainText('ID valid to 01 Jan 2031')
})

test('8a.14 — an exact phone (or ID number) match is listed first; the rest by last name, then first name', async () => {
  const phone = phoneNo()
  await seed({ first: 'Zed', last: `Zzzexact${T}`, phone })
  await seed({ first: 'Zoe', last: `Ordr${T}`, phone: `${phone}2` })
  await seed({ first: 'Amy', last: `Ordr${T}`, phone: `${phone}3` })
  await seed({ first: 'Bob', last: `Bbb${T}`, phone: `${phone}4` })
  await search(phone)
  expect(await names()).toEqual([`Zed Zzzexact${T}`, `Bob Bbb${T}`, `Amy Ordr${T}`, `Zoe Ordr${T}`])

  const number = `EX${digits(6)}`
  await seed({ first: 'Yan', last: `Zzzid${T}`, id: { number } })
  await seed({ first: 'Xia', last: `Aaaid${T}`, id: { number: `${number}9` } })
  await search(number)
  expect(await names()).toEqual([`Yan Zzzid${T}`, `Xia Aaaid${T}`])
})

test('8a.15 — at most 20 of 25 matching customers are listed', async () => {
  for (let i = 0; i < 25; i++) await seed({ first: `N${i}`, last: `Many${T}` })
  await search(`many${T}`)
  await expect(page.locator('ul li')).toHaveCount(20)
})

test("8a.16 — another business's customer and a company customer never appear", async () => {
  await seed({ entity: E2, first: 'Otto', last: `Otherbiz${T}` })
  await seed({ type: 'company', last: `Compco${T}` })
  for (const term of [`otherbiz${T}`, `compco${T}`]) {
    await search(term)
    await expect(page.getByText(/No customer matches/)).toBeVisible()
    await expect(page.locator('ul li')).toHaveCount(0)
  }
})

test('8a.17 — no match shows the message and a New customer button to /gold/customers/new', async () => {
  await search(`zzqq${T}`)
  await expect(page.getByText(`No customer matches “zzqq${T}”. Check the spelling or create a new customer.`)).toBeVisible()
  await page.getByRole('button', { name: 'New customer' }).click()
  await expect(page).toHaveURL(/\/gold\/customers\/new$/)
})

test('8a.18 — Enter opens a single result and does nothing on several; clicking a result opens the customer', async () => {
  const one = await seed({ first: 'Solo', last: `Solo${T}` })
  await search(`solo${T}`)
  await page.getByLabel('Search').press('Enter')
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${one.id}$`))

  await page.goto('/gold')
  const a = await seed({ first: 'Pat', last: `Pair${T}` })
  await seed({ first: 'Pam', last: `Pair${T}` })
  await search(`pair${T}`)
  await page.getByLabel('Search').press('Enter')
  await page.waitForTimeout(500)
  await expect(page).toHaveURL(/\/gold$/)
  await result(`Pat Pair${T}`).click()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${a.id}$`))
})

const colours = (loc) => loc.evaluate((el) => `${getComputedStyle(el).color}|${getComputedStyle(el).backgroundColor}`)
const AU = (iso) => new Intl.DateTimeFormat('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${iso}T12:00:00`))

test('8a.19 — badges read valid / expiring / expired / re-verify / none, with a colour per meaning', async () => {
  const valid = melbourneDate(90)
  const expired = melbourneDate(-1)
  await seed({ first: 'Vee', last: `Badge${T}`, id: { expiry: valid } })
  await seed({ first: 'Exa', last: `Badge${T}`, id: { expiry: melbourneDate(12) } })
  await seed({ first: 'Dan', last: `Badge${T}`, id: { expiry: expired } })
  await seed({ first: 'Olga', last: `Badge${T}`, id: { capturedDaysAgo: 800 } })
  await seed({ first: 'Nia', last: `Badge${T}`, id: false })
  await search(`badge${T}`)
  const badge = (first, text) => result(`${first} Badge${T}`).getByText(text)
  await expect(badge('Vee', `ID valid to ${AU(valid)}`)).toBeVisible()
  await expect(badge('Exa', 'ID expires in 12 days')).toBeVisible()
  await expect(badge('Dan', `ID expired ${AU(expired)}`)).toBeVisible()
  await expect(badge('Olga', 'Re-verify ID')).toBeVisible()
  await expect(badge('Nia', 'No ID on file')).toBeVisible()
  const c = {
    valid: await colours(badge('Vee', 'ID valid')),
    expiring: await colours(badge('Exa', 'ID expires')),
    expired: await colours(badge('Dan', 'ID expired')),
    reverify: await colours(badge('Olga', 'Re-verify')),
    none: await colours(badge('Nia', 'No ID')),
  }
  expect(c.expiring).toBe(c.reverify)
  expect(new Set([c.valid, c.expiring, c.expired, c.none]).size).toBe(4)
})

test('8a.20 — an ID photographed 730 days ago is valid, 731 days ago needs re-verifying; expired beats old', async () => {
  await seed({ first: 'Dday', last: `Window${T}`, id: { capturedDaysAgo: 730 } })
  await seed({ first: 'Eday', last: `Window${T}`, id: { capturedDaysAgo: 731 } })
  await seed({ first: 'Fday', last: `Window${T}`, id: { capturedDaysAgo: 800, expiry: melbourneDate(-1) } })
  await search(`window${T}`)
  await expect(result(`Dday Window${T}`).getByText(/^ID valid/)).toBeVisible()
  await expect(result(`Eday Window${T}`).getByText('Re-verify ID')).toBeVisible()
  await expect(result(`Fday Window${T}`).getByText(/^ID expired/)).toBeVisible()
})

test('8a.21 — a failed search shows a visible error, the page survives, and a later search works', async () => {
  await seed({ first: 'Later', last: `Recover${T}` })
  await page.route('**/rest/v1/rpc/search_customers', (route) => route.abort())
  await page.getByLabel('Search').fill(`recover${T}`)
  await expect(page.getByRole('alert')).toHaveText('The search failed. Check the connection and try again.')
  await expect(page.getByRole('heading', { name: 'Find customer' })).toBeVisible()
  await page.unroute('**/rest/v1/rpc/search_customers')
  await page.getByLabel('Search').fill(`recove${T}`)
  await page.getByLabel('Search').fill(`recover${T}`)
  await expect(result(`Later Recover${T}`)).toBeVisible()
})
