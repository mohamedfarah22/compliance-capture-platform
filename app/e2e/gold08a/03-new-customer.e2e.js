// Gold Phase 8a UAT, New customer (spec 1.5, 1.6, 1.7 C3, 4.3, 4.5, 5.2 CustomerForm create): the form against the real gold functions.
import { expect, test } from '@playwright/test'
import {
  auditRows,
  byLastName,
  captures,
  dmy,
  fillId,
  fillPerson,
  getObject,
  imageRows,
  jpegSize,
  makeImage,
  melbourneDate,
  openAs,
  seed,
  sighted,
  totals,
  uniq,
  upload,
  ACCOUNTS,
} from './support.js'

let ctx
let page
let img
const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('')

test.beforeAll(async ({ browser }) => {
  ctx = await openAs(browser, 's1')
  page = ctx.page
  await page.goto('/gold')
  img = {
    jpg: await makeImage(page, { width: 800, height: 500 }),
    png: await makeImage(page, { width: 3000, height: 2000, type: 'image/png' }),
  }
})
test.afterAll(async () => ctx?.context.close())

test.beforeEach(async () => {
  await page.unroute('**/functions/v1/gold-create-customer')
  await page.goto('/gold/customers/new')
  await expect(page.getByRole('heading', { name: 'New customer' })).toBeVisible()
})

const person = (o = {}) => ({
  first: 'Nova',
  last: `Newc${uniq()}`,
  dob: '1990-03-14',
  phone: `04${digits(2)} ${digits(3)} ${digits(3)}`,
  number: `NC${digits(7)}`,
  ...o,
})

/** Everything on the form filled and valid; photos from `img`. Pass { front: false } etc. to leave something out. */
const fillAll = async (p, { front = true, back = true, tick = true, expiry = melbourneDate(900) } = {}) => {
  await fillPerson(page, p)
  await fillId(page, { number: p.number, hasExpiry: true, expiry })
  if (front) await upload(page, 'ID front', img.jpg, { name: 'front.jpg' })
  if (back) await upload(page, 'ID back', img.jpg, { name: 'back.jpg' })
  if (tick) await sighted(page).check()
}

const create = () => page.getByRole('button', { name: 'Create customer' }).click()

/** Answers the create call itself, so a test can look at what the browser sent and nothing is saved. */
const captureCreate = (status = 500, body = { error: 'create_failed' }) => {
  const seen = []
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' }
  page.route('**/functions/v1/gold-create-customer', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    seen.push(route.request())
    return route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) })
  })
  return seen
}
const payloadOf = (req) => JSON.parse(req.postDataBuffer().toString('latin1').match(/name="payload"\r\n\r\n([\s\S]*?)\r\n--/)[1])
const errorOf = (label) => page.getByLabel(label, { exact: true }).locator('xpath=ancestor::div[starts-with(@class,"_field")][1]').locator('p[class*="_error"]')

test('8a.22 — New customer shows every field, both photo slots and an unticked sighted box', async () => {
  for (const label of [
    'First name',
    'Middle name (optional)',
    'Last name',
    'Date of birth',
    'Phone',
    'Street address',
    'Suburb',
    'State',
    'Postcode',
    'ID type',
    'ID number',
    'Issuer',
    'Country of issue',
  ]) {
    await expect(page.getByLabel(label, { exact: true }), label).toBeVisible()
  }
  await expect(page.getByText('Does the ID have an expiry date?')).toBeVisible()
  await expect(page.getByRole('radiogroup', { name: 'Does the ID have an expiry date?' }).getByRole('radio')).toHaveCount(2)
  await expect(page.getByRole('group', { name: 'ID front' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'ID back' })).toBeVisible()
  await expect(sighted(page)).not.toBeChecked()
  // Reached from the button on Find customer too.
  await page.goto('/gold')
  await page.getByRole('button', { name: 'New customer' }).click()
  await expect(page).toHaveURL(/\/gold\/customers\/new$/)
  await expect(page.getByRole('heading', { name: 'New customer' })).toBeVisible()
})

test('8a.23 — "Create customer" with nothing entered: a message on every required field, no request, focus on the first error', async () => {
  const seen = captureCreate()
  await create()
  const expected = {
    'First name': 'Enter the first name.',
    'Last name': 'Enter the last name.',
    'Date of birth': 'Enter the date of birth as DD/MM/YYYY.',
    Phone: 'Enter a contact phone number.',
    'Street address': 'Enter the street address.',
    Suburb: 'Enter the suburb.',
    State: 'Choose the state or territory.',
    Postcode: 'Postcode must be 4 digits.',
    'ID number': 'Enter the ID number.',
    Issuer: 'Enter the state or authority that issued the ID.',
  }
  for (const [label, message] of Object.entries(expected)) await expect(errorOf(label), label).toHaveText(message)
  await expect(page.getByText('Say whether the ID has an expiry date.')).toBeVisible()
  await expect(page.getByText('Take or upload a photo of the front of the ID.')).toBeVisible()
  await expect(page.getByText('Take or upload a photo of the back of the ID.')).toBeVisible()
  await expect(page.getByText('Confirm you have checked the original ID in person.')).toBeVisible()
  await expect(page.getByLabel('First name')).toBeFocused()
  expect(seen).toHaveLength(0)
})

test('8a.24 — date of birth, phone, postcode and country limits (boundaries)', async () => {
  const seen = captureCreate()
  const p = person()
  await fillAll(p)
  const tryWith = async (label, value, { message, fill = (v) => page.getByLabel(label, { exact: true }).fill(v) }) => {
    const before = seen.length
    await fill(value)
    await create()
    if (message) {
      await expect(errorOf(label), `${label} ${value}`).toHaveText(message)
      expect(seen.length, `${label} ${value} must not be sent`).toBe(before)
    } else {
      await expect.poll(() => seen.length, `${label} ${value} must be accepted`).toBe(before + 1)
      await expect(errorOf(label)).toHaveText('')
    }
  }
  const dob = { fill: (v) => page.getByLabel('Date of birth').fill(v) }
  await tryWith('Date of birth', dmy(melbourneDate(365)), { ...dob, message: 'The date of birth cannot be in the future.' })
  await tryWith('Date of birth', '31/12/1899', { ...dob, message: 'Enter a date of birth from 1900 onwards.' })
  await tryWith('Date of birth', '01/01/1900', dob)
  await page.getByLabel('Date of birth').fill(dmy(p.dob))
  await tryWith('Phone', '1234567', { message: 'Phone number looks too short.' })
  await tryWith('Phone', '12345678', {})
  await page.getByLabel('Phone', { exact: true }).fill(p.phone)
  await tryWith('Postcode', '123', { message: 'Postcode must be 4 digits.' })
  await tryWith('Postcode', '3000', {})
  for (const bad of ['A', '1A']) await tryWith('Country of issue', bad, { message: 'Use a 2-letter country code, for example AU.' })
  // a third letter cannot be typed at all: the box stops at 2 characters
  await page.getByLabel('Country of issue').fill('AUS')
  await expect(page.getByLabel('Country of issue')).toHaveValue('AU')
  await tryWith('Country of issue', 'au', {})
  // a lower-case country is sent as AU
  expect(payloadOf(seen.at(-1)).id.idCountryCode).toBe('AU')
})

test('8a.25 — Driver licence needs the back photo, Passport does not, Other needs a description', async () => {
  const seen = captureCreate()
  const p = person()
  await fillAll(p, { back: false })
  await expect(page.getByRole('group', { name: 'ID back', exact: true })).toBeVisible()
  await create()
  await expect(page.getByText('Take or upload a photo of the back of the ID.')).toBeVisible()
  expect(seen).toHaveLength(0)

  await page.getByLabel('ID type').selectOption('Passport')
  await expect(page.getByRole('group', { name: 'ID back (optional)' })).toBeVisible()
  await create()
  await expect.poll(() => seen.length).toBe(1)
  await expect(page.getByText('Take or upload a photo of the back of the ID.')).toHaveCount(0)

  await page.getByLabel('ID type').selectOption('Other')
  await expect(page.getByLabel('Describe the document')).toBeVisible()
  await create()
  await expect(page.getByText('Describe the document.')).toBeVisible()
  expect(seen).toHaveLength(1)
  await page.getByLabel('Describe the document').fill('Council photo card')
  await create()
  await expect.poll(() => seen.length).toBe(2)
  expect(payloadOf(seen[1]).id).toMatchObject({ documentType: 'Other', documentTypeOther: 'Council photo card' })
})

test('8a.26 — expiry Yes shows a required date, No hides it, a past date is refused', async () => {
  const seen = captureCreate()
  const p = person()
  await fillAll(p)
  const group = page.getByRole('radiogroup', { name: 'Does the ID have an expiry date?' })
  await expect(page.getByLabel('ID expiry date')).toBeVisible()
  await page.getByLabel('ID expiry date').fill('')
  await create()
  await expect(page.getByText('Enter the expiry date shown on the ID.')).toBeVisible()
  await page.getByLabel('ID expiry date').fill(dmy(melbourneDate(-1)))
  await create()
  await expect(page.getByText('This ID has expired. Ask the customer for a current ID.')).toBeVisible()
  expect(seen).toHaveLength(0)
  await group.getByRole('radio', { name: 'No' }).click()
  await expect(page.getByLabel('ID expiry date')).toHaveCount(0)
  await create()
  await expect.poll(() => seen.length).toBe(1)
  expect(payloadOf(seen[0]).id).toMatchObject({ hasExpiry: false })
  expect(payloadOf(seen[0]).id.expiryDate).toBeUndefined()
})

test('8a.27 — the sighted box starts unticked and an unticked box refuses the save', async () => {
  const seen = captureCreate()
  await fillAll(person(), { tick: false })
  await expect(sighted(page)).not.toBeChecked()
  await create()
  await expect(page.getByText('Confirm you have checked the original ID in person.')).toBeVisible()
  expect(seen).toHaveLength(0)
})

test('8a.28 — create with the camera for the front and an uploaded 3000 x 2000 PNG for the back', async () => {
  const p = person({ middle: 'Quinn' })
  await fillPerson(page, p)
  await fillId(page, { number: p.number, hasExpiry: true, expiry: melbourneDate(900) })
  await page.getByRole('group', { name: 'ID front' }).getByRole('button', { name: 'Take photo' }).click()
  const dialog = page.getByRole('dialog', { name: 'ID front' })
  await expect(dialog.getByRole('button', { name: 'Take photo' })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Take photo' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByAltText('ID front preview')).toBeVisible()
  await upload(page, 'ID back', img.png, { name: 'back.png', mimeType: 'image/png' })
  await expect(page.getByAltText('ID back preview')).toBeVisible()
  await sighted(page).check()
  await create()

  await expect(page).toHaveURL(/\/gold\/customers\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('status')).toHaveText('Customer created')
  await expect(page.getByRole('heading', { name: `Nova Quinn ${p.last}` })).toBeVisible()
  await expect(page.getByText(p.number)).toBeVisible()
  await expect(page.getByText('14 Mar 1990')).toBeVisible()

  const rows = await byLastName(p.last)
  expect(rows).toHaveLength(1)
  const c = rows[0]
  expect(c).toMatchObject({ source: 'gold', customer_type: 'individual', first_name: 'Nova', middle_name: 'Quinn', phone: p.phone, res_street: '12 Test Street' })
  const ids = await captures(c.id)
  expect(ids).toHaveLength(1)
  expect(ids[0]).toMatchObject({ verification_basis: 'new_capture', transaction_id: null, party_id: null, document_type: 'Driver licence', document_number: p.number })
  const images = await imageRows(c.id)
  expect(images).toHaveLength(2)
  expect(images.every((i) => i.object_exists === 1 && i.object_path.startsWith(`customers/${c.id}/`))).toBe(true)
  const audit = await auditRows(c.id)
  expect(audit).toHaveLength(1)
  expect(audit[0]).toMatchObject({ source: 'gold_create', changed_by: ACCOUNTS.s1.id })
})

test('8a.29 — both stored photos are JPEG: the 3000 x 2000 PNG as 1600 x 1067, the camera frame within 1600 px', async () => {
  const p = person()
  await fillPerson(page, p)
  await fillId(page, { number: p.number, hasExpiry: true, expiry: melbourneDate(900) })
  await page.getByRole('group', { name: 'ID front' }).getByRole('button', { name: 'Take photo' }).click()
  await page.getByRole('dialog', { name: 'ID front' }).getByRole('button', { name: 'Take photo' }).click()
  await expect(page.getByAltText('ID front preview')).toBeVisible()
  await upload(page, 'ID back', img.png, { name: 'back.png', mimeType: 'image/png' })
  await expect(page.getByAltText('ID back preview')).toBeVisible()
  await sighted(page).check()
  await create()
  await expect(page).toHaveURL(/\/gold\/customers\/[0-9a-f-]{36}$/)
  const [c] = await byLastName(p.last)
  const [capture] = await captures(c.id)
  const rows = await imageRows(c.id)
  const front = rows.find((r) => r.id === capture.front_image_id)
  const back = rows.find((r) => r.id === capture.back_image_id)
  const frontBytes = await getObject(front.object_path)
  const backBytes = await getObject(back.object_path)
  const f = jpegSize(frontBytes)
  const b = jpegSize(backBytes)
  expect(f, 'front is a JPEG').not.toBeNull()
  expect(b, 'back is a JPEG').not.toBeNull()
  expect(Math.max(f.width, f.height)).toBeLessThanOrEqual(1600)
  expect(b).toEqual({ width: 1600, height: 1067 })
  expect(front.content_type).toBe('image/jpeg')
  expect(back.content_type).toBe('image/jpeg')
})

test('8a.30 — the same name and date of birth as a customer on file raises a prompt; nothing is saved until a choice', async () => {
  const last = `Dupname${uniq()}`
  const existing = await seed({ first: 'Dora', last, dob: '1975-05-20' })
  const p = person({ first: 'Dora', last, dob: '1975-05-20' })
  const seen = captureCreate(201, { customerId: existing.id })
  await fillAll(p)
  const prompt = page.getByRole('alert').filter({ hasText: 'This may be an existing customer' })
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText(`Dora ${last}`)
  await expect(prompt).toContainText('20 May 1975')
  await create()
  await page.waitForTimeout(500)
  expect(seen).toHaveLength(0)
  expect(await byLastName(last)).toHaveLength(1)
  await prompt.getByRole('button', { name: 'Open this customer' }).click()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${existing.id}$`))

  await page.unroute('**/functions/v1/gold-create-customer')
  await page.goto('/gold/customers/new')
  await fillAll(person({ first: 'Dora', last, dob: '1975-05-20' }))
  await page.getByRole('button', { name: 'It’s a different person, continue' }).click()
  await create()
  await expect(page).toHaveURL(/\/gold\/customers\/[0-9a-f-]{36}$/)
  expect(await byLastName(last)).toHaveLength(2)
})

test('8a.31 — the same phone (any format) as another customer raises the prompt; under 8 digits cannot match', async () => {
  const last = `Dupphone${uniq()}`
  const rest = `4${digits(2)}${digits(6)}`
  const existing = await seed({ first: 'Pia', last, phone: `0${rest}` })
  const p = person({ phone: `+61 ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}` })
  const seen = captureCreate()
  await fillAll(p)
  const prompt = page.getByRole('alert').filter({ hasText: 'This may be an existing customer' })
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText(`Pia ${last}`)
  await expect(prompt).toContainText('same phone')
  await create()
  await page.waitForTimeout(400)
  expect(seen).toHaveLength(0)
  void existing

  await page.goto('/gold/customers/new')
  await fillAll(person({ phone: '0412 34' }))
  await expect(page.getByText('This may be an existing customer')).toHaveCount(0)
  await create()
  await expect(errorOf('Phone')).toHaveText('Phone number looks too short.')
  expect(seen).toHaveLength(0)
})

test('8a.32 — an ID number already on file raises the collision prompt; "different person" saves with that reason, a different type does not collide', async () => {
  const number = `COL${digits(7)}`
  const owner = await seed({ first: 'Olive', last: `Owner${uniq()}`, id: { number } })
  const p = person({ number })
  await fillAll(p)
  const prompt = page.getByRole('alert').filter({ hasText: 'This ID is already on file' })
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText(owner.last)
  await create()
  await page.waitForTimeout(400)
  expect(await byLastName(p.last)).toHaveLength(0)
  await prompt.getByRole('button', { name: 'Open that customer' }).click()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${owner.id}$`))

  await page.goto('/gold/customers/new')
  const q = person({ number })
  await fillAll(q)
  await page.getByRole('button', { name: 'It’s a different person, continue' }).click()
  await create()
  await expect(page).toHaveURL(/\/gold\/customers\/[0-9a-f-]{36}$/)
  const [c] = await byLastName(q.last)
  expect((await captures(c.id))[0].new_capture_reason).toBe('different_person')

  await page.goto('/gold/customers/new')
  await fillAll(person({ number }))
  await page.getByLabel('ID type').selectOption('Passport')
  await page.getByLabel('ID number').blur()
  await page.waitForTimeout(400)
  await expect(page.getByText('This ID is already on file')).toHaveCount(0)
})

test('8a.33 — a server refusal (validation_failed, create_failed) shows its messages, keeps the form and leaves nothing behind', async () => {
  const before = await totals()
  const p = person({ number: 'X'.repeat(101) })
  await fillAll(p)
  const refused = page.waitForResponse((r) => r.url().includes('/functions/v1/gold-create-customer'))
  await create()
  const res = await refused
  expect(res.status()).toBe(400)
  const body = await res.json()
  expect(body.error).toBe('validation_failed')
  const message = Object.values(body.fields)[0]
  await expect(page.getByText(message, { exact: true })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'Check the highlighted fields.' })).toBeVisible()
  await expect(page.getByLabel('First name')).toHaveValue('Nova')
  await expect(page.getByLabel('Last name')).toHaveValue(p.last)
  await expect(page.getByAltText('ID front preview')).toBeVisible()
  expect(await totals()).toEqual(before)

  // create_failed: the function's generic failure
  await page.getByLabel('ID number').fill(`CF${digits(7)}`)
  captureCreate(500, { error: 'create_failed' })
  await create()
  await expect(page.getByRole('alert').filter({ hasText: 'Could not save. Try again.' })).toBeVisible()
  await expect(page.getByLabel('Last name')).toHaveValue(p.last)
  await expect(page.getByAltText('ID front preview')).toBeVisible()
  expect(await totals()).toEqual(before)
})

test('8a.34 — a double click creates one customer; Cancel saves nothing and returns to /gold', async () => {
  const p = person()
  await fillAll(p)
  let calls = 0
  await page.route('**/functions/v1/gold-create-customer', async (route) => {
    if (route.request().method() === 'POST') {
      calls++
      await new Promise((r) => setTimeout(r, 1500))
    }
    await route.continue()
  })
  await create()
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled()
  await page.getByRole('button', { name: 'Saving…' }).click({ force: true })
  await expect(page).toHaveURL(/\/gold\/customers\/[0-9a-f-]{36}$/)
  expect(calls).toBe(1)
  expect(await byLastName(p.last)).toHaveLength(1)

  await page.unroute('**/functions/v1/gold-create-customer')
  await page.goto('/gold/customers/new')
  const q = person()
  await fillAll(q)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page).toHaveURL(/\/gold$/)
  expect(await byLastName(q.last)).toHaveLength(0)
})

test('8a.35 — on the dev server "Fill with test data" fills every field and both photos, and the form saves', async () => {
  await page.getByRole('button', { name: 'Fill with test data' }).click()
  await expect(page.getByAltText('ID front preview')).toBeVisible()
  await expect(page.getByAltText('ID back preview')).toBeVisible()
  for (const label of ['First name', 'Last name', 'Date of birth', 'Street address', 'Suburb', 'Postcode', 'ID number', 'Issuer']) {
    await expect(page.getByLabel(label, { exact: true }), label).not.toHaveValue('')
  }
  await expect(sighted(page)).toBeChecked()
  const last = await page.getByLabel('Last name').inputValue()
  await create()
  await expect(page).toHaveURL(/\/gold\/customers\/[0-9a-f-]{36}$/)
  expect(await byLastName(last)).toHaveLength(1)
})
