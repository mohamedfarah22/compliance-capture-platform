// UAT matrix Part 2 — offline XSD 1.1 validation of every batch Part 1 and Part 1C produced,
// then the XML each Part 1 row exists to prove ("What it proves"), and Part 1C's XML
// regression checks. Item aggregates (<bui>/<buo>/<pmi>/<pmo>) and recipient details are
// not reachable while ITEM_AND_DELIVERY_CAPTURE_ENABLED is off.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { invokeFunction, sql } from '../support/db.js'
import { repoRoot } from '../support/env.js'
import { DAVID, GOLDEN, JANE, MARCUS, MICHAEL, PERTH_METAL, PRIYA, TOM } from '../support/matrix-cast.js'

test.describe.configure({ mode: 'serial' })

const REFS = [
  'UAT-A-0001', 'UAT-B-0002', 'UAT-B2-0002B', 'UAT-C-0003', 'UAT-D-0004', 'UAT-E-0005', 'UAT-E2-0005B',
  'UAT-E3-0005C', 'UAT-F-0006', 'UAT-G-0007', 'UAT-H-0008', 'UAT-I-0009', 'UAT-J-0010', 'UAT-K-0011',
  'UAT-L-0012', 'UAT-N-0013', 'UAT-O-0014',
]
const ID = 'id="[^"]+"'
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Each transaction's <ttr> block, by reference.
const ttrs = {}

// The id of the <customer> with this full (legal) name.
const customerId = (xml, name) => {
  const id = xml.match(new RegExp(`<customer id="([^"]+)"><(?:individual|organisation)Details><(?:fullName|fullLegalName)>${esc(name)}<`))?.[1]
  expect(id, `no <customer> for ${name}`).toBeTruthy()
  return id
}

const identification = (type, number, issuer, countryCode = 'AU') =>
  new RegExp(`<identification ${ID}><type>${type}</type><number>${esc(number)}</number><issuer>${esc(issuer)}</issuer>${countryCode ? `<countryCode>${countryCode}</countryCode>` : ''}</identification>`)

const validate = (xml, file) => {
  writeFileSync(file, xml)
  let output
  try {
    output = execFileSync(process.env.PYTHON ?? 'python', [path.join(repoRoot, 'scripts', 'validate_ttr_xml.py'), file], { encoding: 'utf8' })
  } catch (err) {
    throw new Error(`validate_ttr_xml.py failed:\n${err.stdout ?? ''}${err.stderr ?? err.message}`, { cause: err })
  }
  expect(output).toContain('XMLSchema11 1.1: 0 error(s)')
}

test('Part 2 — every completed transaction is batched, and each batch is valid under XSD 1.1', async ({}, testInfo) => {
  const completed = await sql`
    select transaction_ref, to_char(completed_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD') as report_date
      from ttr.transactions where status = 'complete' order by completed_at`
  expect(completed.map((t) => t.transaction_ref)).toEqual(REFS)

  // One batch per AEST day, so a run across midnight makes two.
  for (const reportDate of new Set(completed.map((t) => t.report_date))) {
    const res = await invokeFunction('generate-austrac-report', { reportDate })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const [{ xml_content: xml }] = await sql`select xml_content from ttr.report_batches where report_date = ${reportDate}`
    const blocks = xml.match(/<ttr [^>]*>[\s\S]*?<\/ttr>/g)
    expect(xml).toContain(`<reportCount>${blocks.length}</reportCount>`)
    validate(xml, testInfo.outputPath(`batch-${reportDate}.xml`))
    for (const block of blocks) ttrs[block.match(/<txnRefNo>([^<]+)<\/txnRefNo>/)[1]] = block
  }
  expect(Object.keys(ttrs).sort()).toEqual([...REFS].sort())
})

test('TX-A — BULSER, ausCash, sameAsCustomer (self), IdType P, lppFlag N', () => {
  const x = ttrs['UAT-A-0001']
  expect(x).toContain('<lppDetails><lppFlag>N</lppFlag></lppDetails>')
  expect(x).toContain('<designatedService>BULSER</designatedService>')
  expect(x).toMatch(new RegExp(`<moneyReceived ${ID}><cash><ausCash ${ID}><currencyCode>AUD</currencyCode><amount>15000.00</amount></ausCash></cash></moneyReceived>`))
  expect(x).toMatch(new RegExp(`<otherPerson ${ID}><sameAsCustomer refId="${customerId(x, JANE.fullName)}"/></otherPerson>`))
  expect(x).toMatch(identification('P', 'PA1234567', 'Australian Passport Office'))
})

test('TX-B — foreignCash with its exchangeRate, IdType D', () => {
  const x = ttrs['UAT-B-0002']
  expect(x).toMatch(new RegExp(`<moneyProvided ${ID}><cash><foreignCash ${ID}><currencyCode>USD</currencyCode><amount>8000.00</amount><exchangeRate>1\\.520*</exchangeRate></foreignCash></cash></moneyProvided>`))
  expect(x).toMatch(identification('D', 'DL987654321', 'VicRoads'))
})

test('TX-B2 — Agent for an individual: isRepresentingOrganisation N, agencyAuthorisation, reliance keeps IdType D', () => {
  const x = ttrs['UAT-B2-0002B']
  const david = customerId(x, DAVID.fullName)
  expect(x).toMatch(new RegExp(
    `<otherPerson ${ID}><individualDetails><fullName>${PRIYA.fullName}</fullName>[\\s\\S]*?</individualDetails>` +
      `<isRepresentingOrganisation>N</isRepresentingOrganisation><isAuthorisationUsed>Y</isAuthorisationUsed>` +
      `<agencyAuthorisation refId="${david}">${esc(PRIYA.authorityToAct)}</agencyAuthorisation></otherPerson>`,
  ))
  expect(x).not.toContain('<representedOrganisation')
  // TC-209: the reliance row carries the licence it relied on.
  expect(x).toMatch(identification('D', 'DL987654321', 'VicRoads'))
  expect(x).toMatch(identification('P', 'PA7654321', 'Australian Passport Office'))
})

test('TX-C — customerEmployee refId, businessStructure C, employee role in agencyAuthorisation', () => {
  const x = ttrs['UAT-C-0003']
  const golden = customerId(x, GOLDEN.entityName)
  expect(x).toContain('<businessStructure>C</businessStructure>')
  expect(x).toMatch(new RegExp(`<otherPerson ${ID}><customerEmployee refId="${golden}"/><individualDetails><fullName>${TOM.fullName}</fullName>`))
  expect(x).toContain(`<agencyAuthorisation refId="${golden}">${TOM.authorityToAct} - Employee role: ${TOM.employeeRole}</agencyAuthorisation>`)
  expect(x).toMatch(identification('PHOT', 'POA-11223', 'Service Victoria'))
})

test('TX-D — methodOfConductingTxn in place of otherPerson, businessStructure T', () => {
  const x = ttrs['UAT-D-0004']
  expect(x).toMatch(new RegExp(`<methodOfConductingTxn ${ID}><method>N</method></methodOfConductingTxn>`))
  expect(x).not.toContain('<otherPerson')
  expect(x).toContain('<businessStructure>T</businessStructure><isExpressTrust>N</isExpressTrust><isIdentityVerified>')
})

test('TX-E — altName, postalAddress, PRECIOUS, IdType OVS without countryCode', () => {
  const x = ttrs['UAT-E-0005']
  expect(x).toContain('<designatedService>PRECIOUS</designatedService>')
  expect(x).toContain('<fullName>Sarah Jane Austen</fullName><altName>Sarah A. Austen-Smith</altName>')
  expect(x).toMatch(new RegExp(`<postalAddress ${ID}><addr>PO Box 100</addr><suburb>Northcote</suburb><state>VIC</state><postcode>3070</postcode>`))
  expect(x).toMatch(identification('OVS', 'EVS-000123', 'Electronic Verification Co', null))
})

test('TX-E2 — reliance keeps the original document details (TC-209)', () => {
  expect(ttrs['UAT-E2-0005B']).toMatch(identification('OVS', 'EVS-000123', 'Electronic Verification Co', null))
})

test('TX-E3 — the carried-over alias reaches the report', () => {
  expect(ttrs['UAT-E3-0005C']).toContain('<fullName>Sarah Jane Austen</fullName><altName>Sarah A. Austen-Smith</altName>')
})

test('TX-F — ACN, businessStructureOther, isRepresentingOrganisation Y with a representedOrganisation sibling', () => {
  const x = ttrs['UAT-F-0006']
  const perth = customerId(x, PERTH_METAL.entityName)
  expect(x).toContain(`<fullLegalName>${PERTH_METAL.entityName}</fullLegalName><acn>123456789</acn>`)
  expect(x).toContain('<businessStructureOther>Sole trader</businessStructureOther>')
  const org = x.match(/<isRepresentingOrganisation>Y<\/isRepresentingOrganisation><representsOrganisation refId="([^"]+)"\/>/)?.[1]
  expect(org).toBeTruthy()
  expect(x).toMatch(new RegExp(`</otherPerson><representedOrganisation id="${org}"><organisationDetails><fullLegalName>${PERTH_METAL.entityName}</fullLegalName>`))
  expect(x).toContain(`<agencyAuthorisation refId="${perth}">${MICHAEL.authorityToAct}</agencyAuthorisation>`)
  expect(x).toMatch(identification('D', 'DL456789123', 'Department of Transport WA'))
})

test('TX-G — sameAsCustomer resolves to the second customer, not parties[0] (TC-226)', () => {
  const x = ttrs['UAT-G-0007']
  const jane = customerId(x, JANE.fullName)
  const marcus = customerId(x, MARCUS.fullName)
  expect(x.indexOf(`<customer id="${jane}"`)).toBeLessThan(x.indexOf(`<customer id="${marcus}"`))
  expect(x).toMatch(new RegExp(`<otherPerson ${ID}><sameAsCustomer refId="${marcus}"/></otherPerson>`))
  expect(x).toMatch(identification('BENE', 'MC998877', 'Services Australia'))
})

test('TX-I — the employee role is folded into agencyAuthorisation with an ASCII hyphen (fixes #5, #6)', () => {
  const x = ttrs['UAT-I-0009']
  expect(x).toContain(
    `<agencyAuthorisation refId="${customerId(x, GOLDEN.entityName)}">Employed staff member authorised to transact on behalf of Golden Bullion Traders Pty Ltd. - Employee role: Store manager</agencyAuthorisation>`,
  )
})

test('TX-J — isExpressTrust Y then trustDetails, before isIdentityVerified, no participants (fix #7)', () => {
  const x = ttrs['UAT-J-0010']
  expect(x).toMatch(new RegExp(
    `<businessStructure>T</businessStructure><isExpressTrust>Y</isExpressTrust><trustDetails ${ID}>` +
      `<trustTypeOther>Discretionary trust</trustTypeOther><trustName>Southern Cross Family Trust</trustName></trustDetails><isIdentityVerified>`,
  ))
  expect(x).not.toMatch(/trustParticipant|trustBeneficiary/)
})

test('Part 1C — a stored_copy_unclear re-capture reports as a normal identification with its countryCode (TX-K)', () => {
  expect(ttrs['UAT-K-0011']).toMatch(identification('PHOT', 'NIC-334455', 'Department of Home Affairs'))
})
