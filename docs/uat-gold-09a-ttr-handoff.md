# UAT: Gold to TTR hand-off (Gold Phase 9a)

**Purpose:** prove that `gold/09a-ttr-handoff` starts the TTR (AUSTRAC report) for a gold purchase correctly, and that the TTR wizard can pick it up:
1. `gold-start-ttr` creates, in one transaction, the TTR draft or drafts (one per type paid in cash), their parties and their reliance rows, and links the purchase and its same-type parts
2. The server decides everything: whether the sale is reportable, the cash, the case (A or B), the staff, the business. The browser sends only a purchase id
3. A later part on an invoice joins a draft TTR, and a completed TTR blocks it
4. A transaction reference is now unique per business **and scenario**, so a mixed invoice can carry the same reference on two reports
5. The wizard opens a gold-started TTR by id, warns about another report in progress, accepts the counter confirmation copied from gold, and shows where the report came from
6. `cleanup-stale-drafts` leaves gold-linked drafts alone; Exit still deletes one and clears the gold link
7. AUSTRAC batches made from gold-started TTRs are valid, with the right `txnRefNo` and `<identification>`

The gold purchase screens and their "Start TTR" buttons are Phase 8b, and exports are build step 7. Until then the function is called directly and the wizard is opened at `/open-ttr/<ttr id>`.

| | |
|---|---|
| Environment | Local stack (Section A) · dev `rygjssczdoyvmumxmymc` (Section B) |
| Build/commit | ________ |
| Run by / date | ________ |

**Timing.** Section A is automated: about 4 minutes for the `gold09a` Playwright project, plus the stack restart. Section B is about 10 minutes.

**Where the rules come from.** Spec §3 (3.1 to 3.5, including 3.3a), §4.3, §4.4 (the `cleanup-stale-drafts` and `delete-draft-transaction` rows), §4.6, §7 (build-time checks), §8 step 6 and §9 (AUSTRAC file) of `docs/gold-due-diligence-spec.md`. The "Spec" column names the clause each row proves. Where the spec fixes a behaviour but not a response code, the code is the one documented in the header of `supabase/functions/gold-start-ttr/index.ts`.

**`GOLD_JOURNEY_ENABLED`.** Locally it comes from `supabase/config.toml` `[edge_runtime.secrets]` (and the Playwright web server sets `VITE_GOLD_JOURNEY_ENABLED=true`); on dev it is set with `secrets set`; it stays off on the client project `ykerufaergyqvnaycyce`.

**Test setup (every automated row).** Each test seeds its own business, staff and customers (the Phase 7 support in `app/e2e/gold07/support.js` for the API rows, the signed-in dev-style admin and staff accounts of `app/e2e/support/auth.js` for the wizard rows). Names used in the rows:
- **Jane Citizen**: every Party Details field on file (occupation Jeweller, gender F, citizenship AU, tax residency AU, not a sole trader), and a driver licence on file with issuer VIC, country AU
- **Joan Smith**: same, a second person (the joint seller)
- **Gold-only Gina**: name, DOB, address, phone and a licence, but no occupation, gender, citizenship or tax residency (so she is not ready for case A)

"A purchase" means a saved gold purchase with `ttr_self_conducted` and `ttr_details_confirmed` both Yes unless the row says otherwise, saved today. The tests generate a fresh invoice number for each row (for example `INV-G7-<run>-12-3` standing in for `INV-A1`) so a rerun on the same database cannot collide; only the AUSTRAC rows (9.51 to 9.54) use the literal `INV-S1`, `INV-900`, `INV-J1` and `INV-CO1`, so run those on a freshly reset database (`npm run uat:gold09a` resets it).

---

## A · Automated rows

Run from `app/`, under the stack lock if other work shares the machine, from this branch's directory (the local edge runtime serves functions from the directory where `supabase start` ran):

```
npx supabase stop --workdir .. && npx supabase start --workdir .. && npx supabase db reset --workdir ..
npx supabase test db --workdir ..          # pgTAP: expect Result: PASS (includes 13_gold09a_uat.test.sql)
cd ../supabase/functions && deno task test   # expect 0 failed (includes _shared/gold09aFlag.test.ts)
cd ../../app && npm test                     # Vitest, with VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder-anon-key
npm run uat:gold09a                          # the gold09a Playwright project (also part of `npm run uat`)
```

☐ CI green on this commit (jobs `uat`, `functions`, `frontend`)

**Where the tests are.** Playwright files are in `app/e2e/gold09a/`: **A1** `01-refusals-and-rules.e2e.js` · **A2** `02-case-a-contents.e2e.js` · **A3** `03-case-b-joint-mixed-atomic.e2e.js` · **A4** `04-join-and-existing-functions.e2e.js` · **A5** `05-wizard-case-a.e2e.js` · **A6** `06-wizard-case-b-and-pickup.e2e.js` · **A7** `07-wizard-state-and-idle.e2e.js` · **A8** `08-austrac-file.e2e.js` · **A9** `09-mixed-6k-completes.e2e.js` (with `support.js` and `wizard-support.js`). **P** = `supabase/tests/13_gold09a_uat.test.sql` (pgTAP). **D** = `supabase/functions/_shared/gold09aFlag.test.ts` (Deno). **V1** = `app/src/__tests__/ttrExitsToStart.uat.test.js`, **V2** = `app/src/lib/describeSaveError.uat.test.js`, **V3** = `app/src/lib/goldApi.test.js` (Vitest).

**How the wizard rows are driven.** The admin signs in through the real login (password, then the TOTP code). The test makes the purchase with `gold-save-purchase` and the TTR with `gold-start-ttr` using that admin's own token (so the TTR belongs to the admin's business), then opens `/open-ttr/<id>` in the browser and drives the real pages. A new browser tab per test gives an empty `sessionStorage`, which is what the wizard keeps its state in.

**The AUSTRAC file rows run in CI.** `xmlschema` is installed by the `uat` job (`pip install xmlschema`), the same way Part 0, Phase 4 and Part 1 validate their batches, so 9.51 needs no manual step. Locally it needs `pip install xmlschema` and `python` on the path (or set `PYTHON`).

### A · Refusals (`gold-start-ttr`)

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 9.1 ⚠ | §2.2 | With `GOLD_JOURNEY_ENABLED` unset, empty, `false`, `TRUE`, `1`, `true `, ` true`, `True` or `yes`, the function answers **403 `gold_disabled`** before the token is looked at (even with no token) and makes no network call; with exactly `true` it gets past the gate (no token is then 401) | D `9.1 …` (secrets cannot be toggled on the running local stack, so the handler is driven with the stubbed fetch, as `gold06Flag.test.ts` does) |
| 9.2 ⚠ | §6.1 | No token, then the anon key as the token: **401** both times; nothing written | A1 `9.2 ⚠` |
| 9.3 ⚠ | §6.1 | A password-only (`aal1`) session: **403 `mfa_required`**; nothing written | A1 `9.3 ⚠` |
| 9.4 | §6.1 | A deactivated staff member (with MFA): **403 `forbidden`** | A1 `9.4` |
| 9.5 ⚠ | §6.1, §4.3 | Staff of another business with this business's purchase id: **404 `purchase_not_found`**, the same answer as for an unknown id; no TTR, party or link written | A1 `9.5 ⚠` |
| 9.6 | §4.3 | `{}`, `{"purchaseId":"nope"}`, `{"purchaseId":12}`, a non-JSON body, an array and `null`: **400 `bad_request`** naming the field (`purchaseId` or `body`); nothing written | A1 `9.6` |
| 9.7 | §4.5 | A plain `staff` member (not manager or admin) with a valid reportable purchase that has an invoice: **200** | A1 `9.7` |

### B · Rules the server re-checks

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 9.8 ⚠ | §3.2 "runs only when the purchase has an ERP invoice" | A reportable purchase with no invoice number: **422 `invoice_required`**; nothing written | A1 `9.8 ⚠` |
| 9.9 ⚠ | §3.4 reportable at $10,000 | A single purchase with $9,999.99 cash is **422 `not_reportable`** and writes nothing; two same-day linked parts of $5,000 + $5,000 start one TTR of $10,000 | A1 `9.9 ⚠` |
| 9.10 | §3.4 "cash above $0" | A purchase flagged reportable whose entered cash is 0: **422 `no_cash`**; nothing written. `gold-save-purchase` never stores this shape, so the row is written straight into `gold.purchases` | A1 `9.10` |
| 9.11 ⚠ | §3.2, §4.3 | A lying client: the body also carries `cash`, `staff`, `entity`, `ref`, `scenario`, `case` (and their long names). Cash, staff, business, reference, scenario and case all come from saved data | A1 `9.11 ⚠` |

### C · What a case A TTR contains (§3.2)

Jane, one purchase, scrap, $12,000 cash, invoice `INV-A1`, both counter questions Yes.

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 9.12 ⚠ | §3.2 | **200**, one entry: `type` scrap, `scenario` `precious_metal_buy`, `status` draft, `created` true, `case` A. One draft `ttr.transactions` row: reference exactly the invoice, cash and AUD value 12000.00, currency AUD | A2 `9.12 ⚠` |
| 9.13 | §3.2, §3.1 | `transaction_datetime` equals the purchase's `created_at`; service "Purchase of precious metal for physical cash"; location "Coburg, VIC"; staff name, email and role are the caller's; `created_by_staff_id` is the caller | A2 `9.13` |
| 9.14 | §3.2 | One individual party for Jane with `customer_id` set and her name, DOB, phone, address, occupation, gender, citizenship and tax residency copied, not a sole trader; `is_complete` true | A2 `9.14` |
| 9.15 ⚠ | §3.2 | One reliance row: basis `relied_on_prior_identification`, `prior_verification_id` = the capture used on the purchase, reason `customer_confirmed_details_unchanged`, `is_complete` true; document type, number, issuer VIC, country AU, has-expiry and expiry copied; **no front or back image**; `counter_confirmed_at` / `_by_staff_id` equal the purchase's `created_at` and creator | A2 `9.15 ⚠` |
| 9.16 | §3.2 | Parts of the same type on the same invoice, day and seller get the same TTR id; the other type gets its own; another invoice gets none | A2 `9.16` |
| 9.17 | §3.2 | No storage object and no `ttr.stored_images` row is created | A2 `9.17` |
| 9.18 ⚠ | §3.2 "idempotent" | Calling again, and for a second same-type linked part, returns the same TTR with `created` false and `case` null; still one transaction, one party, one reliance row | A2 `9.18 ⚠` |
| 9.19 | §3.2 "or the placeholder" | A reportable bullion purchase with no cash amount entered: the TTR's cash and AUD value are 1.00 | A2 `9.19` |
| 9.20 | §4.5 | One `gold.purchase_audit_log` row: source `start_ttr`, `changed_by` the caller, only `ttr_transaction_id` changed; none on a repeat call | A2 `9.20` |

### D · Case B, joint sales, mixed invoices

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 9.21 ⚠ | §3.3, §3.3a | A No on the details question, and Gina's purchase (not ready): `case` B; the reliance row has reason `prior_id_reviewed_still_valid` and `is_complete` false; Gina's party is not complete and keeps her missing fields empty; the counter confirmation is still copied | A3 `9.21 ⚠` |
| 9.22 ⚠ | §3.3 "a joint sale is always case B" | Jane main, Joan joint, both Yes: one TTR with **two** parties (both with `customer_id`) and **two** reliance rows, one per capture; `case` B; rows not complete | A3 `9.22 ⚠` |
| 9.23 ⚠ | §3.4 | Jane, same day, one invoice: scrap $6,000 cash and bullion $6,000 cash. Called for the bullion part: **two** entries, bullion first; two transactions with the same reference, `bullion_buy` $6,000 and `precious_metal_buy` $6,000 (adding up to $12,000); each part linked to its own type's TTR; the same case on both | A3 `9.23 ⚠` |
| 9.24 | §3.4 "bank transfer gets no TTR" | Scrap $12,000 cash and bullion with a known amount of 0 on one invoice: **one** TTR; the bullion part has none | A3 `9.24` |

### E · Atomicity and concurrency

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 9.25 ⚠ | §3.4, §4.5 (atomic) | Another TTR already holds the invoice for `precious_metal_buy`; a mixed sale is started from its bullion part: **409 `ttr_reference_in_use`**, and the bullion TTR the call had already begun is **not** left behind; no party, reliance row or link | A3 `9.25 ⚠` |
| 9.26 ⚠ | §3.2 "idempotent", invoice lock | Two parts of one invoice started at once: while a second connection holds the invoice lock the calls wait, then exactly **one** TTR set exists and both calls return it (and the same without the lock, as a plain race) | A3 `9.26 ⚠` and `9.26 (race)`. D1 fixed in 26194ae and re-verified |
| 9.27 | §6.1 | A refusal and a success: the log has one line, with the purchase id and an error code only; no name, phone, ID number, invoice or amount | A3 `9.27` |
| 9.28 ⚠ | §2 grants | `authenticated` and `anon` cannot execute `gold.start_ttr` or its five helpers (**42501** when called); only `service_role` can | P `9.28` |

### F · One reference per scenario (§3.4)

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 9.29 ⚠ | §3.4 | The constraint is (`reporting_entity_id`, `transaction_ref`, `scenario`): the same reference in the other scenario and in another business is accepted; the same scenario in the same business fails with **23505** | P `9.29` |

### G · A later part on an invoice that has a TTR (§3.5)

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 9.30 ⚠ | §3.5 | A draft scrap TTR of $12,000; another scrap part of $3,000 saved on the invoice joins it and the draft's cash and AUD value become 15000.00 | A4 `9.30 ⚠` |
| 9.31 | §3.5 | A scrap part saved with no invoice and given the invoice through `gold-complete-purchase` joins the draft the same way | A4 `9.31` |
| 9.32 | §3.4 | A **bullion** part of $500 on the invoice does not join the scrap TTR and its cash is unchanged | A4 `9.32` |
| 9.33 ⚠ | §3.5, §4.3 | Once the TTR is complete, a new scrap part on the invoice is **422** with `errors.erp_invoice_no` "The AUSTRAC report for {invoice} is already finished. Use a new ERP invoice number for this purchase."; nothing saved; the TTR unchanged | A4 `9.33 ⚠` |
| 9.34 ⚠ | §3.5 | The same completed TTR: adding the invoice to a saved part through `gold-complete-purchase` gives the same **422** and the purchase keeps no invoice | A4 `9.34 ⚠` |

### H · Existing TTR functions (§4.4)

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 9.35 ⚠ | §4.4 `cleanup-stale-drafts` | Two drafts aged 60 days, one linked to a gold purchase: the unlinked one is deleted; the linked one stays, with its parties | A4 `9.35 ⚠` |
| 9.36 ⚠ | §4.4 `delete-draft-transaction` | Exit on the linked draft is **200**; the TTR and its parties are gone; the purchase stays with no link; `gold-start-ttr` again makes a fresh draft | A4 `9.36 ⚠` |
| 9.37 | §3.2 | A counter confirmation on a customer-level ID row is refused (**23514**); so is only the time, or only the staff member; pointing a reliance row at another record, or changing it to a new capture, empties both columns | P `9.37` |

### I · The wizard picks up the TTR (admin signed in, real pages)

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 9.38 ⚠ | §3.2 `openTransaction` | `/open-ttr/<case A id>` lands on **Transaction Details** ("Step 3") with the invoice as reference, "Buy precious metal from customer", the sale time of the purchase, **and the cash shown as 12000** | A5 `9.38 ⚠`. D2 fixed in 26194ae and re-verified |
| 9.39 ⚠ | §3.2 Case A, §3.3 | Continue with the cash as shown; Party Details ("Step 4") already complete; Review shows "From gold purchase(s) on invoice …" and Complete / Reportable completes the TTR; the Complete page shows the invoice | A5 `9.39 ⚠`. D2 fixed in 26194ae and re-verified (the same flow with the cash typed is 9.69) |
| 9.40 ⚠ | §3.2 `IdVerificationPage` | Back from Transaction Details: Jane's reliance row shows "ID sighted and matched to this record at the counter on …"; **no** "I confirm the person presenting today matches these ID images" tick; Continue saves without it. A reliance row on a TTR started in the wizard still shows the tick and refuses Continue without it | A5 `9.40 ⚠` and `9.40 ⚠ (control)` |
| 9.41 ⚠ | §3.2 Case B | Gina's TTR lands on **Customers** with her added and the "acting on their own behalf" question; Yes goes to ID Verification (copied confirmation shown), Transaction Details, then Party Details, which asks for occupation and gender (and offers the country fields) and refuses Continue until given; the TTR then completes. No goes to Transaction Details, Party Details and Conducting Person. A joint TTR lists both sellers and its path includes Conducting Person | A6 `9.41 ⚠`, `9.41 ⚠ (No)`, `9.41 ⚠ (joint)` |
| 9.42 ⚠ | §3.2 warning | With one draft active, opening another shows "You have another AUSTRAC report in progress (INV…). It stays saved; reopen it from the TTR start page." and opens nothing; **Open this report** opens the new one; **Cancel** goes to `/start` and the first draft is unchanged. No warning when none is active or the same one is opened | A6 `9.42 ⚠` |
| 9.43 | §3.2 | A completed TTR id and an unknown id: a message ("already complete" / "could not be found") and a **TTR start** button; the session's active report is unchanged. (With another report active the warning of 9.42 comes first; Open this report then shows the message) | A6 `9.43` and `9.43 (no report active)` |
| 9.44 ⚠ | §3.4 | The spec's mixed invoice, $6,000 scrap + $6,000 bullion: open and complete the first; the Complete page shows "Another AUSTRAC report for … is waiting" with **Open it**, which opens the second; after the second the notice is gone | A6 `9.44 ⚠`. D3 fixed in 26194ae and re-verified |
| 9.45 ⚠ | §3.4 Start page | A reference with a completed bullion report: Buy bullion shows "belongs to a completed transaction"; switching to precious metal clears it and starts normally. With a **draft** for the chosen scenario: "Existing draft found — fields pre-filled." | A6 `9.45 ⚠`, `9.45 ⚠ (draft)` |
| 9.46 | §3.4 `describeSaveError` | A save failing on the per-scenario reference constraint reads "That transaction reference is already in use for this scenario. A reference can be used once for each scenario …" | V2 (the message) and P `9.29` (the 23505) |
| 9.47 | §3.2 | Open the case A TTR, change nothing else on Transaction Details, Continue: `transaction_datetime` is not shifted by the time zone (equal to the minute; the seconds are dropped, see spec question 1) | A5 `9.47` |

### J · §7 build-time checks

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 9.48 ⚠ | §7 wizardStorage readers | In a tab with an empty session: `/open-ttr/<id>`, then Customers, ID Verification, Transaction Details, Party Details and Review each show that TTR's data (parties, reference, scenario, document number, "Step 2/3/4" for case A); a second TTR opened over the first replaces every trace of it | A7 `9.48 ⚠` |
| 9.49 | §7 `navigate('/')` | No TTR page directory navigates to `/` (they all go to `/start`); the screens' Exit, Cancel and TTR start were driven in 9.42, 9.43 and 9.50 | V1 `9.49 …`, A6 `9.42`, `9.43`, A7 `9.50` |
| 9.50 ⚠ | §7 idle sign-out | A wizard-started TTR and an active gold-started one; after the idle limit the browser's wizard session is cleared and both drafts stay in the database; signing in with `?redirect=/open-ttr/<id>` reopens the gold-started TTR with its data; the wizard-started one reopens from `/start` by reference and scenario | A7 `9.50 ⚠` |

### K · AUSTRAC file (§9)

Batches are made by `generate-austrac-report` from gold-started TTRs that staff completed with `complete-transaction`: a single-type sale (`INV-S1`, case A), the mixed invoice `INV-900` ($10,000 + $10,000, so both TTRs can be completed, see D3), the joint sale `INV-J1`, plus one TTR started in the wizard for a company (`INV-CO1`; control 2 needs a company party in the batch).

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 9.51 ⚠ | §9 | `python scripts/validate_ttr_xml.py` (`xmlschema.XMLSchema11`, `docs/schema/TTR-1-0.xsd`): `XMLSchema11 1.1: 0 error(s)`; control 1 (digit-led ttr id) **1** error; control 2 (trust without isExpressTrust) **1** error | A8 `9.51 ⚠` (runs in CI) |
| 9.52 ⚠ | §3.4 | Both reports of the mixed invoice have `txnRefNo` exactly `INV-900` (one `BULSER`, one `PRECIOUS`); each `<ttr id="ttr-{TTR id}">` is present; every `id` in the file is unique | A8 `9.52 ⚠` |
| 9.53 ⚠ | §3.2, §9 | `<identification>` has `type`, `number`, `issuer` (VIC) and `countryCode` (AU) copied from the capture, for the single sale, both mixed reports and **both** parties of the joint report | A8 `9.53 ⚠` |
| 9.54 | §3.2 | The single-type report's customer name, occupation, address and amount come from Jane's copied party, and the transaction date is the purchase's | A8 `9.54` |

### L · Client API and regression

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 9.55 | §4.6 `goToAustracForm` | `goToAustracForm(purchaseId)` calls `gold-start-ttr` with only `{ purchaseId }` and returns `{ ttrs, path }` with `path` `/open-ttr/<first id>`; 422 and 409 codes give staff-readable messages | V3 `goToAustracForm …` (read, and seen failing under a break) |
| 9.56 ⚠ | §8 "each step leaves TTR working" | The existing TTR UAT (`uat:part0`, `uat:phase4`, `uat:part1`) passes, including R27 and R25; they run before `gold09a` in `npm run uat` and were not edited | CI job `uat` |
| 9.57 | §8 | The other gold UAT (`uat:gold06`, `gold07`, `gold08a`), the Vitest, Deno and pgTAP suites pass | CI jobs `uat`, `frontend`, `functions` |
| 9.58 | §3.2, §4.6 | The gold read RPCs show the purchase with `ttr_transaction_id`, `ttr_status` draft and `ttr_transaction_ref` equal to the invoice; after the TTR completes `search_gold_purchases` shows `ttr_status` complete and it is no longer "AUSTRAC pending", and `list_incomplete_purchases` drops it (spec 4.6: "reportable with the TTR not complete"); another business and `aal1` see nothing | P `9.58` |

### Added by UAT

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 9.59 | §3.2 "idempotent" | Starting a TTR that is already complete returns it as `complete`, `created` false, and leaves it unchanged | A1 `9.59` |
| 9.60 | §3.4 | Exactly $10,000 is reportable; two parts totalling $9,999.99 are **422 `not_reportable`** | A1 `9.60` |
| 9.61 | §3.4 | A same-type part on another day or another invoice is not linked and does not change the TTR cash | A1 `9.61` |
| 9.63 | §3.3a question 1 | A No on "acting on their own behalf" starts case B | A3 `9.63` |
| 9.64 | §3.2 staff | The TTR carries the staff member who **calls**; the counter confirmation carries the one who **recorded** the purchase | A3 `9.64` |
| 9.65 | §3.4, §4.3 "for that type" | A completed scrap TTR does not block a bullion part on the same invoice | A4 `9.65` |
| 9.66 | §3.4 | The mixed-invoice flow of 9.44 with $10,000 + $10,000: the waiting notice shows after the first and is gone after the second | A6 `9.66` |
| 9.67 | §3.4 `findTransactionByRef` | The same reference with a draft for each scenario reopens the draft of the chosen scenario | A6 `9.67` |
| 9.68 | §3.4 Start page | Typing the reference first and then choosing Buy bullion keeps bullion and shows the completed message, even when a precious metal draft exists | A6 `9.68`. D4 fixed in 26194ae and re-verified |
| 9.69 | §3.3 "fully prefilled" | Case A with the cash typed on Transaction Details: Party Details complete, Review shows the gold source, the TTR completes | A5 `9.69` |
| 9.70 | §3.4 | Both TTRs of the spec's mixed invoice ($6,000 + $6,000) can be completed through `complete-transaction` | A9 `9.70`. D3 fixed in 26194ae and re-verified |
| 9.71 | §3.4, §4.3 "recalculated on the server" | The $10,000 total is worked out from the linked cash whatever the stored flags say: parts written with every flag false, a single $10,000.00 or two of $5,000 start a TTR; $9,999.99 and $5,000 + $4,999.99 are **422 `not_reportable`**. (9.9 and 9.60 start from parts `gold-save-purchase` has flagged, so they prove the flag path; this row proves the server's own total) | A1 `9.71` |

(9.62 was not used.)

### Defects found by this automation (all four fixed in 26194ae and re-verified)

| ID | Rows | Expected | Actual |
|---|---|---|---|
| D1 (fixed in 26194ae) | 9.26 | Two parts of one invoice started at the same moment give one TTR; both calls are 200 | One call is **500 `start_failed`**. Postgres log: `deadlock detected`. `gold.start_ttr` locks its own purchase row (`FOR UPDATE`) before taking the invoice lock, then updates every linked part's row to set the link, so two calls for two parts wait on each other's row and lock |
| D2 (fixed in 26194ae) | 9.38, 9.39 | Transaction Details shows the TTR's cash (12,000) | The Cash amount field is empty (`TransactionDetailsPage.jsx` starts `cashAmount` at `""` and never reads the draft), so Continue is disabled until staff retype it. `openTransaction` seeds the parties, reference, scenario and time but not the cash |
| D3 (fixed in 26194ae) | 9.44, 9.70 | Each TTR of the spec's mixed invoice ($6,000 each, §3.4) can be completed | Transaction Details disables Continue below $10,000, and `complete-transaction` answers 422 `AUD value must be at least $10000` (`TTR_THRESHOLD_AUD`). Neither is changed by this phase |
| D4 (fixed in 26194ae) | 9.68 | The scenario the user chose stays chosen | With a reference typed first, the reference field's blur check runs without a scenario and finds the newest report (the precious metal draft); it switches the page to precious metal and shows "Existing draft found" while the user clicked bullion |

### Spec questions

1. **9.47, seconds.** Spec 3.2: the TTR's `transaction_datetime` is the purchase's `created_at`. Transaction Details uses a minute-level date-time input, so saving it rewrites the time with the seconds dropped. Reading A: acceptable (reports are filed to the minute). Reading B: gold's exact time must survive. The test checks the minute.
2. **9.43, order of the warning and the refusal.** With another report active, opening a completed or unknown id shows the "another report in progress" warning first, and the refusal only after **Open this report**. Reading A: fine, the warning comes first (§3.2 "warn first"). Reading B: a report that cannot be opened should not trigger a warning. The test accepts either order.
3. **D3, intent.** §3.4 makes each TTR of a mixed invoice carry its own type's cash ($6,000 each) yet the wizard and `complete-transaction` both require $10,000 per report. Reading A: gold-started reports linked to a reportable invoice should be exempt from the per-report threshold. Reading B: the reports should carry the invoice total. The automated mixed-invoice rows use $10,000 + $10,000, and 9.44 / 9.70 use the spec's $6,000 + $6,000.
4. **9.58, "complete".** The old sheet said the read RPCs show `ttr_status` complete after completion; §4.6 says `listIncompletePurchases` is "reportable with the TTR not complete", so the completed purchase correctly leaves that list. The row now says so (precision, not a weaker expectation).
5. **9.10.** The shape "flagged reportable with a cash amount of 0" cannot be produced through `gold-save-purchase`, so the test writes the row directly. Say if that shape should be impossible rather than refused.

---

## B · Manual test for the user (about 10 minutes, Postman and browser, one dev admin account)

Only what the local stack cannot see: deploying to dev, the hosted function, which project the Vercel preview uses, and the client project's secrets. Everything else is Section A.

**Before you start**
- Account: the one **dev admin** account on the dev project `rygjssczdoyvmumxmymc`. Use it for every step.
- Token: sign in to the preview (or the local app, step B3) as the dev admin with the 6-digit code, press **F12** > **Application** > **Local Storage** > the entry `sb-rygjssczdoyvmumxmymc-auth-token` > copy the value of `access_token` (the long text starting `eyJ`). It lasts about an hour: copy a new one if a call answers `unauthorized`.
- The dev **anon key**: Supabase dashboard > project `rygjssczdoyvmumxmymc` > **Project Settings** > **API Keys** > `anon` / publishable key.
- Customer: the dummy customer **Lena Hostedsix**, id `174fb856-4049-4c1a-a4c7-5440940ff088`, already on dev with a licence. No new customers are created. She has no gender, citizenship or tax residency on file, so her TTR will be case B.
- A real JPEG under 5 MiB (a Windows Camera photo), called `goods.jpg`, only if B2 has to make a purchase.

### B1. Deploy to dev (3 minutes)
1. ☐ In a terminal, from the repository folder of this branch, confirm the linked project: `cat supabase/.temp/project-ref` (Git Bash) or `type supabase\.temp\project-ref` (Command Prompt). It prints `rygjssczdoyvmumxmymc`. If it prints anything else, **stop**: do not push.
2. ☐ `cd app`, then `npx supabase db push --linked --workdir ..`. It lists four migrations: `20261109000001_ttr_ref_per_scenario.sql`, `20261109000002_ttr_counter_confirmation_and_drafts.sql`, `20261109000003_gold_ttr_join.sql`, `20261109000004_gold_start_ttr.sql`. Answer `Y`. The first changes `uq_tx_ref_per_entity` (per business **and scenario**): dev only; the client project gets it on its own next manual push.
3. ☐ `npx supabase functions deploy gold-start-ttr --project-ref rygjssczdoyvmumxmymc --workdir ..` (the only new or changed function; `cleanup-stale-drafts` and `delete-draft-transaction` change in the database only). It ends `Deployed Functions on project rygjssczdoyvmumxmymc: gold-start-ttr`.
4. ☐ In the dev dashboard > **Edge Functions** the list shows `gold-start-ttr`, and **Secrets** shows `GOLD_JOURNEY_ENABLED` = `true`.

### B2. One Postman call to `gold-start-ttr` (3 minutes)
**Find the purchase.** Dev SQL editor (project `rygjssczdoyvmumxmymc`):
```sql
select p.id, p.purchase_type, p.cash_10k_or_more, p.cash_amount, p.erp_invoice_no, p.ttr_transaction_id, p.sale_date
from gold.purchases p
where p.customer_id = '174fb856-4049-4c1a-a4c7-5440940ff088'
order by p.created_at desc;
```
- ☐ If a row shows `cash_10k_or_more` = true, an `erp_invoice_no` filled in and `ttr_transaction_id` empty, copy its `id`: that is `<purchase id>`. Go to "The call".
- Otherwise (no rows, or none like that) **make one** with a Postman request:
  - Method **POST**, URL `https://rygjssczdoyvmumxmymc.supabase.co/functions/v1/gold-save-purchase`
  - **Headers** tab: `apikey` = the dev anon key. Do **not** add a `Content-Type` header (form-data adds its own).
  - **Authorization** tab: Type **Bearer Token**, Token = the `access_token`.
  - **Body** tab: **form-data**, these rows exactly (Text unless marked File):

    | Key | Type | Value |
    |---|---|---|
    | `customerId` | Text | `174fb856-4049-4c1a-a4c7-5440940ff088` |
    | `purchaseType` | Text | `scrap` |
    | `cash10k` | Text | `true` |
    | `cashAmount` | Text | `12000` |
    | `phone` | Text | `0412 000 606` |
    | `idSighted` | Text | `true` |
    | `ttrSelfConducted` | Text | `true` |
    | `ttrDetailsConfirmed` | Text | `true` |
    | `erpInvoiceNo` | Text | `UAT-DEV-0901` |
    | `photos` | File | `goods.jpg` |
  - ☐ Send: **201** with `"purchaseId":"<purchase id>"` (copy it) and `"ttr":"B"`. (`422` with `errors.erp_invoice_no` "already used" means `UAT-DEV-0901` exists: change it to `UAT-DEV-0902`. `"ttr":"A"` means Lena has every field on file: carry on, B3 then follows the case A screens.)

**The call.** A second Postman request:
- Method **POST**, URL `https://rygjssczdoyvmumxmymc.supabase.co/functions/v1/gold-start-ttr`
- **Headers** tab: `apikey` = the dev anon key.
- **Authorization** tab: Bearer Token = the `access_token`.
- **Body** tab: **raw**, type **JSON**:
  ```
  {"purchaseId":"<purchase id>"}
  ```
1. ☐ **Send**. Status **200** and a body like `{"ttrs":[{"id":"<ttr id>","type":"scrap","scenario":"precious_metal_buy","status":"draft","created":true,"case":"B"}]}`. Copy `<ttr id>`.
2. ☐ In the dev SQL editor: `select transaction_ref, scenario, status, cash_amount, aud_value, location_snapshot from ttr.transactions where id = '<ttr id>';` One row: `transaction_ref` = the invoice (`UAT-DEV-0901`), `precious_metal_buy`, `draft`, `12000.00` twice, `Coburg, VIC`.
3. ☐ `select customer_id, is_complete, first_name, last_name from ttr.parties where transaction_id = '<ttr id>';` One row: `customer_id` `174fb856-4049-4c1a-a4c7-5440940ff088`, `is_complete` false, Lena / Hostedsix.
4. ☐ `select verification_basis, reliance_reason, is_complete, document_number, issuer, id_country_code, front_image_id, counter_confirmed_at, counter_confirmed_by_staff_id from ttr.id_verifications where transaction_id = '<ttr id>';` One row: `relied_on_prior_identification`, `prior_id_reviewed_still_valid`, `is_complete` false, `HOSTED6-DL-001`, `VIC`, `AU`, `front_image_id` **empty**, and both `counter_confirmed_*` filled.
5. ☐ `select ttr_transaction_id from gold.purchases where id = '<purchase id>';` shows `<ttr id>`.
6. ☐ **Send** the same request again. Status **200** with the same `id`, `"created":false`, `"case":null`; step 2's query still returns one row.
7. ☐ If Postman shows `PGRST…` or "Empty or invalid json" the URL went to `/rest/v1`; use `/functions/v1/gold-start-ttr`.

### B3. Open the TTR in the preview (3 minutes)
**Which project does the preview use?**
1. ☐ Open PR #25 on GitHub. In the checks list click **Vercel – Preview** > **Visit Preview**. Note the address (it ends in `.vercel.app`).
2. ☐ Sign in with the dev admin account and the 6-digit code. **F12** > **Network** tab. Reload the page. Click any request whose name starts with `token` or `rpc`: the **Request URL** starts with `https://rygjssczdoyvmumxmymc.supabase.co/`.
   - **Yes**: use the preview for the screens below.
   - **No** (any other host, especially `ykerufaergyqvnaycyce`, the client project): **do not use this preview.** Use the fallback below, and do not set `GOLD_JOURNEY_ENABLED` on the client project.

**Fallback: run the app locally against dev.** In `app/`, create or edit `app/.env.local` (not committed) so it holds exactly:
```
VITE_SUPABASE_URL=https://rygjssczdoyvmumxmymc.supabase.co
VITE_SUPABASE_ANON_KEY=<the dev anon key>
VITE_GOLD_JOURNEY_ENABLED=true
```
Then `cd app`, `npm run dev`, and use `http://localhost:5173` in place of the preview address below. Afterwards put `app/.env.local` back to what it held before.

**The screens (case B, Lena).** Open `<preview address>/open-ttr/<ttr id>` (signed in as the dev admin). If the browser shows "Another AUSTRAC report is in progress", you have a TTR open from earlier: click **Open this report**.
1. ☐ A short "Opening AUSTRAC report" page, then **Add Customers / Parties** ("Step 1 of 3"). Under **Selected for this transaction** is **Lena Hostedsix**, and the question **Is Lena Hostedsix acting on their own behalf for this transaction?** is shown.
2. ☐ Choose **Yes**, press **Continue**: **ID Verification Details & Capture** ("Step 2"). Verification method shows **Relied on prior identification**; the text **ID sighted and matched to this record at the counter on …** is shown; there is **no** "I confirm the person presenting today matches these ID images" tick. Press **Continue**.
3. ☐ **Transaction & Cash Details** ("Step 3"): Transaction reference **UAT-DEV-0901**, scenario **Buy precious metal from customer**, and the **Cash amount** shows **12000**. Press **Continue**.
4. ☐ **Party Details** ("Step 4"): Lena's name, date of birth, phone and address are filled in; **Occupation or principal activity** may be filled; **Gender** is empty and **Continue** is refused until it is chosen (choose **F**, set **Is this person a sole trader?** to **No**, and enter `AU` in the two country boxes if they are empty).
5. ☐ Press **Exit** at the top, and **Exit** in the "Exit transaction?" box: you land on **Start TTR Transaction** (`/start`), not on "What would you like to do?".
6. ☐ Dev SQL editor: `select ttr_transaction_id from gold.purchases where id = '<purchase id>';` is now **empty**, and `select count(*) from ttr.transactions where id = '<ttr id>';` is **0** (Exit deleted the draft and cleared the gold link). The purchase row is still there.

### B4. The client project stays closed (1 minute)
1. ☐ In a terminal, from `app/`: `npx supabase secrets list --project-ref ykerufaergyqvnaycyce --workdir ..` The list does **not** contain `GOLD_JOURNEY_ENABLED`. (Only list; change nothing there.)

---

## What a failure looks like
- `Function not found` for every local call: the local stack was started from another directory. Run `npx supabase stop --workdir .. && npx supabase start --workdir .. && npx supabase db reset --workdir ..` from this branch.
- Every call returns `gold_disabled`: the `GOLD_JOURNEY_ENABLED` secret is missing (local: `supabase/config.toml`; dev: B1 step 4).
- Postman `PGRST…` or "Empty or invalid json": the request went to `/rest/v1`, not `/functions/v1`.
- Postman `invalid_request`: the form-data or the JSON body is malformed (a missing quote or comma, or a Content-Type header you added by hand).
- Postman `unauthorized`: the token expired or was not sent. Copy a fresh `access_token`.
- `422 invoice_required` / `not_reportable` / `no_cash` from `gold-start-ttr`: the purchase has no invoice, the sale is under $10,000, or no part was paid in cash.
- `409 ttr_reference_in_use`: another TTR already uses that invoice for that type of sale; open it from the TTR start page.
- `uat` fails in **part0** on R11/R18/R24/R27, stuck on `/id-verification`: known issue #20 (a StrictMode double load). Re-run the failed job once (`gh run rerun <id> --failed`) before investigating.
- `9.51` fails with `No module named xmlschema` locally: `pip install xmlschema`. `control 2 … no company party`: the company TTR set-up in 9.51's `beforeAll` did not complete.
- A rerun of `08-austrac-file` on a database that already has `INV-S1`: run `npm run uat:gold09a` (it resets the database first).

---

## Progress note
Batches done: API rows (A1 to A4), pgTAP, Deno, Vitest, wizard rows (A5 to A7), AUSTRAC rows (A8, A9); production breaks in five SQL batches, one edge-function batch (after a runtime restart) and one client batch; expectation flips for the screen and earlier-phase rows. Nothing left to break. The break-and-revert results are in the PR body ("UAT automation (independent)").

Re-verification of D1 to D4 (fix 26194ae): each fix was broken once in one stack run (start_ttr lock order, Transaction Details draft cash, the $10,000 waiver in the client and in complete-transaction, the Start page guard). 9.26, 9.26 (race), 9.38, 9.39, 9.44, 9.68 and 9.70 each failed for their own reason (500 start_failed; empty Cash amount; Continue disabled; Continue disabled at $6,000; bullion not kept; 422 AUD value must be at least $10000). After the revert, uat:gold09a, pgTAP, Deno, Vitest, lint and format:check pass.

## Sign-off

☐ Section A green on commit ________ (D1 to D4 fixed) · ☐ Section B (B1 to B3) · ☐ B4 · Notes: ______________________________________________
