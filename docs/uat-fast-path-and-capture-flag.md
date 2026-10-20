# UAT — self-conducted fast path & item/delivery capture flag

**Purpose:** prove the *behaviour* of two specific changes — the `ITEM_AND_DELIVERY_CAPTURE_ENABLED` flag being switched off, and the new "is the customer acting on their own behalf" fast path — is correct. This sheet does not re-prove ID verification, reliance, or AUSTRAC schema coverage; [dev-test-sheet.md](dev-test-sheet.md) already owns that and should be run (or have already passed) on this build first.

| | |
|---|---|
| Environment | ________ |
| Build/commit | ________ |
| Run by / date | ________ |

**Conventions.** Country is `Australia` / `AU` everywhere unless stated. Any small JPG works as a placeholder image. Steps marked ⚠ are where the change is most likely to have a silent or partial failure — read the expected result carefully rather than skimming for "does a screen appear."

**Timing.** About 45–60 min for all cases.

---

## Part 1 — Item & delivery capture disabled

With `ITEM_AND_DELIVERY_CAPTURE_ENABLED = false`, Recipient/Delivery, Bullion Details and Precious Metal Details should not exist anywhere in the app — not as a step, not as a route, not as a validation requirement.

### F1 ▶ Standard (non-fast-path) flow skips the three steps entirely

**Start Transaction:** scenario `Sell bullion to customer`; transactionRef `UAT-FP-001`.

**Customer Search → Create new customer** (Individual): firstName `Priya`; lastName `Fastlane`; dateOfBirth `1988-04-11`; phone `0400111000`; email `priya.fastlane@example.test`. Select her, Continue.

- ☐ The self-conducted question appears, because exactly one individual is selected (see F5). Answer **No**: Continue proceeds straight to Transaction Details

**Transaction Details:** Cash currency `AUD`; cashAmount `12000`.

**Party Details:** fullName `Priya Fastlane`; dateOfBirth `1988-04-11`; resStreet `1 Fastlane Ct`; resSuburb `Coburg`; resState `VIC`; resPostcode `3058`; phone `0400111000`; occupation `Analyst`; gender `F`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`.

**Conducting Person:** hasConductingPerson **No**.

**ID Verification:** `Sighted original document`; documentType `Driver licence`; documentNumber `FPL-100200`; issuer `VicRoads`; `AU`; hasExpiry `Yes`; expiryDate `2030-04-11`; capture front and back. Continue.

1. ☐ Lands directly on **Review / Validate / Submit** — no Recipient/Delivery, Bullion Details, or Precious Metal Details screen is ever shown
2. ☐ No "Recipient / Delivery", "Bullion", or "Precious metal" section renders on the summary
3. ☐ No validation issue mentions recipient, delivery, bullion, or precious metal — "This transaction is ready to be completed."

**Complete.**

- ☐ Succeeds with no error

### F2 ✓ Hidden routes are unreachable by URL

While signed in, type each of the following directly into the address bar:

- `/recipient-delivery`
- `/bullion-details`
- `/precious-metal-details`

☐ All three redirect to `/` (the dashboard) rather than rendering a page

### F3 ✓ Review/Submit back button target is unconditional

1. Repeat F1 but choose scenario `Sell precious metal to customer` at Start Transaction instead
2. From Review/Submit, click **Back**

☐ Returns to **/id-verification** — not `/bullion-details` or `/precious-metal-details` — regardless of scenario

### F4 ✓ ⚠ `complete-transaction` does not require recipient/delivery or item rows

```sql
SELECT
  (SELECT count(*) FROM ttr.recipient_deliveries rd JOIN ttr.transactions t ON t.id = rd.transaction_id WHERE t.transaction_ref = 'UAT-FP-001') AS recipient_rows,
  (SELECT count(*) FROM ttr.bullion_items bi JOIN ttr.transactions t ON t.id = bi.transaction_id WHERE t.transaction_ref = 'UAT-FP-001') AS bullion_rows,
  (SELECT status FROM ttr.transactions WHERE transaction_ref = 'UAT-FP-001') AS status;
```

☐ `recipient_rows` = `0`, `bullion_rows` = `0`, `status` = `complete` — the edge function's server-side validation was skipped for these fields, not merely hidden in the UI. If it had **not** been skipped, F1's Complete step above would have failed with a 422.

---

## Part 2 — Self-conducted fast path

### F5 ▶ Fast path is offered only for exactly one individual party

**Start Transaction:** scenario `Sell bullion to customer`; transactionRef `UAT-FP-002`.

**Customer Search:**

1. Create and select **Individual** `Oliver` `Twostep`, DOB `1992-02-02`, phone `0400222000`, email `oliver.twostep@example.test`
2. ☐ The "Is Oliver Twostep acting on their own behalf for this transaction?" Yes/No question appears
3. Also create and select **Individual** `Grace` `Twoparty`, DOB `1991-03-03`, phone `0400333000`, email `grace.twoparty@example.test`, so two parties are now selected
4. ☐ The question **disappears** — fast path is not offered once a second party is added
5. Remove Grace, leaving only Oliver selected
6. ☐ The question **reappears**
7. Instead create and select **Company** `Bright Metals Pty Ltd`, abnAcn `11223344556`, suburb `Preston`, companyPhone `0393334444`, companyEmail `accounts@brightmetals.example.test`, alongside Oliver (two parties, one company)
8. ☐ The question is **absent** — not offered for company parties or for more than one selected party

Remove Bright Metals Pty Ltd, leaving only Oliver selected, before continuing to F6.

### F6 ▶ Continue is blocked until the question is answered

With only Oliver selected, click **Continue** without selecting Yes or No.

☐ Blocked: "Answer whether the customer is acting on their own behalf." — no navigation occurs

### F7 ▶ Answering "No" takes the normal route, unaffected by the fast path

Select **No**, click Continue.

☐ Proceeds to **Transaction Details** (`Step 2 of 3`), then in order: Party Details (`Step 3 of 4`) → Conducting Person → ID Verification (`Step 5`) → Review/Submit. No step is skipped or reordered.

**Complete this transaction** (Cash `AUD` `11000`; Party Details fullName `Oliver Twostep`, DOB `1992-02-02`, resStreet `2 Twostep Wy`, resSuburb `Preston`, resState `VIC`, resPostcode `3072`, phone `0400222000`, occupation `Teacher`, gender `M`, citizenshipCountryCode `AU`, taxResidencyCountryCode `AU`; Conducting Person **No**; ID Verification `Sighted original document` / `Passport` / `OTS-100300` / `Australian Passport Office` / `AU` / hasExpiry `Yes` / `2032-02-02` / capture front) to keep the DB in a clean state for later cases.

### F8 ▶ Answering "Yes" jumps straight to ID Verification, and Back returns correctly

**Start Transaction:** transactionRef `UAT-FP-003`. **Customer Search:** create and select **Individual** `Nadia` `Quickpath`, DOB `1995-05-05`, phone `0400555000`, email `nadia.quickpath@example.test`. Answer **Yes** to the self-conducted question. Click Continue.

1. ☐ Button reads "Continuing…" briefly, then navigates to **ID Verification**
2. ☐ Step label reads **"Step 2"** (not "Step 5")
3. Click **Back**
4. ☐ Returns to **/customers**, not Conducting Person

### F9 ▶ ⚠ Step numbering and back-navigation stay correct through the rest of the fast path

Continuing `UAT-FP-003` from F8: re-enter ID Verification (`Sighted original document` / `Driver licence` / `NQP-100400` / `VicRoads` / `AU` / hasExpiry `Yes` / `2031-05-05` / capture front and back), click Continue.

1. ☐ Proceeds to **Transaction Details**, labelled **"Step 3"**
2. Click **Back** → ☐ returns to **/id-verification**, not `/customers`
3. Fill in Cash currency `AUD`, cashAmount `10500`, click Continue
4. ☐ Proceeds to **Party Details**, labelled **"Step 4"**
5. Fill in fullName `Nadia Quickpath`, dateOfBirth `1995-05-05`, resStreet `5 Quickpath Rd`, resSuburb `Thornbury`, resState `VIC`, resPostcode `3071`, phone `0400555000`, occupation `Designer`, gender `F`, citizenshipCountryCode `AU`, taxResidencyCountryCode `AU`. Click Continue.
6. ☐ **Record exactly what happens next.** Expected: the wizard proceeds toward Review/Submit (there is nothing left to fill in — Recipient/Delivery, Bullion, and Precious Metal are all disabled per Part 1). **If instead you land back on the dashboard (`/`) with no error message and the transaction abandoned mid-flow, this is a defect** — log it with the transaction ref, do not treat it as a pass, and do not "fix" it yourself by re-entering data through the normal (non-fast-path) route as a workaround for this test.

### F10 ✓ A transaction-ref race is reported in plain language, not as a raw DB error

This exercises the same friendly-error path from two different insert points, since the underlying helper was consolidated into one place used by both.

1. **On Customer Search (fast path insert):** have a second staff session claim/complete transactionRef `UAT-FP-004` at the same moment a fast-path Continue (Yes) is submitted for a new customer under that same ref
   - ☐ "That transaction reference is already in use. Go back to the start and enter a different reference." — not a raw `duplicate key value violates unique constraint` message
2. **On Transaction Details (normal-path save):** repeat the same race using the non-fast-path flow (answer **No**, or use a company customer) with transactionRef `UAT-FP-005`
   - ☐ Identical friendly message shown

---

## Sign-off

☐ All Part 1 cases pass · ☐ All Part 2 cases pass, **with F9's outcome explicitly recorded** (pass or logged defect) · Defects found: ________
