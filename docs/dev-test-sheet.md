# Dev test sheet — pre-production validation

**Purpose:** prove the *behaviour* is correct, from an empty database, before a fresh production environment is built.

**Run D1 → D42 in order.** Every step depends on the ones before it. Each transaction carries all its field data inline — you should never need another document to complete a step. [uat-test-matrix.md](uat-test-matrix.md) explains *why* each case exists and is the place to look when something fails; [go-live.md](go-live.md) is the production sheet and assumes this one has passed.

| | |
|---|---|
| Environment | dev |
| Build/commit | ________ |
| Run by / date | ________ |

**Conventions.** Country is `Australia` / `AU` everywhere unless stated. Any small JPG works as a placeholder image. `dateTime` on Start Transaction is left prefilled throughout. Fields not mentioned for a step are either not shown or can be left at their default. Steps marked ⚠ fail *silently* — the system appears to work while a promise to customers is false.

**Timing.** D1–D5 about 20 min · D6–D24 about 2 hr · D25–D33 about 3–4 hr · D34–D42 about 1 hr.

---

# Part 0 — Reset and deploy

## D1 ✓ Wipe all transaction data

Destructive. `reporting_entities` and `staff_members` survive. Order matters: `stored_images.transaction_id` is `ON DELETE RESTRICT`; `id_verifications.front_image_id` references `stored_images` with no cascade, so verifications go **before** images; and three tables carry immutability triggers.

```sql
-- 1. Record every object path FIRST — your only record of what to delete from the
--    compliance-media bucket. SQL cannot remove storage objects.
SELECT object_path FROM ttr.stored_images ORDER BY object_path;

-- 2. Report links and batches
DELETE FROM ttr.transaction_reports;
DELETE FROM ttr.report_batches;

-- 3. Verifications before images (the FK points that way)
DELETE FROM ttr.id_verifications;
DELETE FROM ttr.stored_images;

-- 4. Audit tables — append-only, so the triggers must come off
ALTER TABLE ttr.access_log            DISABLE TRIGGER trg_access_log_append_only;
ALTER TABLE ttr.transaction_audit_log DISABLE TRIGGER trg_audit_append_only;
DELETE FROM ttr.access_log;
DELETE FROM ttr.transaction_audit_log;
ALTER TABLE ttr.access_log            ENABLE TRIGGER trg_access_log_append_only;
ALTER TABLE ttr.transaction_audit_log ENABLE TRIGGER trg_audit_append_only;

-- 5. Transactions — cascades parties, conducting_persons, recipient_deliveries,
--    bullion_items, precious_metal_items
ALTER TABLE ttr.transactions DISABLE TRIGGER trg_lock_completed;
DELETE FROM ttr.transactions;
ALTER TABLE ttr.transactions ENABLE  TRIGGER trg_lock_completed;

-- 6. Verify
SELECT (SELECT count(*) FROM ttr.transactions)  AS txns,
       (SELECT count(*) FROM ttr.parties)       AS parties,
       (SELECT count(*) FROM ttr.stored_images) AS images,
       (SELECT count(*) FROM ttr.access_log)    AS logs;

-- 7. ⚠ The triggers MUST be back on. A disabled one silently removes the tamper-evidence
--    privacy policy §4 promises, and nothing else will ever tell you.
SELECT tgname, tgenabled = 'O' AS enabled FROM pg_trigger
 WHERE tgname IN ('trg_lock_completed','trg_access_log_append_only','trg_audit_append_only');
```

☐ All four counts `0` · ☐ All three triggers `true` · ☐ Every object deleted from `compliance-media`

## D2 ✓ Apply migrations

```sql
-- Pre-flight for 20260727000004 — must be 0, or that migration fails by design
SELECT count(*) FROM ttr.id_verifications WHERE new_capture_reason = 'other';
```

Apply all pending migrations, then confirm every object exists:

```sql
SELECT 'uniqueness index'   AS object, to_regclass('ttr.uq_idv_doc_new_capture') IS NOT NULL AS present
UNION ALL SELECT 'collision lookup',  to_regproc('public.get_verification_for_document') IS NOT NULL
UNION ALL SELECT 'duplicate finder',  to_regproc('ttr.find_unsuperseded_duplicates') IS NOT NULL
UNION ALL SELECT 'access_log',        to_regclass('ttr.access_log') IS NOT NULL
UNION ALL SELECT 'supersede cols',    EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='ttr' AND table_name='stored_images' AND column_name='superseded_at')
UNION ALL SELECT 'recapture trigger', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_idv_recapture_link')
UNION ALL SELECT 'owner columns',     pg_get_function_result(
    'public.get_verification_for_document(text,text,uuid)'::regprocedure) LIKE '%owner_dob%'
UNION ALL SELECT 'two grounds only',  pg_get_constraintdef(oid) NOT LIKE '%''other''%'
    FROM pg_constraint WHERE conname = 'chk_idv_new_capture_reason_values';
```

☐ All eight `t`

## D3 ✓ Deploy all functions and the frontend

```
npx supabase functions deploy complete-transaction
npx supabase functions deploy upload-id-image
npx supabase functions deploy delete-draft-transaction
npx supabase functions deploy get-id-image-urls
npx supabase functions deploy cleanup-stale-drafts
npx supabase functions deploy reconcile-stored-images
npx supabase functions deploy generate-austrac-report
npx supabase functions deploy approve-batch
```

☐ All eight, from the same commit as the frontend · ☐ Frontend rebuilt · ☐ Browser hard-refreshed

**A stale `complete-transaction` disables the whole of §3 while every screen looks correct** — that produced two false failure reports during earlier testing. The §3 reason list and the ID-capture recovery fixes are frontend-only, so the browser must be refreshed too.

## D4 ✓ Reporting entity sane

```sql
SELECT austrac_account_number, idv_max_reliance_days, idv_block_on_expired,
       name, address_line, suburb, state, postcode FROM public.reporting_entities;
```

☐ 9-digit AUSTRAC number · ☐ `idv_max_reliance_days` = **730** · ☐ Entity address correct — it becomes `<txnLocation>` on every report

## D5 ✓ Automated suites

```
cd app && npm test                                # 307 passing
cd app && npm run lint                            # clean
cd supabase/functions && deno test --allow-all    # 102 passing
```

☐ 307 · ☐ clean · ☐ 102

---

# Part 1 — One copy of ID on file (privacy policy §3)

The core of the build. Four identities, introduced as they are needed.

## D6 ▶ First capture — the control

**Start Transaction:** scenario `Sell bullion to customer`; transactionRef `DEV-001`.

**Customer Search → Create new customer** (Individual): firstName `Regina`; middleName `Mae`; lastName `Testworth`; dateOfBirth `1983-05-12`; phone `0400123123`; email `regina.testworth@example.test`. Select her, Continue.

**Transaction Details:** Cash currency `AUD`; cashAmount `14000`.

**Party Details:** fullName `Regina Mae Testworth`; aliases none; dateOfBirth `1983-05-12`; resStreet `14 Regress Rd`; resSuburb `Preston`; resState `VIC`; resPostcode `3072`; postal-different **unchecked**; phone `0400123123`; occupation `Florist`; gender `F`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`.

**Conducting Person:** hasConductingPerson **No**.

**ID Verification:** verificationMethod `Sighted original document`; documentType `Driver licence`; documentNumber `RGN-111222`; issuer `VicRoads`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2030-05-12`; capture front **and back**.

- ☐ **No "Reason for taking a new copy" field appears at all.** First-time customer, nothing duplicated. If one is demanded, the option-narrowing is over-firing

**Recipient & Delivery:** recipientIsParty **Yes**; recipient `Regina Mae Testworth`; purpose `Collecting bullion`; delivery method `Collected`; notes blank.

**Bullion Details** — Item 1: metalType `Gold`; productType `Bar`; purity `999.9`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `14000`; description `1kg gold bar`.

**Before clicking Complete:** navigate **back** to ID Verification (browser back or the step navigator).

- ☐ ⚠ The saved images reload and render. They are fetched as freshly signed URLs, and *that* is the logged event — not the original capture

**Review & Submit:** **Complete**.

## D7 ✓ ⚠ Viewing an ID image is logged

```sql
SELECT action, resource_type, resource_id, transaction_id, detail
  FROM ttr.access_log WHERE action = 'view' ORDER BY occurred_at DESC;
```

☐ One row per image (front and back) · ☐ `resource_type` = `stored_images` · ☐ `detail` holds the object path · ☐ `transaction_id` populated

## D8 ▶ Same document re-captured

**Start Transaction:** scenario `Buy bullion from customer`; transactionRef `DEV-002`.

**Customer Search:** Individual — firstName `Regina`; lastName `Testworth`; dateOfBirth `1983-05-12` — select the **existing** record.

**Transaction Details:** Cash currency `AUD`; cashAmount `11000`.

**Party Details:** confirm everything carried over unchanged.

**Conducting Person:** hasConductingPerson **No**.

**ID Verification** — the step under test:

1. ☐ Reliance auto-selects on her licence; `Driver licence` / `RGN-111222` / `VicRoads` pre-filled; "Reason for reliance" reads `Prior ID reviewed and still valid`; prior card shows the D6 capture with its images and the image-match checkbox; no camera section
2. ☐ ⚠ Switch to `Sighted original document` — document type, number **and issuer** all clear to empty
3. ☐ Reason field appears **immediately**, number still empty. Options exactly `Customer presented a different document`, `ID has changed (e.g. renewed licence)` — **no `Other`** *(§3 permits two grounds only)*
4. Select documentType `Driver licence`, enter documentNumber `RGN-111222`, tab out
5. ☐ Options become exactly `ID has changed (e.g. renewed licence)`, `Stored copy is unclear`, `Different person who shares this document number`; helper text **names Regina Mae Testworth and her DOB**; still **no `Other`**
6. Select `Stored copy is unclear`
7. ☐ Issuer auto-fills `VicRoads`; **expiry arrives pre-filled `Yes` / `2030-05-12`** — do not retype it, the point is that it is already correct
8. Capture front **and back**

**Recipient & Delivery:** recipientIsParty **Yes**; recipient `Regina Mae Testworth`; purpose `Dropping off bullion`; delivery method `Collected`.

**Bullion Details** — Item 1: metalType `Silver`; productType `Bar`; purity `999`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `11000`; description `1kg silver bar`.

**Review & Submit:** **Complete**.

## D9 ✓ ⚠ The old copy is superseded, its record retained

```sql
SELECT t.transaction_ref, si.superseded_at IS NOT NULL AS superseded,
       si.content_hash_sha256 IS NOT NULL AS hash_retained
  FROM ttr.stored_images si JOIN ttr.transactions t ON t.id = si.transaction_id
 WHERE t.transaction_ref IN ('DEV-001','DEV-002') ORDER BY si.captured_at;
-- DEV-001 rows: superseded true,  hash_retained true    (row kept, object deleted)
-- DEV-002 rows: superseded false, hash_retained true

SELECT t.transaction_ref, idv.new_capture_reason, idv.expiry_date
  FROM ttr.id_verifications idv JOIN ttr.transactions t ON t.id = idv.transaction_id
 WHERE upper(btrim(idv.document_number)) = 'RGN-111222' ORDER BY idv.created_at;
-- DEV-001 | NULL                | 2030-05-12
-- DEV-002 | stored_copy_unclear | 2030-05-12
```

☐ SQL as above · ☐ **DEV-001's two objects are gone from the bucket while its rows remain** — that pairing is the entire design: the image is gone so §3 is true, the hash survives so the seven-year record holds

## D10 ▶ ⚠ A different person cannot be linked

**Start Transaction:** scenario `Buy bullion from customer`; transactionRef `DEV-003`.

**Customer Search → Create new customer** (Individual): firstName `Barry`; lastName `Doubleton`; dateOfBirth `1979-09-30`; phone `0400456456`; email `barry.doubleton@example.test`.

**Transaction Details:** Cash currency `AUD`; cashAmount `10500`.

**Party Details:** fullName `Barry Doubleton`; dateOfBirth `1979-09-30`; resStreet `27 Repeat St`; resSuburb `Thornbury`; resState `VIC`; resPostcode `3071`; phone `0400456456`; occupation `Mechanic`; gender `M`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`.

**Conducting Person:** hasConductingPerson **No**.

**ID Verification:** documentType `Driver licence`; documentNumber `RGN-111222` — Regina's number; tab out.

1. ☐ ⚠ **Exactly ONE option: `Different person who shares this document number`.** `ID has changed` and `Stored copy is unclear` must both be **absent**
2. ☐ Helper text names **Regina** and says the record belongs to a different person — without that, `different_person` is a guess rather than the factual assertion it records
3. Select it; issuer `VicRoads`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2029-09-30`; capture front **and back**; Continue
4. ☐ It saves, **unlinked**. Licence numbers are unique per state, not nationally, so this is a real situation that must have a recorded exit

**Leave this draft in place.** D34 needs Barry's images live — he is the case that proves the sweep spares an innocent customer.

```sql
SELECT p.last_name, idv.new_capture_reason, idv.prior_verification_id IS NOT NULL AS linked
  FROM ttr.id_verifications idv JOIN ttr.parties p ON p.id = idv.party_id
 WHERE upper(btrim(idv.document_number)) = 'RGN-111222' ORDER BY idv.created_at;
-- Doubleton → different_person | linked = false.  Any linked Doubleton row is a failure.
```

☐ Barry's row is `different_person` and unlinked

## D11 ✓ ⚠ The database enforces it too

The UI can no longer produce a cross-person link, so if only the UI were fixed every case above would still pass. Prove the invariant is enforced independently:

```sql
UPDATE ttr.id_verifications
   SET new_capture_reason    = 'id_changed',
       prior_verification_id = (SELECT idv.id FROM ttr.id_verifications idv
                                  JOIN ttr.transactions t ON t.id = idv.transaction_id
                                 WHERE t.transaction_ref = 'DEV-002' LIMIT 1)
 WHERE id = (SELECT idv.id FROM ttr.id_verifications idv
               JOIN ttr.parties p ON p.id = idv.party_id
              WHERE p.last_name ILIKE 'Doubleton' LIMIT 1);
```

☐ **Must raise** `re-capture links to a record for a different person (date of birth … vs …)`. Success here means the invariant is unenforced and only the UI was fixed

## D12 ▶ Renewed licence, unchanged number

**Start Transaction:** scenario `Sell bullion to customer`; transactionRef `DEV-004`.

**Customer Search:** select the existing **Regina Mae Testworth**.

**Transaction Details:** Cash currency `AUD`; cashAmount `13000`.

**Party Details:** confirm carried over. **Conducting Person:** **No**.

**ID Verification:** switch off reliance; documentType `Driver licence`; documentNumber `RGN-111222`; tab out; select `ID has changed (e.g. renewed licence)`.

1. ☐ ⚠ **Expiry arrives BLANK**, not pre-filled with `2030-05-12`. A renewal moves the expiry, so inheriting the old date would be wrong — this is what makes the expiry fix reason-aware rather than a blanket copy
2. Set hasExpiry `Yes`; expiryDate **`2035-05-12`**; issuer `VicRoads`; capture front **and back**

**Recipient & Delivery:** recipientIsParty **Yes**; purpose `Collecting bullion`; delivery `Collected`.

**Bullion Details** — Item 1: `Gold` / `Bar` / `999.9` / qty `1` / `1` kg / unitPrice `13000`; description `1kg gold bar`.

**Review & Submit:** **Complete**.

☐ It saves as a **link** — an unlinked row could not, because the number is unchanged
☐ DEV-002's images are now superseded in turn, leaving DEV-004's as the only live pair

## D13 ▶ A different document

**Start Transaction:** scenario `Sell bullion to customer`; transactionRef `DEV-005`.

**Customer Search:** existing **Regina Mae Testworth**. **Transaction Details:** `AUD` / `12000`. **Conducting Person:** **No**.

**ID Verification:** switch off reliance; documentType `Passport`; documentNumber `PRG-998877`; issuer `Australian Passport Office`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2033-05-12`; tab out of the number.

1. ☐ **No collision** — that number has never been seen — but the reason field still appears, because she has a reusable record
2. ☐ Options exactly `Customer presented a different document`, `ID has changed (e.g. renewed licence)`. `Stored copy is unclear` is **absent** (nothing to link to) and so is **`Other`**
3. Select `Customer presented a different document`; capture **front only** (passports need no back)

**Recipient & Delivery:** recipientIsParty **Yes**; purpose `Collecting bullion`; delivery `Collected`.
**Bullion Details** — Item 1: `Gold` / `Bar` / `999.9` / qty `1` / `1` kg / `12000`.
**Review & Submit:** **Complete**.

☐ Regina now holds **two documents, one live copy each** — the rule is one copy per *document*, not one document per person

## D14 ▶ The re-verification window has lapsed

```sql
-- -1, not 0: every record here was created today, so daysSince = 0 and 0 > 0 is false
UPDATE public.reporting_entities SET idv_max_reliance_days = -1;
```

**Start Transaction:** scenario `Sell bullion to customer`; transactionRef `DEV-006`.
**Customer Search:** existing **Regina**. **Transaction Details:** `AUD` / `16000`. **Conducting Person:** **No**.

**ID Verification:**

1. ☐ **No** auto-selected reliance; her prior records show a `✕ Blocked` badge
2. Select `Relied on prior identification`, pick her **licence** from the picker
3. ☐ "Reason for reliance" offers **exactly two**: `Original document re-sighted today`, `Manager approved reliance` — nothing else
4. ☐ Notice states the window has lapsed and that **no second copy is taken**
5. Choose `Original document re-sighted today`; tick the image-match confirmation

**Recipient & Delivery:** recipientIsParty **Yes**; purpose `Collecting bullion`; delivery `Collected`.
**Bullion Details** — Item 1: `Gold` / `Bar` / `999.9` / qty `1` / `1` kg / `16000`.
**Review & Submit:** **Complete**.

☐ **No new image is stored** — the row has no `front_image_id`. A lapsed window calls for re-*sighting*, not re-photographing, which is what keeps §3 accurate as written

```sql
UPDATE public.reporting_entities SET idv_max_reliance_days = 730;   -- restore before D15
```

☐ Restored to 730

## D15 ▶ The ordinary reliance path is untouched

**Start Transaction:** scenario `Sell bullion to customer`; transactionRef `DEV-007`.
**Customer Search:** existing **Regina**. **Transaction Details:** `AUD` / `10000`. **Conducting Person:** **No**.

**Before starting, confirm the picker will offer a capture and not a reliance row.** D14 completed a reliance transaction for `RGN-111222`, and until finding #18 was fixed that row shadowed the real capture — hiding its image *and* silently skipping the match confirmation. This query replicates what the lookup returns (it cannot be called directly from the SQL editor, being `SECURITY DEFINER` keyed on the caller's entity):

```sql
SELECT DISTINCT ON (idv.document_type, idv.document_number)
       t.transaction_ref, idv.verification_basis, idv.document_number,
       idv.front_image_id IS NOT NULL AS has_front
  FROM ttr.id_verifications idv
  JOIN ttr.parties p      ON p.id = idv.party_id
  JOIN ttr.transactions t ON t.id = p.transaction_id
 WHERE t.status = 'complete' AND p.party_type = 'individual'
   AND idv.verification_basis = 'new_capture'      -- the fix; drop this line to see the bug
   AND lower(p.last_name) = 'testworth' AND lower(p.first_name) = 'regina'
   AND p.date_of_birth = '1983-05-12'
 ORDER BY idv.document_type, idv.document_number, idv.created_at DESC;
```

☐ Licence row is **`DEV-004 / new_capture / has_front = true`** — not `DEV-006`. Removing the `verification_basis` line should return `DEV-006 / relied_on_prior_identification / has_front = false`, which is the bug and a useful way to confirm the filter is what's doing the work

**ID Verification — change nothing:**

1. ☐ Reliance auto-selects; reason reads `Prior ID reviewed and still valid`
2. ☐ **No** "Reason for taking a new copy" field; no camera section
3. ☐ ⚠ **The prior record's images render** — DEV-004's surviving pair, not a broken thumbnail pointing at a deleted object. This is where §3's deletions are most likely to break something adjacent
4. ☐ ⚠ **The "I confirm the person presenting today matches these ID images" checkbox is present and Continue is blocked until it is ticked.** If it is absent, the picker has offered an image-less row and §3's confirmation requirement is being bypassed — that is finding #18 and it must not recur
5. Tick the confirmation

**Recipient & Delivery:** recipientIsParty **Yes**; purpose `Collecting bullion`; delivery `Collected`.
**Bullion Details** — Item 1: `Gold` / `Bar` / `999.9` / qty `1` / `1` kg / `10000`.
**Review & Submit:** **Complete**.

## D16 ▶ ⚠ Conducting person — DOB validation

**Start Transaction:** scenario `Sell bullion to customer`; transactionRef `DEV-008`.

**Customer Search → Create new customer** (Company): entityName `Wilma Wholesale Pty Ltd`; abnAcn `55667788990`; suburb `Carlton`; companyPhone `0392223333`; companyEmail `accounts@wilmawholesale.example.test`.

**Transaction Details:** Cash currency `AUD`; cashAmount `15000`.

**Party Details:** entityName `Wilma Wholesale Pty Ltd`; companyTradingName blank; legalForm `Company`; bizStreet `9 Trade Pl`; bizSuburb `Carlton`; bizState `VIC`; bizPostcode `3053`; postal-different unchecked; companyPhone `0392223333`; registration identifier type `ABN`, value `55667788990`; principalActivity `Metal wholesaling`.

**Conducting Person:** hasConductingPerson **Yes**; representedPartyId `Wilma Wholesale Pty Ltd`; fullName `Colin Broker`; aliases none; dobKnown **Yes**; **leave dateOfBirth blank**; resStreet `5 Agent Ave`; resSuburb `Carlton`; resState `VIC`; resPostcode `3053`; postal-different unchecked; phone `0400789789`; occupation `Broker`; relationship `Agent`; authorityToAct `Authorised to transact on behalf of Wilma Wholesale Pty Ltd.`; isEmployee **No**; actingViaEntity **No**. Click Continue.

1. ☐ ⚠ **An inline field error appears on Date of birth**, the page **stays put**, and **nothing uncaught appears in the browser console**. This used to fail silently with a raw `23514` and nothing on screen
2. Enter dateOfBirth `1986-02-14`, Continue — succeeds
3. ☐ Navigate **back** to this page: "Is date of birth known?" still reads **Yes** and the date is still `1986-02-14`

**ID Verification** — **Colin only** (company parties get no ID record of their own): verificationMethod `Sighted original document`; documentType `Passport`; documentNumber `CLB-334455`; issuer `Australian Passport Office`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2031-02-14`; capture **front**.

**Recipient & Delivery:** recipientIsParty **Yes**; recipient `Wilma Wholesale Pty Ltd`; purpose `Collecting bullion`; delivery `Collected`.
**Bullion Details** — Item 1: metalType `Platinum`; productType `Bar`; purity `999.5`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `15000`; description `1kg platinum bar`.
**Review & Submit:** **Complete**.

## D17 ▶ The same conducting person again

**Start Transaction:** scenario `Sell bullion to customer`; transactionRef `DEV-009`.
**Customer Search:** search Company — entityName `Wilma Wholesale Pty Ltd`, ABN `55667788990`, suburb `Carlton` — select the **existing** record.
**Transaction Details:** `AUD` / `15000`. **Party Details:** confirm carried over.
**Conducting Person:** identical to D16, including dateOfBirth `1986-02-14`.

**ID Verification** (Colin):

1. ☐ **No** auto-selected reliance — conducting persons have no name-based prior lookup, so the document collision is their only route to reuse
2. ☐ Also note: `Relied on prior identification` is **absent** from the method dropdown at first
3. Select `Sighted original document`; documentType `Passport`; documentNumber `CLB-334455`; tab out
4. ☐ The collision prompt appears naming the record on file, and `Relied on prior identification` **becomes** available in the method dropdown
5. Select `Stored copy is unclear`; capture front

**Recipient & Delivery / Bullion Details:** as D16. **Complete.**

```sql
SELECT idv.verification_basis, idv.new_capture_reason,
       idv.prior_verification_id IS NOT NULL AS linked,
       idv.party_id IS NULL AS is_conducting_person
  FROM ttr.id_verifications idv
 WHERE idv.document_number = 'CLB-334455' ORDER BY idv.created_at;
-- row 2: new_capture | stored_copy_unclear | true | true
```

☐ SQL as above — `is_conducting_person` true on both rows proves the rule is role-agnostic

---

# Part 2 — Recovery and robustness

## D18 ▶ Entry order does not matter

**Start Transaction:** scenario `Sell bullion to customer`; transactionRef `DEV-010`. **Customer Search:** existing **Regina**. **Transaction Details:** `AUD` / `11000`. **Conducting Person:** **No**.

**ID Verification:** switch off reliance, then **enter the document number first** — `RGN-111222` — tab out, and only *then* choose documentType `Driver licence`.

- ☐ The collision is found anyway: the reason list narrows to three and the helper text names Regina. Entering the number first used to find nothing silently, which is how an unsaveable row got created

**Do not complete.** Leave this draft for D19.

## D19 ▶ ⚠ A failed save can be retried

The highest-operational-risk case in the build — the difference between a staff member recovering at the counter and being stuck with a customer in front of them.

Continue in `DEV-010`. Select `ID has changed (e.g. renewed licence)`; hasExpiry `Yes`; expiryDate `2036-05-12`; capture front **and back** so Continue is ready.

1. DevTools → Network → **Offline**
2. Click **Continue**
   - ☐ An on-screen error appears — not a blank freeze
3. Back to **Online**
4. Click **Continue** again
   - ☐ ⚠ **It succeeds and moves to Recipient & Delivery.** No *"An image for this person/side already exists"*, and no second upload of the same photo

```sql
SELECT count(*) AS image_rows FROM ttr.stored_images
 WHERE transaction_id = (SELECT id FROM ttr.transactions WHERE transaction_ref = 'DEV-010');
-- 2 for a licence (front + back). More means the retry re-uploaded.
```

☐ Exactly 2. Then finish the transaction — **Recipient & Delivery:** recipientIsParty **Yes**; purpose `Collecting bullion`; delivery `Collected`. **Bullion Details:** `Gold` / `Bar` / `999.9` / qty `1` / `1` kg / `11000`. **Complete.**

## D20 ▶ Cancel works on a draft holding ID photos

**Start Transaction:** scenario `Sell bullion to customer`; transactionRef `DEV-011`. **Customer Search:** existing **Regina**. **Transaction Details:** `AUD` / `10500`. **Conducting Person:** **No**.

**ID Verification:** switch off reliance; documentType `Driver licence`; documentNumber `RGN-111222`; select `Stored copy is unclear`; capture front **and back**; Continue.

Then **exit the wizard and confirm Cancel**.

- ☐ Succeeds with no error and lands on `/start`

```sql
SELECT (SELECT count(*) FROM ttr.transactions     WHERE transaction_ref = 'DEV-011') AS txn,
       (SELECT count(*) FROM ttr.stored_images    si JOIN ttr.transactions t ON t.id = si.transaction_id
         WHERE t.transaction_ref = 'DEV-011')                                        AS images;
```

☐ Both `0` · ☐ The transaction's folder is gone from `compliance-media`. *"Failed to delete transaction record"* means the FK-ordered delete regressed

## D21 ▶ A completed reference cannot be reused

1. ☐ `/start`, enter transactionRef `DEV-001`, tab out → *"This reference belongs to a completed transaction and cannot be reused. Enter a different reference."* and **no** "Existing draft found" notice
2. ☐ Pick a scenario, click **Start transaction** → does **not** navigate to Add Customers; the message stays on the field
3. ☐ Edit to `DEV-001X` → the message clears and the transaction starts normally. **Cancel out of it**
4. ☐ Enter `DEV-003` (Barry's live draft) → *"Existing draft found — fields pre-filled."* and it resumes. **Exit without cancelling** — D34 still needs that draft

---

# Part 3 — Report generation and access logging

## D22 ✓ Generate the batch

```
POST https://<project>.supabase.co/functions/v1/generate-austrac-report
Authorization: Bearer <sb_secret_...>      # the new-style secret key, NOT the legacy service_role JWT
apikey:        <same key>
Content-Type:  application/json

{"reportDate": "<today, AEST, YYYY-MM-DD>"}
```

☐ A batch is produced · ☐ `reportCount` matches the number of `<ttr>` elements · Batch id: ________ · Token: ________

## D23 ✓ ⚠ The XML does not reach the browser on page load

DevTools → Network, then load `/review-batch/<batchId>` fresh and inspect the `report_batches` request.

☐ **No `xml_content` field.** It should appear only in the `approve-batch` response, and only after Download. Before this it shipped every name, address and document number in the batch on every page view

## D24 ✓ Exporting is logged, and logging did not become access control

1. Open `/review-batch/<batchId>?token=<token>`, click **Download XML**
   - ☐ File downloads as `ttr-fbs-<date>.xml`
   ```sql
   SELECT action, resource_type, detail FROM ttr.access_log
    WHERE action = 'export' ORDER BY occurred_at DESC LIMIT 1;
   -- 'export' / 'report_batches' / 'ttr-fbs-<date>.xml'
   ```
   - ☐ SQL as above
2. Open `/review-batch/<batchId>` with **no** `?token=` at all
   - ☐ Amber view-only warning; Approve / Reject / Regenerate all disabled
   - ☐ **Download XML still works and still writes an `export` row.** Logging was meant to be additive, not a new access control
3. ☐ ⚠ Both of these must raise *"Audit log is append-only"*:
   ```sql
   UPDATE ttr.access_log SET action = 'view' WHERE id = (SELECT id FROM ttr.access_log LIMIT 1);
   DELETE FROM ttr.access_log WHERE id = (SELECT id FROM ttr.access_log LIMIT 1);
   ```
4. ☐ Signed in as the **non-admin** account, `SELECT * FROM ttr.access_log;` returns **0 rows** — even though that staff member's own views are recorded in it

---

# Part 4 — AUSTRAC schema coverage

**Nothing else covers this.** Part 1 exercised one individual, one company, one conducting person and AUD cash. These nine transactions are the only coverage of foreign currency, trusts, sole traders, ACNs, aliases, separate postal addresses, two customers, deleted line items, precious metals and the impersonal channel.

Three consolidations versus the original A–J matrix, because from a clean database you can run the corrected versions directly: **B2 replaces B** (B was completed without its conducting person, which was its entire point); **D answers the express-trust question**, so D and J collapse into one; and **C already covers I**, since it specifies `isEmployee = Yes` with a role.

## D25 ▶ TX-A — baseline

**Start Transaction:** `Sell bullion to customer`; transactionRef `UAT-A-0001`.
**Create new customer** (Individual): firstName `Jane`; middleName `Alice`; lastName `Citizen`; dateOfBirth `1985-06-15`; phone `0400111222`; email `jane.citizen@example.test`.
**Transaction Details:** Cash currency `AUD`; cashAmount `15000`; audValue auto-fills `15000`.
**Party Details:** fullName `Jane Alice Citizen`; aliases none; businessTradingName blank; dateOfBirth `1985-06-15`; resStreet `12 Test St`; resSuburb `Coburg`; resState `VIC`; resPostcode `3058`; postal-different unchecked; phone `0400111222`; occupation `Jeweller`; abn blank; gender `F`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`.
**Conducting Person:** hasConductingPerson **No**.
**ID Verification:** `Sighted original document`; documentType `Passport`; documentNumber `PA1234567`; issuer `Australian Passport Office`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2031-06-15`; capture **front** only.
**Recipient & Delivery:** recipientIsParty **Yes**; recipient `Jane Alice Citizen`; purpose `Collecting bullion`; delivery `Collected`; notes blank.
**Bullion Details** — Item 1: `Gold` / `Bar` / purity `999.9` / qty `1` / weight `1` `kilograms` / unitPrice `15000`; description `1kg PAMP minted bar`.
**Complete.**

☐ Proves `BULSER`, `<ausCash>`, `<sameAsCustomer>` self, `<buo>`, IdType `P`, `<lppFlag>N</lppFlag>`

## D26 ▶ TX-B2 — foreign currency, agent, deleted item

**Start Transaction:** `Buy bullion from customer`; transactionRef `UAT-B2-0002B`.
**Create new customer** (Individual): firstName `David`; middleName `Paul`; lastName `Sampleton`; dateOfBirth `1978-11-02`; phone `0400555666`; email `david.sampleton@example.test`.
**Transaction Details:** Cash currency **Other**; foreignCurrencyType `USD`; foreignCurrencyAmount `8000`; fxRate `1.52`; rateSource `Internal POS rate`; audValue auto-fills `12160`.
**Party Details:** fullName `David Paul Sampleton`; dateOfBirth `1978-11-02`; resStreet `9 Demo Rd`; resSuburb `Brunswick`; resState `VIC`; resPostcode `3056`; postal-different unchecked; phone `0400555666`; occupation `Accountant`; gender `M`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`.
**Conducting Person:** hasConductingPerson **Yes**; representedPartyId `David Paul Sampleton`; fullName `Priya Agent`; aliases none; dobKnown `Yes`; dateOfBirth `1982-04-10`; resStreet `3 Broker Ln`; resSuburb `Fitzroy`; resState `VIC`; resPostcode `3065`; postal-different unchecked; phone `0400777888`; occupation `Financial adviser`; relationship `Agent`; authorityToAct `Power of attorney dated 2026-06-01 authorising Priya Agent to act on David Sampleton's behalf for this transaction.`; isEmployee **No**; actingViaEntity **No**.
**ID Verification:**
- David Paul Sampleton: `Sighted original document`; `Driver licence`; `DL987654321`; issuer `VicRoads`; `AU`; hasExpiry `Yes`; expiryDate `2028-03-01`; capture front **and back**
- Priya Agent: `Sighted original document`; `Passport`; `PA7654321`; issuer `Australian Passport Office`; `AU`; hasExpiry `Yes`; expiryDate `2029-09-09`; capture front

**Recipient & Delivery:** recipientIsParty **No**; recipient full name `Recipient B Test`; dobKnown `Yes`; dob `1980-05-05`; address `33 Handover St, Fitzroy, VIC, 3065, Australia`; purpose `Collecting bullion`; delivery `Courier`; deliveryAddressDifferent **No**; notes `Courier arranged by recipient's agent.`
**Bullion Details:**
- Item 1: `Gold` / `Bar` / `999.9` / qty `1` / `1` kg / `9000`; description `1kg gold bar ex-customer`
- Item 2: `Silver` / `Coin` / `999` / qty `1` / `1` kg / `3000`; description `1kg silver coin lot`
- Item 3 (temporary): `Platinum` / `Wafer` / `999.5` / qty `1` / `1` kg / `5000`. **Click Remove on Item 3 before Continue**

**Complete.**

☐ Final aggregate is Gold + Silver only ($12,000) · ☐ Proves `bui`, `<foreignCash>` with `<exchangeRate>`, `otherPerson`/`individualDetails`, `isRepresentingOrganisation=N`, non-empty `<agencyAuthorisation>`, IdType `D`, deleted item excluded

## D27 ▶ TX-C — company customer, employee conducting person

**Start Transaction:** `Sell bullion to customer`; transactionRef `UAT-C-0003`.
**Create new customer** (Company): entityName `Golden Bullion Traders Pty Ltd`; abnAcn `12345678901`; suburb `Dandenong`; companyPhone `0398765432`; companyEmail `accounts@goldenbullion.example.test`.
**Transaction Details:** Cash currency `AUD`; cashAmount `12000`.
**Party Details:** entityName `Golden Bullion Traders Pty Ltd`; companyTradingName blank; legalForm `Company`; bizStreet `100 Industry Rd`; bizSuburb `Dandenong`; bizState `VIC`; bizPostcode `3175`; postal-different unchecked; companyPhone `0398765432`; registration identifier type `ABN`, value `12345678901`; principalActivity `Bullion dealing`.
**Conducting Person:** hasConductingPerson **Yes**; representedPartyId `Golden Bullion Traders Pty Ltd`; fullName `Tom Employee`; dobKnown `Yes`; dateOfBirth `1995-09-09`; resStreet `8 Staff St`; resSuburb `Dandenong`; resState `VIC`; resPostcode `3175`; phone `0400999000`; occupation `Branch teller`; relationship `Employee`; authorityToAct `Employed staff member authorised to transact on behalf of Golden Bullion Traders Pty Ltd.`; isEmployee **Yes**; employeeRole `Store manager`; actingViaEntity **No**.
**ID Verification** (Tom Employee only): `Sighted original document`; documentType `Proof of age card`; documentNumber `POA-11223`; issuer `Service Victoria`; `AU`; hasExpiry `Yes`; expiryDate `2027-12-01`; capture front.
**Recipient & Delivery:** recipientIsParty **Yes**; recipient `Golden Bullion Traders Pty Ltd`; purpose `Collecting bullion`; delivery `Collected`; notes `Collected by store manager.`
**Bullion Details** — Item 1: `Platinum` / `Bar` / `999.5` / qty `1` / `1` kg / `12000`; description `1kg platinum bar`.
**Complete.**

☐ Proves `<customerEmployee refId>`, `businessStructure` `C`, and the employee role folded into `<agencyAuthorisation>` — verify at D33 that it reads `"…Golden Bullion Traders Pty Ltd. - Employee role: Store manager"` with a **plain ASCII hyphen**, not an em-dash

## D28 ▶ TX-D — trust, express trust, impersonal channel

**Start Transaction:** `Buy bullion from customer`; transactionRef `UAT-D-0004`.
**Create new customer** (Company): entityName `Southern Cross Metals Trust`; abnAcn `98765432109`; suburb `Box Hill`; companyPhone `0387654321`; companyEmail `admin@socrossmetals.example.test`.
**Transaction Details:** Cash currency `AUD`; cashAmount `20000`.
**Party Details:** entityName `Southern Cross Metals Trust`; legalForm `Trust`; bizStreet `22 Commerce St`; bizSuburb `Box Hill`; bizState `VIC`; bizPostcode `3128`; companyPhone `0387654321`; registration identifier type `ABN`, value `98765432109`; principalActivity `Precious metal trading`.
- ☐ Selecting `Trust` reveals **"Is this an express trust?"** — select **Yes**; Trust type `Discretionary trust`; Trust name `Southern Cross Family Trust`

**Conducting Person:** hasConductingPerson **No**; conductorIdentifiable **No — impersonal channel** (this question appears only because the customer is a company); methodOfConductingTxn `Night safe or express deposit`.
**ID Verification:** none — no individual to verify.
**Recipient & Delivery:** recipientIsParty **Yes**; recipient `Southern Cross Metals Trust`; purpose `Dropping off bullion`; delivery `Collected`; notes blank.
**Bullion Details** — Item 1: `Gold` / `Coin` / `999.9` / qty `1` / `1` kg / `20000`; description `1kg gold coin lot, night-safe deposit`.
**Complete.**

☐ Proves `<methodOfConductingTxn id><method>N</method>` in place of `<otherPerson>`, `businessStructure` `T`, and `<isExpressTrust>Y` followed by `<trustDetails>`

## D29 ▶ TX-E — alias, postal address, alloy

**Start Transaction:** `Sell precious metal to customer`; transactionRef `UAT-E-0005`.
**Create new customer** (Individual): firstName `Sarah`; middleName `Jane`; lastName `Austen`; dateOfBirth `1975-01-20`; phone `0400222333`; email `sarah.austen@example.test`.
**Transaction Details:** Cash currency `AUD`; cashAmount `10500`.
**Party Details:** fullName `Sarah Jane Austen`; **alias** — type `Sarah A. Austen-Smith` into the alias box and click **Add**; businessTradingName blank; dateOfBirth `1975-01-20`; resStreet `5 River St`; resSuburb `Northcote`; resState `VIC`; resPostcode `3070`; postal-different **checked** → postStreet `PO Box 100`; postSuburb `Northcote`; postState `VIC`; postPostcode `3070`; phone `0400222333`; occupation `Designer`; gender `F`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`.
**Conducting Person:** hasConductingPerson **No**.
**ID Verification:** verificationMethod `Electronic data source`; elecDataSrc `Electronic Verification Co`; documentType `Electronic verification source`; documentNumber `EVS-000123`; issuer `Electronic Verification Co`; idCountryCode `AU`; hasExpiry `No`; capture front (still required — only reliance mode skips images). **This record is reused in D30.**
**Recipient & Delivery:** recipientIsParty **Yes**; recipient `Sarah Jane Austen`; purpose `Collecting precious metal`; delivery `Collected`.
**Precious Metal Details** — Item 1: metalType `Alloy`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `10500`; description `70% gold / 30% copper alloy ring stock`; serialNumber `SN-ALLOY-001`.
**Complete.**

☐ Proves `<altName>`, `<postalAddress>`, `pmo`, metal `ALLOY` with description and serial number, and IdType `OVS` — verify at D33 that the OVS `<identification>` has **no `countryCode`**

## D30 ▶ TX-E3 — alias carryover and reliance

**Start Transaction:** `Sell precious metal to customer`; transactionRef `UAT-E3-0005C`.
**Customer Search:** Individual — firstName `Sarah`; lastName `Austen`; dateOfBirth `1975-01-20` — select the **existing** record.
- ☐ **The alias `Sarah A. Austen-Smith` is already listed**, without clicking Add again. This is the behaviour under test

**Transaction Details:** Cash currency `AUD`; cashAmount `10500`.
**Party Details:** ☐ confirm the alias is pre-filled and address / DOB / occupation all carried over.
**Conducting Person:** hasConductingPerson **No**.
**ID Verification:** verificationMethod **Relied on prior identification**, selecting `EVS-000123` from the picker; reason `Prior ID reviewed and still valid`; tick the image-match confirmation.
**Recipient & Delivery:** recipientIsParty **Yes**; recipient `Sarah Jane Austen`; purpose `Collecting precious metal`; delivery `Collected`.
**Precious Metal Details** — Item 1: metalType `Gold`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `10500`.
**Complete.**

☐ Proves the alias carries onto a new party snapshot, and that reliance retains the original document details

## D31 ▶ TX-F — sole trader, ACN, director representing an organisation

**Start Transaction:** `Buy precious metal from customer`; transactionRef `UAT-F-0006`.
**Create new customer** (Company): entityName `Perth Metal Co`; abnAcn `123456789`; suburb `Fremantle`; companyPhone `0894561234`; companyEmail `info@perthmetal.example.test`.
**Transaction Details:** Cash currency `AUD`; cashAmount `18000`.
**Party Details:** entityName `Perth Metal Co`; legalForm `Sole trader`; bizStreet `7 Harbour Rd`; bizSuburb `Fremantle`; bizState `WA`; bizPostcode `6160`; companyPhone `0894561234`; registration identifier type `ACN`, value `123456789`; principalActivity `Metal refining`.
**Conducting Person:** hasConductingPerson **Yes**; representedPartyId `Perth Metal Co`; fullName `Michael Director`; dobKnown `Yes`; dateOfBirth `1970-07-07`; resStreet `4 Harbour Rd`; resSuburb `Fremantle`; resState `WA`; resPostcode `6160`; phone `0400444555`; occupation `Company director`; relationship **`Director`** (not Employee — this is what triggers the full `isRepresentingOrganisation=Y` plus `representedOrganisation` block); authorityToAct `Sole director and company secretary, authorised under the company constitution to act for Perth Metal Co.`; isEmployee **No**; actingViaEntity **No**.
**ID Verification** (Michael Director): `Sighted original document`; documentType `Driver licence`; documentNumber `DL456789123`; issuer `Department of Transport WA`; `AU`; hasExpiry `Yes`; expiryDate `2027-05-05`; capture front **and back**.
**Recipient & Delivery:** recipientIsParty **Yes**; recipient `Perth Metal Co`; purpose `Dropping off precious metal`; delivery `Collected`.
**Precious Metal Details:**
- Item 1: metalType `Iridium`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `18000`; description blank; serialNumber blank
- Item 2 (temporary): metalType `Rhodium`; quantity `1`; weight `1`; `kilograms`; unitPrice `12000`. **Delete Item 2 before Continue**

**Complete.**

☐ Final `<pmi>` aggregate is Iridium only ($18,000) · ☐ Proves `businessStructureOther` (Sole trader has no valid code), the ACN path, and `isRepresentingOrganisation=Y` **with** a real `<representedOrganisation>` sibling block

## D32 ▶ TX-G — two customers, conducting-person refId

**Start Transaction:** `Sell bullion to customer`; transactionRef `UAT-G-0007`.
**Customer Search:** search Individual for `Jane` / `Citizen` / `1985-06-15` and select the **existing** record from D25. Then **Create new customer** (Individual) for a second party: firstName `Marcus`; middleName `James`; lastName `Tester`; dateOfBirth `1990-03-22`; phone `0400333444`; email `marcus.tester@example.test`. Continue with **both** parties selected.
**Transaction Details:** Cash currency `AUD`; cashAmount `11000`.
**Party Details:**
- Jane Alice Citizen: ☐ confirm existing details carried over (occupation `Jeweller`, gender `F`, `AU`/`AU`, `12 Test St, Coburg VIC 3058`)
- Marcus James Tester: fullName `Marcus James Tester`; dateOfBirth `1990-03-22`; resStreet `45 Sample Ave`; resSuburb `Richmond`; resState `VIC`; resPostcode `3121`; phone `0400333444`; occupation `Retailer`; gender `M`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`

**Conducting Person:** hasConductingPerson **No**; conductedByPartyId — **explicitly select Marcus James Tester**, the second party. Do not leave it defaulted to Jane; this is the case being tested.
**ID Verification:**
- Jane Alice Citizen: `Sighted original document`; `Passport`; `PA1234567`; issuer `Australian Passport Office`; `AU`; hasExpiry `Yes`; expiryDate `2031-06-15`; capture front
- Marcus James Tester: `Sighted original document`; `Medicare card`; `MC998877`; issuer `Services Australia`; `AU`; hasExpiry `No`; capture front

**Recipient & Delivery:** recipientIsParty **Yes**; recipient **Jane Alice Citizen** (deliberately independent of who conducted it); purpose `Collecting bullion`; delivery `Collected`.
**Bullion Details** — Item 1: `Silver` / `Bar` / `999` / qty `1` / `1` kg / `11000`; description `1kg silver bar`.
**Complete.**

☐ Proves `<sameAsCustomer refId>` resolves to customer **#2**, not `parties[0]`

## D33 ▶ TX-H — recipient with unknown DOB, delivery "Other"

**Start Transaction:** `Buy bullion from customer`; transactionRef `UAT-H-0008`.
**Create new customer** (Individual): firstName `Grace`; lastName `Harbour`; dateOfBirth `1988-08-08`; phone `0400666777`; email `grace.harbour@example.test`.
**Transaction Details:** Cash currency `AUD`; cashAmount `10200`.
**Party Details:** fullName `Grace Harbour`; dateOfBirth `1988-08-08`; resStreet `18 Bay St`; resSuburb `Geelong`; resState `VIC`; resPostcode `3220`; phone `0400666777`; occupation `Nurse`; gender `F`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`.
**Conducting Person:** hasConductingPerson **No**.
**ID Verification** (Grace Harbour): `Sighted original document`; documentType `National identity card`; documentNumber `NIC-334455`; issuer `Department of Home Affairs`; `AU`; hasExpiry `No`; capture front.
**Recipient & Delivery:** recipientIsParty **No**; recipient full name `Recipient Test Person`; dobKnown **No**; address `20 Delivery Way, Geelong, VIC, 3220, Australia`; purpose `Dropping off bullion`; delivery method **Other** → describe `Sent via registered post with signature on delivery`; deliveryAddressDifferent **No**; notes blank.
**Bullion Details** — Item 1: `Gold` / `Bar` / `999.9` / qty `1` / `1` kg / `10200`; description `1kg gold bar`.
**Complete.**

☐ Proves the recipient DOB-unknown path, the remaining `transfer_purpose` enum value, and delivery `Other` with free text

---

# Part 5 — Schema validation

## D34 ✓ Rebuild the batch to cover everything

**Use Regenerate, not a second generate call.** `ttr.report_batches` carries `UNIQUE (reporting_entity_id, report_date)`, so calling `generate-austrac-report` again for today would violate that constraint — there is one batch per entity per day by design. The **Regenerate** button on `/review-batch/<batchId>` deletes the not-yet-submitted batch and its `transaction_reports` links, then re-triggers generation for the same date server-side, so the rebuilt batch includes D6–D33 together.

☐ Regenerated · ☐ `reportCount` covers every transaction completed today · Batch id: ________

*(If you ran D25–D33 on a later calendar day than D22, they land in their own batch and no regenerate is needed — just generate for that date.)*

## D35 ✓ ⚠ Validate against the XSD, and prove the validation is real

```
python -c "import xmlschema; s=xmlschema.XMLSchema11('docs/schema/TTR-1-0.xsd'); \
  print(type(s).__name__, s.XSD_VERSION); print(len(list(s.iter_errors(r'<batch>.xml'))))"
```

☐ Prints `XMLSchema11 1.1` and **`0`**

**Then both negative controls.** "0 errors" and "the validator checked nothing" are indistinguishable without them — and `xmlschema.XMLSchema` is itself a 1.0 validator that ignores `xs:assert`, exactly like `xmllint` and .NET's `System.Xml.Schema`:

```
# Control 1 — strip the "ttr-" prefix from one id so it starts with a digit
d.replace('ttr-<first-uuid>', '<first-uuid>', 1)          # must be 1 error (NCName/xs:ID)

# Control 2 — make an organisation a Trust without isExpressTrust
d.replace('<businessStructure>C</businessStructure>',
          '<businessStructure>T</businessStructure>', 1)   # must be 1 error,
                                                          # reading "assertion test is false"
```

☐ Control 1 = 1 error · ☐ Control 2 = 1 error reading **"assertion test is false"** — that phrase is what proves `xs:assert` actually ran

## D36 ✓ Spot-check the generated elements

Read the XML and confirm each transaction's target construct:

☐ Every individual has **no `isAbnHolder` and no `abn`** (none is a sole trader)
☐ Every `<ttr id="...">` starts with `ttr-`, not a digit
☐ `UAT-C-0003` — `<agencyAuthorisation>` ends `". - Employee role: Store manager"` with a plain ASCII hyphen
☐ `UAT-D-0004` — `<isExpressTrust>Y</isExpressTrust>` immediately followed by `<trustDetails>` containing `<trustTypeOther>Discretionary trust</trustTypeOther><trustName>Southern Cross Family Trust</trustName>`, positioned before `<isIdentityVerified>`, and **no** `trustParticipant`/`trustBeneficiary`
☐ `UAT-E-0005` — the OVS `<identification>` has **no `countryCode`**
☐ `UAT-E3-0005C` — `<altName>Sarah A. Austen-Smith</altName>` present
☐ `UAT-F-0006` — `businessStructureOther`, and `<representedOrganisation>` present alongside `isRepresentingOrganisation=Y`
☐ `UAT-G-0007` — `<sameAsCustomer refId>` points at Marcus, not Jane
☐ `UAT-B2-0002B` — `<foreignCash>` with `<exchangeRate>`, and the `<bui>` aggregate is $12,000

---

# Part 6 — Reconciliation sweep

## D37 ✓ Create one of each drift class

**Must be manual.** The sweep's person-safety lives in `find_unsuperseded_duplicates`'s `PARTITION BY chain_root`, which is SQL and unreachable by unit tests. Given that grouping on document number instead once deleted an innocent customer's ID images, this is the case that matters most in the sheet.

1. **Un-superseded duplicate** — make a completed supersede look like one that never finished:
   ```sql
   UPDATE ttr.stored_images SET superseded_at = NULL, superseded_by_image_id = NULL
    WHERE id = '<one already-superseded image id for RGN-111222>';
   ```
2. **Orphaned object** — delete a `stored_images` row (and first the `id_verifications` row referencing it) leaving its object in the bucket
3. **Missing object** — delete an object from `compliance-media` leaving its row, `superseded_at` still null
4. **Dangling folder** — create a folder named for a UUID that is **not** in `ttr.transactions`, with one file in it
5. ☐ **Confirm Barry's `DEV-003` images are still live** — `superseded_at` null on both

☐ All five set up · Note the ids: ________

## D38 ✓ ⚠ Dry run

POST `{"apply": false, "full": true}` to `reconcile-stored-images`.

☐ `mode` is `"dry-run"`
☐ The report names exactly the four things from D37 — nothing more
☐ ⚠ **Barry's image ids appear nowhere in `unsupersededCopies`.** If they do, **stop** — applying would delete a customer's identification
☐ Every `deleted` and `superseded` count is **0**

## D39 ✓ Apply

POST `{"apply": true, "full": true}`.

☐ Class 1 and 4 objects gone from the bucket
☐ Class 3 object gone, its row stamped with `superseded_at` and `superseded_by_image_id`
☐ Class 2 **still reported and still untouched** — the row is the only remaining proof that document was sighted, and the image cannot be recreated
☐ Barry's images **untouched**, in both storage and metadata
☐ `SELECT count(*) FROM ttr.stored_images;` unchanged from before the run — the sweep never deletes rows

## D40 ✓ Stale drafts holding photos are cleaned

```sql
UPDATE ttr.transactions SET created_at = now() - interval '45 days'
 WHERE transaction_ref = 'DEV-003';        -- Barry's draft, which holds ID photos
```

Run `cleanup-stale-drafts`.

☐ Reports `deleted`, **not** `skipped`. Such drafts used to be skipped on every run forever, so their ID images accumulated with nothing accounting for them
☐ `DEV-003`, its `id_verifications`, its `stored_images` rows and its bucket folder are all gone

---

# Part 7 — Closing invariants

## D41 ✓ §3 holds

```sql
-- Grouped by chain root, NOT document number: two people can lawfully share a licence
-- number (that is what different_person records), so they count separately. Using the
-- document-number key here is the mistake that deletes an innocent customer's ID.
SELECT coalesce(idv.prior_verification_id, idv.id) AS chain_root,
       count(*) FILTER (WHERE si.superseded_at IS NULL) AS live_copies
  FROM ttr.id_verifications idv
  JOIN ttr.stored_images si ON si.id IN (idv.front_image_id, idv.back_image_id)
  JOIN ttr.transactions t   ON t.id = idv.transaction_id
 WHERE idv.verification_basis = 'new_capture'
   -- Completed transactions only. A DRAFT mid-capture legitimately holds a fresh copy of
   -- a document already on file — it has not superseded anything yet, because supersede
   -- runs on completion. Without this filter every in-progress re-capture reads as a §3
   -- breach. "One copy on file" is a claim about records, not about a photograph someone
   -- is halfway through taking.
   AND t.status = 'complete'
 GROUP BY 1
HAVING count(*) FILTER (WHERE si.superseded_at IS NULL) > 2;   -- >2 = more than front+back
```

☐ **No rows.** This is the machine-checkable form of *"we keep one copy of your identification on file"* — keep it and run it periodically

## D42 ✓ Environment left in a sane state

```sql
SELECT tgname, tgenabled = 'O' AS enabled FROM pg_trigger
 WHERE tgname IN ('trg_lock_completed','trg_access_log_append_only','trg_audit_append_only');

SELECT idv_max_reliance_days FROM public.reporting_entities;   -- 730
```

☐ All three triggers `true` · ☐ `idv_max_reliance_days` = 730

---

---

# Part 8 — Closing two cases the run exposed

Both fixes landed **during** the run, so neither has been observed working in the wizard.

## D43 ▶ Cancel, on a step that had no Exit button

**This is D20, re-run for real.** D20 could not be performed as written — Recipient / Delivery had no Exit control — and by the time one existed, `DEV-011` had already been collected by D40's cleanup instead. So the escape hatch has never been seen to work. It also exercises three fixes at once: the missing exit buttons, the `.schema("ttr")` qualification, and the FK-ordered child delete.

**Start Transaction:** scenario `Sell bullion to customer`; transactionRef `DEV-012`.
**Customer Search:** existing **Regina**. **Transaction Details:** `AUD` / `10500`. **Conducting Person:** **No**.
**ID Verification:** switch off reliance; documentType `Driver licence`; documentNumber `RGN-111222`; tab out; select `Stored copy is unclear`; capture front **and back**; **Continue**.

You are now on **Recipient / Delivery**.

1. ☐ ⚠ **An `Exit` button is present.** Until today this page had none, and neither did Bullion Details or Precious Metal Details
2. Click it → ☐ a confirmation dialog appears first. Exiting destroys captured ID images, so it must never be one click
3. Confirm → ☐ no error, lands on `/start`

```sql
SELECT (SELECT count(*) FROM ttr.transactions WHERE transaction_ref = 'DEV-012')          AS txn,
       (SELECT count(*) FROM ttr.stored_images si JOIN ttr.transactions t ON t.id = si.transaction_id
         WHERE t.transaction_ref = 'DEV-012')                                              AS images,
       (SELECT count(*) FROM ttr.id_verifications idv JOIN ttr.transactions t ON t.id = idv.transaction_id
         WHERE t.transaction_ref = 'DEV-012')                                              AS verifications;
```

☐ All three `0` · ☐ The transaction's folder gone from `compliance-media`

*"Transaction not found"* means the schema qualification regressed; *"Failed to delete transaction record"* means the child delete did.

## D44 ▶ A reason chosen before the collision

Closes finding #19. The reason field is on screen from the moment a method is chosen, so the choice and the collision can arrive in either order — and until today only one order produced a saveable row.

**Start Transaction:** scenario `Sell bullion to customer`; transactionRef `DEV-013`.
**Customer Search:** existing **Regina**. **Transaction Details:** `AUD` / `11500`. **Conducting Person:** **No**.

**ID Verification — deliberately out of order:**

1. Switch off reliance. The reason field appears with the no-collision options
2. **Select `ID has changed (e.g. renewed licence)` now**, before entering any document details
3. Set `Is there an expiry date?` = **Yes**, expiryDate **`2037-05-12`**
4. *Now* select documentType `Driver licence`, enter documentNumber `RGN-111222`, tab out
5. ☐ The reason stays selected as `ID has changed` — it is still valid against a collision
6. ☐ ⚠ **The expiry is still `2037-05-12`.** Establishing the link must not reset it; a renewal clears expiry by design, so re-running the whole reason handler here would silently wipe what you just typed
7. Capture front **and back**, then **Continue**

☐ ⚠ **It saves.** No *"That document number is already on file"* — that message means the row went in unlinked and finding #19 has regressed

```sql
SELECT t.transaction_ref, idv.new_capture_reason,
       idv.prior_verification_id IS NOT NULL AS linked, idv.expiry_date
  FROM ttr.id_verifications idv JOIN ttr.transactions t ON t.id = idv.transaction_id
 WHERE t.transaction_ref = 'DEV-013';
-- DEV-013 | id_changed | true | 2037-05-12
```

☐ `linked = true` — the assertion. An unlinked `id_changed` row on a number already on file cannot save at all
☐ `expiry_date = 2037-05-12` — not null, and not inherited from the record on file

Complete it with recipient is party / `Collecting bullion` / `Collected`, Gold Bar `999.9` / 1 kg / `11500`.

---

## Run record — 2026-07-27

**All 44 cases passed.** Seven defects found and fixed during the run; none was catchable by the automated suites, which stayed green at 312 Vitest / 102 Deno throughout.

| # | Found at | Defect |
|---|---|---|
| 18 | D15 | Reliance rows shadowed real captures in the prior-verification lookup — hid the image, **skipped the match confirmation**, and silently reset the re-verification window so it would never expire for returning customers |
| 19 | D19 | A capture reason chosen before the collision was discovered never linked, so the row could not save |
| 20 | D38 | The reconciliation sweep would have deleted a **completed** record's live ID images in favour of a **draft's** — data loss on a filed record, caught only because the sweep is dry-run by default |
| 21 | D40 | `cleanup-stale-drafts` called its helper on the wrong schema and returned 500 on its first statement — **the nightly cleanup had never run, once** |
| 22 | D40 | The same schema mistake ×3 more, including both calls in `delete-draft-transaction` — **Cancel had never deleted anything**, which had masked finding #13 entirely |
| — | D20 | Three wizard steps (Recipient / Delivery, Bullion Details, Precious Metal Details) had **no Exit button at all**, leaving no way to abandon a transaction after ID Verification |
| — | D9 | The §3 invariant in these documents counted drafts, and would have reported a false breach on every in-progress re-capture |

**Three of these — #20, #21, #22 — were visible only because a function was invoked by hand rather than trusted to work.** A scheduled function that has never been run manually has never been tested, and its failure mode is silence.

**Two regression tests initially passed against the bug they were written for** (finding #15's supersede fakes ignored `.in()` filters; finding #19's first test asserted on helper text that appears with or without a link). Both were corrected and verified to fail against the unfixed code. A regression test that has never been seen to fail for the right reason is not evidence.

## Sign-off

| Part | Steps | Result | By | Date |
|---|---|---|---|---|
| 0 — reset and deploy | D1–D5 | | | |
| 1 — one copy of ID | D6–D17 | | | |
| 2 — recovery and robustness | D18–D21 | | | |
| 3 — reports and access logging | D22–D24 | | | |
| 4 — AUSTRAC coverage | D25–D33 | | | |
| 5 — schema validation | D34–D36 | | | |
| 6 — reconciliation sweep | D37–D40 | | | |
| 7 — closing invariants | D41–D42 | | | |
| 8 — cases the run exposed | D43–D44 | | | |
| **Behaviour validated; cleared to build production** | | | | |

Record any failure with its step number, the exact error, and whether it was a UI message or a raw Postgres error. **A raw `23505`, `23514` or `duplicate key value violates unique constraint` reaching the screen is itself a finding** — ID Verification, Transaction Details and Conducting Person all have error translation that should have caught it first.
