// Gold Phase 6 UAT, section E: gold-update-customer-id (spec 1.6 "Gold Update ID", 5.2, 6.1).
import { expect, test } from '@playwright/test'
import {
  AAL2,
  idPayload,
  makeCustomer,
  photo,
  q3,
  q4,
  q5,
  rpc,
  sql,
  tag,
  updateId,
} from './support.js'

test.describe.configure({ mode: 'serial' })

const S1 = () => AAL2('s1')
const NUM = `UAT6-DL-${tag()}`
const two = (a, b) => ({ front: photo(a), back: photo(b) })
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d)

let carol
let carolFirst // the original capture
let renewal // the 6.83 capture row
let passportPhotos
let beforeRenewal // Q4 before 6.83

test.beforeAll(async () => {
  carol = await makeCustomer({ firstName: 'Carol', 'id.documentNumber': NUM })
  carolFirst = (await q3(carol.id))[0]
  beforeRenewal = await q4(carol.id)
})

const U1 = (changes = {}) => idPayload(carol.id, { documentNumber: NUM, ...changes })
const live = (rows) => rows.filter((r) => r.superseded_at === null)

test('6.83 ⚠ — a renewal with the same number is linked to the first capture and supersedes its two photos', async () => {
  const res = await updateId(S1(), U1(), two('front2', 'back2'))
  expect(res.status, res.text).toBe(201)
  expect(res.body.superseded).toBe(2)
  const rows = await q3(carol.id)
  expect(rows).toHaveLength(2)
  renewal = rows[1]
  expect(renewal).toMatchObject({
    new_capture_reason: 'id_changed',
    prior_verification_id: carolFirst.id,
    transaction_id: null,
    party_id: null,
    conducting_person_id: null,
    id: res.body.verificationId,
  })
  expect(iso(renewal.expiry_date)).toBe('2035-06-30')
})

test('6.84 ⚠ — the old photos are stamped superseded, their objects deleted and their rows kept; the new ones are live', async () => {
  const rows = await q4(carol.id)
  expect(rows).toHaveLength(4)
  const frontNew = rows.find((r) => r.id === renewal.front_image_id)
  for (const old of beforeRenewal) {
    const now = rows.find((r) => r.id === old.id)
    expect(now.superseded_at, 'superseded_at').not.toBeNull()
    expect(now.superseded_by_image_id).toBe(frontNew.id)
    expect(now.object_exists).toBe(0)
    expect(now.content_hash_sha256).toBe(old.content_hash_sha256)
    expect(now.captured_by_staff_id).toBe(old.captured_by_staff_id)
    expect(now.created_at).toEqual(old.created_at)
  }
  const fresh = live(rows)
  expect(fresh).toHaveLength(2)
  expect(fresh.map((r) => r.object_exists)).toEqual([1, 1])
  expect(fresh.map((r) => r.content_hash_sha256).sort()).toEqual([photo('front2').sha, photo('back2').sha].sort())
})

test('6.86 ⚠ — a different document is unlinked, supersedes nothing and adds one photo', async () => {
  const livePhotosBefore = live(await q4(carol.id)).map((r) => r.id)
  const res = await updateId(
    S1(),
    idPayload(carol.id, { reason: 'different_document', documentType: 'Passport', documentNumber: `UAT6-PP-${tag()}`, issuer: 'Australia', expiryDate: '2033-01-31' }),
    { front: photo('pp-front') },
  )
  expect(res.status, res.text).toBe(201)
  expect(res.body.superseded).toBe(0)
  const rows = await q3(carol.id)
  expect(rows.at(-1)).toMatchObject({ new_capture_reason: 'different_document', prior_verification_id: null })
  const after = await q4(carol.id)
  for (const id of livePhotosBefore) {
    const r = after.find((x) => x.id === id)
    expect([r.superseded_at, r.object_exists]).toEqual([null, 1])
  }
  expect(live(after)).toHaveLength(livePhotosBefore.length + 1)
  passportPhotos = rows.at(-1).front_image_id
})

test('6.87 ⚠ — photo unclear links to the original capture and supersedes the renewal photos, never the passport', async () => {
  const before = await q4(carol.id)
  const originals = before.filter((r) => r.superseded_at !== null)
  const res = await updateId(S1(), U1({ reason: 'photo_unclear' }), two('front3', 'back3'))
  expect(res.status, res.text).toBe(201)
  expect(res.body.superseded).toBe(2)
  const rows = await q3(carol.id)
  expect(rows.at(-1)).toMatchObject({ new_capture_reason: 'stored_copy_unclear', prior_verification_id: carolFirst.id })
  const after = await q4(carol.id)
  for (const id of [renewal.front_image_id, renewal.back_image_id]) {
    const r = after.find((x) => x.id === id)
    expect(r.superseded_at).not.toBeNull()
    expect(r.object_exists).toBe(0)
  }
  const passport = after.find((x) => x.id === passportPhotos)
  expect([passport.superseded_at, passport.object_exists]).toEqual([null, 1])
  const newest = after.filter((r) => [rows.at(-1).front_image_id, rows.at(-1).back_image_id].includes(r.id))
  expect(newest.map((r) => [r.superseded_at, r.object_exists])).toEqual([[null, 1], [null, 1]])
  for (const o of originals) {
    const r = after.find((x) => x.id === o.id)
    expect(r.superseded_by_image_id).toBe(o.superseded_by_image_id)
    expect(r.superseded_at).toEqual(o.superseded_at)
  }
})

test('6.88 ⚠ — a renewal with a new number is unlinked and leaves the old number’s photos live', async () => {
  const before = live(await q4(carol.id))
  const res = await updateId(S1(), U1({ documentNumber: `${NUM}-B` }), two('front2', 'back2'))
  expect(res.status, res.text).toBe(201)
  expect(res.body.superseded).toBe(0)
  expect((await q3(carol.id)).at(-1)).toMatchObject({ new_capture_reason: 'id_changed', prior_verification_id: null, document_number: `${NUM}-B` })
  const after = await q4(carol.id)
  for (const b of before) expect([after.find((x) => x.id === b.id).superseded_at, after.find((x) => x.id === b.id).object_exists]).toEqual([null, 1])
})

test('6.98 — the current ID is the newest capture', async () => {
  const res = await rpc('customer_current_id', S1(), { p_customer_id: carol.id })
  expect(res.status, res.text).toBe(200)
  const row = Array.isArray(res.body) ? res.body[0] : res.body
  expect(row.document_number).toBe(`${NUM}-B`)
})

test('6.99 — updating an ID writes no customer audit row: Carol has only her gold_create row', async () => {
  const rows = await q5(carol.id)
  expect(rows.map((r) => r.source)).toEqual(['gold_create'])
})

test('6.100 — every image sits under customers/<customer>/<its own capture>/', async () => {
  const captures = await q3(carol.id)
  for (const image of await q4(carol.id)) {
    const owner = captures.find((c) => c.front_image_id === image.id || c.back_image_id === image.id)
    expect(owner, image.id).toBeTruthy()
    expect(image.object_path.startsWith(`customers/${carol.id}/${owner.id}/`), image.object_path).toBe(true)
  }
  const objects = await sql`select name from storage.objects where bucket_id = 'compliance-media' and name like ${`customers/${carol.id}/%`}`
  for (const { name } of objects) expect(captures.some((c) => name.startsWith(`customers/${carol.id}/${c.id}/`)), name).toBe(true)
})

test('6.146 — issuer holds the state or authority as typed on an update too', async () => {
  expect((await q3(carol.id)).at(-1).issuer).toBe('VIC')
})
