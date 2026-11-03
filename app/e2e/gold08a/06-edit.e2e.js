// Gold Phase 8a UAT, Edit details (spec 2.3, 4.3, 4.5, 5.2 CustomerForm edit): managers and admins, against gold-update-customer.
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { ACCOUNTS, auditRows, customerRow, dmy, openAs, seed, sql, uniq, E1 } from './support.js'
import { localEnv } from '../support/env.js'

let manager
let admin
let staff

test.beforeAll(async ({ browser }) => {
  manager = await openAs(browser, 'm1')
  admin = await openAs(browser, 'a1')
  staff = await openAs(browser, 's1')
})
test.afterAll(async () => {
  for (const x of [manager, admin, staff]) await x?.context.close()
})

const fullCustomer = async () => {
  return seed({
    first: 'Edna',
    middle: 'Mae',
    last: `Edit${uniq()}`,
    dob: '1970-04-09',
    phone: '0411 222 333',
    profile: { gender: 'F', email: 'edna@example.test', occupation: 'Jeweller', citizenship: 'AU', taxResidency: 'NZ' },
    id: { front: null },
  })
}
const editPage = async (page, c) => {
  await page.goto(`/gold/customers/${c.id}`)
  await page.getByRole('button', { name: 'Edit details' }).click()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}/edit$`))
  await expect(page.getByRole('heading', { name: 'Edit details' })).toBeVisible()
}
const watchEdits = (page) => {
  const sent = []
  page.on('request', (r) => r.url().includes('/functions/v1/gold-update-customer') && r.method() === 'POST' && sent.push(r))
  return sent
}

test('8a.47 — a manager and an admin can open Edit details: prefilled profile fields, no ID fields', async () => {
  for (const who of [manager, admin]) {
    const c = await fullCustomer()
    await editPage(who.page, c)
    const v = (label, value) => expect(who.page.getByLabel(label, { exact: true }), label).toHaveValue(value)
    await v('First name', 'Edna')
    await v('Middle name (optional)', 'Mae')
    await v('Last name', c.last)
    await v('Date of birth', '09/04/1970')
    await v('Gender', 'F')
    await v('Phone', '0411 222 333')
    await v('Email (optional)', 'edna@example.test')
    await v('Occupation (optional)', 'Jeweller')
    await v('Street address', '1 Test St')
    await v('Suburb', 'Coburg')
    await v('State', 'VIC')
    await v('Postcode', '3058')
    await v('Citizenship country (optional)', 'AU')
    await v('Tax residency country (optional)', 'NZ')
    for (const idField of ['ID type', 'ID number', 'Issuer', 'Country of issue']) {
      await expect(who.page.getByLabel(idField, { exact: true })).toHaveCount(0)
    }
    await expect(who.page.getByRole('group', { name: /ID front/ })).toHaveCount(0)
  }
})

test('8a.48 — a manager changes last name, date of birth and street: one gold_edit audit row for exactly those columns; past TTR party copies unchanged', async () => {
  const c = await fullCustomer()
  const tx = randomUUID()
  const party = randomUUID()
  await sql`insert into ttr.transactions (id, reporting_entity_id, scenario, transaction_ref, transaction_datetime, designated_service,
      location_snapshot, staff_member_name, staff_member_email, cash_currency, cash_amount, aud_value, status, completed_at)
    values (${tx}, ${E1}, 'bullion_sell', ${`UAT8A-TX-${uniq()}`}, '2026-01-01', 'Sale of bullion for physical cash',
      'Coburg, VIC', 'Staff', 'staff@example.test', 'AUD', 15000, 15000, 'complete', '2026-01-01')`
  await sql`insert into ttr.parties (id, transaction_id, party_type, first_name, last_name, date_of_birth, phone, res_street, res_suburb, res_state, res_postcode, customer_id)
    values (${party}, ${tx}, 'individual', ${'Edna'}, ${c.last}, '1970-04-09', '0411 222 333', '1 Test St', 'Coburg', 'VIC', '3058', ${c.id})`
  const partyHash = async () => (await sql`select md5(to_jsonb(p)::text) as h from ttr.parties p where id = ${party}`)[0].h
  const before = await partyHash()
  const { page } = manager
  await editPage(page, c)
  const newLast = `${c.last}x`
  await page.getByLabel('Last name').fill(newLast)
  await page.getByLabel('Date of birth').fill(dmy('1971-05-10'))
  await page.getByLabel('Street address').fill('99 New Road')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page).toHaveURL(new RegExp(`/gold/customers/${c.id}$`))
  await expect(page.getByRole('status')).toHaveText('Details updated')
  await expect(page.getByRole('heading', { name: `Edna Mae ${newLast}` })).toBeVisible()
  await expect(page.getByText('10 May 1971')).toBeVisible()
  await expect(page.getByText('99 New Road, Coburg VIC 3058')).toBeVisible()

  const row = await customerRow(c.id)
  expect(row).toMatchObject({ last_name: newLast, res_street: '99 New Road' })
  const audit = await auditRows(c.id)
  expect(audit).toHaveLength(1)
  expect(audit[0]).toMatchObject({ source: 'gold_edit', changed_by: ACCOUNTS.m1.id })
  expect(Object.keys(audit[0].changes).sort()).toEqual(['date_of_birth', 'last_name', 'res_street'])
  const text = JSON.stringify(audit[0].changes)
  for (const piece of [c.last, newLast, '1970-04-09', '1971-05-10', '1 Test St', '99 New Road']) expect(text).toContain(piece)
  expect(await partyHash(), 'the past TTR party copy is unchanged').toBe(before)
})

test('8a.49 — nothing changed, a blank first name and a 7-digit phone are refused and nothing is saved', async () => {
  const c = await fullCustomer()
  const { page } = manager
  const sent = watchEdits(page)
  await editPage(page, c)
  const save = () => page.getByRole('button', { name: 'Save changes' }).click()
  await save()
  await expect(page.getByRole('alert')).toHaveText('Change at least one field.')
  await page.getByLabel('First name').fill('')
  await save()
  await expect(page.getByText('Enter the first name.')).toBeVisible()
  await page.getByLabel('First name').fill('Edna')
  await page.getByLabel('Phone', { exact: true }).fill('1234567')
  await save()
  await expect(page.getByText('Phone number looks too short.')).toBeVisible()
  expect(sent).toHaveLength(0)
  expect(await auditRows(c.id)).toHaveLength(0)
  expect((await customerRow(c.id)).phone).toBe('0411 222 333')
})

test('8a.50 — staff: no Edit details button, the edit URL is refused without loading the customer, and the function answers 403', async () => {
  const c = await fullCustomer()
  const { page, session } = staff
  const reads = []
  page.on('request', (r) => /\/rest\/v1\/(customers|rpc\/customer_current_id)/.test(r.url()) && reads.push(r.url()))
  await page.goto(`/gold/customers/${c.id}`)
  await expect(page.getByRole('heading', { name: new RegExp(c.last) })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit details' })).toHaveCount(0)
  reads.length = 0
  await page.goto(`/gold/customers/${c.id}/edit`)
  await expect(page.getByText('You are not authorised to view this page.')).toBeVisible()
  await expect(page.getByLabel('First name')).toHaveCount(0)
  await page.waitForTimeout(500)
  expect(reads, 'no customer data requested').toEqual([])

  const { API_URL, ANON_KEY } = localEnv()
  const res = await fetch(`${API_URL}/functions/v1/gold-update-customer`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerId: c.id, changes: { occupation: 'Hacker' } }),
  })
  expect(res.status).toBe(403)
  expect((await customerRow(c.id)).occupation).toBe('Jeweller')
  expect(await auditRows(c.id)).toHaveLength(0)
})
