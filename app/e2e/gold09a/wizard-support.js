// Shared set-up for the Gold Phase 9a wizard rows: a signed-in admin (the TTR wizard's real login), and TTRs started
// by gold-start-ttr for that admin's business, so the wizard pages are driven against the data gold writes.
import { expect } from '@playwright/test'
import { ENTITY_ID, signedInContext } from '../support/auth.js'
import { sql } from '../support/db.js'
import { bullion, customer, reportable, save, startTtr, world, yes } from './support.js'

export { ENTITY_ID }

// A last name per customer: the wizard looks people up by name and date of birth, so two "Jane Citizen"s would clash.
// Random letters keep names unique within a run and across repeated local runs on the same database.
const letters = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')
export const nextLast = () => `Wren${letters(6)}`

let runNo = 0
const RUN = Date.now().toString(36).toUpperCase().slice(-5)
/** An invoice number that is unique across runs of this project. */
export const invoice = (tag) => `INV-W-${RUN}-${tag}-${++runNo}`

export const openAdmin = async (browser) => {
  await world()
  const context = await signedInContext(browser, 'admin')
  const page = await context.newPage()
  await page.goto('/')
  await expect(page).toHaveURL(/\/$/)
  return { context, page }
}

/** The signed-in admin's current access token (the app keeps it fresh in localStorage). */
export const adminToken = (page) =>
  page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => /auth-token$/.test(k))
    return JSON.parse(localStorage.getItem(key)).access_token
  })

/** A returning customer of the admin's business (ready: every Party Details field on file, or only what gold collects). */
export const person = async ({ first = 'Jane', last, ready = true } = {}) =>
  customer({ entity: ENTITY_ID, first, last: last ?? nextLast(), ready })

/**
 * A saved reportable scrap purchase for `who` with its invoice, and its TTR started by gold-start-ttr.
 * `answers` change the counter answers: { ttrDetailsConfirmed: 'false' } makes it case B.
 * Returns { ttrId, purchaseId, number, who, entry }.
 */
export const startedScrap = async (page, { who, number = invoice('S'), amount = '12000', answers = yes, extra = {} } = {}) => {
  const c = who ?? (await person())
  const tok = await adminToken(page)
  const r = await save(tok, { customerId: c.id, cashAmount: amount, ...reportable, ...answers, erpInvoiceNo: number, ...extra })
  if (r.status !== 201) throw new Error(`setup save refused: ${r.status} ${r.text}`)
  const s = await startTtr(tok, { purchaseId: r.body.purchaseId })
  if (s.status !== 200) throw new Error(`setup start refused: ${s.status} ${s.text}`)
  return { ttrId: s.body.ttrs[0].id, purchaseId: r.body.purchaseId, number, who: c, entry: s.body.ttrs[0] }
}

/**
 * A mixed invoice for `who`: scrap `scrapCash` and bullion `bullionCash` on one invoice, both TTRs started.
 * Returns { number, scrapId, bullionId, who }.
 */
export const startedMixed = async (page, { who, number = invoice('M'), scrapCash = '6000', bullionCash = '6000' } = {}) => {
  const c = who ?? (await person())
  const tok = await adminToken(page)
  const a = await save(tok, { customerId: c.id, cash10k: 'true', cashAmount: scrapCash, erpInvoiceNo: number, ...(Number(scrapCash) >= 10000 ? yes : {}) })
  const band = Number(bullionCash) >= 10000 ? '10k_plus' : '5k_to_10k'
  const b = await save(tok, { customerId: c.id, ...bullion(band, { partAmount: bullionCash, erpInvoiceNo: number }), ...yes })
  if (a.status !== 201 || b.status !== 201) throw new Error(`setup saves refused: ${a.text} ${b.text}`)
  const s = await startTtr(tok, { purchaseId: b.body.purchaseId })
  if (s.status !== 200) throw new Error(`setup start refused: ${s.status} ${s.text}`)
  return {
    number,
    who: c,
    bullionId: s.body.ttrs.find((e) => e.type === 'bullion').id,
    scrapId: s.body.ttrs.find((e) => e.type === 'scrap').id,
  }
}

export const ttrRow = async (id) => (await sql`select * from ttr.transactions where id = ${id}`)[0]
