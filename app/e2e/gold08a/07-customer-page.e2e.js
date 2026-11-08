// Gold Phase 8a UAT, Customer page (spec 4.6, 5.2 CustomerDetail view, 6.1).
import { expect, test } from '@playwright/test'
import { ACCOUNTS, auditRows, customerRow, makeImage, melbourneDate, openAs, seed, sql, uniq, E2 } from './support.js'

let staff
let manager
let photo
const AU = (iso) => new Intl.DateTimeFormat('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${iso}T12:00:00`))
const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('')

test.beforeAll(async ({ browser }) => {
  staff = await openAs(browser, 's1')
  manager = await openAs(browser, 'm1')
  await staff.page.goto('/gold')
  photo = await makeImage(staff.page, { width: 800, height: 500, label: 'ID' })
})
test.afterAll(async () => {
  for (const x of [staff, manager]) await x?.context.close()
})

const dd = (page, term) => page.locator('dt', { hasText: term }).locator('xpath=following-sibling::dd')

test('8a.51 — the customer page shows name, DOB, phone, address, ID details, Customer since, ID last updated (the capture date) and who captured it', async () => {
  const { page } = staff
  const number = `DET${digits(6)}`
  const c = await seed({ first: 'Deta', last: `Detail${uniq()}`, dob: '1985-11-02', phone: '0433 444 555', createdDaysAgo: 100, id: { number, capturedDaysAgo: 20, expiry: '2031-01-01', front: photo } })
  await page.goto(`/gold/customers/${c.id}`)
  await expect(page.getByRole('heading', { name: `Deta ${c.last}` })).toBeVisible()
  await expect(dd(page, 'Phone')).toContainText('0433 444 555')
  await expect(dd(page, 'Date of birth')).toHaveText('02 Nov 1985')
  await expect(dd(page, 'Address')).toHaveText('1 Test St, Coburg VIC 3058')
  await expect(dd(page, 'ID type')).toHaveText('Driver licence')
  await expect(dd(page, 'ID number')).toHaveText(number)
  await expect(dd(page, 'Issuer')).toHaveText('VIC')
  await expect(dd(page, 'Expiry')).toHaveText('01 Jan 2031')
  await expect(dd(page, 'Customer since')).toHaveText(AU(melbourneDate(-100)))
  await expect(dd(page, 'ID last updated')).toHaveText(AU(melbourneDate(-20)))
  await expect(dd(page, 'ID captured by')).toHaveText(ACCOUNTS.s1.name)
})

test('8a.52 — ID thumbnails load through get-id-image-urls with one access_log row per image; click opens a larger view, Escape closes it and returns focus; a missing back shows "Not on file"', async () => {
  const { page } = staff
  const c = await seed({ first: 'Pho', last: `Photo${uniq()}`, id: { front: photo, back: photo } })
  const urlCalls = []
  page.on('request', (r) => r.url().includes('/functions/v1/get-id-image-urls') && r.method() === 'POST' && urlCalls.push(r))
  await page.goto(`/gold/customers/${c.id}`)
  const front = page.getByRole('button', { name: 'ID front' })
  await expect(front.getByRole('img')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ID back' }).getByRole('img')).toBeVisible()
  expect(await front.getByRole('img').evaluate((img) => img.naturalWidth)).toBeGreaterThan(0)
  expect(urlCalls).toHaveLength(1)
  const logs = await sql`select action, resource_type, staff_member_id, transaction_id from ttr.access_log
    where resource_id in (${c.ver.frontId}, ${c.ver.backId})`
  expect(logs).toHaveLength(2)
  expect(logs.every((l) => l.action === 'view' && l.staff_member_id === ACCOUNTS.s1.id && l.transaction_id === null)).toBe(true)

  await front.click()
  const dialog = page.getByRole('dialog', { name: 'Photo' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(front).toBeFocused()

  const noBack = await seed({ first: 'Nob', last: `Noback${uniq()}`, id: { front: photo } })
  await page.goto(`/gold/customers/${noBack.id}`)
  await expect(page.getByRole('button', { name: 'ID front' }).getByRole('img')).toBeVisible()
  await expect(page.getByText('Not on file')).toBeVisible()
})

test('8a.53 — Change phone: Enter saves in place with a notice and one phone_change audit row; the same number writes nothing', async () => {
  const { page } = staff
  const c = await seed({ first: 'Phil', last: `Phone${uniq()}`, phone: '0455 100 100', id: false })
  await page.goto(`/gold/customers/${c.id}`)
  const change = page.getByRole('button', { name: 'Change' })
  await change.click()
  const box = page.getByLabel('Phone')
  await expect(box).toBeFocused()
  await box.fill('0455 200 200')
  await box.press('Enter')
  await expect(dd(page, 'Phone')).toContainText('0455 200 200')
  await expect(page.getByRole('status')).toHaveText('Phone number updated')
  const audit = await auditRows(c.id)
  expect(audit).toHaveLength(1)
  expect(audit[0]).toMatchObject({ source: 'phone_change', changed_by: ACCOUNTS.s1.id })
  expect((await customerRow(c.id)).phone).toBe('0455 200 200')

  await change.click()
  await page.getByLabel('Phone').press('Enter')
  await expect(change).toBeVisible()
  expect(await auditRows(c.id)).toHaveLength(1)
})

test('8a.53 — after saving a new phone with Enter the focus returns to "Change"', async () => {
  const { page } = staff
  const c = await seed({ first: 'Fran', last: `Focus${uniq()}`, phone: '0455 400 400', id: false })
  await page.goto(`/gold/customers/${c.id}`)
  await page.getByRole('button', { name: 'Change' }).click()
  await page.getByLabel('Phone').fill('0455 500 500')
  await page.getByLabel('Phone').press('Enter')
  await expect(page.getByRole('status')).toHaveText('Phone number updated')
  await expect(page.getByRole('button', { name: 'Change' })).toBeFocused()
})

test('8a.54 — a 7-digit phone shows "Phone number looks too short." and saves nothing; Escape closes the editor with the old number', async () => {
  const { page } = staff
  const c = await seed({ first: 'Pam', last: `Short${uniq()}`, phone: '0455 300 300', id: false })
  const rpc = []
  page.on('request', (r) => r.url().includes('/rpc/update_customer_phone') && rpc.push(r))
  await page.goto(`/gold/customers/${c.id}`)
  await page.getByRole('button', { name: 'Change' }).click()
  await page.getByLabel('Phone').fill('1234567')
  await page.getByLabel('Phone').press('Enter')
  await expect(page.getByRole('alert')).toHaveText('Phone number looks too short.')
  expect(rpc).toHaveLength(0)
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Phone')).toHaveCount(0)
  await expect(dd(page, 'Phone')).toContainText('0455 300 300')
  expect((await customerRow(c.id)).phone).toBe('0455 300 300')
  expect(await auditRows(c.id)).toHaveLength(0)
})

test("8a.55 — another business's customer and an unknown id show 'Customer not found.' on the page, Update ID and Edit details, with nothing of the other business", async () => {
  const other = await seed({ entity: E2, first: 'Otis', last: `Foreign${uniq()}`, id: { front: photo } })
  const targets = [other.id, '00000000-0000-4000-8000-0000000000ff', 'not-a-uuid']
  for (const id of targets) {
    for (const [who, suffix] of [
      [staff, ''],
      [staff, '/update-id'],
      [manager, '/edit'],
    ]) {
      await who.page.goto(`/gold/customers/${id}${suffix}`)
      await expect(who.page.getByText('Customer not found.'), `${id}${suffix}`).toBeVisible()
      await expect(who.page.getByRole('link', { name: 'Back to Find customer' })).toHaveAttribute('href', '/gold')
      await expect(who.page.getByText(other.last)).toHaveCount(0)
      await expect(who.page.getByRole('button', { name: 'Edit details' })).toHaveCount(0)
    }
  }
})

test('8a.56 — (Phase 8b replaced the placeholder) a customer with no ID has no purchase form, only a prompt to add the ID; "Back to search" returns to /gold', async () => {
  const { page } = staff
  const c = await seed({ first: 'Plac', last: `Holder${uniq()}`, id: false })
  await page.goto(`/gold/customers/${c.id}`)
  await expect(page.getByRole('heading', { name: 'Record purchase' })).toBeVisible()
  await expect(page.getByText('Add the customer’s ID before recording a purchase.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Record purchase' })).toHaveCount(0)
  await page.getByRole('link', { name: 'Back to search' }).click()
  await expect(page).toHaveURL(/\/gold$/)
})
