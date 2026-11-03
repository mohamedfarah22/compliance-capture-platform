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
| Environment | ________ |
| Build/commit | ________ |
| Run by / date | ________ |

**Where the rules come from.** Spec §3 (3.1 to 3.5, including 3.3a), §4.3, §4.4 (the `cleanup-stale-drafts` and `delete-draft-transaction` rows), §4.6, §7 (build-time checks), §8 step 6 and §9 (AUSTRAC file) of `docs/gold-due-diligence-spec.md`. The "Spec" column names the clause each row proves. Where the spec fixes a behaviour but not a response code, the code is the one documented in the header of `supabase/functions/gold-start-ttr/index.ts`.

**`GOLD_JOURNEY_ENABLED`.** Locally it comes from `supabase/config.toml` `[edge_runtime.secrets]`; on dev it is set with `secrets set`; it stays off on the client project `ykerufaergyqvnaycyce`.

**Test setup (every row).** A business with an admin and a plain `staff` member (both enrolled in MFA), and customers:
- **Jane Citizen**: every Party Details field on file (occupation Jeweller, gender F, citizenship AU, tax residency AU, not a sole trader), and a driver licence on file with issuer VIC, country AU
- **Joan Smith**: same, a second person (the joint seller)
- **Gold-only Gina**: name, DOB, address, phone and a licence, but no occupation, gender, citizenship or tax residency (so she is not ready for case A)

"A purchase" means a saved gold purchase with `ttr_self_conducted` and `ttr_details_confirmed` both Yes unless the row says otherwise, saved today.

---

## A · Refusals (`gold-start-ttr`)

| # | Spec | Action | Expected |
|---|---|---|---|
| 9.1 ⚠ | §2.2 | Call with `GOLD_JOURNEY_ENABLED` unset, empty, `false`, `TRUE`, `1` or `true ` | **403 `gold_disabled`** before the token is looked at; nothing written |
| 9.2 ⚠ | §6.1 | Call with no token, then with the anon key as the token | **401** both times; nothing written |
| 9.3 ⚠ | §6.1 | Call with a password-only (`aal1`) session | **403 `mfa_required`**; nothing written |
| 9.4 | §6.1 | Call as a deactivated staff member (with MFA) | **403 `forbidden`** |
| 9.5 ⚠ | §6.1, §4.3 | Staff of another business calls with this business's purchase id | **404 `purchase_not_found`**, the same answer as for an unknown id; no TTR, party or link written |
| 9.6 | §4.3 | Send `{}`, `{"purchaseId":"nope"}`, a non-JSON body and an array | **400 `bad_request`** naming the field; nothing written |
| 9.7 | §4.5 | A plain `staff` member calls with a valid reportable purchase that has an invoice | **200**: any active staff member can start a TTR |

## B · Rules the server re-checks

| # | Spec | Action | Expected |
|---|---|---|---|
| 9.8 ⚠ | §3.2 "runs only when the purchase has an ERP invoice" | Call for a reportable purchase with no invoice number | **422 `invoice_required`**; nothing written |
| 9.9 ⚠ | §3.4 reportable at $10,000 | A single purchase with $9,999.99 cash; then two same-day linked parts of $5,000 and $5,000 on one invoice | The first is **422 `not_reportable`**, nothing written. The second starts one TTR, because the linked cash reaches $10,000 |
| 9.10 | §3.4 "cash above $0" | A purchase flagged reportable whose entered cash amount is 0 | **422 `no_cash`**; nothing written |
| 9.11 ⚠ | §3.2, §4.3 | A lying client: the body also carries `cash`, `staff`, `entity`, `ref`, `scenario`, `case` | The extra fields change nothing: cash, staff, business, reference, scenario and case all come from saved data |

## C · What a case A TTR contains (§3.2)

Jane, one purchase, scrap, $12,000 cash, invoice `INV-A1`, both counter questions Yes.

| # | Spec | Action | Expected |
|---|---|---|---|
| 9.12 ⚠ | §3.2 | Call `gold-start-ttr` | **200**, one entry: `type` scrap, `scenario` `precious_metal_buy`, `status` draft, `created` true, `case` A. One `ttr.transactions` row: draft, `transaction_ref` exactly `INV-A1`, `cash_amount` and `aud_value` 12000.00, currency AUD |
| 9.13 | §3.2, §3.1 | Read that row | `transaction_datetime` equals the purchase's `created_at`; `designated_service` "Purchase of precious metal for physical cash"; `location_snapshot` "Coburg, VIC"; staff name, email and role are those of the staff member who called; `created_by_staff_id` is them |
| 9.14 | §3.2 | Read its `ttr.parties` | One individual party for Jane with `customer_id` set, copied name, DOB, phone, residential address, occupation, gender, citizenship and tax residency, not a sole trader; `is_complete` true |
| 9.15 ⚠ | §3.2 | Read its `ttr.id_verifications` | One reliance row for Jane's party: basis `relied_on_prior_identification`, `prior_verification_id` = the capture used on the purchase, reason `customer_confirmed_details_unchanged`, `is_complete` true; document type, number, issuer VIC, country AU, has-expiry and expiry date copied from the capture; **no front or back image**; `counter_confirmed_at` and `counter_confirmed_by_staff_id` equal the purchase's `created_at` and creator |
| 9.16 | §3.2 | Read the purchase | `ttr_transaction_id` is the new TTR. Parts of the same type on the same invoice, day and seller get the same id; a part of the other type, another invoice or another day does not |
| 9.17 | §3.2 | Check Storage and `ttr.stored_images` | No object or image row was created: no photo is copied |
| 9.18 ⚠ | §3.2 "idempotent" | Call again; then call for a second same-type linked part | Both return the same TTR id with `created` false and `case` null; still one transaction, one party, one reliance row |
| 9.19 | §3.2 "or the placeholder" | A reportable bullion purchase with no cash amount entered | The TTR's `cash_amount` and `aud_value` are 1.00 (the placeholder) |
| 9.20 | §4.5 | Call it with MFA staff; read `gold.purchase_audit_log` | One row for the purchase with source `start_ttr`, `changed_by` the staff member, and only `ttr_transaction_id` changed |

## D · Case B, joint sales, mixed invoices

| # | Spec | Action | Expected |
|---|---|---|---|
| 9.21 ⚠ | §3.3, §3.3a | Start a TTR for (a) a purchase with ID-details answer No, (b) Gina's purchase | `case` B. The reliance row has reason `prior_id_reviewed_still_valid` and `is_complete` false; Gina's party has `is_complete` false and keeps her missing fields empty. The counter confirmation is still copied |
| 9.22 ⚠ | §3.3 "a joint sale is always case B" | A joint purchase: Jane main, Joan joint, both counter answers Yes | One TTR with **two** parties (both with `customer_id`) and **two** reliance rows, one for each capture; `case` B; rows not complete |
| 9.23 ⚠ | §3.4 | Jane, same day, invoice `INV-900`: scrap $6,000 cash and bullion $6,000 cash. Call for the bullion part | **Two** entries, bullion first (the caller's type). Two transactions, both with reference exactly `INV-900`: `bullion_buy` $6,000.00 and `precious_metal_buy` $6,000.00. Each part is linked to its own type's TTR. Both TTRs have the same case |
| 9.24 | §3.4 "bank transfer gets no TTR" | Scrap $12,000 cash and bullion with a known amount of 0 on one invoice | **One** TTR (`precious_metal_buy`); the bullion part has no TTR |

## E · Atomicity and concurrency

| # | Spec | Action | Expected |
|---|---|---|---|
| 9.25 ⚠ | §3.4, §2 (atomic) | Another TTR already uses `INV-CLASH` with scenario `precious_metal_buy`; start a TTR for a scrap purchase on `INV-CLASH` | **409 `ttr_reference_in_use`**; no new transaction, party or reliance row, and no `ttr_transaction_id` set |
| 9.26 ⚠ | §3.2 "idempotent", §2 lock | Hold the invoice lock from a second database connection and call twice at once; then release | The calls wait, then exactly **one** TTR set exists and both calls return it |
| 9.27 | §6.1 | Trigger a refusal and a success; read the function logs | Lines carry the purchase id and an error code only: no name, phone, ID number, invoice or amount |
| 9.28 ⚠ | §2 grants | As `authenticated` and `anon`, call `gold.start_ttr` and its helpers | **42501** for each; only `service_role` can execute them |

## F · One reference per scenario (§3.4)

| # | Spec | Action | Expected |
|---|---|---|---|
| 9.29 ⚠ | §3.4 | Insert transactions with the same reference: other scenario; same scenario; other business, same scenario | The first and third succeed; the second fails with **23505** on `uq_tx_ref_per_entity`, whose definition is (`reporting_entity_id`, `transaction_ref`, `scenario`) |

## G · A later part on an invoice that has a TTR (§3.5)

| # | Spec | Action | Expected |
|---|---|---|---|
| 9.30 ⚠ | §3.5 | `INV-A1` has a draft scrap TTR of $12,000. Save another scrap part of $3,000 on `INV-A1` through `gold-save-purchase` | The part is saved and linked to the draft; the draft's `cash_amount` and `aud_value` are 15000.00 |
| 9.31 | §3.5 | Save a scrap part with no invoice, then add `INV-A1` through `gold-complete-purchase` | It is linked to the draft the same way and the draft's cash is the new type total |
| 9.32 | §3.4 | Save a **bullion** part of $500 on `INV-A1` | It does not join the scrap TTR and the scrap TTR's cash is unchanged |
| 9.33 ⚠ | §3.5, §4.3 | Complete the TTR (status complete). Save a new scrap part on `INV-A1` | **422** with `errors.erp_invoice_no` "The AUSTRAC report for INV-A1 is already finished. Use a new ERP invoice number for this purchase."; nothing saved; the completed TTR is unchanged |
| 9.34 ⚠ | §3.5 | Same completed TTR: add `INV-A1` to a saved scrap part with no invoice through `gold-complete-purchase` | The same **422** message; the purchase still has no invoice |

## H · Existing TTR functions (§4.4)

| # | Spec | Action | Expected |
|---|---|---|---|
| 9.35 ⚠ | §4.4 `cleanup-stale-drafts` | Age two drafts to 60 days: one linked to a gold purchase, one not. Run the function | The unlinked draft is deleted; the linked one stays, with its parties |
| 9.36 ⚠ | §4.4 `delete-draft-transaction` | Call Exit (`delete-draft-transaction`) on the linked draft | **200**; the TTR is gone, the purchase stays with `ttr_transaction_id` empty. Calling `gold-start-ttr` again creates a fresh draft |
| 9.37 | §3.2 | Try to put a counter confirmation on a customer-level ID row, or set only the time without the staff member. Then point a reliance row at another record, or change it to a new capture | The first two are refused (**23514**). After the last, both confirmation columns are empty |

## I · The wizard picks up the TTR (Playwright, admin signed in)

| # | Spec | Action | Expected |
|---|---|---|---|
| 9.38 ⚠ | §3.2 `openTransaction` | Open `/open-ttr/<id of the case A TTR>` | Lands on **Transaction Details** ("Step 3"). The reference shows `INV-A1`, the scenario Buy precious metal from customer and the sale date and time of the purchase; the cash shows 12,000 |
| 9.39 ⚠ | §3.2 Case A, §3.3 | Continue with the cash as shown; then open Party Details; then Review | Party Details shows Jane's copied details, already complete. Review shows "From gold purchase(s) on invoice INV-A1" and no missing-field issues. "Complete / Reportable" completes the TTR; the Complete page shows `INV-A1` |
| 9.40 ⚠ | §3.2 `IdVerificationPage` | From the case A TTR open ID Verification (Back from Transaction Details) | Jane's reliance row shows the record relied on and "ID sighted and matched to this record at the counter on …"; there is **no** "I confirm the person presenting today matches these ID images" tick; Continue saves without it. A reliance row on a TTR started in the wizard still shows the tick and refuses Continue without it |
| 9.41 ⚠ | §3.2 Case B | Open the case B TTR (Gina) | Lands on **Customers** with Gina already added, and asks whether she is acting on her own behalf. Answering Yes goes to ID Verification, where she must tick the match confirmation or accept the copied one; Party Details asks for occupation, gender, citizenship and tax residency; No goes to Transaction Details, Party Details and Conducting Person. For the joint TTR both sellers are listed and the path includes Conducting Person |
| 9.42 ⚠ | §3.2 warning | With one draft TTR active in the session, open a different one by id | The page says "You have another AUSTRAC report in progress (INV-A1). It stays saved; reopen it from the TTR start page." and opens nothing. **Open this report** opens the new one; **Cancel** goes to `/start` and the first draft is unchanged. No warning when none is active or the same one is opened |
| 9.43 | §3.2 | Open the id of a completed TTR; open an unknown id | A message ("already complete" / "could not be found") and a **TTR start** button; the session's active report is unchanged |
| 9.44 ⚠ | §3.4 | Mixed `INV-900` TTRs: open and complete the first; on the Complete page look for the other | **"Another AUSTRAC report for INV-900 is waiting"** is shown, with **Open it**, which opens the second report. After the second is complete the notice is gone |
| 9.45 ⚠ | §3.4 Start page | On `/start` type `INV-900`, choose Buy bullion from customer, with a completed bullion report on `INV-900` and no precious metal report; then choose Buy precious metal from customer | Buy bullion: "belongs to a completed transaction". Switching to precious metal clears it and starts normally. With a **draft** for the chosen scenario: "Existing draft found — fields pre-filled." |
| 9.46 | §3.4 `describeSaveError` | Start a precious metal report on a reference another report already holds for that scenario, and save | The error reads "That transaction reference is already in use for this scenario. A reference can be used once for each scenario …" |
| 9.47 | §3.2 | Open the case A TTR, change nothing on Transaction Details, save, read the row | `transaction_datetime` is unchanged (not shifted by the time zone) |

## J · §7 build-time checks

| # | Spec | Action | Expected |
|---|---|---|---|
| 9.48 ⚠ | §7 wizardStorage readers | Clear all browser storage, sign in, open `/open-ttr/<id>`; visit Customers, Transaction Details, ID Verification and Party Details, then Review | Every page shows the TTR's data (parties, reference, scenario, fast-path labels "Step 2/3/4" for case A); nothing is blank or from an earlier report |
| 9.49 | §7 `navigate('/')` | Search the TTR pages for exits; use Exit, Cancel and "Start New Transaction" on each wizard page and the Complete page | No TTR page navigates to `/`: all go to `/start`, which stays the TTR start. `/` is the journey picker |
| 9.50 ⚠ | §7 idle sign-out | With a gold-started TTR in progress (and a TTR started on `/start`), leave the app idle for 10 minutes, sign in again | The browser's wizard session is cleared, the drafts are not. `/open-ttr/<id>` (also as the `?redirect=` after login) reopens the gold-started TTR with its data. The wizard-started one reopens from `/start` by reference and scenario |

## K · AUSTRAC file (§9)

Batches are made by `generate-austrac-report` from gold-started TTRs that staff completed: a single-type sale (`INV-S1`, Jane), the mixed invoice `INV-900`, and the joint sale `INV-J1`, plus one TTR started in the wizard for a company (control 2 needs a company party in the batch).

| # | Spec | Action | Expected |
|---|---|---|---|
| 9.51 ⚠ | §9 | Validate the batch with `python scripts/validate_ttr_xml.py` (`xmlschema.XMLSchema11`, `docs/schema/TTR-1-0.xsd`) | `XMLSchema11 1.1: 0 error(s)`; control 1 (digit-led ttr id) **1** error; control 2 (trust without isExpressTrust) **1** error |
| 9.52 ⚠ | §3.4 | Read `txnRefNo` and the `id` attributes of the mixed invoice's two reports | Both `txnRefNo` are exactly `INV-900`; every `id` in the file is unique |
| 9.53 ⚠ | §3.2, §9 | Read `<identification>` for each gold-started party | Each has `type`, `number`, `issuer` (VIC) and `countryCode` (AU) copied from the capture; the joint report has two |
| 9.54 | §3.2 | Read the report for the single-type sale | The customer, address, occupation and other fields come from Jane's copied party; `transaction date` is the purchase's |

## L · Client API and regression

| # | Spec | Action | Expected |
|---|---|---|---|
| 9.55 | §4.6 `goToAustracForm` | In `goldApi.js`, call `goToAustracForm(purchaseId)` | It calls `gold-start-ttr` with only `{ purchaseId }` and returns `{ ttrs, path }` where `path` is `/open-ttr/<first id>`. The 422 and 409 codes give staff-readable messages (invoice needed, under $10,000, no cash, reference in use) |
| 9.56 ⚠ | §8 "each step leaves TTR working" | Run the existing TTR UAT: `npm run uat:part0`, `uat:phase4`, `uat:part1` | All pass, including **R27** (reusing a reference blocks or reopens the right report) and R25 |
| 9.57 | §8 | Run the other gold UAT (`uat:gold06`, `gold07`, `gold08a`) and the unit, Deno and pgTAP suites | All pass |
| 9.58 | §3.2 | Read the purchase through the gold read RPCs after a TTR starts (`gold.list_incomplete_purchases` and `gold.search_gold_purchases`) | The purchase shows `ttr_transaction_id`, `ttr_status` draft and `ttr_transaction_ref` equal to the invoice; after the TTR completes the status is complete |
