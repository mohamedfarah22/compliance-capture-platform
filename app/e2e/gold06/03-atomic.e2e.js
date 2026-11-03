// Gold Phase 6 UAT, section D: atomic writes (spec 4.5). A check constraint that only the dummy values
// trip makes the database refuse part-way through; nothing may be left in rows or in storage.
// Each row adds and drops its own constraint, so the rows are independent of one another.
import { expect, test } from '@playwright/test'
import { AAL2, BOTH, create, edit, edgeLogs, fixtures, idPayload, makeCustomer, newCustomer, photo, tag, q1, q3, q4, q5, sql, totals, updateId } from './support.js'

const S1 = () => AAL2('s1')

// Runs fn with `check` on ttr.id_verifications (or public.customers) that refuses one dummy value.
const withBlock = async (table, name, check, fn) => {
  await sql.unsafe(`alter table ${table} add constraint ${name} check (${check}) not valid`)
  try {
    return await fn()
  } finally {
    await sql.unsafe(`alter table ${table} drop constraint if exists ${name}`)
  }
}

const failingCreate = (number, changes = {}) => newCustomer({ 'id.documentNumber': number, firstName: `Fay${tag()}`, ...changes })

test('6.77 ⚠ — a database failure after the photos are uploaded leaves no customer, alias, image, audit row or object', async () => {
  await withBlock('ttr.id_verifications', 'uat6_block', `document_number <> 'UAT6-FAIL-1'`, async () => {
    const before = await totals()
    const payload = failingCreate('UAT6-FAIL-1')
    const res = await create(S1(), payload, BOTH())
    expect([res.status, res.body]).toEqual([500, { error: 'create_failed' }])
    expect(await totals()).toEqual(before)
    expect((await sql`select count(*)::int as n from public.customers where first_name = ${payload.firstName}`)[0].n).toBe(0)
  })
})

test('6.78 — with the constraint gone the same call succeeds and the customer exists once', async () => {
  const payload = failingCreate('UAT6-FAIL-3')
  await withBlock('ttr.id_verifications', 'uat6_block_b', `document_number <> 'UAT6-FAIL-3'`, async () => {
    expect((await create(S1(), payload, BOTH())).status).toBe(500)
  })
  const res = await create(S1(), payload, BOTH())
  expect(res.status, res.text).toBe(201)
  expect((await sql`select count(*)::int as n from public.customers where first_name = ${payload.firstName}`)[0].n).toBe(1)
  expect((await sql`select count(*)::int as n from ttr.id_verifications where document_number = 'UAT6-FAIL-3'`)[0].n).toBe(1)
})

test('6.79 ⚠ — a failed Update ID adds no capture, no image and no object', async () => {
  const frank = await makeCustomer()
  const [captures, images] = [await q3(frank.id), await q4(frank.id)]
  await withBlock('ttr.id_verifications', 'uat6_block2', `document_number <> 'UAT6-FAIL-2'`, async () => {
    const before = await totals()
    const res = await updateId(
      S1(),
      idPayload(frank.id, { reason: 'different_document', documentType: 'Passport', documentNumber: 'UAT6-FAIL-2', issuer: 'Australia', hasExpiry: false, expiryDate: undefined }),
      { front: photo('front2') },
    )
    expect([res.status, res.body]).toEqual([500, { error: 'update_failed' }])
    expect(await q3(frank.id)).toEqual(captures)
    expect(await q4(frank.id)).toEqual(images)
    expect(await totals()).toEqual(before)
  })
})

test('6.80 ⚠ — a failed edit changes none of the fields sent and writes no audit row', async () => {
  const erin = await makeCustomer({ firstName: 'Erin' })
  const [row, audit] = [await q1(erin.id), await q5(erin.id)]
  await withBlock('public.customers', 'uat6_block3', `last_name <> 'Uatsixblock'`, async () => {
    const res = await edit(AAL2('m1'), { customerId: erin.id, changes: { firstName: 'Changed', lastName: 'Uatsixblock' } })
    expect([res.status, res.body]).toEqual([500, { error: 'update_failed' }])
    expect(await q1(erin.id)).toEqual(row)
    expect(await q5(erin.id)).toEqual(audit)
  })
})

test('6.82 — a failed create is logged with ids and an error code and none of the personal data', async () => {
  const since = new Date(Date.now() - 2000).toISOString()
  const payload = failingCreate('UAT6-FAIL-5')
  await withBlock('ttr.id_verifications', 'uat6_block5', `document_number <> 'UAT6-FAIL-5'`, async () => {
    expect((await create(S1(), payload, BOTH())).status).toBe(500)
  })
  let logs = ''
  await expect
    .poll(
      () => {
        logs = edgeLogs(since)
        return logs
      },
      { timeout: 15_000 },
    )
    .toMatch(/gold-create-customer: save failed/)
  // The logger prints the object over several lines: take the entry that follows the message.
  const at = logs.indexOf('gold-create-customer: save failed')
  const entry = logs.slice(at, logs.indexOf('}', at) + 1)
  expect(entry).toContain(fixtures().staff.s1.id)
  expect(entry).toMatch(/23514/)
  for (const secret of [payload.firstName, 'UAT6-FAIL-5', 'Uatsix', payload.phone, payload.dateOfBirth, payload.email]) expect(logs).not.toContain(secret)
})

test('6.136 — no orphan photo remains under customers/ after failed creates and failed Update IDs', async () => {
  const frank = await makeCustomer()
  await withBlock('ttr.id_verifications', 'uat6_block6', `document_number like 'UAT6-OK-%'`, async () => {
    expect((await create(S1(), failingCreate('UAT6-FAIL-6'), BOTH())).status).toBe(500)
    const res = await updateId(S1(), idPayload(frank.id, { reason: 'different_document', documentType: 'Passport', documentNumber: 'UAT6-FAIL-7', issuer: 'Australia' }), { front: photo('front2') })
    expect(res.status).toBe(500)
  })
  const orphans = await sql`
    select o.name from storage.objects o
    where o.bucket_id = 'compliance-media' and o.name like 'customers/%'
      and not exists (select 1 from ttr.stored_images i where i.object_path = o.name and i.storage_bucket = o.bucket_id)`
  expect(orphans).toEqual([])
})
