// Shared fixtures for the Gold Phase 8b UAT (docs/uat-gold-08b-purchase-screens.md). The business, staff and
// sign-in come from the Phase 8a support (business One, staff s1, manager m1, admin a1; business Two, staff s2);
// this adds people with the TTR fields, purchases saved through the real gold-save-purchase, and tabs that stay
// signed in for a whole test file.
import { expect } from '@playwright/test'
import { CONTEXT_OPTIONS } from '../support/auth.js'
import { localEnv } from '../support/env.js'
import { jpeg, save } from '../gold07/support.js'
import { abandonTransaction } from '../support/wizard.js'
import { partiesOf, startTtr, txByRef, txRow } from '../gold09a/support.js'
import { E1, E2, login, makeImage, seed, sql, storageKey, uniq, upload } from '../gold08a/support.js'

export * from '../gold08a/support.js'
export { jpeg, startTtr, txByRef, partiesOf, txRow, abandonTransaction }

// jwt_expiry is 300 s locally, so a session only lives as long as the tab that holds it keeps refreshing it. Each test
// file therefore signs in once (open) and keeps that one tab for all its tests; tokenOf reads the live token from it.
const tabs = {}
export const tokenOf = async (label) => {
  const page = tabs[label]
  if (!page) throw new Error(`No open tab for ${label}: call open(browser, '${label}') first`)
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => /auth-token$/.test(k))
    return JSON.parse(localStorage.getItem(key)).access_token
  })
}

// Locally, edge functions see SUPABASE_URL as Docker's internal http://kong:8000; rewrite the signed image URLs.
const reachSignedUrls = (context) =>
  context.route('http://kong:8000/**', (route) =>
    route.continue({ url: route.request().url().replace('http://kong:8000', localEnv().API_URL) }),
  )

/** A browser context signed in as `label` (password then TOTP), with its page on /gold. Registers the tab for tokenOf. */
export const open = async (browser, label) => {
  const session = await login(label)
  const context = await browser.newContext({ ...CONTEXT_OPTIONS, viewport: { width: 1280, height: 900 } })
  await reachSignedUrls(context)
  await context.addInitScript(
    ([key, value]) => {
      if (sessionStorage.getItem('uat8b.injected')) return
      sessionStorage.setItem('uat8b.injected', '1')
      localStorage.setItem(key, value)
    },
    [storageKey(), JSON.stringify(session)],
  )
  const page = await context.newPage()
  await page.goto('/gold')
  tabs[label] = page
  return { context, page, session }
}

/** A new tab's worth of state: the wizard keeps its active draft in sessionStorage. Keeps the sign-in marker. */
export const freshTab = (page) =>
  page.evaluate(() => {
    for (const k of Object.keys(sessionStorage)) if (k !== 'uat8b.injected') sessionStorage.removeItem(k)
  })

// ─── People ──────────────────────────────────────────────────────────────────────────────

const READY = { gender: 'F', occupation: 'Jeweller', citizenship: 'AU', taxResidency: 'AU' }

/** Ready for case A: every TTR Party Details field on file. `last` is made unique so the name finds only this person. */
export const jane = async ({ first = 'Jane', entity = E1, id = {}, last } = {}) => {
  const p = await seed({ entity, first, last: last ?? `Citizen${uniq()}`, phone: '0412 345 678', profile: READY, id: { capturedDaysAgo: 10, ...id } })
  await sql`update public.customers set is_sole_trader = false where id = ${p.id}`
  return { ...p, name: `${p.first} ${p.last}` }
}

/** Gold-only: name, date of birth, address, phone and licence. Not ready for case A. */
export const gina = async ({ first = 'Gina', entity = E1, id = {} } = {}) => {
  const p = await seed({ entity, first, last: `Goldonly${uniq()}`, phone: '0412 555 000', profile: {}, id: { capturedDaysAgo: 10, ...id } })
  return { ...p, name: `${p.first} ${p.last}` }
}

// ─── Purchases ───────────────────────────────────────────────────────────────────────────

let n = 0
const RUN = Date.now().toString(36).toUpperCase().slice(-5)
/** An invoice number unique to this run: the duplicate rules look at every purchase of the business. */
export const inv = (tag = 'X') => `INV-8B-${RUN}-${tag}-${++n}`

export const yes = { ttrSelfConducted: 'true', ttrDetailsConfirmed: 'true' }

/** A purchase saved through gold-save-purchase as account `label` (a goods photo is added). Returns its id. */
export const buy = async (label, fields = {}) => {
  const r = await save(await tokenOf(label), fields)
  if (r.status !== 201) throw new Error(`setup save refused: ${r.status} ${r.text}`)
  return r.body.purchaseId
}

/** A reportable $12,000 scrap purchase with its invoice (case A when the customer is ready), and its TTR started. */
export const reportableWithTtr = async (label, customer, { number = inv('R'), amount = '12000', answers = yes } = {}) => {
  const purchaseId = await buy(label, { customerId: customer.id, cash10k: 'true', cashAmount: amount, erpInvoiceNo: number, ...answers })
  const s = await startTtr(await tokenOf(label), { purchaseId })
  if (s.status !== 200) throw new Error(`setup start refused: ${s.status} ${s.text}`)
  return { purchaseId, number, ttrId: s.body.ttrs[0].id }
}

export const purchaseRow = async (id) => (await sql`select to_jsonb(p) as j from gold.purchases p where id = ${id}`)[0]?.j
export const purchasesOf = (customerId) => sql`select * from gold.purchases where customer_id = ${customerId} order by created_at`
export const countPurchases = async () => (await sql`select count(*)::int as n from gold.purchases`)[0].n
export const ttrOfInvoice = (number) => sql`select * from ttr.transactions where transaction_ref = ${number} order by scenario`

/**
 * What To complete should list for a business, worked out from the tables (spec 4.6: no invoice, or reportable with the
 * TTR not complete). pending = reportable ones; other = the rest.
 */
export const expectedToComplete = async (entity = E1) => {
  const [r] = await sql`
    select count(*) filter (where p.cash_10k_or_more)::int as pending,
           count(*) filter (where not p.cash_10k_or_more)::int as other
    from gold.purchases p left join ttr.transactions t on t.id = p.ttr_transaction_id
    where p.reporting_entity_id = ${entity}
      and (p.erp_invoice_no is null or (p.cash_10k_or_more and t.status is distinct from 'complete'))`
  return { ...r, total: r.pending + r.other }
}
export const expectedToCompleteCount = async (entity = E1) => (await expectedToComplete(entity)).total

/** Makes a purchase `days` older (created_at and sale_date), as a purchase recorded earlier. Triggers are off for this update only. */
export const backdate = (purchaseId, days) =>
  sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`
    await tx`
      update gold.purchases
      set created_at = created_at - make_interval(days => ${days}),
          sale_date = ((created_at - make_interval(days => ${days})) at time zone 'Australia/Melbourne')::date
      where id = ${purchaseId}`
  })

/** Marks a TTR complete in the database. The wizard's own completion is proved by the Phase 9a UAT. */
export const completeTtr = (ttrId) =>
  sql`update ttr.transactions set status = 'complete', completed_at = now() where id = ${ttrId}`

// ─── Screens ─────────────────────────────────────────────────────────────────────────────

export const GOODS = 'Photos of items purchased (required)'
export const addGoodsPhoto = (page, buffer, name = 'goods.jpg', mimeType = 'image/jpeg') => upload(page, GOODS, buffer, { name, mimeType })
export const sightedBox = (page) => page.getByRole('checkbox', { name: /sighted in person today/ })
export const recordButton = (page) => page.getByRole('button', { name: /^Record purchase/ })
export const typeOption = (page, label) => page.getByRole('radiogroup', { name: 'What are you buying?' }).getByRole('radio', { name: label })
export const yesNo = (page, question, answer) => page.getByRole('radiogroup', { name: question }).getByRole('radio', { name: answer, exact: true })
export const scrapCash = (page, answer) => yesNo(page, /Paid in cash of \$10,000 or more\?/, answer)
export const bullionBand = (page, label) => page.getByRole('radiogroup', { name: 'Cash paid' }).getByRole('radio', { name: label })
export const invoiceBox = (page) => page.getByLabel('ERP invoice number')

/** Adds `joint` as the second person through the "Add second person" dialog. */
export const addJoint = async (page, joint) => {
  await page.getByRole('button', { name: 'Add second person (joint sale)' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add second person' })
  await dialog.getByLabel('Search').fill(joint.last)
  await dialog.getByRole('button', { name: new RegExp(joint.name) }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('Joint seller', { exact: true })).toBeVisible()
}

/** Fills the common part of the form: goods photo, sighted box, optional invoice. */
export const fillCommon = async (page, img, { invoice, tick = true } = {}) => {
  await addGoodsPhoto(page, img)
  if (tick) await sightedBox(page).check()
  if (invoice) await invoiceBox(page).fill(invoice)
}

export const openCustomer = async (page, c) => {
  await page.goto(`/gold/customers/${c.id}`)
  await expect(page.getByRole('heading', { name: 'Record purchase' })).toBeVisible()
}

/** A goods photo as stored (service role). */
export const goodsBytes = async (bucket, objectPath) => {
  const { API_URL, SERVICE_ROLE_KEY } = localEnv()
  const res = await fetch(`${API_URL}/storage/v1/object/${bucket}/${objectPath}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  })
  if (!res.ok) throw new Error(`get ${objectPath}: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}
export const goodsPhotoRows = (purchaseId) =>
  sql`select content_type, storage_bucket, object_path, byte_size from gold.goods_photos where purchase_id = ${purchaseId} order by sort_order`

/** The "To complete (n)" count shown in the gold header. */
export const headerCount = async (page) => {
  const text = await page.getByRole('navigation', { name: 'Gold' }).getByRole('link', { name: /^To complete/ }).innerText()
  return Number(/\((\d+)\)/.exec(text)?.[1])
}

export { E1, E2, expect, makeImage, seed, sql, uniq, upload }
