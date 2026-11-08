// Gold Phase 8b UAT, section A (rows 8b.26 to 8b.31): the joint-seller dialog and a joint sale (spec 3.3, 5.2, 5.4).
import { expect, test } from '@playwright/test'
import {
  freshTab,
  addJoint,
  dmy,
  fillCommon,
  fillId,
  fillPerson,
  inv,
  invoiceBox,
  jane,
  makeImage,
  melbourneDate,
  open,
  openCustomer,
  partiesOf,
  purchasesOf,
  recordButton,
  scrapCash,
  sighted,
  sightedBox,
  txByRef,
  uniq,
  upload,
} from './support.js'

let ctx
let page
let img
test.beforeAll(async ({ browser }) => {
  ctx = await open(browser, 's1')
  page = ctx.page
  img = await makeImage(page, { width: 800, height: 500, label: 'Goods' })
})
test.afterAll(async () => ctx?.context.close())
// A new tab's state for each test: the wizard keeps its active draft in sessionStorage.
test.beforeEach(async () => freshTab(page))

const ADD = 'Add second person (joint sale)'
const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('')

test('8b.26 — the Add second person dialog focuses the search, shows the main seller as "Already the main seller", and Escape returns the focus to the button', async () => {
  const c = await jane()
  await openCustomer(page, c)
  await page.getByRole('button', { name: ADD }).click()
  const dialog = page.getByRole('dialog', { name: 'Add second person' })
  await expect(dialog.getByLabel('Search')).toBeFocused()
  await dialog.getByLabel('Search').fill(c.last)
  const own = dialog.getByRole('button', { name: new RegExp(c.name) })
  await expect(own).toBeDisabled()
  await expect(own).toContainText('Already the main seller')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: ADD })).toBeFocused()
})

test('8b.27 — picking Joan closes the dialog and shows the Joint seller row (ID, badge, View ID, Remove); the box says both people; Remove brings the button back with focus', async () => {
  const c = await jane()
  const joan = await jane({ first: 'Joan' })
  await openCustomer(page, c)
  await addJoint(page, joan)
  const row = page.getByText('Joint seller', { exact: true }).locator('xpath=..')
  await expect(row).toContainText(joan.name)
  await expect(row).toContainText('Driver licence')
  await expect(row.getByRole('button', { name: 'View ID' })).toBeVisible()
  await expect(row.getByText(/valid|expired|re-verif/i).first()).toBeVisible()
  await expect(page.getByText('Both people and their IDs sighted in person today')).toBeVisible()
  await row.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByRole('button', { name: ADD })).toBeFocused()
  await expect(page.getByText('Customer and ID sighted in person today')).toBeVisible()
})

test('8b.28 — a joint sale shows no counter questions and, with reportable cash and no invoice, asks for the invoice and saves nothing', async () => {
  const c = await jane()
  const joan = await jane({ first: 'Joan' })
  await openCustomer(page, c)
  await addJoint(page, joan)
  await scrapCash(page, 'Yes').click()
  await fillCommon(page, img)
  await expect(page.getByText('Are these details still correct?')).toHaveCount(0)
  await recordButton(page).click()
  await expect(page.getByText(`Enter the ERP invoice number. The AUSTRAC report for ${c.name} must be started now.`)).toBeVisible()
  expect(await purchasesOf(c.id)).toHaveLength(0)
})

test('8b.29 — a joint sale with the invoice is case B: the TTR has both people as parties, and both customer pages list the purchase with a "Joint sale with" link', async () => {
  const c = await jane()
  const joan = await jane({ first: 'Joan' })
  const number = inv('B9')
  await openCustomer(page, c)
  await addJoint(page, joan)
  await scrapCash(page, 'Yes').click()
  await fillCommon(page, img, { invoice: number })
  await page.getByRole('button', { name: 'Record purchase and continue to AUSTRAC' }).click()
  await expect(page).toHaveURL(/\/customers$/)
  const [tx] = await txByRef(number)
  expect((await partiesOf(tx.id)).map((p) => p.customer_id).sort()).toEqual([c.id, joan.id].sort())
  await page.goto(`/gold/customers/${c.id}`)
  await expect(page.getByText(`Joint sale with ${joan.name}`)).toBeVisible()
  await expect(page.getByRole('link', { name: joan.name })).toBeVisible()
  await page.goto(`/gold/customers/${joan.id}`)
  await expect(page.getByText(`Joint sale with ${c.name}`)).toBeVisible()
  await expect(page.getByRole('link', { name: c.name })).toBeVisible()
  await expect(page.getByRole('link', { name: `View purchase ${number}` })).toBeVisible()
})

test('8b.30 — New customer from the dialog creates the person and returns to the main seller\'s page with them attached and the form as left', async () => {
  const c = await jane()
  const number = inv('B10')
  await openCustomer(page, c)
  await fillCommon(page, img, { invoice: number })
  await page.getByRole('button', { name: ADD }).click()
  await page.getByRole('dialog', { name: 'Add second person' }).getByRole('button', { name: 'New customer' }).click()
  await expect(page.getByRole('heading', { name: 'New customer' })).toBeVisible()
  const pat = { first: 'Pat', last: `Newman${uniq()}`, dob: '1990-03-14', phone: `04${digits(2)} ${digits(3)} ${digits(3)}`, number: `PN${digits(7)}` }
  await fillPerson(page, pat)
  await fillId(page, { number: pat.number, hasExpiry: true, expiry: melbourneDate(900) })
  await upload(page, 'ID front', img, { name: 'front.jpg' })
  await upload(page, 'ID back', img, { name: 'back.jpg' })
  await sighted(page).check()
  await page.getByRole('button', { name: 'Create customer' }).click()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}$`))
  await expect(page.getByText('Joint seller', { exact: true })).toBeVisible()
  await expect(page.getByText(`Pat ${pat.last}`, { exact: true })).toBeVisible()
  await expect(invoiceBox(page)).toHaveValue(number)
  await expect(page.getByRole('img', { name: 'Goods photo 1' })).toBeVisible()
})

test('8b.31 — an expired joint seller blocks the cash sale (named as joint seller); renewing the ID returns to the main seller\'s page with the joint seller still attached', async () => {
  const c = await jane()
  const joan = await jane({ first: 'Joan', id: { expiry: '2020-01-01' } })
  await openCustomer(page, c)
  await addJoint(page, joan)
  await scrapCash(page, 'Yes').click()
  const alert = page.getByRole('alert').filter({ hasText: 'An expired ID cannot go into an AUSTRAC report.' })
  await expect(alert).toContainText(`${joan.name} (joint seller): ID expired on`)
  await alert.getByRole('button', { name: 'Update ID now' }).click()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${joan.id}/update-id$`))
  await page.getByRole('radio', { name: /^Renewed/ }).check()
  await page.getByLabel('ID expiry date').fill(dmy(melbourneDate(1500)))
  await upload(page, 'ID front', img)
  await upload(page, 'ID back', img)
  await sighted(page).check()
  await page.getByRole('button', { name: 'Save new ID' }).click()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}$`))
  await expect(page.getByText('Joint seller', { exact: true })).toBeVisible()
  await expect(page.getByText(joan.name).first()).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'An expired ID cannot go into an AUSTRAC report.' })).toHaveCount(0)
  await expect(sightedBox(page)).not.toBeChecked()
})
