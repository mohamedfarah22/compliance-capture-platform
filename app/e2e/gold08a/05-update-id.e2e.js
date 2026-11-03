// Gold Phase 8a UAT, Update ID (spec 1.6, 1.7 C2, 4.3, 5.2 CustomerForm update, 6.1): the screen against gold-update-customer-id.
import { expect, test } from '@playwright/test'
import { captures, dmy, fillId, imageRows, makeImage, melbourneDate, openAs, seed, sighted, totals, uniq, upload } from './support.js'

let ctx
let page
let photos
const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('')
const AU = (iso) => new Intl.DateTimeFormat('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${iso}T12:00:00`))

test.beforeAll(async ({ browser }) => {
  ctx = await openAs(browser, 's1')
  page = ctx.page
  await page.goto('/gold')
  photos = {
    old: await makeImage(page, { width: 800, height: 500, label: 'OLD' }),
    fresh: await makeImage(page, { width: 900, height: 600, label: 'NEW' }),
    fresh2: await makeImage(page, { width: 700, height: 450, label: 'NEW2' }),
  }
})
test.afterAll(async () => ctx?.context.close())

/** A customer with a licence on file, photos stored for real. */
const withId = async (o = {}) => {
  const id = { number: `UP${digits(7)}`, front: photos.old, back: photos.old, expiry: melbourneDate(200), ...(o.id ?? {}) }
  const c = await seed({ first: 'Una', last: `Upd${uniq()}`, id })
  return { ...c, number: id.number }
}
const open = async (c) => {
  await page.goto(`/gold/customers/${c.id}/update-id`)
  await expect(page.getByRole('heading', { name: 'Update ID' })).toBeVisible()
}
const reason = (name) => page.getByRole('radio', { name })
const REASON = { renewed: /^Renewed/, different: /different document/, unclear: /stored photo is unclear/ }
const save = () => page.getByRole('button', { name: 'Save new ID' }).click()
const watchUpdates = () => {
  const sent = []
  page.on('request', (r) => r.url().includes('/functions/v1/gold-update-customer-id') && r.method() === 'POST' && sent.push(r))
  return sent
}

test('8a.39 — Update ID shows the name, the ID on file with its badge and a required choice of three reasons', async () => {
  const c = await withId()
  await page.goto(`/gold/customers/${c.id}`)
  await page.getByRole('button', { name: 'Update ID' }).click()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}/update-id$`))
  await expect(page.getByText(`${c.first} ${c.last} | On file: Driver licence ${c.number}`)).toBeVisible()
  await expect(page.getByText(/^ID valid to/)).toBeVisible()
  const group = page.getByRole('group', { name: 'Why are you updating the ID?' })
  await expect(group.getByRole('radio')).toHaveCount(3)
  for (const r of Object.values(REASON)) await expect(reason(r)).not.toBeChecked()
  const sent = watchUpdates()
  await save()
  await expect(page.getByText('Choose why you are updating the ID.')).toBeVisible()
  expect(sent).toHaveLength(0)
})

test('8a.40 — Renewed with the same number: new expiry, linked new capture, old photos replaced, customer page updated', async () => {
  const c = await withId()
  const [oldCap] = await captures(c.id)
  const newExpiry = melbourneDate(1500)
  await open(c)
  await reason(REASON.renewed).check()
  await expect(page.getByLabel('ID number')).toHaveValue(c.number)
  await expect(page.getByRole('radiogroup', { name: 'Does the ID have an expiry date?' }).getByRole('radio', { name: 'Yes' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByLabel('ID expiry date')).toHaveValue('')
  await page.getByLabel('ID expiry date').fill(dmy(newExpiry))
  await upload(page, 'ID front', photos.fresh)
  await upload(page, 'ID back', photos.fresh2)
  await sighted(page).check()
  await save()

  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}$`))
  await expect(page.getByRole('status')).toHaveText('ID updated')
  const dd = (term) => page.locator('dt', { hasText: term }).locator('xpath=following-sibling::dd')
  await expect(dd('Expiry')).toHaveText(AU(newExpiry))
  await expect(dd('ID last updated')).toHaveText(AU(melbourneDate()))
  await expect(page.getByText(`ID valid to ${AU(newExpiry)}`)).toBeVisible()

  const caps = await captures(c.id)
  expect(caps).toHaveLength(2)
  expect(caps[1]).toMatchObject({ verification_basis: 'new_capture', new_capture_reason: 'id_changed', prior_verification_id: oldCap.id, document_number: c.number })
  const rows = await imageRows(c.id)
  const old = rows.filter((r) => [oldCap.front_image_id, oldCap.back_image_id].includes(r.id))
  expect(old).toHaveLength(2)
  for (const r of old) {
    expect(r.superseded_at, 'old photo row stamped superseded').not.toBeNull()
    expect(r.object_exists, 'old photo object deleted').toBe(0)
  }
  const fresh = rows.filter((r) => [caps[1].front_image_id, caps[1].back_image_id].includes(r.id))
  expect(fresh.map((r) => r.object_exists)).toEqual([1, 1])
})

test('8a.41 — Photo unclear with the same number saves linked as stored_copy_unclear; with a number not on file it is refused', async () => {
  const c = await withId()
  const [oldCap] = await captures(c.id)
  await open(c)
  await reason(REASON.unclear).check()
  await expect(page.getByLabel('ID number')).toHaveValue(c.number)
  await upload(page, 'ID front', photos.fresh)
  await upload(page, 'ID back', photos.fresh2)
  await sighted(page).check()
  await save()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}$`))
  await expect(page.getByRole('status')).toHaveText('ID updated')
  const caps = await captures(c.id)
  expect(caps).toHaveLength(2)
  expect(caps[1]).toMatchObject({ new_capture_reason: 'stored_copy_unclear', prior_verification_id: oldCap.id })
  const old = (await imageRows(c.id)).filter((r) => [oldCap.front_image_id, oldCap.back_image_id].includes(r.id))
  expect(old.every((r) => r.superseded_at !== null && r.object_exists === 0)).toBe(true)

  const before = await totals()
  await open(c)
  await reason(REASON.unclear).check()
  await page.getByLabel('ID number').fill(`OTHER${digits(6)}`)
  await upload(page, 'ID front', photos.fresh)
  await upload(page, 'ID back', photos.fresh2)
  await sighted(page).check()
  await save()
  await expect(page.getByRole('alert').filter({ hasText: 'That document is not on file for this customer. Choose “Different document” to record a new one.' })).toBeVisible()
  await expect(page).toHaveURL(/update-id$/)
  expect(await totals()).toEqual(before)
})

test('8a.42 — Different document saves unlinked, keeps the old photos, and becomes the current ID', async () => {
  const c = await withId()
  const [oldCap] = await captures(c.id)
  const number = `PP${digits(7)}`
  await open(c)
  await reason(REASON.different).check()
  await expect(page.getByLabel('ID number')).toHaveValue('')
  await fillId(page, { type: 'Passport', number, issuer: 'Australia', hasExpiry: true, expiry: melbourneDate(2000) })
  await upload(page, 'ID front', photos.fresh)
  await sighted(page).check()
  await save()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}$`))
  await expect(page.locator('dt', { hasText: 'ID type' }).locator('xpath=following-sibling::dd')).toHaveText('Passport')
  await expect(page.locator('dt', { hasText: 'ID number' }).locator('xpath=following-sibling::dd')).toHaveText(number)

  const caps = await captures(c.id)
  expect(caps).toHaveLength(2)
  expect(caps[1]).toMatchObject({ new_capture_reason: 'different_document', prior_verification_id: null, document_type: 'Passport' })
  const old = (await imageRows(c.id)).filter((r) => [oldCap.front_image_id, oldCap.back_image_id].includes(r.id))
  expect(old).toHaveLength(2)
  expect(old.every((r) => r.superseded_at === null && r.object_exists === 1), 'old photos kept').toBe(true)
})

test("8a.43 — Different document with a number on file for another customer is refused naming the owner, and nothing is saved", async () => {
  const number = `TAKEN${digits(6)}`
  const owner = await seed({ first: 'Orla', last: `Holder${uniq()}`, id: { number, type: 'Passport' } })
  const c = await withId()
  const before = await totals()
  await open(c)
  await reason(REASON.different).check()
  await fillId(page, { type: 'Passport', number, issuer: 'Australia', hasExpiry: true, expiry: melbourneDate(2000) })
  await upload(page, 'ID front', photos.fresh)
  await sighted(page).check()
  await save()
  const alert = page.getByRole('alert').filter({ hasText: 'already on file' })
  await expect(alert).toBeVisible()
  await expect(alert).toContainText(owner.last)
  await expect(page).toHaveURL(/update-id$/)
  expect(await totals()).toEqual(before)
})

test('8a.44 — an expired ID gives a red banner, an ID older than the window an amber one; both open Update ID and clear after an update', async () => {
  const expired = await withId({ id: { expiry: melbourneDate(-1) } })
  await page.goto(`/gold/customers/${expired.id}`)
  const red = page.locator('div[class*="bannerBlocking"]')
  await expect(red).toContainText(`ID expired on ${AU(melbourneDate(-1))}`)
  const old = await withId({ id: { capturedDaysAgo: 800 } })
  await page.goto(`/gold/customers/${old.id}`)
  const amber = page.locator('div[class*="bannerAttention"]')
  await expect(amber).toContainText('ID needs re-verifying')
  await expect(amber).toContainText('photographed on')
  await expect(amber).toContainText('more than 730 days ago')
  const bg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor)
  const amberBg = await bg(amber)
  await page.goto(`/gold/customers/${expired.id}`)
  expect(await bg(red)).not.toBe(amberBg)

  for (const [c, wasExpired] of [
    [expired, true],
    [old, false],
  ]) {
    await page.goto(`/gold/customers/${c.id}`)
    await page.getByRole('button', { name: 'Update ID now' }).click()
    await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}/update-id$`))
    await reason(REASON.renewed).check()
    await page.getByLabel('ID expiry date').fill(dmy(melbourneDate(1200)))
    await upload(page, 'ID front', photos.fresh)
    await upload(page, 'ID back', photos.fresh2)
    await sighted(page).check()
    await save()
    await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}$`))
    await expect(page.getByText(`ID valid to ${AU(melbourneDate(1200))}`)).toBeVisible()
    await expect(page.locator('div[class*="banner"]')).toHaveCount(0)
    void wasExpired
  }
})

test('8a.45 — a customer with no ID: "Add ID" opens a form without the reason choice and records the first ID as different_document', async () => {
  const c = await seed({ first: 'Noor', last: `Noid${uniq()}`, id: false })
  await page.goto(`/gold/customers/${c.id}`)
  await expect(page.locator('div[class*="banner"]')).toContainText('No ID on file')
  await page.getByRole('button', { name: 'Add ID' }).click()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}/update-id$`))
  await expect(page.getByText('No ID is on file for this customer yet.')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Why are you updating the ID?' })).toHaveCount(0)
  await expect(page.getByLabel('ID number')).toBeVisible()
  const number = `FIRST${digits(5)}`
  await fillId(page, { type: 'Passport', number, issuer: 'Australia', hasExpiry: true, expiry: melbourneDate(2000) })
  await upload(page, 'ID front', photos.fresh)
  await sighted(page).check()
  await save()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}$`))
  await expect(page.locator('dt', { hasText: 'ID number' }).locator('xpath=following-sibling::dd')).toHaveText(number)
  const caps = await captures(c.id)
  expect(caps).toHaveLength(1)
  expect(caps[0]).toMatchObject({ new_capture_reason: 'different_document', prior_verification_id: null, verification_basis: 'new_capture' })
})

test('8a.46 — no front photo, a licence without a back photo, a blank number: each is refused with a message and nothing is sent', async () => {
  const c = await withId()
  await open(c)
  const sent = watchUpdates()
  await reason(REASON.different).check()
  await fillId(page, { type: 'Driver licence', number: `NEW${digits(6)}`, issuer: 'VIC', hasExpiry: true, expiry: melbourneDate(1000) })
  await sighted(page).check()
  await upload(page, 'ID back', photos.fresh2)
  await save()
  await expect(page.getByText('Take or upload a photo of the front of the ID.')).toBeVisible()
  expect(sent).toHaveLength(0)

  await page.goto(`/gold/customers/${c.id}/update-id`)
  await reason(REASON.different).check()
  await fillId(page, { type: 'Driver licence', number: `NEW${digits(6)}`, issuer: 'VIC', hasExpiry: true, expiry: melbourneDate(1000) })
  await sighted(page).check()
  await upload(page, 'ID front', photos.fresh)
  await save()
  await expect(page.getByText('Take or upload a photo of the back of the ID.')).toBeVisible()
  await expect(page.getByText('Take or upload a photo of the front of the ID.')).toHaveCount(0)
  expect(sent).toHaveLength(0)

  await page.goto(`/gold/customers/${c.id}/update-id`)
  await reason(REASON.different).check()
  await fillId(page, { type: 'Driver licence', number: 'x', issuer: 'VIC', hasExpiry: true, expiry: melbourneDate(1000) })
  await page.getByLabel('ID number').fill('')
  await sighted(page).check()
  await upload(page, 'ID front', photos.fresh)
  await upload(page, 'ID back', photos.fresh2)
  await save()
  await expect(page.getByText('Enter the ID number.')).toBeVisible()
  expect(sent).toHaveLength(0)
})
