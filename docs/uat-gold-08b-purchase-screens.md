# UAT: Gold purchase screens (Gold Phase 8b)

**Purpose:** prove that `gold/08b-purchase-screens` gives staff the purchase half of the gold journey in the browser, and that it hands over to the TTR wizard where the spec says it does:
1. On a customer's page, staff record a scrap or bullion purchase: goods photos, the cash question, the ERP invoice, the sighted box, the counter questions, a joint seller
2. A reportable sale is either case A (ready on file, both counter answers Yes: the TTR is started when the invoice is entered at the counter or added later, but at the counter it is not opened: staff finish it from To complete) or case B (anything else: the invoice is required and the TTR opens straight after the save)
3. To complete, Complete purchase, Purchases and Purchase record show purchases, their AUSTRAC status ("AUSTRAC pending" until the TTR is complete, then "AUSTRAC") and the TTR link
4. Every screen only shows what the Phase 5 to 9a server pieces allow; the browser never decides a rule the server re-checks
5. Exports, printing and Download are **not** here (build step 7, Phase 9b)

| | |
|---|---|
| Environment | Local Supabase stack (`supabase start`), Vite on 5199, flag on |
| Build/commit | see the sign-off line |
| Run by / date | independent UAT agent (uat-automation), 2026-11-04 |

**Where the rules come from.** Spec §3.2, §3.3, §3.3a, §3.4, §3.5, §4.3, §4.6, §5.2 (the CustomerDetail purchase form, JointSellerPanel, ToComplete, CompletePurchase, Purchases and PurchaseRecord rows), §5.3, §5.4, and C1, C2, C3 in §1.7 of `docs/gold-due-diligence-spec.md`. The "Spec" column names the clause each row proves.

**Set-up for every row.** `VITE_GOLD_JOURNEY_ENABLED=true` for the browser build and `GOLD_JOURNEY_ENABLED=true` for the local functions. Staff sign in with password then TOTP. Unless a row says otherwise the user is an active `staff` member of business One, on `/gold`.

**People used.** All three have a driver licence on file (state VIC, country AU, valid for at least a year, photographed within the business's re-verification window):
- **Jane Citizen**: every TTR Party Details field on file (occupation Jeweller, gender F, citizenship AU, tax residency AU, not a sole trader). Ready for case A.
- **Joan Smith**: same, a second person (the joint seller).
- **Gold-only Gina**: name, date of birth, address, phone and licence only. No occupation, gender, citizenship or tax residency. Not ready for case A.

"Reportable" means cash of $10,000 or more. Scrap is asked "Paid in cash of $10,000 or more?". Bullion is asked "Cash paid" with the choices "Under $5,000", "$5,000 to $9,999" and "$10,000 or more". "Photo" means any JPEG or PNG file chosen with the **Upload** button of the goods-photo field. Invoice numbers are made unique per run (`INV-B1` below stands for `INV-B1-<run>`).

---

## Section A · Automated rows

```
cd app
npx supabase db reset --workdir .. && npm run uat:gold08b      # Playwright, project gold08b (all 73 rows, one test per row, named after the row ID)
npx supabase test db --workdir ..                              # pgTAP: supabase/tests/08_gold_reads.test.sql also covers the two Phase 8b migrations
```
`npm run uat` includes `uat:gold08b` between `uat:gold08a` and `uat:gold09a`. The gold edge functions need `GOLD_JOURNEY_ENABLED=true` (set for the local stack and CI in `supabase/config.toml` `[edge_runtime.secrets]`); the browser build needs `VITE_GOLD_JOURNEY_ENABLED=true` (`app/playwright.config.js` sets it for the Vite server). The tests call `gold-save-purchase`, `gold-complete-purchase`, `gold-start-ttr` and `get-gold-photo-urls`, so after `supabase start` from another worktree run `npx supabase stop --workdir .. && npx supabase start --workdir ..` from this worktree's `app/` first.

☐ CI green on this commit

**How the tests sign in.** Business One's staff, manager and admin and business Two's staff come from the 8a fixtures (`app/e2e/gold08a/support.js`). Each test file signs in once through the Auth API (password then TOTP) and keeps that one tab for all its tests, because the local access token lasts five minutes and only a live tab renews it. Purchases that a row needs as set-up are made with the real `gold-save-purchase` (and `gold-start-ttr`) using the signed-in tab's token; the screens under test are driven in the browser. Customers are made by SQL (`jane()` has every TTR field and a valid licence photographed 10 days ago; `gina()` has only what gold collects).

**Where a row differs from the sheet's first wording** (the expectation is unchanged):
- 8b.13: the apostrophe in "Gold-only Gina's AUSTRAC details are incomplete" is a straight `'`, as in the spec (§3.3).
- 8b.16: "The button opens the new TTR" is proved by the wizard's active draft (sessionStorage) being the new TTR's id and the URL leaving `/open-ttr`.
- 8b.17 and 8b.21 (rewritten after ruling Q1, spec §3.3): the case A save at the counter no longer opens the wizard, so they expect the confirmation and the customer page. 8b.21 keeps its data assertions (two parts of $6,000, the flag and the $12,000 total on the new part, both parts linked to a TTR). 8b.17 reaches the fast path through **Resume TTR**.
- 8b.21 and 8b.45: the earlier scrap part keeps its own `cash_10k_or_more = false`; the invoice total ($12,000.00) and the flag sit on the new part (see spec question 2).
- 8b.33: the invoice link's accessible name is "View purchase <invoice>". The "Joint sale with" text is plain text followed by the other person's name as a link.
- 8b.37: the earlier purchases are back-dated in SQL (triggers off for that update) so the business days left are exactly 3 (amber), 2 (red) and -2 (overdue); the test works the deadline out itself (Mon to Fri) and checks the colours by computed style.
- 8b.39 and 8b.40: the draft is deleted through the wizard's own Exit; a TTR is completed by a database update (`status = 'complete'`), because completing it in the wizard is proved by the Phase 9a UAT. 8b.40's empty state uses business Two, which holds no incomplete purchase.
- 8b.43: a manager completes a staff member's purchase, so the record's "Completed ... by UAT8a Manager" proves the completer's name (the `gold.list_purchase_staff` RPC) and not only the recorder's.
- 8b.47: the "reportable, expired ID" purchase is seeded by saving a non-cash purchase for a customer with an expired licence and then setting the cash fields in SQL with triggers off, because the server refuses to save it directly.
- 8b.50: the list is narrowed by searching for the customer's unique name, so it is exactly 26 whatever else the business holds.
- 8b.54 and 8b.58: checked as staff and as an admin.
- 8b.55: the stored goods photos in the test data are not decodable JPEGs, so the goods photo is checked by its signed URL; the ID photos are real pictures and are checked as loaded.
- 8b.56: the date label is "Newer copy of this ID, taken 04 Nov 2026" (two-digit day).

**Spec questions** (the sheet and the code agree with each other; the spec is silent or can be read two ways)
1. §5.2 says Purchases and Purchase record have "Download hidden for `staff`" (so managers and admins see it), while §8 step 7 puts Download in Phase 9b and this sheet says there is no Download for anyone. 8b.54 and 8b.58 check the Phase 9b reading (no Download for staff or admin). If Download should already show for admins here, those two rows change.
2. (Answered: defect D2 and the user's ruling make "reportable" per sale, now in spec §3.2. Rows 8b.36 and 8b.64 follow it.)
3. (Answered by ruling Q5: a completed TTR is plain text with its reference and completion date, no link. Rows 8b.57 and 8b.72.)
4. (Answered by the user's label ruling, spec §3.3 "Record button label": for case A with the invoice entered at the counter the button reads "Record purchase and start AUSTRAC report"; case B keeps "Record purchase and continue to AUSTRAC"; a sale that is not reportable keeps "Record purchase". Rows 8b.21 and 8b.73 assert the case A label, 8b.14 and 8b.73 the case B label.)

**Defects found by UAT** (a defect's test stays red until it is fixed). **Open: none (D1, D2, D3 fixed).**

| ID | Row | Expected | Actual | Evidence and suspected cause |
|---|---|---|---|---|
| D1 | 8b.63 | **FIXED in `02857df`** (migration 20261110000003 lists a part linked to an incomplete TTR; the record page shows its AUSTRAC report line). Was: Spec §3.4 "Finishing both ... To complete lists both until both are complete": after a mixed invoice ($6,000 scrap + $6,000 bullion) starts two TTRs, To complete lists both purchases with **Resume TTR**, and still lists the second while only one TTR is complete | To complete lists one row (the bullion part); the scrap part, linked to a draft scrap TTR, is not listed at all, and its Purchase record shows no "AUSTRAC report" line, so the scrap draft cannot be reached from gold | `npx playwright test --project=gold08b -g "8b.63"`: `Expected: 2, Received: 1` at the first `toHaveCount(2)`. The scrap part was saved with its own cash under $10,000, so `gold.purchases.cash_10k_or_more` is false; `gold.list_incomplete_purchases` (`supabase/migrations/20261105000005_gold_purchase_read_rpcs.sql:71`) and the record page (`GoldPurchaseRecordPage.jsx` `renderAustrac`) both key on that flag. Fix is on the server side: list (and show the TTR for) every part whose invoice is reportable and whose linked TTR is not complete (or set the flag on every part when the invoice becomes reportable, in `gold-save-purchase`) |
| D2 | 8b.64, 8b.36 | **FIXED in `ec03429`** (AUSTRAC pending is per sale: a part linked to a TTR that is not complete is reportable on To complete, in the tags, the due line and the Purchases status filters). Was: Spec §3.2 "AUSTRAC pending = reportable and the TTR isn't complete" and §3.4 (the invoice is reportable, each part links to its type's TTR): the unflagged part of a mixed invoice, now listed on To complete, sits under "AUSTRAC pending (n)" with the **AUSTRAC pending** tag and the "AUSTRAC report due" line | It is listed under "Other purchases", has no AUSTRAC pending tag and no deadline line, so the AUSTRAC deadline for that part is never shown. The header count n includes it (8b.35 passes). 8b.36 fails too, because earlier tests leave such parts in the shared data and its heading count expects them under "AUSTRAC pending" | `npx playwright test --project=gold08b -g "8b.64"`: `Expected: 2, Received: 1` at the "AUSTRAC pending" section count; 8b.36: heading `AUSTRAC pending (13)` not found. Cause: `GoldToCompletePage.jsx` lines 110, 121-122 and `shared/PurchaseTags.jsx` key on `cash_10k_or_more` only; they should treat a part with a linked TTR (`ttr_transaction_id`) that is not complete as reportable (the fix for D1 did this for the list RPC and the record page only) |
| D3 | 8b.71 | **FIXED in `397d7f0`** (`hasUnconfirmedGoldPurchase` now treats a late part as confirmed when another same-day part of the customer's invoice has both counter answers; re-verified: 8b.71 passes, and fails again with that check dropped). Was: Spec §3.3 (Q3) and §3.4: the notice shows only when a linked purchase "became reportable on Complete purchase" without counter answers; the case is decided once per invoice. Jane's mixed invoice ($6,000 scrap recorded first, then $6,000 bullion at the counter with both counter questions Yes) has no notice on either TTR review | The bullion TTR review has no notice, but the **scrap** TTR review shows "The customer wasn’t asked to confirm their details at the counter. Contact them to confirm before completing the TTR." The scrap part was recorded before the invoice was reportable, so it has `cash_10k_or_more = false` and no counter answers of its own; the answers sit on the bullion part | `npx playwright test --project=gold08b -g "8b.71"`: `Expected: 0, Received: 1` at the notice, in the "precious_metal_buy review". Suspected: `hasUnconfirmedGoldPurchase` in `app/src/lib/wizardApi.js` tests each linked part on its own flags; it should look at the invoice's case (any part of the sale with counter answers, or a flagged part) |

**Rows added by UAT** (spec clause; 8b.59 to 8b.64 in `app/e2e/gold08b/10-added-by-uat.e2e.js`, 8b.65 to 8b.73 added after the user's rulings in `app/e2e/gold08b/11-rulings.e2e.js`)

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 8b.59 | §4.3 | Signed in as business One's staff, open `/gold/purchases/<id>` of a business Two purchase. | "Purchase not found." with **Back to Purchases**. No invoice number, no Purchase ID, nothing from business Two. | `10-added-by-uat` 8b.59 |
| 8b.60 | §2.3 | With a password-only (aal1) session, open `/gold/purchases`, `/gold/to-complete`, a purchase record and Complete purchase. | Each is sent to `/login`; no purchase, photo or invoice request is made. | `10-added-by-uat` 8b.60 |
| 8b.61 | §3.3, §4.3 | Make the browser unable to see that the invoice is used (its lookup answers an empty list). Fill a reportable case A purchase with an invoice another purchase already uses. Press **Record purchase and continue to AUSTRAC**. | The server refuses (422); the page shows "The ERP invoice number ... is already used by another purchase." under the invoice box (marked invalid); nothing is saved. | `10-added-by-uat` 8b.61 |
| 8b.62 | §3.2 | Make `gold-start-ttr` fail (the request is aborted). Record a case B purchase with an invoice. | The purchase is saved; the page stays on the customer and says "Purchase recorded, but the AUSTRAC report could not be started. ... Start it from To complete."; no TTR exists; To complete shows **Start TTR** for it. | `10-added-by-uat` 8b.62 |
| 8b.63 | §3.4 | Jane: scrap $6,000 and bullion $6,000 on one invoice, both TTRs started. Open To complete; complete one TTR; open it again; complete the other; open it again. | Two rows, each with **Resume TTR**; then one; then none. | `10-added-by-uat` 8b.63 (D1 fixed in `02857df`; also checks the scrap part's record shows "AUSTRAC report: draft in progress") |
| 8b.64 | §3.2, §3.4 | Same mixed invoice as 8b.63 (a new one), both TTRs started. Open To complete. | Both Jane rows sit under "AUSTRAC pending", each with the **AUSTRAC pending** tag and an "AUSTRAC report due" line. | `10-added-by-uat` 8b.64 (D2 fixed in `ec03429`) |
| 8b.65 | §3.3 (Q1) | Jane, case A, invoice `INV-Q1` entered at the counter (as 8b.17). Look at her **Purchase history**, then open **To complete**. | The TTR draft exists (type precious_metal_buy, reference `INV-Q1`, status draft) and is linked to the purchase. History shows the tag "AUSTRAC pending". To complete lists Jane's row under "AUSTRAC pending" with "Invoice INV-Q1", the button **Resume TTR** (not Start TTR) and the line "AUSTRAC report due <date> · n business days left". The header count is 1 or more. | `11-rulings` 8b.65 |
| 8b.66 | §3.3 (Q1) | Open a case B TTR for Gina (invoice `INV-Q1a`) so it is the active draft in this tab. Open Jane's page and record a case A purchase with invoice `INV-Q1b`. | No "Another AUSTRAC report is in progress" warning and no "You have another AUSTRAC report in progress" text. Gold stays on Jane's page with "AUSTRAC report started. Finish it from To complete." Jane's draft exists. The tab's active draft is still Gina's. | `11-rulings` 8b.66 |
| 8b.67 | §3.3 (Q1) | Make `gold-start-ttr` fail (the request is aborted). Record a case A purchase with an invoice for Jane. Open To complete. | The purchase is saved; the page stays on Jane's page and says "Purchase recorded, but the AUSTRAC report could not be started. ... Start it from To complete." (not the "started" confirmation); no TTR exists; To complete shows **Start TTR**. | `11-rulings` 8b.67 |
| 8b.68 | §3.3 (Q1), §5.2 | A reportable case A purchase for Jane with no invoice. On Complete purchase enter `INV-Q1d` and press **Save and continue to AUSTRAC**. | Unlike the counter, this **does** open the TTR: the browser leaves gold for Transaction Details, the draft exists, and it is the tab's active draft. | `11-rulings` 8b.68 |
| 8b.69 | §3.3 (Q3) | Jane: scrap part on `INV-Q3a` (cash No), a bullion part ("$5,000 to $9,999") with no invoice. Complete the bullion part with `INV-Q3a`, 6,000 on each part, press **Save and continue to AUSTRAC**. Open the bullion TTR's **Review** page. | The page shows "From gold purchase(s) on invoice INV-Q3a" and the amber notice "The customer wasn’t asked to confirm their details at the counter. Contact them to confirm before completing the TTR." | `11-rulings` 8b.69 |
| 8b.70 | §3.3 (Q3) | Open the Review page of the TTR of (a) a normal case A purchase (both counter answers Yes) and (b) a case B purchase (Gina, reportable at the counter). | Each shows "From gold purchase(s) on invoice ..." and **no** amber notice. | `11-rulings` 8b.70 |
| 8b.71 | §3.3 (Q3), §3.4 | Jane: scrap part on `INV-Q3d` (cash No), then on her page a bullion part on `INV-Q3d` with 6,000 on each part, both counter questions Yes, record. Open the Review page of each of the two TTRs (scrap and bullion). | Both show "From gold purchase(s) on invoice INV-Q3d" and **neither** shows the amber notice (the case is decided once per invoice, and the answers were given on the part that made it reportable). | `11-rulings` 8b.71 |
| 8b.72 | §3.2 (Q5) | Jane's reportable purchase whose TTR is complete, and another whose TTR is a draft. Open both records. | Complete: exactly "AUSTRAC report: complete. Reference <invoice>, completed <dd Mon yyyy>." with no link anywhere in that line and no **Open AUSTRAC report** link. Draft: "AUSTRAC report: draft in progress." with the link **Open AUSTRAC report**. | `11-rulings` 8b.72 |
| 8b.73 | §3.3 (record button label ruling) | Jane (ready), scrap, cash Yes, both counter questions Yes, photo, box ticked, invoice `INV-L1`: read the record button; clear the invoice and read it again. Then Gina (not ready), scrap, cash Yes, invoice `INV-L2`. Then Jane again, scrap, cash No, invoice `INV-L3`. | Jane with the invoice: the button reads "Record purchase and start AUSTRAC report" (never "continue to AUSTRAC"). Jane without the invoice: "Record purchase". Gina with the invoice (case B): "Record purchase and continue to AUSTRAC". Jane with cash No: "Record purchase". | `11-rulings` 8b.73 |

Rows 8b.1 to 8b.58 are the implementer's. Every row is one Playwright test whose name starts with the row ID; the "Covered by" column gives the file.

---

### A1 · Purchase form on the customer page

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 8b.1 | C3, §5.2 | Open Jane's page. Look at the **Record purchase** form. | The box "Customer and ID sighted in person today" is **not** ticked. Under it: "Doesn't match the record? Update ID first." The "Record purchase" button is enabled. | `01-form-basics` |
| 8b.2 | C3 | Choose Scrap jewellery, answer the cash question No, add one photo, leave the box unticked, press **Record purchase**. | Nothing is saved. The error under the box reads "ID must be sighted today and match the record on file. Doesn't match the record? Update ID first." | `01-form-basics` |
| 8b.3 | §5.2 (unchanged) | Tick the box, remove the photo (or use a fresh form), press **Record purchase**. | Error "Add at least one photo of the items purchased." Nothing saved. With a photo added it saves. | `01-form-basics` |
| 8b.4 | §4.5, §5.2 | Upload a 3000 x 2000 pixel PNG as the goods photo. | A thumbnail appears with **Remove**. The request to `gold-save-purchase` carries that photo as `image/jpeg`, 1600 pixels or less on the long side (this is the same rule the ID photos follow). Adding an 11th photo is refused: "You can add up to 10 photos." | `01-form-basics` |
| 8b.5 | §5.2 (unchanged) | Jane, Scrap jewellery, cash No, one photo, box ticked, no invoice, **Record purchase**. | Saved. Toast "Purchase recorded. Add the invoice number later from To complete." The form is empty again. **Purchase history** lists it as "No invoice number yet" with the tags "Scrap" and "Incomplete" and "1 photo". The header link reads "To complete (1)" (plus any older ones). | `01-form-basics` |
| 8b.6 | §5.2 (unchanged) | Choose Bullion. Select each of the three bands. | "Under $5,000" and "$5,000 to $9,999" show no cash-amount box; "$5,000 to $9,999" shows "Needs this customer’s current ID. No AUSTRAC report." "$10,000 or more" shows the optional cash amount box. With Scrap, answering Yes shows the same box. | `01-form-basics` |
| 8b.7 | §5.2 (phone rules) | Change Phone to 7 digits and press **Record purchase** (box ticked, photo added). Then to 8 digits and a new number. | 7 digits: "Phone number looks too short." and nothing saved. A new 8-digit number shows the hint "Different from the customer record. Saving the purchase also updates the customer’s phone number." After the save Jane's page shows the new phone. | `01-form-basics` |
| 8b.8 | §3.3a | Jane, scrap, cash **Yes**, no amount typed. Then switch to cash No. Then Yes with a typed cash amount of 8,000. Then 10,000. | Yes with no amount: two counter questions appear: "Is Jane Citizen acting on their own behalf?" and "Are these details still correct?". The second shows Jane's residential address, occupation (Jeweller), citizenship (AU) and tax residency (AU). Each has No / Yes. Cash No: the questions are hidden (not shown on non-reportable sales). Amount 8,000: still hidden (the amount decides). Amount 10,000: shown. | `02-cases-and-handoff` |
| 8b.9 | §3.3a | Open Gold-only Gina. Scrap, cash Yes. Then Jane with a joint seller (8b.26), cash Yes. | Neither shows the questions (Gina is not ready; a joint sale is always case B). | `02-cases-and-handoff` |
| 8b.10 | §3.3a | Jane, scrap, cash Yes, photo, box ticked, answer only the first question, press **Record purchase**. | Nothing saved. Error "Answer both questions." under the second. | `02-cases-and-handoff` |
| 8b.11 | §3.3, §3.3a | Jane, scrap, cash Yes, answer both counter questions **Yes**, photo, box ticked, no invoice. Press **Record purchase**. | Before pressing: the amber notice "No invoice number yet, so this purchase will be saved as AUSTRAC pending. Add the invoice number within 10 business days from To complete." and the button "Record purchase". After: saved as case A, you stay on Jane's page, toast "Purchase recorded as AUSTRAC pending. Add the invoice number from To complete." History shows the tag "AUSTRAC pending". No TTR exists yet. | `02-cases-and-handoff` |
| 8b.12 | §3.3 | Jane, scrap, cash Yes, answer the first question **No** (second Yes), no invoice, press **Record purchase**. | Case B: error on the invoice box "Enter the ERP invoice number. The AUSTRAC report for Jane Citizen must be started now." Nothing saved. | `02-cases-and-handoff` |
| 8b.13 | §3.3 | Gold-only Gina, scrap, cash Yes, photo, box ticked, no invoice, press **Record purchase**. | Error "Enter the ERP invoice number. Gold-only Gina's AUSTRAC details are incomplete, so the report must be started now." Nothing saved. | `02-cases-and-handoff` |
| 8b.14 | §3.2, §3.3, §3.4 | Gina, scrap, cash Yes, invoice `INV-B1`, photo, box ticked. Read the button, press it. | The button reads "Record purchase and continue to AUSTRAC", with the amber notice "After you record this purchase, the AUSTRAC form will open with this customer loaded." After the save the browser leaves `/gold` for the TTR (`/open-ttr/<id>` then the first wizard step that needs input). The draft TTR exists with reference `INV-B1`, scenario precious_metal_buy, and Gina as its party. | `02-cases-and-handoff` |
| 8b.15 | §3.2 | Same as 8b.14 with Bullion, band "$10,000 or more", invoice `INV-B2`. | The TTR draft has scenario bullion_buy and reference `INV-B2`. | `02-cases-and-handoff` |
| 8b.16 | §3.2 | Open any draft TTR in this browser tab (so one is active), then record a case B purchase for Gina (invoice `INV-B3`). | After the save: "Another AUSTRAC report is in progress" with "You have another AUSTRAC report in progress (<its reference>). It stays saved; reopen it from the TTR start page." and the button "Open this report". The purchase is saved. The button opens the new TTR. | `02-cases-and-handoff` |
| 8b.17 | §3.3 (Q1) | Jane, scrap, cash Yes, both counter answers Yes, invoice `INV-B4` entered at the counter. Read the amber notice, press the **Record purchase** button. Then open **To complete** and press **Resume TTR** on her row. | Before pressing: the amber notice reads "After you record this purchase, the AUSTRAC report will be started. Finish it from To complete." (not "the AUSTRAC form will open"). After: the TTR is **started but not opened**: gold stays on Jane's page and shows "AUSTRAC report started. Finish it from To complete."; the draft TTR exists with reference `INV-B4` and is linked to the purchase; this tab has no active TTR. **Resume TTR** then opens it on the case A fast path: ID details already confirmed (the wizard goes to Transaction Details, not to ID verification). | `02-cases-and-handoff` |
| 8b.18 | §3.3 | Record a reportable purchase with invoice `INV-B5` for Gina. Then record a reportable purchase for Jane with invoice `INV-B5`. | The second is refused before saving: "The ERP invoice number INV-B5 is already used by another purchase. A reportable purchase needs its own invoice number." Nothing saved. | `02-cases-and-handoff` |
| 8b.19 | §3.3, handover | Record a non-reportable purchase with invoice `INV-B6`. Then a second non-reportable purchase, for another customer, with `INV-B6`. | After leaving the invoice box: "This invoice number is already recorded. Check it’s not a duplicate." The second purchase **saves** (a warning, not a block). | `02-cases-and-handoff` |
| 8b.20 | §3.4 | Jane: scrap, cash No, invoice `INV-B7`, saved. Then a new bullion purchase with invoice `INV-B7` the same day. | After the invoice box loses focus the cash question is replaced by the amber panel "Same invoice as an earlier purchase today for this customer", listing the Scrap purchase with a box "Cash paid on that part (AUD)" (its amount was never entered) and a box "Cash paid for this part (AUD)". Leaving this part blank and saving shows "Enter the cash paid for this part. Enter 0 if none was cash." | `03-linked-invoice-and-id-gates` |
| 8b.21 | §3.4, §3.3 (Q1) | In 8b.20 the scrap part's cash amount is blank. Enter 6,000 for "Cash paid on that part (AUD)" and 6,000 for this part. Answer both counter questions Yes and press the record button, which reads "Record purchase and start AUSTRAC report". | The panel says "Cash on INV-B7 today: $12,000.00. That’s $10,000.00 or more, so the invoice will be reported to AUSTRAC once." Saving works as a reportable purchase (Jane is ready: both counter questions are asked first). It is case A, so the TTRs are started but not opened: gold stays on Jane's page with "AUSTRAC report started. Finish it from To complete." Two purchases exist with $6,000 each, the new part carries the flag and the $12,000 invoice total, and both parts link to a TTR. | `03-linked-invoice-and-id-gates` |
| 8b.22 | §3.5 | Complete the TTRs of 8b.21 (both). Then record a third part for Jane on `INV-B7`. | Refused: "The AUSTRAC report for INV-B7 is already finished. Use a new ERP invoice number for this purchase." Nothing saved. | `03-linked-invoice-and-id-gates` |
| 8b.23 | C2, §3.3 | Gina's licence is expired. Scrap, cash Yes. Then cash No. | Cash Yes: a red notice "Update the ID before recording this cash purchase. An expired ID cannot go into an AUSTRAC report." with "Gold-only Gina (main seller): ID expired on <date>" and **Update ID now**; **Record purchase** is disabled. Cash No: "ID on file has expired for Gold-only Gina. This purchase will be saved with an expired-ID flag." and it saves. | `03-linked-invoice-and-id-gates` |
| 8b.24 | C2 | Jane's licence was photographed longer ago than the business's re-verification days. Scrap, cash Yes. Then cash No. Then bullion "$5,000 to $9,999". | Cash Yes: blocked with the same red notice and **Update ID now**. Cash No: an amber notice "ID needs re-verifying" and it saves. Bullion $5,000 to $9,999: blocked (a current ID is needed). | `03-linked-invoice-and-id-gates` |
| 8b.25 | C2, §5.4 | In 8b.23 fill the form, press **Update ID now**, renew the ID (reason "Renewed: same document, new expiry date"). | You return to Gina's page. The form is filled as you left it (photos, answers, invoice). The red notice is gone. | `03-linked-invoice-and-id-gates` |
| 8b.26 | §5.2, §5.4 | Press **Add second person (joint sale)**. | A dialog "Add second person" opens, the search box has the focus. Typing "Jane" shows Jane with "Already the main seller", not selectable. Escape closes the dialog and the focus goes back to **Add second person (joint sale)**. | `04-joint-seller` |
| 8b.27 | §5.2 | In the dialog search "Joan", pick Joan Smith. | The dialog closes. A "Joint seller" row shows Joan, her ID type and number, an ID status badge, **View ID** and **Remove**. The box now reads "Both people and their IDs sighted in person today". **Remove** puts the button back and the focus on it. | `04-joint-seller` |
| 8b.28 | §3.3 | Jane + Joan (8b.27), scrap, cash Yes, photo, box ticked, no invoice. Press **Record purchase**. | No counter questions are shown. Error on the invoice box: "Enter the ERP invoice number. The AUSTRAC report for Jane Citizen must be started now." Nothing saved. | `04-joint-seller` |
| 8b.29 | §3.2, §3.3 | Same, with invoice `INV-B8`, press the button. | A joint sale is always case B: the TTR opens with two parties (Jane and Joan), the wizard asks for what is missing. Jane's page history and Joan's page history both list the purchase, with "Joint sale with ..." links. | `04-joint-seller` |
| 8b.30 | §5.2 | In the dialog press **New customer**, create "Pat Newman" (all required fields, a licence, front and back photos, the sighted box). | After "Customer created" you land on Jane's page (not Pat's). The Joint seller row shows Pat and Jane's draft is as left. | `04-joint-seller` |
| 8b.31 | C2 | Joan's licence expired; Jane + Joan, cash Yes. | Red notice lists Joan ("joint seller") with **Update ID now**; after renewing you return to Jane's page with Joan still attached. | `04-joint-seller` |
| 8b.32 | handover §5 | Fill Jane's form partly (photo, invoice, cash Yes). Open **Purchases** from the header and come back to Jane. Then **Switch journey** and open Jane again. | Coming back from Purchases: the form is as left. After Switch journey: the form is empty. After a successful save the form is empty. | `05-draft-history-header` |
| 8b.33 | §3.2 | Jane's page, **Purchase history**. | Newest first. Each row: invoice number (or "No invoice number yet"), tags, date and time, "n photo(s)", and for a joint sale "Joint sale with <name>" as a link. Clicking the invoice opens the Purchase record. | `05-draft-history-header` |
| 8b.34 | §3.2 | Look at the tags: a reportable purchase with a draft TTR; one with a completed TTR; a non-reportable one with an invoice. | "AUSTRAC pending"; "AUSTRAC"; neither tag. A purchase with no invoice also has "Incomplete". | `05-draft-history-header` |
| 8b.35 | §5.3 | Look at the gold header. | "Gold due diligence", then "To complete (n)", "Purchases", the staff name, "Switch journey", "Sign out". n is the number of purchases on the To complete screen and updates after a save. | `05-draft-history-header` |

### A2 · To complete

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 8b.36 | §5.2, §3.3 | Open **To complete** with: 8b.11 (case A, no invoice), 8b.5 (non-reportable, no invoice), 8b.14 (case B, draft TTR). | Section "AUSTRAC pending (2)" holds the case A purchase and the case B one; "Other purchases (1)" holds the non-reportable one. Each row: names, tags, "Recorded <date time> by <staff>", "n photo(s)". The case A and the invoice-less purchases have **Complete**; the case B one has **Resume TTR**. | `06-to-complete` |
| 8b.37 | handover §4.3 | Look at the line under an AUSTRAC pending purchase recorded 1 business day ago, and one recorded 12 business days ago (recorded by the test seed). | "AUSTRAC report due <date> · 9 business days left" in amber; the older one "Overdue by 2 business days" in red. A purchase with 2 or fewer days left is also red. The due date is the sale date plus 10 business days (Mon to Fri). | `06-to-complete` |
| 8b.38 | §3.3 | Press **Resume TTR** on the 8b.14 row. | The TTR draft opens in the wizard at the first step that needs input (the same draft, not a second one). | `06-to-complete` |
| 8b.39 | §5.2 | Delete that draft TTR in the wizard (**Exit**, then confirm deleting the draft), return to **To complete**. | The purchase is still listed, now with **Start TTR**. Pressing it creates a new draft with the same reference and opens it. | `06-to-complete` |
| 8b.40 | §3.2, handover | Complete that TTR (all wizard steps), then open **To complete**. Then, with nothing left, look again. | The purchase is gone and the header count is one lower. With nothing left: "Nothing to complete. Every purchase has an invoice number." | `06-to-complete` |

### A3 · Complete purchase

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 8b.41 | handover | **Complete** on the 8b.5 purchase. | Page "Complete purchase" with tags, "Recorded <date time> by <staff>. Add the ERP invoice number to complete it.", the sellers (read only, with ID badges), the goods photos (open in a lightbox), the invoice box with hint "Required to complete the purchase." | `07-complete-purchase` |
| 8b.42 | handover | Press **Save and complete** with the invoice blank. | Error "Enter the ERP invoice number for this purchase." Nothing saved. | `07-complete-purchase` |
| 8b.43 | handover | Enter `INV-C1`, **Save and complete**. | Back on To complete with "Purchase completed". The purchase is gone from the list; its record shows "Completed <date time> by <staff>". | `07-complete-purchase` |
| 8b.44 | §3.3 | **Complete** the 8b.11 purchase (case A). The button reads "Save and continue to AUSTRAC". Enter `INV-C2`, press it. | The TTR is created and opens (case A fast path, Transaction Details). Its reference is `INV-C2`. | `07-complete-purchase` |
| 8b.45 | §3.3 | Jane: part 1 scrap, cash No, invoice `INV-C3`, saved (no cash amount). Part 2 bullion "$5,000 to $9,999", no invoice, saved. Complete part 2 with `INV-C3`. | The linked panel appears. Enter 6,000 for part 1's cash and 6,000 for this part. Total $12,000.00. An amber notice reads "The customer wasn’t asked to confirm their details at the counter. Contact them to confirm before completing the TTR." Pressing **Save and continue to AUSTRAC** creates two TTR drafts (scrap and bullion) and opens the first. | `07-complete-purchase` |
| 8b.46 | §3.3 | Complete a purchase with an invoice that a reportable other-customer purchase already uses. | Error under the invoice: "The ERP invoice number <inv> is already used by another purchase. A reportable purchase needs its own invoice number." (When the completing purchase is not reportable it is a warning only.) | `07-complete-purchase` |
| 8b.47 | C2 | A reportable purchase saved with an expired ID (seed). Open it in Complete purchase. | Red text "An ID on file had expired when this purchase was recorded." and the red box "This purchase can’t go into an AUSTRAC report." The save button is disabled. | `07-complete-purchase` |
| 8b.48 | §3.5 | Completing an invoice whose same-type TTR is already complete. | "The AUSTRAC report for <inv> is already finished. Use a new ERP invoice number for this purchase." | `07-complete-purchase` |
| 8b.49 | §4.3 | Open Complete purchase for a purchase that already has an invoice; then `/gold/purchases/<random id>/complete`; then another business's purchase id. | First: "Purchase already completed" with the invoice and who completed it, and **Back**. The other two: "Purchase not found." with a link back. Nothing is shown from the other business. | `07-complete-purchase` |

### A4 · Purchases

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 8b.50 | §5.2 | With 26 purchases, open **Purchases**. Press **Next**, then **Previous**, then a row. | 25 rows newest first, "26 purchases" and **Next**; **Next** shows the 26th and the URL has `page=2`; **Previous** goes back. A row opens its Purchase record. | `08-purchases` |
| 8b.51 | §5.2, handover | Set Type Bullion, Status "AUSTRAC pending", Cash "Cash $10k+", From and To dates, Recorded by one staff member; reload the page. Then press **Clear filters**. | The URL carries `type`, `status`, `cash`, `from`, `to`, `by`. After the reload every control and the result list are the same. The search text is **not** in the URL. **Clear filters** resets all of them and the URL is plain `/gold/purchases`. | `08-purchases` |
| 8b.52 | §5.2 | Type "Jane", then a phone, then Jane's licence number, then an invoice number. | Each finds the right purchases (including purchases where the person is the joint seller). | `08-purchases` |
| 8b.53 | §3.2 | Status options. | All, Incomplete, Completed, AUSTRAC pending, AUSTRAC. "AUSTRAC pending" shows reportable purchases whose TTR is not complete; "AUSTRAC" those whose TTR is complete. | `08-purchases` |
| 8b.54 | §5.2, §8 step 7 | Look for Download. | There is no Download button or print button on Purchases (Phase 9b). | `08-purchases` |

### A5 · Purchase record

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 8b.55 | §5.2 | Open the record of Jane + Joan's purchase (8b.29). | Details: Recorded, Recorded by, Completed, Type, Cash paid, AUSTRAC report (cash $10,000 or more) Yes, Cash amount, Phone at purchase, Sighted in person Yes, ID expired at time Yes/No, Purchase ID. Under "Main seller" and "Joint seller": the ID details **used for that purchase** (type, number, issuer, expiry, "Captured by <staff> on <date>"), ID front and back photos, goods photos. | `09-purchase-record` |
| 8b.56 | C1 | Jane renews her licence after a purchase (same document, "Renewed"). Open the older purchase's record. | The ID details are those at the time of the purchase; the photos shown are the new ones, labelled "Newer copy of this ID, taken <date>". | `09-purchase-record` |
| 8b.57 | §3.2 (Q5) | Open the record of a reportable purchase with a draft TTR; then one with a completed TTR; then a non-reportable one. | Draft: "AUSTRAC report: draft in progress" and a link **Open AUSTRAC report** that opens it in the wizard. Completed: "AUSTRAC report: complete" (with its reference and completion date, see 8b.72) and no link to open (a completed TTR cannot be reopened). Non-reportable: no AUSTRAC report line. | `09-purchase-record` |
| 8b.58 | §5.2 | An incomplete purchase. | A **Complete** button opens Complete purchase. There is no Download record or print button (Phase 9b). | `09-purchase-record` |


---

## Not in this PR

Exports and printing (build order step 7, Phase 9b): Download on Purchases, Download record on Purchase record, `gold-export`. Adding goods photos on Complete purchase (ruling Q2, spec §7: not in v1; `gold-complete-purchase` takes no photos). Staff names for older records beyond those who recorded or completed purchases.

---

## Section B · Manual test for the user (10 minutes or less)

Only what local tests cannot see: which hosted project the preview uses, a real iPad or iPhone camera taking goods photos, and one reportable sale on the hosted dev project through to the opened TTR. Everything else is in Section A.

**Before you start**
- Account: the one **dev admin** account on the dev project `rygjssczdoyvmumxmymc`. Use it for every step.
- Customer: the dummy customer **Lena Hostedsix**, id `174fb856-4049-4c1a-a4c7-5440940ff088`, already on dev with a valid licence. No new customers are created.
- Dev needs Phase 8b's two migrations (`20261110000001_gold_purchase_staff_names.sql`, `20261110000002_gold_search_purchases_invoice.sql`), the earlier gold migrations, these edge functions: `gold-save-purchase`, `gold-complete-purchase`, `gold-start-ttr`, `get-gold-photo-urls`, `get-id-image-urls`, `delete-draft-transaction`, and the secret `GOLD_JOURNEY_ENABLED` = `true`. If a step below shows a missing function or "Could not load purchases", deploy with the pinned CLI:
  ```
  cd app
  npx supabase db push --linked --workdir ..
  npx supabase functions deploy gold-save-purchase gold-complete-purchase gold-start-ttr get-gold-photo-urls get-id-image-urls delete-draft-transaction --project-ref rygjssczdoyvmumxmymc --workdir ..
  ```
- Invoice numbers: type them exactly as written, with today's date in place of `MMDD` (for example `UAT8B-CAM-1104`). A number can only be used once, so if you repeat a step add a letter: `UAT8B-CAM-1104B`.

### 1. Which Supabase project does the PR #28 preview use? (2 minutes)
1. ☐ Open PR #28 on GitHub. In the checks list click **Vercel – Preview** > **Visit Preview**. Note the address (it ends in `.vercel.app`).
2. ☐ On the preview, sign in with the dev admin account and the 6-digit code.
3. ☐ The "What would you like to do?" page shows a card **Gold due diligence**. (No card means the preview was built without `VITE_GOLD_JOURNEY_ENABLED=true`: stop and tell the implementer.)
4. ☐ Press **F12** > **Network** tab. Click the card, type `Hostedsix` in **Search**.
5. ☐ A request named `search_customers` appears. Click it. The **Request URL** starts with `https://rygjssczdoyvmumxmymc.supabase.co/rest/v1/rpc/search_customers`.
   - **Yes** (host is `rygjssczdoyvmumxmymc`): use the preview for everything below.
   - **No** (any other host, especially `ykerufaergyqvnaycyce`, the client project): **do not use this preview.** Do the fallback below, and do not set `GOLD_JOURNEY_ENABLED` on the client project.
6. ☐ One row is listed: **Lena Hostedsix**, with her date of birth, ID type and number, phone and an ID badge. Click it.

**Fallback: run the app locally against dev (only if step 5 was "No")**
1. In `app/`, create or edit `app/.env.local` (it is not committed) so it holds exactly these three lines. The anon key is the dev project's: Supabase dashboard > project `rygjssczdoyvmumxmymc` > **Project Settings** > **API Keys** > `anon` / publishable key.
   ```
   VITE_SUPABASE_URL=https://rygjssczdoyvmumxmymc.supabase.co
   VITE_SUPABASE_ANON_KEY=<the dev anon key>
   VITE_GOLD_JOURNEY_ENABLED=true
   ```
2. Run `cd app` then `npm run dev`. Open `http://localhost:5173` and sign in with the dev admin account. Repeat steps 1.3 to 1.6.
3. A phone or iPad cannot use the camera on `http://` over your network, so step 2 below needs a preview that does point at dev. Steps 3 and 4 work on `localhost` (the PC webcam covers the camera buttons).
4. When finished, set `app/.env.local` back to what it held before.

### 2. Goods photos with the real camera on an iPad or iPhone (4 minutes)
Use Safari on the iPad or iPhone, on the HTTPS preview address from step 1 (not localhost). Sign in with the dev admin account. Tap **Gold due diligence**, type `Hostedsix`, tap **Lena Hostedsix**.
1. ☐ Under **Record purchase**, **What are you buying?** shows **Scrap jewellery** selected. **Paid in cash of $10,000 or more?** shows **No** selected. Leave both.
2. ☐ Under **Photos of items purchased (required)** tap **Take photo**. Safari asks to use the camera: tap **Allow**. A live picture shows. Point it at any object and tap **Take photo** in the dialog. The dialog closes and the picture shows with a **Remove** button, readable.
3. ☐ A second box **Photos of items purchased (required)** shows. Tap **Upload**, choose **Photo Library** and pick a photo taken with this device (iPhones and iPads save these as HEIC). No red message appears and a second thumbnail shows. (The page converts it to a JPEG.)
4. ☐ Tick **Customer and ID sighted in person today**. Leave **ERP invoice number** empty. Tap **Record purchase**.
5. ☐ A green message reads "Purchase recorded. Add the invoice number later from To complete." The form is empty again. **Purchase history** at the bottom has a new first row **No invoice number yet** with the tags **Scrap** and **Incomplete**, and "2 photos".
6. ☐ Tap **No invoice number yet**. The **Scrap jewellery purchase** record opens. **Goods photos (2)** shows two thumbnails, both pictures visible. Tap the first: a larger picture opens. Tap **Close**.
7. ☐ Check what was stored: Supabase dashboard (dev) > **Storage** > bucket `gold-goods`. Open the newest folders: both files end in `.jpg`, are **image/jpeg**, and when downloaded and opened (**Properties > Details**) each is **1600 pixels or less** on its longer side.
8. ☐ Finish the purchase so it does not stay on To complete: tap **Complete**, type `UAT8B-CAM-MMDD` in **ERP invoice number**, tap **Save and complete**. You land on **To complete** with "Purchase completed".

### 3. One reportable sale for Lena, from the form to the opened TTR (4 minutes, PC browser)
Work on the PC (the preview from step 1, or the local fallback). Open **Lena Hostedsix**. Since the user's ruling (spec 3.3), the two cases end differently: **case A** (Lena is ready on file) records the purchase and *starts* the TTR but stays in gold, and you open the TTR yourself from **To complete** with **Resume TTR**; **case B** (Lena is missing some TTR field) opens the TTR straight after the save.
1. ☐ **What are you buying?** = **Scrap jewellery**. **Paid in cash of $10,000 or more?** = tap **Yes**. A box **Cash amount (AUD, optional)** appears: type `12500`.
2. ☐ **Photos of items purchased (required)**: tap **Upload** and choose any JPEG from the PC.
3. ☐ **ERP invoice number**: type `UAT8B-TTR-MMDD`. Tick **Customer and ID sighted in person today**.
4. Look at the page. Lena's record decides which of these two you see; do the one that matches:
   - **A. Two questions show** under **Counter questions** (Lena has every TTR field on file).
     1. ☐ **Is Lena Hostedsix acting on their own behalf?** tap **Yes**.
     2. ☐ **Are these details still correct?** (it lists her residential address, occupation, citizenship and tax residency) tap **Yes**.
     3. ☐ The amber box says "After you record this purchase, the AUSTRAC report will be started. Finish it from To complete." (it does not say the AUSTRAC form will open). Tap the record button at the bottom of the form. It reads **Record purchase and start AUSTRAC report** (case A starts the report but does not open it).
     4. ☐ The browser **stays on Lena's page** (the address still ends in her customer id and `/gold` is still in it). A green message reads "AUSTRAC report started. Finish it from To complete." The form is empty again and **Purchase history** has a new first row "UAT8B-TTR-MMDD" with the tags **Scrap** and **AUSTRAC pending**.
     5. ☐ In the gold header tap **To complete**. Under **AUSTRAC pending** the row for **Lena Hostedsix** says "Invoice UAT8B-TTR-MMDD", shows a line "AUSTRAC report due <date> · n business days left", and has a button **Resume TTR** (not Start TTR).
     6. ☐ Tap **Resume TTR**. The browser leaves Gold and the TTR wizard opens on **Step 3 Transaction Details** (the address ends in `/transaction-details`): **Transaction reference** = `UAT8B-TTR-MMDD`, **Cash amount** = 12500 (or empty, in which case type 12500).
   - **B. No questions show** (Lena is missing some TTR field).
     1. ☐ The amber box says "After you record this purchase, the AUSTRAC form will open with this customer loaded." and the button reads **Record purchase and continue to AUSTRAC**. Tap it.
     2. ☐ The browser leaves Gold and the wizard opens on its first step, **Customers** (the address ends in `/customers`), with Lena already loaded.
5. ☐ In the wizard press **Exit**, then in the "Exit transaction?" dialog press **Exit**. (This deletes the draft so dev stays tidy. Do not complete the report.)
6. ☐ Back in the gold journey (address bar: remove everything after the site name and type `/gold/to-complete`), **AUSTRAC pending (1)** or more is listed, and the row for **Lena Hostedsix** says "Invoice UAT8B-TTR-MMDD" and has a button **Start TTR** (not Resume TTR, because the draft was deleted). Tap **Start TTR**: the wizard opens again with the same reference. Press **Exit** and **Exit** once more.
7. ☐ Open `/gold/purchases`: the top row is **Lena Hostedsix**, tags **Scrap** and **AUSTRAC pending**, "UAT8B-TTR-MMDD". Tap it: the record shows **AUSTRAC report (cash $10,000 or more)** = Yes and a line "AUSTRAC report: not started" (the draft was deleted).

### 4. The client project stays closed (1 minute)
1. ☐ Open the production site (the client's live address, built from `main`) and sign in. The "What would you like to do?" page has **no** Gold due diligence card, and typing `/gold` after the address returns you to this page.
2. ☐ Supabase dashboard > project `ykerufaergyqvnaycyce` > **Edge Functions** > **Secrets**: there is no secret named `GOLD_JOURNEY_ENABLED`. (Do not add one.)

### 5. Counter feel (1 minute)
☐ On the preview at the PC's normal size, and then with the window dragged narrow (about a phone's width): Lena's page with the Record purchase form, To complete, Purchases and a Purchase record. Nothing needs sideways scrolling, and the ID badge and AUSTRAC tag colours match their meaning (green valid, amber expiring or re-verify, red expired or AUSTRAC pending, grey none).

---

## What a failure looks like
- "Could not load purchases. Try again." on To complete, Purchases or a record: the preview points at a project that lacks Phase 8b's migrations (`gold.list_purchase_staff`, the invoice search), or at the wrong project (step 1).
- Step 3 ends with "Purchase recorded, but the AUSTRAC report could not be started." (instead of "AUSTRAC report started." in case A): `gold-start-ttr` is not deployed on dev, or `GOLD_JOURNEY_ENABLED` is not `true` there. The purchase is saved; **Start TTR** on To complete retries it.
- Step 2.3 shows "That photo could not be read": the browser could not convert the HEIC file. Note the device and iOS version and report it.
- Search never answers and a red message says it failed: the preview cannot reach `rest/v1/rpc/search_customers`, usually the wrong project or the anon key.
- "The ERP invoice number … is already used by another purchase": the invoice was used before; add a letter to it.
- A `PGRST…` code or "Empty or invalid json" means a request went to `/rest/v1`, not `/functions/v1`; `invalid_request` means a form-data or JSON payload is malformed; `unauthorized` means the token expired (they last five minutes locally and an hour on dev) or was not sent. (Section B uses the browser only, so these show in the F12 Network tab.)
- CI `uat` red in **part0** on R11, R18, R24 or R27 and stuck on `/id-verification`: known issue #20 (a double load). Re-run the failed job once before investigating.

☐ Section A green on commit ______ · ☐ Section B · Notes: ______________________________

---

**Progress note (UAT automation).** All 63 rows are Playwright tests (`app/e2e/gold08b/`, 10 files). Break-and-revert done for every row: production breaks for the rules the screens and this phase's migrations enforce (photo cap, 1600 px compression, counter-question visibility, phone change, deadline colour, status tags, filters in the URL, paging, hand-off to the wizard, Complete purchase hand-off and "wasn't asked" notice, expired-ID button, draft kept across Update ID / Purchases, joint dialog Escape, Resume/Start label, start-TTR failure notice, and `gold.list_purchase_staff` / invoice search in the two 8b migrations, which the pgTAP rows in `supabase/tests/08_gold_reads.test.sql` also failed on), and one expectation flip per remaining row. Breaks left: none. D1 was fixed in `02857df` and re-verified. Re-verify (fresh agent): the fix was broken twice and 8b.63 failed each time (record-page line removed: `AUSTRAC report: draft in progress` not found; migration back to the flag only: `Expected: 2, Received: 1`), then reverted and it passes. `expectedToComplete()` in `support.js` encoded the old rule (flag only), so 8b.35 and 8b.36 failed once the part was listed. Spec §3.4 ("To complete lists both until both are complete"), §3.2 and the To complete row of §5.2 say such a part belongs on To complete and in the header count, so the helper now counts a part with a linked TTR as reportable (expectation flip on 8b.35: failed on the count, 49 vs 48). 8b.35 also read its own count before the header had loaded (NaN), so it now reads it after the poll. Added 8b.64. D2 was fixed in `ec03429` and re-verified (fresh agent). Break and revert: `GoldToCompletePage.jsx` back to the flag only failed 8b.64 (`Expected: 2, Received: 1` at the "AUSTRAC pending" count), and `PurchaseTags.jsx` back to the flag only failed 8b.64 the same way; both reverted and 8b.64 and 8b.36 pass. `npm run uat:gold08b`: 64 passed, 0 failed. pgTAP passes on a clean reset (855 tests); it fails 3 assertions only when run after the Playwright suite, because the suite leaves data behind. No open defects.

**Progress note (rulings Q1, Q3, Q5; fresh UAT agent).** The user's rulings are in the spec (commit 7dff641). Rows that asserted the old behaviour were rewritten to the spec as it now reads: 8b.17 and 8b.21 (a case A save at the counter no longer opens the wizard: they now expect the "AUSTRAC report started. Finish it from To complete." confirmation and the customer page; 8b.21 keeps all its data assertions; 8b.17 keeps the fast-path assertion by pressing Resume TTR on To complete). 8b.57's wording now names the reference and date (proved by 8b.72). The Purpose item 2, the spec questions (2 and 3 answered, 4 new: the case A button label) and Section B step 3 (case A now ends at To complete, Resume TTR) were updated. No row contradicts Q2 (no goods photos on Complete purchase) or Q4 (the Purchases search matches the invoice number: 8b.52). Added 8b.65 to 8b.72. Break and revert: Q1 no-open (`GoldCustomerPage.jsx` `saved.ttr === "A"` branch removed) failed 8b.17, 8b.21, 8b.65 and 8b.66 on the "AUSTRAC report started" confirmation; Q5 text (`GoldPurchaseRecordPage.jsx` back to "AUSTRAC report: complete") failed 8b.72 (`Received: "AUSTRAC report: complete"`); Q3 notice never shown (`hasUnconfirmedGoldPurchase` returns false) failed 8b.69; Q3 notice always shown (returns true) failed 8b.70 and 8b.71; Q3 notice ignoring the reportable flag failed 8b.70 (the case B review) and 8b.71 (the scrap review). Expectation flips: 8b.17 (notice wording), 8b.67 (Start TTR to Resume TTR), 8b.68 (Transaction Details to To complete), each failed on its assertion. 8b.71 is red for real: see D3. `npx playwright test --project=gold08b`: 71 passed, 1 failed (8b.71, D3). No SQL test was added, so pgTAP was not re-run.

**Progress note (D3 re-verify and button label ruling; fresh UAT agent).** Fix 397d7f0 read: `hasUnconfirmedGoldPurchase` (`app/src/lib/wizardApi.js`) now looks at the customer's same-day parts of the invoice before calling a late part unconfirmed, and `GoldCustomerPage.jsx` picks the record button label by case. Test changes: 8b.21 now presses "Record purchase and start AUSTRAC report" (it clicked the old case A label, "Record purchase and continue to AUSTRAC", so it failed after the label ruling; this follows the spec as edited in 397d7f0, it does not weaken the row). Added 8b.73 (case A label, case B label, non-reportable label; `11-rulings`), and 8b.14 keeps asserting the case B label. Section B step 3 case A names the new button text, and spec question 4 is answered. Break and revert: D3 (the same-invoice check dropped so a late part is always unconfirmed) failed 8b.71 on the notice count; the case A and case B labels swapped in `GoldCustomerPage.jsx` failed 8b.14, 8b.21 and 8b.73 on the button name; both reverted. D3 is marked fixed.
