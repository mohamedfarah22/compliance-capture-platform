# UAT: Gold purchase screens (Gold Phase 8b)

**Purpose:** prove that `gold/08b-purchase-screens` gives staff the purchase half of the gold journey in the browser, and that it hands over to the TTR wizard where the spec says it does:
1. On a customer's page, staff record a scrap or bullion purchase: goods photos, the cash question, the ERP invoice, the sighted box, the counter questions, a joint seller
2. A reportable sale is either case A (ready on file, both counter answers Yes: the TTR starts when the invoice is added) or case B (anything else: the invoice is required and the TTR opens straight after the save)
3. To complete, Complete purchase, Purchases and Purchase record show purchases, their AUSTRAC status ("AUSTRAC pending" until the TTR is complete, then "AUSTRAC") and the TTR link
4. Every screen only shows what the Phase 5 to 9a server pieces allow; the browser never decides a rule the server re-checks
5. Exports, printing and Download are **not** here (build step 7, Phase 9b)

| | |
|---|---|
| Environment | Local Supabase stack (`supabase start`), Vite on 5199, flag on |
| Build/commit | ________ |
| Run by / date | ________ |

**Where the rules come from.** Spec §3.2, §3.3, §3.3a, §3.4, §3.5, §4.3, §4.6, §5.2 (the CustomerDetail purchase form, JointSellerPanel, ToComplete, CompletePurchase, Purchases and PurchaseRecord rows), §5.3, §5.4, and C1, C2, C3 in §1.7 of `docs/gold-due-diligence-spec.md`. The "Spec" column names the clause each row proves.

**Set-up for every row.** `VITE_GOLD_JOURNEY_ENABLED=true` for the browser build and `GOLD_JOURNEY_ENABLED=true` for the local functions. Staff sign in with password then TOTP. Unless a row says otherwise the user is an active `staff` member of business One, on `/gold`.

**People used.** All three have a driver licence on file (state VIC, country AU, valid for at least a year, photographed within the business's re-verification window):
- **Jane Citizen**: every TTR Party Details field on file (occupation Jeweller, gender F, citizenship AU, tax residency AU, not a sole trader). Ready for case A.
- **Joan Smith**: same, a second person (the joint seller).
- **Gold-only Gina**: name, date of birth, address, phone and licence only. No occupation, gender, citizenship or tax residency. Not ready for case A.

"Reportable" means cash of $10,000 or more. Scrap is asked "Paid in cash of $10,000 or more?". Bullion is asked "Cash paid" with the choices "Under $5,000", "$5,000 to $9,999" and "$10,000 or more". "Photo" means any JPEG or PNG file chosen with the **Upload** button of the goods-photo field. Invoice numbers are made unique per run (`INV-B1` below stands for `INV-B1-<run>`).

---

## A · Purchase form on the customer page

| # | Spec | Action | Expected |
|---|---|---|---|
| 8b.1 | C3, §5.2 | Open Jane's page. Look at the **Record purchase** form. | The box "Customer and ID sighted in person today" is **not** ticked. Under it: "Doesn't match the record? Update ID first." The "Record purchase" button is enabled. |
| 8b.2 | C3 | Choose Scrap jewellery, answer the cash question No, add one photo, leave the box unticked, press **Record purchase**. | Nothing is saved. The error under the box reads "ID must be sighted today and match the record on file. Doesn't match the record? Update ID first." |
| 8b.3 | §5.2 (unchanged) | Tick the box, remove the photo (or use a fresh form), press **Record purchase**. | Error "Add at least one photo of the items purchased." Nothing saved. With a photo added it saves. |
| 8b.4 | §4.5, §5.2 | Upload a 3000 x 2000 pixel PNG as the goods photo. | A thumbnail appears with **Remove**. The request to `gold-save-purchase` carries that photo as `image/jpeg`, 1600 pixels or less on the long side (this is the same rule the ID photos follow). Adding an 11th photo is refused: "You can add up to 10 photos." |
| 8b.5 | §5.2 (unchanged) | Jane, Scrap jewellery, cash No, one photo, box ticked, no invoice, **Record purchase**. | Saved. Toast "Purchase recorded. Add the invoice number later from To complete." The form is empty again. **Purchase history** lists it as "No invoice number yet" with the tags "Scrap" and "Incomplete" and "1 photo". The header link reads "To complete (1)" (plus any older ones). |
| 8b.6 | §5.2 (unchanged) | Choose Bullion. Select each of the three bands. | "Under $5,000" and "$5,000 to $9,999" show no cash-amount box; "$5,000 to $9,999" shows "Needs this customer’s current ID. No AUSTRAC report." "$10,000 or more" shows the optional cash amount box. With Scrap, answering Yes shows the same box. |
| 8b.7 | §5.2 (phone rules) | Change Phone to 7 digits and press **Record purchase** (box ticked, photo added). Then to 8 digits and a new number. | 7 digits: "Phone number looks too short." and nothing saved. A new 8-digit number shows the hint "Different from the customer record. Saving the purchase also updates the customer’s phone number." After the save Jane's page shows the new phone. |
| 8b.8 | §3.3a | Jane, scrap, cash **Yes**, no amount typed. Then switch to cash No. Then Yes with a typed cash amount of 8,000. Then 10,000. | Yes with no amount: two counter questions appear: "Is Jane Citizen acting on their own behalf?" and "Are these details still correct?". The second shows Jane's residential address, occupation (Jeweller), citizenship (AU) and tax residency (AU). Each has No / Yes. Cash No: the questions are hidden (not shown on non-reportable sales). Amount 8,000: still hidden (the amount decides). Amount 10,000: shown. |
| 8b.9 | §3.3a | Open Gold-only Gina. Scrap, cash Yes. Then Jane with a joint seller (8b.26), cash Yes. | Neither shows the questions (Gina is not ready; a joint sale is always case B). |
| 8b.10 | §3.3a | Jane, scrap, cash Yes, photo, box ticked, answer only the first question, press **Record purchase**. | Nothing saved. Error "Answer both questions." under the second. |
| 8b.11 | §3.3, §3.3a | Jane, scrap, cash Yes, answer both counter questions **Yes**, photo, box ticked, no invoice. Press **Record purchase**. | Before pressing: the amber notice "No invoice number yet, so this purchase will be saved as AUSTRAC pending. Add the invoice number within 10 business days from To complete." and the button "Record purchase". After: saved as case A, you stay on Jane's page, toast "Purchase recorded as AUSTRAC pending. Add the invoice number from To complete." History shows the tag "AUSTRAC pending". No TTR exists yet. |
| 8b.12 | §3.3 | Jane, scrap, cash Yes, answer the first question **No** (second Yes), no invoice, press **Record purchase**. | Case B: error on the invoice box "Enter the ERP invoice number. The AUSTRAC report for Jane Citizen must be started now." Nothing saved. |
| 8b.13 | §3.3 | Gold-only Gina, scrap, cash Yes, photo, box ticked, no invoice, press **Record purchase**. | Error "Enter the ERP invoice number. Gold-only Gina’s AUSTRAC details are incomplete, so the report must be started now." Nothing saved. |
| 8b.14 | §3.2, §3.3, §3.4 | Gina, scrap, cash Yes, invoice `INV-B1`, photo, box ticked. Read the button, press it. | The button reads "Record purchase and continue to AUSTRAC", with the amber notice "After you record this purchase, the AUSTRAC form will open with this customer loaded." After the save the browser leaves `/gold` for the TTR (`/open-ttr/<id>` then the first wizard step that needs input). The draft TTR exists with reference `INV-B1`, scenario precious_metal_buy, and Gina as its party. |
| 8b.15 | §3.2 | Same as 8b.14 with Bullion, band "$10,000 or more", invoice `INV-B2`. | The TTR draft has scenario bullion_buy and reference `INV-B2`. |
| 8b.16 | §3.2 | Open any draft TTR in this browser tab (so one is active), then record a case B purchase for Gina (invoice `INV-B3`). | After the save: "Another AUSTRAC report is in progress" with "You have another AUSTRAC report in progress (<its reference>). It stays saved; reopen it from the TTR start page." and the button "Open this report". The purchase is saved. The button opens the new TTR. |
| 8b.17 | §3.3 | Jane, scrap, cash Yes, both counter answers Yes, invoice `INV-B4` entered at the counter, press **Record purchase and continue to AUSTRAC**. | Saved and the TTR opens: the case A fast path, ID details already confirmed (the wizard goes to Transaction Details, not to ID verification). |
| 8b.18 | §3.3 | Record a reportable purchase with invoice `INV-B5` for Gina. Then record a reportable purchase for Jane with invoice `INV-B5`. | The second is refused before saving: "The ERP invoice number INV-B5 is already used by another purchase. A reportable purchase needs its own invoice number." Nothing saved. |
| 8b.19 | §3.3, handover | Record a non-reportable purchase with invoice `INV-B6`. Then a second non-reportable purchase, for another customer, with `INV-B6`. | After leaving the invoice box: "This invoice number is already recorded. Check it’s not a duplicate." The second purchase **saves** (a warning, not a block). |
| 8b.20 | §3.4 | Jane: scrap, cash No, invoice `INV-B7`, saved. Then a new bullion purchase with invoice `INV-B7` the same day. | After the invoice box loses focus the cash question is replaced by the amber panel "Same invoice as an earlier purchase today for this customer", listing the Scrap purchase with a box "Cash paid on that part (AUD)" (its amount was never entered) and a box "Cash paid for this part (AUD)". Leaving this part blank and saving shows "Enter the cash paid for this part. Enter 0 if none was cash." |
| 8b.21 | §3.4 | In 8b.20 the scrap part's cash amount is blank. Enter 6,000 for "Cash paid on that part (AUD)" and 6,000 for this part. | The panel says "Cash on INV-B7 today: $12,000.00. That’s $10,000.00 or more, so the invoice will be reported to AUSTRAC once." Saving works as a reportable purchase (Jane is ready: both counter questions are asked first). |
| 8b.22 | §3.5 | Complete the TTRs of 8b.21 (both). Then record a third part for Jane on `INV-B7`. | Refused: "The AUSTRAC report for INV-B7 is already finished. Use a new ERP invoice number for this purchase." Nothing saved. |
| 8b.23 | C2, §3.3 | Gina's licence is expired. Scrap, cash Yes. Then cash No. | Cash Yes: a red notice "Update the ID before recording this cash purchase. An expired ID cannot go into an AUSTRAC report." with "Gold-only Gina (main seller): ID expired on <date>" and **Update ID now**; **Record purchase** is disabled. Cash No: "ID on file has expired for Gold-only Gina. This purchase will be saved with an expired-ID flag." and it saves. |
| 8b.24 | C2 | Jane's licence was photographed longer ago than the business's re-verification days. Scrap, cash Yes. Then cash No. Then bullion "$5,000 to $9,999". | Cash Yes: blocked with the same red notice and **Update ID now**. Cash No: an amber notice "ID needs re-verifying" and it saves. Bullion $5,000 to $9,999: blocked (a current ID is needed). |
| 8b.25 | C2, §5.4 | In 8b.23 fill the form, press **Update ID now**, renew the ID (reason "Renewed: same document, new expiry date"). | You return to Gina's page. The form is filled as you left it (photos, answers, invoice). The red notice is gone. |
| 8b.26 | §5.2, §5.4 | Press **Add second person (joint sale)**. | A dialog "Add second person" opens, the search box has the focus. Typing "Jane" shows Jane with "Already the main seller", not selectable. Escape closes the dialog and the focus goes back to **Add second person (joint sale)**. |
| 8b.27 | §5.2 | In the dialog search "Joan", pick Joan Smith. | The dialog closes. A "Joint seller" row shows Joan, her ID type and number, an ID status badge, **View ID** and **Remove**. The box now reads "Both people and their IDs sighted in person today". **Remove** puts the button back and the focus on it. |
| 8b.28 | §3.3 | Jane + Joan (8b.27), scrap, cash Yes, photo, box ticked, no invoice. Press **Record purchase**. | No counter questions are shown. Error on the invoice box: "Enter the ERP invoice number. The AUSTRAC report for Jane Citizen must be started now." Nothing saved. |
| 8b.29 | §3.2, §3.3 | Same, with invoice `INV-B8`, press the button. | A joint sale is always case B: the TTR opens with two parties (Jane and Joan), the wizard asks for what is missing. Jane's page history and Joan's page history both list the purchase, with "Joint sale with ..." links. |
| 8b.30 | §5.2 | In the dialog press **New customer**, create "Pat Newman" (all required fields, a licence, front and back photos, the sighted box). | After "Customer created" you land on Jane's page (not Pat's). The Joint seller row shows Pat and Jane's draft is as left. |
| 8b.31 | C2 | Joan's licence expired; Jane + Joan, cash Yes. | Red notice lists Joan ("joint seller") with **Update ID now**; after renewing you return to Jane's page with Joan still attached. |
| 8b.32 | handover §5 | Fill Jane's form partly (photo, invoice, cash Yes). Open **Purchases** from the header and come back to Jane. Then **Switch journey** and open Jane again. | Coming back from Purchases: the form is as left. After Switch journey: the form is empty. After a successful save the form is empty. |
| 8b.33 | §3.2 | Jane's page, **Purchase history**. | Newest first. Each row: invoice number (or "No invoice number yet"), tags, date and time, "n photo(s)", and for a joint sale "Joint sale with <name>" as a link. Clicking the invoice opens the Purchase record. |
| 8b.34 | §3.2 | Look at the tags: a reportable purchase with a draft TTR; one with a completed TTR; a non-reportable one with an invoice. | "AUSTRAC pending"; "AUSTRAC"; neither tag. A purchase with no invoice also has "Incomplete". |
| 8b.35 | §5.3 | Look at the gold header. | "Gold due diligence", then "To complete (n)", "Purchases", the staff name, "Switch journey", "Sign out". n is the number of purchases on the To complete screen and updates after a save. |

## B · To complete

| # | Spec | Action | Expected |
|---|---|---|---|
| 8b.36 | §5.2, §3.3 | Open **To complete** with: 8b.11 (case A, no invoice), 8b.5 (non-reportable, no invoice), 8b.14 (case B, draft TTR). | Section "AUSTRAC pending (2)" holds the case A purchase and the case B one; "Other purchases (1)" holds the non-reportable one. Each row: names, tags, "Recorded <date time> by <staff>", "n photo(s)". The case A and the invoice-less purchases have **Complete**; the case B one has **Resume TTR**. |
| 8b.37 | handover §4.3 | Look at the line under an AUSTRAC pending purchase recorded 1 business day ago, and one recorded 12 business days ago (recorded by the test seed). | "AUSTRAC report due <date> · 9 business days left" in amber; the older one "Overdue by 2 business days" in red. A purchase with 2 or fewer days left is also red. The due date is the sale date plus 10 business days (Mon to Fri). |
| 8b.38 | §3.3 | Press **Resume TTR** on the 8b.14 row. | The TTR draft opens in the wizard at the first step that needs input (the same draft, not a second one). |
| 8b.39 | §5.2 | Delete that draft TTR in the wizard (**Exit**, then confirm deleting the draft), return to **To complete**. | The purchase is still listed, now with **Start TTR**. Pressing it creates a new draft with the same reference and opens it. |
| 8b.40 | §3.2, handover | Complete that TTR (all wizard steps), then open **To complete**. Then, with nothing left, look again. | The purchase is gone and the header count is one lower. With nothing left: "Nothing to complete. Every purchase has an invoice number." |

## C · Complete purchase

| # | Spec | Action | Expected |
|---|---|---|---|
| 8b.41 | handover | **Complete** on the 8b.5 purchase. | Page "Complete purchase" with tags, "Recorded <date time> by <staff>. Add the ERP invoice number to complete it.", the sellers (read only, with ID badges), the goods photos (open in a lightbox), the invoice box with hint "Required to complete the purchase." |
| 8b.42 | handover | Press **Save and complete** with the invoice blank. | Error "Enter the ERP invoice number for this purchase." Nothing saved. |
| 8b.43 | handover | Enter `INV-C1`, **Save and complete**. | Back on To complete with "Purchase completed". The purchase is gone from the list; its record shows "Completed <date time> by <staff>". |
| 8b.44 | §3.3 | **Complete** the 8b.11 purchase (case A). The button reads "Save and continue to AUSTRAC". Enter `INV-C2`, press it. | The TTR is created and opens (case A fast path, Transaction Details). Its reference is `INV-C2`. |
| 8b.45 | §3.3 | Jane: part 1 scrap, cash No, invoice `INV-C3`, saved (no cash amount). Part 2 bullion "$5,000 to $9,999", no invoice, saved. Complete part 2 with `INV-C3`. | The linked panel appears. Enter 6,000 for part 1's cash and 6,000 for this part. Total $12,000.00. An amber notice reads "The customer wasn’t asked to confirm their details at the counter. Contact them to confirm before completing the TTR." Pressing **Save and continue to AUSTRAC** creates two TTR drafts (scrap and bullion) and opens the first. |
| 8b.46 | §3.3 | Complete a purchase with an invoice that a reportable other-customer purchase already uses. | Error under the invoice: "The ERP invoice number <inv> is already used by another purchase. A reportable purchase needs its own invoice number." (When the completing purchase is not reportable it is a warning only.) |
| 8b.47 | C2 | A reportable purchase saved with an expired ID (seed). Open it in Complete purchase. | Red text "An ID on file had expired when this purchase was recorded." and the red box "This purchase can’t go into an AUSTRAC report." The save button is disabled. |
| 8b.48 | §3.5 | Completing an invoice whose same-type TTR is already complete. | "The AUSTRAC report for <inv> is already finished. Use a new ERP invoice number for this purchase." |
| 8b.49 | §4.3 | Open Complete purchase for a purchase that already has an invoice; then `/gold/purchases/<random id>/complete`; then another business's purchase id. | First: "Purchase already completed" with the invoice and who completed it, and **Back**. The other two: "Purchase not found." with a link back. Nothing is shown from the other business. |

## D · Purchases

| # | Spec | Action | Expected |
|---|---|---|---|
| 8b.50 | §5.2 | With 26 purchases, open **Purchases**. Press **Next**, then **Previous**, then a row. | 25 rows newest first, "26 purchases" and **Next**; **Next** shows the 26th and the URL has `page=2`; **Previous** goes back. A row opens its Purchase record. |
| 8b.51 | §5.2, handover | Set Type Bullion, Status "AUSTRAC pending", Cash "Cash $10k+", From and To dates, Recorded by one staff member; reload the page. Then press **Clear filters**. | The URL carries `type`, `status`, `cash`, `from`, `to`, `by`. After the reload every control and the result list are the same. The search text is **not** in the URL. **Clear filters** resets all of them and the URL is plain `/gold/purchases`. |
| 8b.52 | §5.2 | Type "Jane", then a phone, then Jane's licence number, then an invoice number. | Each finds the right purchases (including purchases where the person is the joint seller). |
| 8b.53 | §3.2 | Status options. | All, Incomplete, Completed, AUSTRAC pending, AUSTRAC. "AUSTRAC pending" shows reportable purchases whose TTR is not complete; "AUSTRAC" those whose TTR is complete. |
| 8b.54 | §5.2, §8 step 7 | Look for Download. | There is no Download button or print button on Purchases (Phase 9b). |

## E · Purchase record

| # | Spec | Action | Expected |
|---|---|---|---|
| 8b.55 | §5.2 | Open the record of Jane + Joan's purchase (8b.29). | Details: Recorded, Recorded by, Completed, Type, Cash paid, AUSTRAC report (cash $10,000 or more) Yes, Cash amount, Phone at purchase, Sighted in person Yes, ID expired at time Yes/No, Purchase ID. Under "Main seller" and "Joint seller": the ID details **used for that purchase** (type, number, issuer, expiry, "Captured by <staff> on <date>"), ID front and back photos, goods photos. |
| 8b.56 | C1 | Jane renews her licence after a purchase (same document, "Renewed"). Open the older purchase's record. | The ID details are those at the time of the purchase; the photos shown are the new ones, labelled "Newer copy of this ID, taken <date>". |
| 8b.57 | §3.2 | Open the record of a reportable purchase with a draft TTR; then one with a completed TTR; then a non-reportable one. | Draft: "AUSTRAC report: draft in progress" and a link **Open AUSTRAC report** that opens it in the wizard. Completed: "AUSTRAC report: complete" with no link to open (a completed TTR cannot be reopened). Non-reportable: no AUSTRAC report line. |
| 8b.58 | §5.2 | An incomplete purchase. | A **Complete** button opens Complete purchase. There is no Download record or print button (Phase 9b). |

---

## Not in this PR

Exports and printing (build order step 7, Phase 9b): Download on Purchases, Download record on Purchase record, `gold-export`. Adding goods photos on Complete purchase (`gold-complete-purchase` takes no photos). Staff names for older records beyond those who recorded or completed purchases.
