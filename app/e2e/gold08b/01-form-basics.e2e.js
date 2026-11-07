// Gold Phase 8b UAT, section A (rows 8b.1 to 8b.7): the Record purchase form on the customer page
// (spec 1.7 C3, 4.5, 5.2 CustomerDetail row). Real gold-save-purchase behind the real screens.
import { expect, test } from '@playwright/test'
import {
  addGoodsPhoto,
  goodsBytes,
  goodsPhotoRows,
  headerCount,
  jane,
  jpegSize,
  makeImage,
  open,
  openCustomer,
  purchasesOf,
  recordButton,
  scrapCash,
  bullionBand,
  sightedBox,
  typeOption,
} from './support.js'

let ctx
let page
let img
test.beforeAll(async ({ browser }) => {
  ctx = await open(browser, 's1')
  page = ctx.page
  await page.goto('/gold')
  img = await makeImage(page, { width: 800, height: 500, label: 'Goods' })
})
test.afterAll(async () => ctx?.context.close())

const MISMATCH = "ID must be sighted today and match the record on file. Doesn't match the record? Update ID first."

test('8b.1 — a new purchase form has the sighted box unticked, the "Update ID first" hint, and an enabled Record purchase button', async () => {
  const c = await jane()
  await openCustomer(page, c)
  await expect(sightedBox(page)).not.toBeChecked()
  await expect(page.getByText("Doesn't match the record? Update ID first.")).toBeVisible()
  await expect(recordButton(page)).toBeEnabled()
})

test('8b.2 — the sighted box left unticked stops the save with the "must be sighted today" error', async () => {
  const c = await jane()
  await openCustomer(page, c)
  await addGoodsPhoto(page, img)
  await recordButton(page).click()
  await expect(page.getByRole('alert').filter({ hasText: MISMATCH })).toBeVisible()
  expect(await purchasesOf(c.id)).toHaveLength(0)
})

test('8b.3 — no goods photo stops the save with "Add at least one photo"; with a photo it saves', async () => {
  const c = await jane()
  await openCustomer(page, c)
  await sightedBox(page).check()
  await recordButton(page).click()
  await expect(page.getByText('Add at least one photo of the items purchased.')).toBeVisible()
  expect(await purchasesOf(c.id)).toHaveLength(0)
  await addGoodsPhoto(page, img)
  await recordButton(page).click()
  await expect(page.getByRole('status').filter({ hasText: 'Purchase recorded' })).toBeVisible()
  expect(await purchasesOf(c.id)).toHaveLength(1)
})

test('8b.4 — a 3000 x 2000 PNG goes to the server as a JPEG of 1600 px or less; an 11th photo is refused', async () => {
  const c = await jane()
  await openCustomer(page, c)
  const png = await makeImage(page, { width: 3000, height: 2000, type: 'image/png', label: 'Big' })
  await addGoodsPhoto(page, png, 'big.png', 'image/png')
  await expect(page.getByRole('img', { name: 'Goods photo 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove goods photo 1' })).toBeVisible()
  await sightedBox(page).check()
  await recordButton(page).click()
  await expect(page.getByRole('status').filter({ hasText: 'Purchase recorded' })).toBeVisible()
  const [p] = await purchasesOf(c.id)
  const [photo] = await goodsPhotoRows(p.id)
  expect(photo.content_type).toBe('image/jpeg')
  const size = jpegSize(await goodsBytes(photo.storage_bucket, photo.object_path))
  expect(size, 'the stored file is a JPEG').not.toBeNull()
  expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1600)

  await openCustomer(page, c)
  for (let i = 1; i <= 10; i++) await addGoodsPhoto(page, await makeImage(page, { width: 200, height: 150, label: `P${i}` }), `p${i}.jpg`)
  await expect(page.getByRole('img', { name: /^Goods photo \d+$/ })).toHaveCount(10)
  await expect(page.getByText('You can add up to 10 photos.')).toBeVisible()
  await expect(page.getByLabel('Photos of items purchased (required) file')).toHaveCount(0)
})

test('8b.5 — a scrap purchase with no invoice saves: toast, empty form, history row "No invoice number yet", To complete count up by one', async () => {
  const c = await jane()
  await openCustomer(page, c)
  const before = await headerCount(page)
  await addGoodsPhoto(page, img)
  await sightedBox(page).check()
  await recordButton(page).click()
  await expect(page.getByText('Purchase recorded. Add the invoice number later from To complete.')).toBeVisible()
  await expect(sightedBox(page)).not.toBeChecked()
  await expect(page.getByRole('img', { name: /^Goods photo/ })).toHaveCount(0)
  const row = page.getByRole('listitem').filter({ hasText: 'No invoice number yet' })
  await expect(row).toContainText('Scrap')
  await expect(row).toContainText('Incomplete')
  await expect(row).toContainText('1 photo')
  await expect.poll(() => headerCount(page)).toBe(before + 1)
})

test('8b.6 — the cash question: bullion bands show their hints and the amount box only for "$10,000 or more"; scrap Yes shows the amount box', async () => {
  const c = await jane()
  await openCustomer(page, c)
  await typeOption(page, 'Bullion').click()
  await bullionBand(page, 'Under $5,000').click()
  await expect(page.getByLabel('Cash amount (AUD, optional)')).toHaveCount(0)
  await bullionBand(page, '$5,000 to $9,999').click()
  await expect(page.getByLabel('Cash amount (AUD, optional)')).toHaveCount(0)
  await expect(page.getByText('Needs this customer’s current ID. No AUSTRAC report.')).toBeVisible()
  await bullionBand(page, '$10,000 or more').click()
  await expect(page.getByLabel('Cash amount (AUD, optional)')).toBeVisible()
  await typeOption(page, 'Scrap jewellery').click()
  await expect(page.getByLabel('Cash amount (AUD, optional)')).toHaveCount(0)
  await scrapCash(page, 'Yes').click()
  await expect(page.getByLabel('Cash amount (AUD, optional)')).toBeVisible()
})

test('8b.7 — a 7-digit phone is refused and nothing is saved; a new 8-digit phone shows the hint and updates the customer', async () => {
  const c = await jane()
  await openCustomer(page, c)
  await addGoodsPhoto(page, img)
  await sightedBox(page).check()
  await page.getByLabel('Phone for this purchase').fill('0412 345')
  await recordButton(page).click()
  await expect(page.getByText('Phone number looks too short.')).toBeVisible()
  expect(await purchasesOf(c.id)).toHaveLength(0)
  await page.getByLabel('Phone for this purchase').fill('0499 888 777')
  await expect(page.getByText('Different from the customer record. Saving the purchase also updates the customer’s phone number.')).toBeVisible()
  await recordButton(page).click()
  await expect(page.getByRole('status').filter({ hasText: 'Purchase recorded' })).toBeVisible()
  await expect(page.getByText('0499 888 777').first()).toBeVisible()
  expect((await purchasesOf(c.id))[0].phone).toContain('0499')
})
