// Gold Phase 6 UAT, section H: the existing TTR wizard shares the ID store with gold (spec 1.6 "Uniqueness and
// collisions", rows 6.133 to 6.135). Signed in through the real login and second factor.
import { expect, test } from '@playwright/test'
import { signedInContext } from '../support/auth.js'
import * as w from '../support/wizard.js'
import { makeCustomer, tag } from './support.js'

test.describe.configure({ mode: 'serial' })

let context
let page
let alice

test.beforeAll(async ({ browser }) => {
  context = await signedInContext(browser, 'admin')
  page = await context.newPage()
  alice = await makeCustomer({ firstName: 'Alicia', middleName: '', lastName: 'Uatsixwiz', dateOfBirth: '1985-03-14', phone: '0412 345 701', aliases: [] })
})

test.afterAll(async () => {
  await context.close()
})

test('6.133 ⚠ — in the TTR wizard a licence number that gold holds raises the existing collision prompt', async () => {
  await w.startTransaction(page, { scenario: 'Sell bullion to customer', ref: `UAT6-W-${tag()}` })
  await w.createCustomer(page, { type: 'individual', firstName: 'Zed', lastName: 'Uatsixwiz', dateOfBirth: '1990-01-02', phone: '0412 999 888', email: 'zed@example.test' })
  await w.confirmOwnBehalf(page, 'Zed Uatsixwiz')
  await w.setVerificationMethod(page, 'Sighted original document')
  await w.enterDocument(page, { type: 'Driver licence', number: alice.payload.id.documentNumber })
  await expect(page.getByText(`Driver licence ${alice.payload.id.documentNumber} is already on file`)).toBeVisible()
  await expect(page.getByText(/a different person/)).toBeVisible()
})

test('6.134 — in the wizard a licence number nobody holds raises no prompt', async () => {
  await page.getByLabel('Document or reference number').fill(`UAT6-DL-8888-${tag()}`)
  await page.getByLabel('Document or reference number').blur()
  await expect(page.getByText(/is already on file/)).toHaveCount(0)
})

test('6.135 — in the wizard a gold customer found by name and date of birth brings their gold-captured ID as the prior verification', async () => {
  await w.startTransaction(page, { scenario: 'Sell bullion to customer', ref: `UAT6-W-${tag()}` })
  await w.addExistingIndividual(page, { firstName: 'Alicia', lastName: 'Uatsixwiz', dateOfBirth: '1985-03-14', fullName: 'Alicia Uatsixwiz' })
  await w.confirmOwnBehalf(page, 'Alicia Uatsixwiz')
  await expect(page.getByLabel('Verification method')).toHaveValue('Relied on prior identification')
  await expect(page.getByLabel('Document or reference number')).toHaveValue(alice.payload.id.documentNumber)
})
