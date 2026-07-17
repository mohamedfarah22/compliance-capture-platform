# Manual UAT test matrix: end-to-end transactions for AUSTRAC TTR validation

## Context

The AUSTRAC report generator (`supabase/functions/generate-austrac-report/index.ts`) was fully rewritten against the real TTR-1-0 schema and has 67/67 Deno + 211/211 Vitest automated tests passing at the time of the rewrite. The user then manually exercised the wizard end-to-end (transactions A–H below), which surfaced two further real defects, both since root-caused and fixed:

1. **Fixed:** `generate-austrac-report` queried `ttr.party_aliases` by a `transaction_id` column that table doesn't have, silently dropping `<altName>` from every report. Fixed by querying `party_id` instead (`supabase/functions/generate-austrac-report/index.ts`, `loadTxnScopedData`/`aliasesForParties`), verified via the "Regenerate" batch feature (`supabase/functions/approve-batch/index.ts`'s `regenerate` action and the `Regenerate` button on `ReviewBatchPage.jsx`).
2. **Fixed:** when an existing customer (with an alias already on file) was re-added to a new transaction via Customer Search, the alias didn't carry over — found while checking TX-E2 (a follow-up transaction for Sarah Austen, added via search) against the regenerated report. Fixed across the search RPCs (`supabase/migrations/20260708000001_customer_search_include_aliases.sql`) and `wizardApi.js`'s `migrateNewParties`.
3. **Fixed:** an individual's middle name was silently dropped from their "full name" wherever it was constructed from parts (`CreateCustomerPage.jsx`, `wizardApi.js`, `PartyDetailsPage.jsx`, `ReviewSubmitPage.jsx`, `RecipientDeliveryPage.jsx`) — already-completed transactions in this matrix (A–H, E2) all have this gap in their generated XML and can't be corrected retroactively (transactions are immutable once complete); the fix only applies going forward.
4. **Fixed:** a conducting person's `dob_known` was always saved as `false` regardless of what was selected, due to a string/boolean mismatch in `wizardApi.js`'s `cpToDbRow`. Didn't affect generated XML (the generator reads `date_of_birth` directly), but caused a draft-reload UX bug.
5. **Fixed:** a conducting person's `is_employee` was always saved as `null` regardless of the "Is employee?" selection — the same string/boolean mismatch pattern as fix #4, in the same `cpToDbRow` function, just uncaught for this field (`data.isEmployee` is the string `'yes'/'no'/'unknown'`, compared against boolean literals `true`/`false`, which never match). Unlike `dob_known`, this one **does** affect generated XML: `buildAgencyAuthorisationText()` in `generate-austrac-report/index.ts` only folds `employee_role` into `<agencyAuthorisation>` when `is_employee === "yes"`, so TX-C's "Store manager" role never appeared in its report even though the fold logic itself was correct and covered by a passing test. `dbRowToCp` had the inverse bug, converting the DB string to a boolean the page's radio buttons don't recognise, so reloading a draft also silently reset the "Is employee?" selection. Both fixed by passing the string straight through (`cp_employee_status`'s DB enum values are exactly `'yes'|'no'|'unknown'`, matching the page's own values) — see **TX-I** below for the verification transaction.
6. **Fixed:** `buildAgencyAuthorisationText()` joined its parts with an em-dash (`" — "`), a non-ASCII character — this had never actually reached generated XML before (the only code path that produces multiple parts, the employee-role fold, was blocked by fix #5's bug), so it went undetected until TX-I exercised it for the first time and the em-dash came out as mojibake (`â`) instead. Root cause not fully isolated (likely a UTF-8/Latin-1 mismatch somewhere in how the edge function response is served or captured downstream), but rather than depend on getting a charset header right everywhere this XML might be transported through, the separator was changed to a plain ASCII hyphen (`" - "`), which is unambiguous regardless of encoding — appropriate for text going straight into a legal filing.

7. **Fixed:** running the actual generated reports through a real XSD 1.1 validator (`xmllint`/.NET's `System.Xml.Schema` don't support XSD 1.1 `xs:assert`, so the Python `xmlschema` package was used instead) surfaced 4 systemic schema-compliance bugs never caught by the Deno/Vitest suites, all now fixed in `generate-austrac-report/index.ts`:
   - `<ttr id="...">` used the raw transaction UUID directly with no letter prefix (unlike every other id in the document) — NCName/xs:ID values must start with a letter, so any transaction whose UUID happened to start with a digit (~62.5% of the time) silently failed AUSTRAC's own schema validation. Now prefixed `ttr-...`.
   - `isAbnHolder`/`abn` were unconditionally emitted for every individual, violating the schema's requirement that both be entirely absent when `isSoleTrader='N'` — effectively every individual in every report, since individuals here never have `isSoleTrader='Y'`. Now both are omitted unless the individual is a sole trader.
   - `countryCode` was unconditionally emitted for every identification record, violating the schema's requirement that it be absent for `type='OVS'` (Electronic verification source) — affected every reliance-based identification (e.g. Sarah Austen's, reused in TX-E/E2/E3). Now omitted specifically for OVS.
   - `isExpressTrust`/`TrustDetails` were never emitted for Trust-structured organisations at all, violating the schema's requirement that `isExpressTrust` exist whenever `businessStructure='T'` — affected TX-D (Southern Cross Metals Trust). This was a fully greenfield gap: a new "Is this an express trust?" question (+ Trust type/Trust name when Yes) was added to `PartyDetailsPage.jsx`, with new `is_express_trust`/`trust_type_other`/`trust_name` columns on `ttr.parties` (`supabase/migrations/20260716000001_trust_details.sql`) — see **TX-J** below for the verification transaction.

Separately, **TX-B** (`UAT-B-0002`) was completed without actually exercising its intended scenario (the Agent conducting-person path) — `hasConductingPerson` was left at No. Since `ttr.transactions` is permanently immutable once `status = 'complete'` (the `trg_lock_completed` trigger raises on `UPDATE` or `DELETE`), this can't be corrected in place — **TX-B2** and **TX-E3** below are new transactions added to cover this gap and to prove the alias-carryover fix end-to-end.

**Compliance constraint:** a TTR is a legal filing to AUSTRAC. This plan defaults to **offline schema validation** (Part 2 — no data ever reaches AUSTRAC) as the primary verification method; actual AUSTRAC-side acceptance testing (Part 3) requires direct confirmation from AUSTRAC of their current test/UAT process, and is deferred until after prod deploy.

## Known future feature (deferred, not built): conducting-person search

There's currently no way to search for/reuse an existing conducting person across transactions — every conducting person must be manually re-entered in full each time, even though the same real person (e.g. Priya Agent) could be a conducting person on one transaction and a primary party/customer on another. A design for this was scoped (new RPC dedicated to `ConductingPersonPage.jsx`, splitting `conducting_persons.full_name` into first/middle/last to match `parties`, unioning candidates from both `ttr.parties` and `ttr.conducting_persons`) but deliberately deferred — not part of this UAT pass. `CustomerSearchPage.jsx` and its existing RPCs are explicitly out of scope for that future work.

## Known future feature (deferred, not built): trust participants/beneficiaries

TTR-1-0's `TrustDetails` complex type also supports `trustParticipant` (trustees/appointors/settlors, each either an existing party or a fully-detailed individual/organisation) and a beneficiary sub-structure (either up to 10 named beneficiaries or a type/class description). Both are schema-optional (`minOccurs="0"`), and their conditional asserts only fire once `isTenOrLessBeneficiaries` is actually set — this system never sets it, so omitting both keeps generated XML fully schema-valid without needing this much larger recursive-entity feature. Only `isExpressTrust` + `trustType`/`trustName` are captured today.

## Part 1 — Manual transaction matrix

Each row is one transaction to create through the wizard (`/start` → ... → `/review`), chosen so that together they exercise every AUSTRAC-schema-relevant branch in the report generator. Field names below match the actual UI (`ConductingPersonPage.jsx`, enum values from `supabase/migrations/20260621000003_enums.sql`, `20260704000001_precious_metal_type_enum.sql`, `20260704000006_recipient_delivery_purpose_enum.sql`).

**One-time setup:** confirm the logged-in staff member's reporting entity profile has a valid 9-digit `austrac_account_number` set — this becomes `<reAustracAccountNumber>`/`<submitterAustracAccountNumber>` in every report (TC-218/257).

| # | Scenario | Customer(s) | Conducting person | Currency | ID verification | Recipient | Items | What it proves |
|---|---|---|---|---|---|---|---|---|
| **A** | Sell bullion to customer | 1 individual | No (self) | AUD $15,000 | Sighted original document — Passport | Same as recorded party | 1× Gold Bar | Baseline happy path: `BULSER`, `<ausCash>`, `<sameAsCustomer>` (self), `<buo>`, IdType `P`, `<lppFlag>N</lppFlag>` |
| **B** | Buy bullion from customer | 1 individual | *Completed without this step — see TX-B2* | Other/foreign — e.g. USD 8,000 @ FX rate to clear $10k AUD | Customer: Driver licence (triggers back-image requirement). CP: Passport | Different recipient, manual entry, DOB known = yes | 3× bullion items (Gold Bar, Silver Coin, Platinum Wafer) — **delete the 3rd before Continue** | `bui`, `<foreignCash>` with `<exchangeRate>`, deleted item excluded from the `<bui>` aggregate (TC-237). Agent/`agencyAuthorisation` coverage deferred to TX-B2 |
| **C** | Sell bullion to customer | 1 company (legal form "Company", ABN 11 digits) | Yes — relationship "Employee", is-employee = yes with a role, party represented = the company | AUD | CP only — company customers don't get an ID-verification record themselves (only individuals + the CP do) | Same as recorded party | 1× Platinum Bar | `<customerEmployee refId>`, `businessStructure` code `C`, employee role folded into `<agencyAuthorisation>` text |
| **D** | Buy bullion from customer | 1 company (legal form "Trust", ABN or ACN) | "Is a different person conducting the transaction?" → select the impersonal path, "which party does this apply to?" = the company, Method of conducting = "Night safe or express deposit" | AUD | CP-less | Same as recorded party | 1× Gold Coin | `<methodOfConductingTxn id="..."><method>N</method></methodOfConductingTxn>` in place of `<otherPerson>`, `businessStructure` code `T` |
| **E** | Sell precious metal to customer | 1 individual, with an alias added and "different postal address" checked | No (self) | AUD | **First** verify normally (Sighted original document — Electronic verification source, maps to IdType `OVS`); on a **later** transaction for the same person, use "Relied on prior identification" pointing at this record | Same as recorded party | 1× Alloy item with a description (≤500 chars) and a serial number (≤100 chars) | `<altName>`, `<postalAddress>`, `pmo`, metal `ALLOY` with `<description>`/`<serialNumber>`, reliance-based `<identification>` retaining the original document details (TC-209) |
| **F** | Buy precious metal from customer | 1 company (legal form "Sole trader", ACN 9 digits) | Yes — relationship "Director" (not Employee), party represented = the company | AUD | CP only | Same as recorded party | 2× items (e.g. Iridium + Rhodium) — **delete one before Continue** | `businessStructureOther` ("Sole trader" has no valid code), ACN path, `isRepresentingOrganisation=Y` **with** a real `<representedOrganisation>` sibling block + `<representsOrganisation refId>` (the one combination A–D/G/H don't cover), `pmi`, deleted item excluded from the `<pmi>` aggregate (TC-245) |
| **G** | Sell bullion to customer | 2 individuals | No (self), but explicitly pick the **second** customer in "which party conducted this transaction?" | AUD | Both customers verified normally | Same as recorded party | 1× Silver Bar | `<sameAsCustomer refId>` resolves to customer #2, not `parties[0]` (TC-226) |
| **H** | Buy bullion from customer | 1 individual | No (self) | AUD | Normal | Different recipient, DOB known = **no**, purpose of transfer = "Dropping off bullion", delivery method = "Other" with free-text description | 1× Gold Bar | Recipient DOB-unknown path, the remaining `transfer_purpose` enum value, delivery method "Other" free text |
| **B2** | Buy bullion from customer | 1 individual (existing — David Sampleton, reused from TX-B via Customer Search) | Yes — relationship "Agent", party represented = the customer, non-empty authority-to-act text | Other/foreign — USD 8,000 @ FX rate to clear $10k AUD | Customer: Driver licence (reused/re-verified). CP: Passport | Different recipient, manual entry, DOB known = yes | 3× bullion items — **delete the 3rd before Continue** | Redo of TX-B's missed coverage: `otherPerson`/`individualDetails` + `isRepresentingOrganisation=N` (represented party is an individual) + non-empty `<agencyAuthorisation>`, IdType `D` |
| **E3** | Sell precious metal to customer | 1 individual (existing — Sarah Austen, reused from TX-E via Customer Search) | No (self) | AUD | Relied on prior identification (reuse `EVS-000123`) | Same as recorded party | 1× Gold item | Alias-carryover fix: `<altName>Sarah A. Austen-Smith</altName>` appears without re-entering the alias — proves Customer Search now correctly copies an existing customer's aliases onto a new transaction's party snapshot |

### Dummy data — reusable identities

To keep the transactions internally consistent, reuse these fictitious identities rather than inventing new ones per row. All clearly fake data — no real ABN/ACN/DOB overlap intended.

**Individuals**
- **Jane Alice CITIZEN** — DOB 1985-06-15, phone 0400111222, occupation "Jeweller", gender F, citizenship AU, tax residency AU, residential 12 Test St, Coburg VIC 3058, postal = same as residential.
- **Marcus James TESTER** — DOB 1990-03-22, phone 0400333444, occupation "Retailer", gender M, citizenship AU, tax residency AU, residential 45 Sample Ave, Richmond VIC 3121.
- **David Paul SAMPLETON** — DOB 1978-11-02, phone 0400555666, occupation "Accountant", gender M, citizenship AU, tax residency AU, residential 9 Demo Rd, Brunswick VIC 3056. (TX-B customer, reused in TX-B2)
- **Priya AGENT** — DOB 1982-04-10, phone 0400777888, occupation "Financial adviser", residential 3 Broker Ln, Fitzroy VIC 3065. (TX-B / TX-B2 conducting person)
- **Tom EMPLOYEE** — DOB 1995-09-09, phone 0400999000, occupation "Branch teller", residential 8 Staff St, Dandenong VIC 3175. (TX-C conducting person)
- **Sarah Jane AUSTEN** — DOB 1975-01-20, phone 0400222333, occupation "Designer", gender F, citizenship AU, tax residency AU, residential 5 River St, Northcote VIC 3070, alias "Sarah A. Austen-Smith", postal PO Box 100, Northcote VIC 3070 (different from residential). (TX-E, reused in TX-E2/TX-E3)
- **Michael DIRECTOR** — DOB 1970-07-07, phone 0400444555, occupation "Company director", residential 4 Harbour Rd, Fremantle WA 6160. (TX-F conducting person)
- **Grace HARBOUR** — DOB 1988-08-08, phone 0400666777, occupation "Nurse", gender F, citizenship AU, tax residency AU, residential 18 Bay St, Geelong VIC 3220. (TX-H customer)
- **Recipient Test PERSON** — no DOB, address 20 Delivery Way, Geelong VIC 3220. (TX-H manual recipient)

**Companies**
- **Golden Bullion Traders Pty Ltd** — legal form Company, ABN `12345678901`, business address 100 Industry Rd, Dandenong VIC 3175, phone 0398765432, principal activity "Bullion dealing". (TX-C)
- **Southern Cross Metals Trust** — legal form Trust, ABN `98765432109`, business address 22 Commerce St, Box Hill VIC 3128, phone 0387654321, principal activity "Precious metal trading". (TX-D)
- **Perth Metal Co** — legal form Sole trader, ACN `123456789`, business address 7 Harbour Rd, Fremantle WA 6160, phone 0894561234, principal activity "Metal refining". (TX-F)

**ID verification defaults** (use for whichever person needs a "Sighted original document" record unless the row says otherwise): document number pattern `PA1234567` (passport) / `DL987654321` (driver licence, requires front **and** back images — any small JPG works as a placeholder) / `EVS-000123` (electronic verification source, issuer "Electronic Verification Co"). Issuer for passport: "Australian Passport Office"; for driver licence: "VicRoads"; country AU throughout.

### Per-transaction data — every field, page by page

Field ids/labels below are confirmed against the actual page components (`StartTransactionPage.jsx`, `CustomerSearchPage.jsx`, `CreateCustomerPage.jsx`, `TransactionDetailsPage.jsx`, `PartyDetailsPage.jsx`, `ConductingPersonPage.jsx`, `IdVerificationPage.jsx`, `RecipientDeliveryPage.jsx`, `BullionDetailsPage.jsx`, `PreciousMetalDetailsPage.jsx`). Fields not mentioned for a given transaction are either not shown (conditional) or can be left at their default. Country fields all default to "Australia" / country codes to "AU" unless stated. ID front/back "capture" means the camera-capture flow on ID Verification — any placeholder image works when testing without real documents.

---

**TX-A — Sell bullion to customer, baseline**

- **Start Transaction**: scenario = Sell bullion to customer; transactionRef = `UAT-A-0001`; dateTime = leave prefilled.
- **Customer Search → Create new customer** (Individual): firstName `Jane`, middleName `Alice`, lastName `Citizen`, dateOfBirth `1985-06-15`, phone `0400111222`, email `jane.citizen@example.test`. Select her, Continue.
- **Transaction Details**: Cash currency = AUD; cashAmount = `15000`; audValue auto-fills `15000`.
- **Party Details** (Jane Alice Citizen, Individual): fullName `Jane Alice Citizen`; aliases none; businessTradingName blank; dateOfBirth `1985-06-15`; resStreet `12 Test St`; resSuburb `Coburg`; resState `VIC`; resPostcode `3058`; resCountry `Australia`; postal-different unchecked; phone `0400111222`; occupation `Jeweller`; abn blank; gender `F`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`.
- **Conducting Person**: hasConductingPerson = **No**.
- **ID Verification** (Jane Alice Citizen): verificationMethod `Sighted original document`; documentType `Passport`; documentNumber `PA1234567`; issuer `Australian Passport Office`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2031-06-15`; capture front image (no back needed for passport).
- **Recipient & Delivery**: recipientIsParty = **Yes**; recipient = Jane Alice Citizen; purpose of transfer = `Collecting bullion`; delivery method = `Collected`; notes blank.
- **Bullion Details** — Item 1: metalType `Gold`; productType `Bar`; purity `999.9`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `15000`; description `1kg PAMP minted bar`.
- **Review & Submit**: click **Complete**.

---

**TX-B — Buy bullion from customer, foreign currency + third-party agent + deleted item**

- **Start Transaction**: scenario = Buy bullion from customer; transactionRef = `UAT-B-0002`; dateTime prefilled.
- **Create new customer** (Individual): firstName `David`, middleName `Paul`, lastName `Sampleton`, dateOfBirth `1978-11-02`, phone `0400555666`, email `david.sampleton@example.test`.
- **Transaction Details**: Cash currency = **Other**; foreignCurrencyType = `USD`; foreignCurrencyAmount = `8000`; fxRate = `1.52`; rateSource = `Internal POS rate`; audValue auto-fills `12160`.
- **Party Details** (David Paul Sampleton): fullName `David Paul Sampleton`; dateOfBirth `1978-11-02`; resStreet `9 Demo Rd`; resSuburb `Brunswick`; resState `VIC`; resPostcode `3056`; resCountry `Australia`; postal-different unchecked; phone `0400555666`; occupation `Accountant`; gender `M`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`.
- **Conducting Person**: hasConductingPerson = **Yes**; representedPartyId = David Paul Sampleton; fullName `Priya Agent`; aliases none; dobKnown `Yes`; dateOfBirth `1982-04-10`; resStreet `3 Broker Ln`; resSuburb `Fitzroy`; resState `VIC`; resPostcode `3065`; resCountry `Australia`; postal-different unchecked; phone `0400777888`; occupation `Financial adviser`; relationship = `Agent`; authorityToAct = `Power of attorney dated 2026-06-01 authorising Priya Agent to act on David Sampleton's behalf for this transaction.`; isEmployee = **No**; actingViaEntity = **No**. **(Historical note: this step was not actually recorded when TX-B was run — the transaction completed self-conducted instead. See TX-B2.)**
- **ID Verification**:
  - David Paul Sampleton: verificationMethod `Sighted original document`; documentType `Driver licence`; documentNumber `DL987654321`; issuer `VicRoads`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2028-03-01`; capture front **and back** (mandatory for driver licence).
  - Priya Agent: verificationMethod `Sighted original document`; documentType `Passport`; documentNumber `PA7654321`; issuer `Australian Passport Office`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2029-09-09`; capture front.
- **Recipient & Delivery**: recipientIsParty = **No**; recipient full name = `Recipient B Test`; dobKnown `Yes`; dob `1980-05-05`; address `33 Handover St, Fitzroy, VIC, 3065, Australia`; purpose of transfer = `Collecting bullion`; delivery method = `Courier`; deliveryAddressDifferent = **No**; notes `Courier arranged by recipient's agent.`
- **Bullion Details**:
  - Item 1: metalType `Gold`; productType `Bar`; purity `999.9`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `9000`; description `1kg gold bar ex-customer`.
  - Item 2: metalType `Silver`; productType `Coin`; purity `999`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `3000`; description `1kg silver coin lot`.
  - Item 3 (temporary): metalType `Platinum`; productType `Wafer`; purity `999.5`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `5000`; description `1kg platinum wafer`. **Click Remove on Item 3 before clicking Continue** — final aggregate should be Gold + Silver only ($12,000).
- **Review & Submit**: Complete.

**TX-B2 — redo of TX-B's Agent conducting-person scenario, with the step actually recorded:**

- **Start Transaction**: scenario = Buy bullion from customer; transactionRef = `UAT-B2-0002B`; dateTime prefilled (after TX-B's completion time).
- **Customer Search**: search Individual — firstName `David`, lastName `Sampleton`, dateOfBirth `1978-11-02` — select the **existing** David Paul Sampleton record from TX-B (don't create a new party).
- **Transaction Details**: Cash currency = **Other**; foreignCurrencyType = `USD`; foreignCurrencyAmount = `8000`; fxRate = `1.52`; rateSource = `Internal POS rate`; audValue auto-fills `12160`.
- **Party Details**: confirm David's details carried over correctly from his existing record; fill in anything blank identically to TX-B.
- **Conducting Person**: hasConductingPerson = **Yes** — this is the field that was missed last time; confirm the toggle is actually set and Priya's full details are entered and saved **before** clicking Continue; representedPartyId = David Paul Sampleton; fullName `Priya Agent`; dobKnown `Yes`; dateOfBirth `1982-04-10`; resStreet `3 Broker Ln`; resSuburb `Fitzroy`; resState `VIC`; resPostcode `3065`; resCountry `Australia`; phone `0400777888`; occupation `Financial adviser`; relationship = `Agent`; authorityToAct = `Power of attorney dated 2026-06-01 authorising Priya Agent to act on David Sampleton's behalf for this transaction.`; isEmployee = **No**; actingViaEntity = **No**.
- **ID Verification**:
  - David Paul Sampleton: verificationMethod `Sighted original document`; documentType `Driver licence`; documentNumber `DL987654321`; issuer `VicRoads`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2028-03-01`; capture front **and back**.
  - Priya Agent: verificationMethod `Sighted original document`; documentType `Passport`; documentNumber `PA7654321`; issuer `Australian Passport Office`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2029-09-09`; capture front.
- **Recipient & Delivery**: recipientIsParty = **No**; recipient full name = `Recipient B Test`; dobKnown `Yes`; dob `1980-05-05`; address `33 Handover St, Fitzroy, VIC, 3065, Australia`; purpose of transfer = `Collecting bullion`; delivery method = `Courier`; notes `Courier arranged by recipient's agent.`
- **Bullion Details**:
  - Item 1: metalType `Gold`; productType `Bar`; purity `999.9`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `9000`; description `1kg gold bar ex-customer`.
  - Item 2: metalType `Silver`; productType `Coin`; purity `999`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `3000`; description `1kg silver coin lot`.
  - Item 3 (temporary): metalType `Platinum`; productType `Wafer`; purity `999.5`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `5000`. **Delete before Continue** — final aggregate should be Gold + Silver only ($12,000).
- **Review & Submit**: Complete.

---

**TX-C — Sell bullion to customer, company customer + employee conducting person**

- **Start Transaction**: scenario = Sell bullion to customer; transactionRef = `UAT-C-0003`; dateTime prefilled.
- **Create new customer** (Company): entityName `Golden Bullion Traders Pty Ltd`; abnAcn `12345678901`; suburb `Dandenong`; companyPhone `0398765432`; companyEmail `accounts@goldenbullion.example.test`.
- **Transaction Details**: Cash currency = AUD; cashAmount = `12000`.
- **Party Details** (Golden Bullion Traders Pty Ltd, Company): entityName `Golden Bullion Traders Pty Ltd`; companyTradingName blank; legalForm `Company`; bizStreet `100 Industry Rd`; bizSuburb `Dandenong`; bizState `VIC`; bizPostcode `3175`; bizCountry `Australia`; postal-different unchecked; companyPhone `0398765432`; registration identifier type `ABN`, value `12345678901`; principalActivity `Bullion dealing`.
- **Conducting Person**: hasConductingPerson = **Yes**; representedPartyId = Golden Bullion Traders Pty Ltd; fullName `Tom Employee`; dobKnown `Yes`; dateOfBirth `1995-09-09`; resStreet `8 Staff St`; resSuburb `Dandenong`; resState `VIC`; resPostcode `3175`; resCountry `Australia`; phone `0400999000`; occupation `Branch teller`; relationship = `Employee`; authorityToAct = `Employed staff member authorised to transact on behalf of Golden Bullion Traders Pty Ltd.`; isEmployee = **Yes**; employeeRole = `Store manager`; actingViaEntity = **No**.
- **ID Verification** (Tom Employee only — the company customer itself doesn't appear in the ID Verification navigator): verificationMethod `Sighted original document`; documentType `Proof of age card`; documentNumber `POA-11223`; issuer `Service Victoria`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2027-12-01`; capture front.
- **Recipient & Delivery**: recipientIsParty = **Yes**; recipient = Golden Bullion Traders Pty Ltd; purpose of transfer = `Collecting bullion`; delivery method = `Collected`; notes `Collected by store manager.`
- **Bullion Details** — Item 1: metalType `Platinum`; productType `Bar`; purity `999.5`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `12000`; description `1kg platinum bar`.
- **Review & Submit**: Complete.

---

**TX-D — Buy bullion from customer, company with no identifiable individual (methodOfConductingTxn)**

- **Start Transaction**: scenario = Buy bullion from customer; transactionRef = `UAT-D-0004`; dateTime prefilled.
- **Create new customer** (Company): entityName `Southern Cross Metals Trust`; abnAcn `98765432109`; suburb `Box Hill`; companyPhone `0387654321`; companyEmail `admin@socrossmetals.example.test`.
- **Transaction Details**: Cash currency = AUD; cashAmount = `20000`.
- **Party Details** (Southern Cross Metals Trust, Company): entityName `Southern Cross Metals Trust`; legalForm `Trust`; bizStreet `22 Commerce St`; bizSuburb `Box Hill`; bizState `VIC`; bizPostcode `3128`; bizCountry `Australia`; companyPhone `0387654321`; registration identifier type `ABN`, value `98765432109`; principalActivity `Precious metal trading`.
- **Conducting Person**: hasConductingPerson = **No**; conductorIdentifiable = **No — impersonal channel** (this question only appears because the customer is a company); if a "which party does this apply to?" dropdown appears (only when more than one company party exists — with a single company party it won't), leave/select Southern Cross Metals Trust; methodOfConductingTxn = `Night safe or express deposit`.
- **ID Verification**: none — no individual to verify.
- **Recipient & Delivery**: recipientIsParty = **Yes**; recipient = Southern Cross Metals Trust; purpose of transfer = `Dropping off bullion`; delivery method = `Collected`; notes blank.
- **Bullion Details** — Item 1: metalType `Gold`; productType `Coin`; purity `999.9`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `20000`; description `1kg gold coin lot, night-safe deposit`.
- **Review & Submit**: Complete.

---

**TX-E — Sell precious metal to customer, alias + postal address + Alloy item, then follow-up transactions**

- **Start Transaction**: scenario = Sell precious metal to customer; transactionRef = `UAT-E-0005`; dateTime prefilled.
- **Create new customer** (Individual): firstName `Sarah`, middleName `Jane`, lastName `Austen`, dateOfBirth `1975-01-20`, phone `0400222333`, email `sarah.austen@example.test`.
- **Transaction Details**: Cash currency = AUD; cashAmount = `10500`.
- **Party Details** (Sarah Jane Austen): fullName `Sarah Jane Austen`; alias — type `Sarah A. Austen-Smith` into the alias box and click Add; businessTradingName blank; dateOfBirth `1975-01-20`; resStreet `5 River St`; resSuburb `Northcote`; resState `VIC`; resPostcode `3070`; resCountry `Australia`; postal-different **checked** → postStreet `PO Box 100`; postSuburb `Northcote`; postState `VIC`; postPostcode `3070`; postCountry `Australia`; phone `0400222333`; occupation `Designer`; gender `F`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`.
- **Conducting Person**: hasConductingPerson = **No**.
- **ID Verification** (Sarah Jane Austen): verificationMethod `Electronic data source`; elecDataSrc `Electronic Verification Co`; documentType `Electronic verification source`; documentNumber `EVS-000123`; issuer `Electronic Verification Co`; idCountryCode `AU`; hasExpiry `No`; capture front (still required — only reliance mode skips images). **This record is reused below.**
- **Recipient & Delivery**: recipientIsParty = **Yes**; recipient = Sarah Jane Austen; purpose of transfer = `Collecting precious metal`; delivery method = `Collected`.
- **Precious Metal Details** — Item 1: metalType `Alloy`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `10500`; description `70% gold / 30% copper alloy ring stock`; serialNumber `SN-ALLOY-001`.
- **Review & Submit**: Complete.

**TX-E2 — follow-up transaction for the same customer, testing reliance on prior identification (TC-209):**

- **Start Transaction**: scenario = Sell precious metal to customer; transactionRef = `UAT-E2-0005B`; dateTime prefilled (must be after TX-E's completion time).
- **Customer Search**: search Individual — firstName `Sarah`, lastName `Austen`, dateOfBirth `1975-01-20` — select the **existing** Sarah Jane Austen record (don't create a new party).
- **Transaction Details**: Cash currency = AUD; cashAmount = `10500`.
- **Party Details**: should already be populated from her existing record — just confirm and Continue.
- **Conducting Person**: hasConductingPerson = **No**.
- **ID Verification** (Sarah Jane Austen): verificationMethod = **Relied on prior identification** (only available because a prior record exists); relianceReason = `Prior ID reviewed and still valid`; use the prior-verification search picker to select the `EVS-000123` record from TX-E; documentNumber = `EVS-000123` (re-enter — required even in reliance mode); tick "I confirm the person presenting today matches these ID images" if shown.
- **Recipient & Delivery**: recipientIsParty = **Yes**; recipient = Sarah Jane Austen; purpose of transfer = `Collecting precious metal`; delivery method = `Collected`.
- **Precious Metal Details** — Item 1: metalType `Gold`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `10500`.
- **Review & Submit**: Complete.

**TX-E3 — second follow-up, proving the alias-carryover fix:**

- **Start Transaction**: scenario = Sell precious metal to customer; transactionRef = `UAT-E3-0005C`; dateTime prefilled (after TX-E2's completion time).
- **Customer Search**: search Individual — firstName `Sarah`, lastName `Austen`, dateOfBirth `1975-01-20` — select the **existing** Sarah Jane Austen record. **Check the search result / Party Details immediately after selecting her**: the alias "Sarah A. Austen-Smith" should already be listed, without needing to click Add again — this is the actual behavior under test.
- **Transaction Details**: Cash currency = AUD; cashAmount = `10500`.
- **Party Details**: confirm the alias appears pre-filled; confirm address/DOB/etc. also carried over as before.
- **Conducting Person**: hasConductingPerson = **No**.
- **ID Verification** (Sarah Jane Austen): verificationMethod = **Relied on prior identification**, reusing `EVS-000123` as in TX-E2.
- **Recipient & Delivery**: recipientIsParty = **Yes**; recipient = Sarah Jane Austen; purpose of transfer = `Collecting precious metal`; delivery method = `Collected`.
- **Precious Metal Details** — Item 1: metalType `Gold`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `10500`.
- **Review & Submit**: Complete.
- **After generating a report for this transaction's date**, confirm the XML's `<individualDetails>` for Sarah Austen includes `<altName>Sarah A. Austen-Smith</altName>`.

---

**TX-F — Buy precious metal from customer, sole-trader/ACN company + Director representing an organisation + deleted item**

- **Start Transaction**: scenario = Buy precious metal from customer; transactionRef = `UAT-F-0006`; dateTime prefilled.
- **Create new customer** (Company): entityName `Perth Metal Co`; abnAcn `123456789`; suburb `Fremantle`; companyPhone `0894561234`; companyEmail `info@perthmetal.example.test`.
- **Transaction Details**: Cash currency = AUD; cashAmount = `18000`.
- **Party Details** (Perth Metal Co, Company): entityName `Perth Metal Co`; legalForm `Sole trader`; bizStreet `7 Harbour Rd`; bizSuburb `Fremantle`; bizState `WA`; bizPostcode `6160`; bizCountry `Australia`; companyPhone `0894561234`; registration identifier type `ACN`, value `123456789`; principalActivity `Metal refining`.
- **Conducting Person**: hasConductingPerson = **Yes**; representedPartyId = Perth Metal Co; fullName `Michael Director`; dobKnown `Yes`; dateOfBirth `1970-07-07`; resStreet `4 Harbour Rd`; resSuburb `Fremantle`; resState `WA`; resPostcode `6160`; resCountry `Australia`; phone `0400444555`; occupation `Company director`; relationship = `Director` (**not** Employee — this is what triggers the full `isRepresentingOrganisation=Y` + `representedOrganisation` block, distinct from TX-C's Employee path); authorityToAct = `Sole director and company secretary, authorised under the company constitution to act for Perth Metal Co.`; isEmployee = **No**; actingViaEntity = **No**.
- **ID Verification** (Michael Director): verificationMethod `Sighted original document`; documentType `Driver licence`; documentNumber `DL456789123`; issuer `Department of Transport WA`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2027-05-05`; capture front **and back**.
- **Recipient & Delivery**: recipientIsParty = **Yes**; recipient = Perth Metal Co; purpose of transfer = `Dropping off precious metal`; delivery method = `Collected`.
- **Precious Metal Details**:
  - Item 1: metalType `Iridium`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `18000`; description blank (not required — not Alloy/Other); serialNumber blank.
  - Item 2 (temporary): metalType `Rhodium`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `12000`. **Delete Item 2 before clicking Continue** — final `<pmi>` aggregate should be Iridium only ($18,000).
- **Review & Submit**: Complete.

---

**TX-G — Sell bullion to customer, two customers, conducting-person refId correctness**

- **Start Transaction**: scenario = Sell bullion to customer; transactionRef = `UAT-G-0007`; dateTime prefilled.
- **Customer Search**: search Individual for Jane Citizen (firstName `Jane`, lastName `Citizen`, dateOfBirth `1985-06-15`) and select the **existing** record from TX-A. Then **Create new customer** (Individual) for a second party: firstName `Marcus`, middleName `James`, lastName `Tester`, dateOfBirth `1990-03-22`, phone `0400333444`, email `marcus.tester@example.test`. Continue with both parties selected.
- **Transaction Details**: Cash currency = AUD; cashAmount = `11000`.
- **Party Details**:
  - Jane Alice Citizen: confirm her existing details carried over correctly (occupation `Jeweller`, gender `F`, citizenship/tax `AU`, address as in TX-A); fill in anything blank identically to TX-A.
  - Marcus James Tester: fullName `Marcus James Tester`; dateOfBirth `1990-03-22`; resStreet `45 Sample Ave`; resSuburb `Richmond`; resState `VIC`; resPostcode `3121`; resCountry `Australia`; phone `0400333444`; occupation `Retailer`; gender `M`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`.
- **Conducting Person**: hasConductingPerson = **No**; conductedByPartyId = **explicitly select Marcus James Tester** (the second party added — this is the case being tested, do not leave it defaulted to Jane).
- **ID Verification**:
  - Jane Alice Citizen: verificationMethod `Sighted original document`; documentType `Passport`; documentNumber `PA1234567`; issuer `Australian Passport Office`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2031-06-15`; capture front.
  - Marcus James Tester: verificationMethod `Sighted original document`; documentType `Medicare card`; documentNumber `MC998877`; issuer `Services Australia`; idCountryCode `AU`; hasExpiry `No`; capture front.
- **Recipient & Delivery**: recipientIsParty = **Yes**; recipient = Jane Alice Citizen (deliberately independent of which party conducted the transaction); purpose of transfer = `Collecting bullion`; delivery method = `Collected`.
- **Bullion Details** — Item 1: metalType `Silver`; productType `Bar`; purity `999`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `11000`; description `1kg silver bar`.
- **Review & Submit**: Complete.

---

**TX-H — Buy bullion from customer, different recipient with unknown DOB, delivery method "Other"**

- **Start Transaction**: scenario = Buy bullion from customer; transactionRef = `UAT-H-0008`; dateTime prefilled.
- **Create new customer** (Individual): firstName `Grace`, lastName `Harbour`, dateOfBirth `1988-08-08`, phone `0400666777`, email `grace.harbour@example.test`.
- **Transaction Details**: Cash currency = AUD; cashAmount = `10200`.
- **Party Details** (Grace Harbour): fullName `Grace Harbour`; dateOfBirth `1988-08-08`; resStreet `18 Bay St`; resSuburb `Geelong`; resState `VIC`; resPostcode `3220`; resCountry `Australia`; phone `0400666777`; occupation `Nurse`; gender `F`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`.
- **Conducting Person**: hasConductingPerson = **No**.
- **ID Verification** (Grace Harbour): verificationMethod `Sighted original document`; documentType `National identity card`; documentNumber `NIC-334455`; issuer `Department of Home Affairs`; idCountryCode `AU`; hasExpiry `No`; capture front.
- **Recipient & Delivery**: recipientIsParty = **No**; recipient full name = `Recipient Test Person`; dobKnown = **No**; address `20 Delivery Way, Geelong, VIC, 3220, Australia`; purpose of transfer = `Dropping off bullion`; delivery method = `Other` → describe delivery method = `Sent via registered post with signature on delivery`; deliveryAddressDifferent = **No**; notes blank.
- **Bullion Details** — Item 1: metalType `Gold`; productType `Bar`; purity `999.9`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `10200`; description `1kg gold bar`.
- **Review & Submit**: Complete.

---

**TX-I — Employee conducting person, verifying the `is_employee`/employee-role persistence fix (fix #5):**

- **Start Transaction**: scenario = Sell bullion to customer; transactionRef = `UAT-I-0009`; dateTime prefilled (after TX-H's completion time).
- **Customer Search**: search Company — entityName `Golden Bullion Traders Pty Ltd`, ABN `12345678901`, registered suburb/postcode `Dandenong` (all three required) — select the **existing** company record from TX-C (don't create a new party).
- **Transaction Details**: Cash currency = AUD; cashAmount = `12000`.
- **Party Details**: confirm Golden Bullion Traders Pty Ltd's details carried over correctly from TX-C; fill in anything blank identically to TX-C.
- **Conducting Person**: hasConductingPerson = **Yes**; representedPartyId = Golden Bullion Traders Pty Ltd; fullName `Tom Employee`; dobKnown `Yes`; dateOfBirth `1995-09-09`; resStreet `8 Staff St`; resSuburb `Dandenong`; resState `VIC`; resPostcode `3175`; resCountry `Australia`; phone `0400999000`; occupation `Branch teller`; relationship = `Employee`; authorityToAct = `Employed staff member authorised to transact on behalf of Golden Bullion Traders Pty Ltd.`; **isEmployee = Yes**; employeeRole = `Store manager`; actingViaEntity = **No**. Click Save/Continue.
- **Draft-reload check (proves the `dbRowToCp` half of the fix, no DB access needed)**: navigate back to the Conducting Person page (browser back, or the wizard's step navigator) before completing the transaction. Confirm "Is employee?" is still shown as **Yes** and "Store manager" is still populated in the employee role field — before the fix, this would have silently reset to unselected on reload.
- **ID Verification** (Tom Employee only): verificationMethod `Sighted original document`; documentType `Proof of age card`; documentNumber `POA-11223`; issuer `Service Victoria`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2027-12-01`; capture front.
- **Recipient & Delivery**: recipientIsParty = **Yes**; recipient = Golden Bullion Traders Pty Ltd; purpose of transfer = `Collecting bullion`; delivery method = `Collected`; notes blank.
- **Bullion Details** — Item 1: metalType `Platinum`; productType `Bar`; purity `999.5`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `12000`; description `1kg platinum bar`.
- **Review & Submit**: Complete.
- **After generating a report for this transaction's date**, confirm the XML's `<agencyAuthorisation>` for Tom Employee reads `"Employed staff member authorised to transact on behalf of Golden Bullion Traders Pty Ltd. - Employee role: Store manager"` (plain ASCII hyphen, not an em-dash — see fix #6 below) — the employee-role fold TX-C was meant to prove, now actually working end-to-end.

---

**TX-J — Trust organisation answering the express-trust question, verifying `isExpressTrust`/`TrustDetails` (fix #7):**

- **Start Transaction**: scenario = Buy bullion from customer; transactionRef = `UAT-J-0010`; dateTime prefilled (after TX-I's completion time).
- **Customer Search**: search Company — entityName `Southern Cross Metals Trust`, ABN `98765432109`, registered suburb/postcode `Box Hill` (all three required) — select the **existing** company record from TX-D (don't create a new party).
- **Transaction Details**: Cash currency = AUD; cashAmount = `20000`.
- **Party Details**: confirm Southern Cross Metals Trust's details carried over correctly from TX-D; legalForm should already show `Trust`, which reveals **Is this an express trust?** — this question didn't exist when TX-D was originally completed. Select **Yes**; Trust type = `Discretionary trust`; Trust name = `Southern Cross Family Trust`. Fill in anything else blank identically to TX-D.
- **Conducting Person**: hasConductingPerson = **No**; conductorIdentifiable = **No — impersonal channel** (as in TX-D); methodOfConductingTxn = `Night safe or express deposit`.
- **ID Verification**: none.
- **Recipient & Delivery**: recipientIsParty = **Yes**; recipient = Southern Cross Metals Trust; purpose of transfer = `Dropping off bullion`; delivery method = `Collected`.
- **Bullion Details** — Item 1: metalType `Gold`; productType `Coin`; purity `999.9`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `20000`; description `1kg gold coin lot`.
- **Review & Submit**: Complete.
- **After generating a report for this transaction's date**, confirm the XML shows `<isExpressTrust>Y</isExpressTrust>` immediately followed by `<trustDetails>` containing `<trustTypeOther>Discretionary trust</trustTypeOther><trustName>Southern Cross Family Trust</trustName>`, positioned before `<isIdentityVerified>` — and that no `trustParticipant`/`trustBeneficiary` elements appear (deliberately deferred, see "Known future feature" above).

---

All cash-vs-item-total pairings above are chosen to match 1:1 for narrative simplicity — the schema itself doesn't require cash value to equal item value, so exact matching isn't a validation requirement, just a convenience for sanity-checking the generated XML by eye. Weight is set to `1` and weightUnit to `kilograms` for every item throughout, with the unit price carrying the full line-total value — this keeps the qty × weight × unitPrice arithmetic trivial to verify by eye; real weights/prices aren't needed for schema-validation purposes.

Not included: a single transaction with both AUD cash and foreign cash components (TC-235) — the wizard doesn't currently support capturing both on one transaction, and this was explicitly scoped out of the earlier gap-sweep by the user's own decision, so there's no UI path to build it manually either.

After each transaction reaches `/review` with no blocking issues, click **Complete** — this calls `complete-transaction`, which marks the transaction `status = 'complete'`. It does **not** generate the XML itself.

### Triggering report generation on demand

`generate-austrac-report` is a separate batch job, not called synchronously by `complete-transaction`, and there's no UI button to invoke it directly either — it pulls all `status = 'complete'` transactions whose `completed_at` falls within a given report date (AEST calendar day) that aren't already in a `report_batches` row, and bundles them per reporting entity. It's meant to run via a `pg_cron` schedule (currently commented out in `supabase/migrations/20260621000025_report_batches.sql:56-74`), so nothing calls it automatically in this deployment yet — invoke it directly, or use the **Regenerate** button on `ReviewBatchPage.jsx` (deletes a not-yet-submitted batch and its transaction links, then re-triggers generation for the same date server-side, in one click).

To trigger a batch manually: `POST https://rygjssczdoyvmumxmymc.supabase.co/functions/v1/generate-austrac-report` with `Authorization: Bearer <key>`, `apikey: <same key>`, and body `{"reportDate": "<AEST date, YYYY-MM-DD>"}` — a ready-to-use Postman collection exists at `supabase/functions/generate-austrac-report/generate-austrac-report.postman_collection.json`. **Known project-specific gotcha**: for this project, the key that actually works is the **new-style `sb_secret_...` key** (Project Settings → API → API Keys → Secret keys) — not the legacy JWT-format `service_role` key, despite that being the opposite of Supabase's general legacy/new-key guidance (confirmed by hashing the function's actual runtime `SUPABASE_SERVICE_ROLE_KEY` value and matching it byte-for-byte against the `sb_secret_...` key).

Each transaction is recorded in `transaction_reports` once batched, so a second call for the same date won't pick it up again — use Regenerate (not a second raw call) if a batch needs to be rebuilt.

## Part 2 — Offline schema validation (safe, no AUSTRAC interaction)

1. Pull the `xml_content` column from each resulting `report_batches` row (one row per reporting entity per report date — if UAT transactions were completed across multiple days, there will be one row/XML per date).
2. The user already has the official AUSTRAC TTR-1-0 XSD file and will validate against it directly.
3. Validate each transaction's XML against the XSD with a standard tool — `xmllint --noout --schema ttr-1-0.xsd <file>.xml` (libxml2, available via Git Bash/WSL) is the simplest option; no new dependency needs to be added to the project for this. (`xmllint` was not found installed in this environment when last checked — PowerShell's built-in `System.Xml.Schema.XmlSchemaSet` is a no-install fallback if needed.)
4. For each transaction, confirm: valid against the XSD, `reportCount` matches the number of `<ttr>` blocks, all `xs:ID`/`xs:IDREF` pairs resolve (already covered by TC-248/249 automated tests, but worth eyeballing once on real generated data).

This step alone gives strong confidence AUSTRAC's own schema validation (which AUSTRAC Online runs on upload) will pass, without any risk of lodging test data as a real report.

## Part 3 — Confirming AUSTRAC will actually accept the file

Before uploading anything to AUSTRAC Online with real credentials:
- Check whether the organisation already has a designated test/training reporting arrangement with AUSTRAC (worth confirming with whoever manages the AUSTRAC Online account/reporting group registration).
- If not, contact AUSTRAC directly (their reporting entity help desk/onboarding contact) and ask specifically how they want batch-file TTR testing done before go-live — this varies by their current process and shouldn't be guessed at.
- Only once AUSTRAC confirms a safe channel should any transaction's XML be uploaded there.

## Sequencing

1. **Part 1** — run TX-B2, TX-E3, TX-I, and TX-J (the only transactions not yet completed as of this writing); A–H, E2 are already done.
2. **Part 2** — offline XSD validation of all batches, including the fresh ones from TX-B2/TX-E3/TX-I/TX-J. Use a real XSD 1.1-capable validator (e.g. Python's `xmlschema` package) — `xmllint`/.NET's `System.Xml.Schema` don't support the `xs:assert` conditional rules this schema relies on and will falsely report every file as valid.
3. Prod deploy.
4. **Part 3** — AUSTRAC acceptance confirmation, only after prod deploy.

## Verification

- TX-B2, TX-E3, TX-I, and TX-J each reach `/review` with the green "ready to complete" banner and complete successfully.
- TX-B2's generated XML shows the Agent/`agencyAuthorisation` structure TX-B was meant to prove; TX-E3's shows `<altName>` without having re-entered the alias; TX-I's shows `employee_role` folded into `<agencyAuthorisation>`, and its draft-reload check confirms "Is employee?" survives a page reload; TX-J's shows `isExpressTrust`/`trustDetails` correctly, with no participant/beneficiary elements.
- Regenerating any existing batch (A–H, E2) shows fix #7's other 3 bugs resolved too, even without a dedicated new transaction for them: every individual's `isAbnHolder`/`abn` are now absent (not just "N"), every OVS identification (Sarah Austen's, reused in TX-E/E2/E3) no longer carries a `countryCode`, and every `<ttr id>` is now prefixed `ttr-` regardless of what the underlying transaction UUID starts with.
- Every batch's XML (including regenerated ones) validates cleanly against the AUSTRAC XSD via Part 2 — including the `xs:assert` business rules, not just structure/types.
- No file is uploaded to AUSTRAC Online until Part 3's confirmation step is satisfied.
