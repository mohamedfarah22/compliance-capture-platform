// Gold Phase 9a UAT, section K of docs/uat-gold-09a-ttr-handoff.md (spec 9 "AUSTRAC file"): the batch
// generate-austrac-report makes from TTRs that gold-start-ttr started and staff completed is valid against
// docs/schema/TTR-1-0.xsd under XSD 1.1 (scripts/validate_ttr_xml.py, which also runs the two negative controls),
// repeats the invoice number as txnRefNo on both reports of a mixed invoice, and carries each party's identification.
// xmlschema is installed in CI (.github/workflows/ci.yml, "pip install xmlschema"), so this runs there.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { invokeFunction, sql } from '../support/db.js'
import { repoRoot } from '../support/env.js'
import { COLIN, DOCS, WILMA } from '../support/cast.js'
import * as w from '../support/wizard.js'
import { bullion, callFunction, reportable, save, startTtr, yes } from './support.js'
import { adminToken, ENTITY_ID, openAdmin, person } from './wizard-support.js'

// One batch is made once for all four rows, so a failure in one row skips the rest of this file.
test.describe.configure({ mode: 'serial' })

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ID = 'id="[^"]+"'
const identification = (type, number, issuer, countryCode) =>
  new RegExp(
    `<identification ${ID}><type>${type}</type><number>${esc(number)}</number><issuer>${esc(issuer)}</issuer><countryCode>${countryCode}</countryCode></identification>`,
  )

let xml
let blocks // the <ttr> blocks, by reference
let made // what the set-up made
let context

const complete = async (tok, ttrId) => {
  const r = await callFunction('complete-transaction', tok, { transactionId: ttrId })
  if (r.status !== 200) throw new Error(`complete-transaction refused ${ttrId}: ${r.status} ${r.text}`)
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(420_000)
  let page
  ;({ context, page } = await openAdmin(browser))
  const tok = await adminToken(page)
  const answers = { ...reportable }

  // 1. A single-type sale, case A (Jane), completed.
  const jane = await person({ first: 'Jane' })
  const s = await save(tok, { customerId: jane.id, cashAmount: '12000', ...answers, erpInvoiceNo: 'INV-S1' })
  const single = await startTtr(tok, { purchaseId: s.body.purchaseId })
  await complete(tok, single.body.ttrs[0].id)

  // 2. The mixed invoice INV-900: scrap and bullion, $10,000 cash each, both TTRs completed.
  const mia = await person({ first: 'Mia' })
  const a = await save(tok, { customerId: mia.id, cash10k: 'true', cashAmount: '10000', ...yes, erpInvoiceNo: 'INV-900' })
  const b = await save(tok, { customerId: mia.id, ...bullion('10k_plus', { partAmount: '10000', erpInvoiceNo: 'INV-900' }), ...yes })
  if (a.status !== 201 || b.status !== 201) throw new Error(`mixed saves refused: ${a.text} ${b.text}`)
  const mixed = await startTtr(tok, { purchaseId: b.body.purchaseId })
  for (const e of mixed.body.ttrs) await complete(tok, e.id)

  // 3. The joint sale INV-J1 (case B): staff accept both reliance rows in ID Verification, then complete.
  const joe = await person({ first: 'Joe' })
  const joan = await person({ first: 'Joan' })
  const j = await save(tok, { customerId: joe.id, jointCustomerId: joan.id, cashAmount: '12000', ...answers, erpInvoiceNo: 'INV-J1' })
  const joint = await startTtr(tok, { purchaseId: j.body.purchaseId })
  await sql`update ttr.id_verifications set is_complete = true where transaction_id = ${joint.body.ttrs[0].id}`
  await complete(tok, joint.body.ttrs[0].id)

  // 4. A company TTR started in the wizard (the second negative control needs a company party in the batch).
  const company = { ...WILMA, entityName: 'Wilma Wholesale Pty Ltd', abn: '55667788990' }
  await w.startTransaction(page, { scenario: 'Sell bullion to customer', ref: 'INV-CO1' })
  await w.createCustomer(page, company)
  await w.clickContinue(page)
  await w.fillCash(page, 15000)
  await w.fillCompanyDetails(page, company)
  await w.fillConductingPerson(page, COLIN, { representing: company.entityName })
  await w.clickContinue(page)
  await expect(page).toHaveURL(/\/id-verification$/)
  await w.setVerificationMethod(page, 'Sighted original document')
  await w.enterDocument(page, DOCS.colinPassport)
  await page.getByLabel('Issuer').fill(DOCS.colinPassport.issuer)
  await w.setExpiry(page, DOCS.colinPassport.expiry)
  await w.captureSide(page, 'front')
  await w.clickContinue(page)
  await w.completeTransaction(page)

  // The batch(es): one per AEST day the completions fall on.
  const days = await sql`
    select distinct to_char(completed_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD') as d
    from ttr.transactions where transaction_ref in ('INV-S1', 'INV-900', 'INV-J1', 'INV-CO1') and status = 'complete'`
  expect(days.length, 'the TTRs fall on more than one AEST day (the run crossed midnight): rerun').toBe(1)
  const reportDate = days[0].d
  const g = await invokeFunction('generate-austrac-report', { reportDate })
  expect(g.status, JSON.stringify(g.body)).toBe(200)
  ;[{ xml_content: xml }] = await sql`select xml_content from ttr.report_batches where report_date = ${reportDate} and reporting_entity_id = ${ENTITY_ID}`
  blocks = {}
  for (const block of xml.match(/<ttr [^>]*>[\s\S]*?<\/ttr>/g)) {
    const ref = block.match(/<txnRefNo>([^<]+)<\/txnRefNo>/)[1]
    ;(blocks[ref] ??= []).push(block)
  }
  made = { jane, joe, joan, mia, mixedIds: mixed.body.ttrs.map((e) => e.id), singleId: single.body.ttrs[0].id, jointId: joint.body.ttrs[0].id, purchaseId: s.body.purchaseId }
})

test.afterAll(async () => {
  await context?.close()
})

const docNumber = async (verId) => (await sql`select document_number from ttr.id_verifications where id = ${verId}`)[0].document_number

test.describe('K · AUSTRAC file', () => {
  test('9.51 ⚠ — the batch is valid under XMLSchema11 against TTR-1-0.xsd: 0 errors, and exactly 1 error for each negative control', async ({}, testInfo) => {
    const file = testInfo.outputPath('gold09a-batch.xml')
    writeFileSync(file, xml)
    let output
    try {
      output = execFileSync(process.env.PYTHON ?? 'python', [path.join(repoRoot, 'scripts', 'validate_ttr_xml.py'), file], { encoding: 'utf8' })
    } catch (err) {
      throw new Error(`validate_ttr_xml.py failed:\n${err.stdout ?? ''}${err.stderr ?? err.message}`, { cause: err })
    }
    expect(output).toContain('XMLSchema11 1.1: 0 error(s)')
    expect(output).toContain('control 1 (digit-led ttr id): 1 error(s)')
    expect(output).toContain('control 2 (trust without isExpressTrust): 1 error(s)')
    for (const ref of ['INV-S1', 'INV-900', 'INV-J1', 'INV-CO1']) expect(blocks[ref], ref).toBeTruthy()
    expect(xml).toContain('<businessStructure>C</businessStructure>')
  })

  test('9.52 ⚠ — both reports of the mixed invoice have txnRefNo INV-900, and every id in the file is unique', async () => {
    expect(blocks['INV-900']).toHaveLength(2)
    expect(blocks['INV-900'].map((b) => b.match(/<designatedService>([^<]+)</)[1]).sort()).toEqual(['BULSER', 'PRECIOUS'].sort())
    for (const id of made.mixedIds) expect(xml).toContain(`<ttr id="ttr-${id}"`)
    const ids = [...xml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
    expect(ids.length).toBeGreaterThan(20)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('9.53 ⚠ — <identification> carries the document number, issuer and country copied from the capture, one per party (two on the joint report)', async () => {
    const jane = identification('D', await docNumber(made.jane.verId), 'VIC', 'AU')
    expect(blocks['INV-S1'][0]).toMatch(jane)
    const joint = blocks['INV-J1'][0]
    expect(joint).toMatch(identification('D', await docNumber(made.joe.verId), 'VIC', 'AU'))
    expect(joint).toMatch(identification('D', await docNumber(made.joan.verId), 'VIC', 'AU'))
    expect((joint.match(/<identification /g) ?? []).length).toBe(2)
    const mia = identification('D', await docNumber(made.mia.verId), 'VIC', 'AU')
    for (const b of blocks['INV-900']) expect(b).toMatch(mia)
  })

  test("9.54 — the single-type report's customer, address and occupation come from Jane's copied party, and the transaction date is the purchase's", async () => {
    const x = blocks['INV-S1'][0]
    expect(x).toContain(`<fullName>Jane ${made.jane.last}</fullName>`)
    expect(x).toContain('<occupationBusinessActivity>Jeweller</occupationBusinessActivity>')
    expect(x).toContain('<addr>1 Test St</addr>')
    expect(x).toContain('<suburb>Coburg</suburb>')
    expect(x).toContain('<state>VIC</state>')
    expect(x).toContain('<postcode>3058</postcode>')
    expect(x).toContain('<amount>12000.00</amount>')
    const [{ d }] = await sql`
      select to_char(created_at at time zone 'Australia/Melbourne', 'YYYY-MM-DD') as d from gold.purchases where id = ${made.purchaseId}`
    expect(x).toContain(`<txnDate>${d}</txnDate>`)
  })
})
