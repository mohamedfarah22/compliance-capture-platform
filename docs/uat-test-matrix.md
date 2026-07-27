# Manual UAT test matrix: end-to-end transactions for AUSTRAC TTR validation

> **Which document do you want?**
>
> | Task | Use |
> |---|---|
> | Validating a build before production | [dev-test-sheet.md](dev-test-sheet.md) — run once from an empty dev database; proves the **behaviour** is correct |
> | Launching a production environment | [go-live.md](go-live.md) — proves the **environment** is configured and deployed; assumes the dev sheet passed |
> | Understanding *why* a case exists, or diagnosing a failure | **this file** |
>
> This is the deep reference. It records every case, every finding and the reasoning behind each fix — which is what you want when something breaks, not when deciding whether to ship. The two sheets above cite case numbers from here, so a failure in either leads back to the detail.

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

### Found during the dev validation run (2026-07-27)

22. **Fixed ⚠ — Cancel has never worked either, for the same reason.** After fixing #21, `cleanup-stale-drafts` found the stale draft but reported `skipped: 1`. Its transaction delete was also unqualified — `serviceClient.from("transactions")` → `public.transactions`, which does not exist. The same mistake then turned up **twice more** in `delete-draft-transaction`, on both the ownership check and the delete, which means **Cancel has never deleted anything**: the ownership lookup errored and the function returned its deliberately-indistinct *"Transaction not found"*.
    That reframes finding #13. The FK-ordering bug there was real, but unreachable — execution never got past step 1. Two bugs stacked, the outer one masking the inner.
    Four occurrences in total (`cleanup-stale-drafts` ×2, `delete-draft-transaction` ×2), all now `.schema("ttr")`. Every other function had it right, which is why the mistake looked like an exception rather than a pattern. **A sweep of all seven functions confirms every `ttr` table and RPC access is now schema-qualified** — worth repeating if new functions are added, because the call is well-typed and type-checking cannot see it.
    The through-line with #21: `createClient()` defaults to the `public` schema, every domain table lives in `ttr`, and the resulting error is a runtime 404 from PostgREST that reads like a missing row rather than a missing table. Both were invisible until a function was invoked by hand.

21. **Fixed ⚠ — the nightly stale-draft cleanup had never run, once.** Invoking `cleanup-stale-drafts` by hand at D40 returned `500 {"error":"Failed to query stale drafts"}` — on its **first statement**. The helper is `ttr.get_stale_draft_ids` (`20260621000019`), but the code called `serviceClient.rpc("get_stale_draft_ids", …)` without `.schema("ttr")`, so PostgREST resolved it against `public`, where no such function exists. Fixed by adding `.schema("ttr")`.
    **This function is scheduled daily (`0 2 * * *`).** It has been failing on every run since it was written, returning 500 into logs nobody reads — so **no abandoned draft has ever been cleaned up**, and every ID image captured into a draft that was never completed is still in the bucket. That is a §3 and §6 problem hiding behind a cron job that appears to be configured.
    It also makes finding #17's `cleanup-stale-drafts` fix academic in retrospect: the FK-ordering bug was real, but execution never reached it.
    **No test could have caught this.** There is no test file for the function, and the failure is a runtime schema-resolution error that type-checking cannot see — the call is well-typed, it just addresses the wrong schema. It surfaced only because a manual case invoked the function directly rather than trusting the schedule. Worth a standing lesson: **a scheduled function that has never been invoked by hand has never been tested**, and its failure mode is silence.

20. **Fixed ⚠ — the reconciliation sweep would have deleted a completed record's live ID images in favour of a draft's.** Caught on the first real run of `ttr.find_unsuperseded_duplicates()` at D38: it returned four rows where only two were the deliberately-created drift. The extra pair was `DEV-010` — the **live** copy on a **completed** transaction — displaced by `DEV-011`, an uncancelled **draft**.
    **Cause:** the `captures` CTE read every `new_capture` row regardless of transaction status, so a draft's in-progress photo ranked newest in its chain (`rn = 1`) and became the keeper, demoting the completed transaction's images to duplicates awaiting supersede.
    **Consequence had it run with `apply:true`:** the completed transaction's objects deleted and its rows stamped as superseded by a draft's image. Cancel that draft afterwards — `delete-draft-transaction` removes its images — and the customer is left with **no live copy at all**, while a filed record points at a deleted image. Data loss on a legal record, caused by the cleanup that exists to protect it.
    **Fixed** by `AND t.status = 'complete'` in the CTE (`20260727000007`). A draft is work in progress; supersede runs on completion, and until then the draft's photo and the copy on file legitimately coexist. Only completed transactions constitute the record §3 makes promises about.
    **Same omission as the standing §3 invariant**, corrected an hour earlier for counting drafts and reporting false breaches — the reasoning was not carried across to the RPC. That one only *reported*; this one *deletes*. **Any query deciding what is "on file" needs this filter.**
    Two things made this survivable: the sweep is **dry-run by default**, so it reported rather than acted; and the manual case existed at all, because no unit test reaches SQL behind a database function. The chain-root partition it was written to test passed — the different person's images were correctly absent.

19. **Fixed — a capture reason chosen *before* the collision is discovered never linked.** Hit at D19. `checkDocumentCollision` reconciles an already-chosen reason against the new collision state in one direction only — it *clears* a reason that has become invalid, but never *links* one that is still valid:
    ```js
    if (chosen && !reasonsForCapture(Boolean(match), otherPerson).some((r) => r.value === chosen)) {
      updateCurrentData({ newCaptureReason: null, priorVerificationId: null })
    }
    ```
    The reason field is on screen from the moment the verification method is set, so staff can pick `ID has changed` before entering the document type and number. At that point there is no collision, so `handleCaptureReasonChange` sets no `prior_verification_id`. The collision is then found, `id_changed` is still a valid option so it is kept — but nothing establishes the link, because linking only happens when the dropdown *changes*. The row saves unlinked, hits `uq_idv_doc_new_capture`, and surfaces as *"That document number is already on file…"*.
    Same shape as #14: the collision arriving *later* than the user's choice, with the two never reconciled. #14 fixed the detection timing; this is the other half.
    **Workaround:** select the reason *after* tabbing out of the document number, which is the documented order anyway. Re-selecting the reason (change it and change it back — picking the same option fires no `onChange`) also establishes the link.
    **Fixed** by reconciling in both directions: when `checkDocumentCollision` finds a match and a still-valid *linking* reason is already selected with no link, it sets `prior_verification_id`. Deliberately **only** the link — re-running the whole reason handler would also reset the expiry, silently discarding a date the operator had typed (there is a regression test for exactly that). The identifiers need no update, since the collision was found using them.
    The failure was safe: the database refused the unlinked row and `describeSaveError` translated it into plain English, so nothing bad was written — a usability defect rather than a data-integrity one.
    **Worth noting how nearly the regression test was useless.** The first version asserted on the *"same number after renewal"* helper text, which is gated on `reason === 'id_changed' && collidingRecord` — not on whether a link exists. It passed with the fix deliberately disabled. The link is only observable in the `saveIdVerifications` payload, so the test now completes the capture and asserts `priorVerificationId` there. **A regression test that has never been seen to fail for the right reason is not evidence of anything** — the same lesson as the `.in()` filter in the supersede fakes (finding #15).

18. **Fixed ⚠ — the prior-verification pickers offered reliance rows, which hold no images.** Spotted in dev at D15 as a missing thumbnail: the driver licence showed no image in the reliance picker while the passport showed one. `get_prior_verifications_individual` and `_company` took `DISTINCT ON (document_type, document_number) ORDER BY created_at DESC` with **no filter on `verification_basis`**, so once a customer had a *completed* reliance transaction for a document, that reliance row became the newest row for it and shadowed the actual capture. Two consequences, and the second had no visible symptom at all:
    **(a) The match confirmation was silently skipped.** `validateCurrentPerson` gates it on the prior having a front image (`if (prior?.front_image_id && !currentData.imageApproved)`). A reliance row has none, so no confirmation was required and Continue succeeded without one. Privacy policy §3 says *"We are still legally required to sight your physical ID on every visit and confirm it matches our record"* — that checkbox is the confirmation half. Observed in dev: neither shown nor ticked.
    **(b) The re-verification window reset on every reliance.** `evaluateReliance` measures `daysSince` from `prior.created_at`. When the row returned was the reliance row, that timestamp was when staff last relied, not when the document was captured — so a licence photographed four years ago appeared eligible because last month's reliance row was newest. `idv_max_reliance_days` would never have fired for returning customers, which are exactly the customers it exists to catch.
    **Fixed** by restricting both lookups to `verification_basis = 'new_capture'` (`20260727000006`). A reliance row is not something you can rely *on* — it is a pointer to a capture, so offering it builds a pointer to a pointer, and it carries no document copy. With it excluded, `DISTINCT ON` lands on the newest actual capture (whose images are always live, since #9 supersedes only older copies) and the window is measured from when the document was photographed. `get_verification_for_document` already filtered this way, which is why the *collision* path resolved correctly while the picker did not — the two lookups disagreed, and now they agree.
    **Why it went unseen:** both lookups require `t.status = 'complete'`, and the earlier R-series run left its lapsed-window transaction (`REG-008`) as a draft, so no reliance row was ever visible to them. **No unit test reaches this** — it is SQL behaviour behind a `SECURITY DEFINER` function keyed on the caller's entity, and the page tests mock the lookup. It is covered by a data-level assertion in D15 of the dev sheet instead.

### Policy alignment and durability (2026-07-27)

16. **Fixed — the reason list offered a ground privacy policy §3 does not permit.** §3 tells customers: *"We will only take a new copy if your ID has changed (for example, a renewed licence) or if our stored copy is unclear."* Two grounds. The dropdown also offered **`other`**, reasoned in `20260725000002` as "so staff are never forced to mis-state the reason" — a good instinct about data quality and a bad outcome for the promise, since a customer is told only two grounds exist. Removed from the UI and from `chk_idv_new_capture_reason_values` (`20260727000004`), so it cannot drift back with a future UI change.
    `different_person` and `different_document` are deliberately **kept**: neither is a second copy of an ID already held. `different_person` is another human's *first* copy — removing it would leave the uniqueness index with no lawful exit for a real situation. `different_document` is a first copy of a *different* document; §2 already anticipates more than one, and "a new copy" in §3 means a new copy of the ID already held — a passport is not a copy of a licence. Keeping it also avoids forcing staff to record a passport as "ID has changed", which would be untrue.
17. **Fixed — §3 held only at the moment of completion, not durably.** Three paths could leave a duplicate copy on file: `cleanup-stale-drafts` silently skipped every stale draft that held ID photos (the same `ON DELETE RESTRICT` bug as #13, in a second place — and the larger of the two, because it ran unattended nightly, so those images accumulated forever); a failed supersede never retried, since it is non-fatal by design so a storage hiccup cannot roll back a completed legal record; and nothing compared the bucket against `ttr.stored_images` in either direction.
    Fixed by the FK-ordered child delete in `cleanup-stale-drafts`, plus a new scheduled **`reconcile-stored-images`** sweep covering four drift classes: orphaned objects, rows whose object is missing (**reported, never remediated** — an image cannot be recreated and deleting the row erases the proof it existed), un-superseded duplicates, and folders with no transaction. It is **dry-run by default**, never deletes a `stored_images` row, refuses to run at all if the transaction list cannot be loaded (an empty list would mark every folder dangling), and groups duplicates on chain root via `ttr.find_unsuperseded_duplicates` — never on document number, for the reason finding #15 makes concrete.

### Introduced by the #9 fix and corrected same day (2026-07-27)

15. **Fixed ⚠ — the supersede swept a different person's ID images.** `supersedePriorImages` grouped candidates by `(reporting_entity_id, document_type, upper(btrim(document_number)))` — the key `uq_idv_doc_new_capture` uses. That key is correct for "may a second unlinked row exist" and **wrong for "may this image be destroyed"**, because the index deliberately exempts `new_capture_reason = 'different_person'`. Document numbers are unique per state, not nationally, so completing one customer's linked re-capture deleted the licence images of an unrelated customer who had legitimately been recorded as `different_person` against the same number. Caught in dev before any production data existed, while writing the detection query for the reconciliation sweep — which would have applied the same flaw across all history rather than one transaction at a time.
    **Fixed by grouping on the CHAIN ROOT** (`prior_verification_id ?? id`) instead of the document number. That is person-safe by construction: a `different_person` capture is always unlinked, so it is its own root and can never share one with another person's chain, and `check_idv_recapture_link()` (finding #8) rejects any link whose target belongs to a different person, so a chain cannot span two people either. Note it cannot be chain-*following* from the new row instead — two re-captures of one document both link to the same root rather than to each other, so following only the new row's link would leave the earlier one's images live, which is the duplicate §3 forbids. Locked down by a regression test verified to fail against the old grouping.

### Findings from Phase 4 itself (2026-07-27) — all fixed

Running the fix-verification pass surfaced three more, and these are **operationally worse than #8–#11**: those produced wrong data quietly, these stop work entirely. A staff member who hit #12 at the counter could neither continue nor cancel, with a customer in front of them and no way out short of running SQL.

12. **Fixed ⚠ — any save failure at ID Verification was unrecoverable.** Photos upload *before* the database is consulted, so by the time an error appears the objects already exist. The new image ids lived only in `handleContinue`'s local `updated`, which is discarded when `saveIdVerifications` throws — so the app forgot images it had already stored. Object paths are deterministic (`{transactionId}/{personType}-{personId}-{side}.jpg`) and `upload-id-image` used `upsert: false`, so the retry re-uploaded to an existing path and got *"An image for this person/side already exists"* — a message about something the operator never did, repeating forever. Combined with #13 there was no forward path and no backward path. Triggered by **any** failure at that step: a duplicate number, a dropped connection, an expired session.
    **Fixed in two layers.** `handleContinue` now commits each image id to React state the moment its upload returns, so a retry skips the upload entirely; and `upload-id-image` upserts both the object and its `stored_images` row, keying on the table's existing `(storage_bucket, object_path)` unique constraint so the row id is stable and anything referencing it stays valid. The non-overwrite guarantee still holds where it matters — that path is unreachable unless `status = 'draft'`, so the boundary moved to "drafts are mutable, completed transactions are not" rather than disappearing.
13. **Fixed — Cancel failed on any draft with captured ID photos.** `delete-draft-transaction` removed the storage objects but never the `ttr.stored_images` rows, and `stored_images.transaction_id` is `ON DELETE RESTRICT`, so the transaction delete was rejected. This is why `REG-003` survived the R11–R27 pass despite R19 saying to abandon it. Fixed by deleting the non-cascading children in FK order first — `id_verifications` before `stored_images`, because its `front_image_id`/`back_image_id` reference the images with no cascade of their own, then the transaction. The ordering is locked down by tests, since getting it backwards fails just as completely.
14. **Fixed — the collision check never re-ran when the document type changed.** `checkDocumentCollision` fired only on the number field's blur and no-opped when the type was blank, and nothing re-ran it afterwards. Enter number-then-type and no collision was found — which is exactly what produced #12's unsaveable row. It was documented as a step-ordering trap in R18/R19/R20 rather than fixed, and no counter staff member will have read this document. The lookup now also runs from the document-type dropdown's own `onChange`, so **entry order no longer matters** and those warnings have been removed.

### Findings from the R11–R27 pass (2026-07-26) — all fixed 2026-07-27

Four defects surfaced by running Part 0 by hand against the cloud project. **None was caught by any existing Deno or Vitest test** — all four needed the wizard driven manually, which is the main argument for keeping this matrix. All four are now fixed, each with regression tests that would have caught it (11 new Vitest cases, 6 new Deno cases). **Phase 4 (F0–F8) below is the pass that verifies them end to end.**

8. **Fixed ⚠ — `different_person` was optional; `id_changed` silently linked across people.** With a document-number collision present, the "Reason for taking a new copy" dropdown offers `id_changed`, `stored_copy_unclear` and `different_person` with nothing distinguishing them by *whose* record is being collided with. `handleCaptureReasonChange` (`IdVerificationPage.jsx`) auto-links on `id_changed`, and `trg_idv_recapture_link` validates only `document_type`, `document_number` and `reporting_entity_id` — it never compares the person. Confirmed live in R19: Barry Doubleton's row (`REG-003`) links to Regina Testworth's licence record, asserting his document is a *renewal* of hers. `uq_idv_doc_new_capture` blocks a second unlinked copy and `different_person` is the *audited* exit for a genuine collision; `id_changed` is a second exit that is unaudited, permits the duplicate capture anyway, and associates two unrelated customers' identity records. Anything walking `prior_verification_id` — reliance chains, audit, identification provenance — treated the two documents as continuous.
   **Fixed both sides.** `get_verification_for_document` now returns the colliding record's owner (`20260727000002`), so `IdVerificationPage` names them in the helper text and offers **only** `different_person` when the owner differs; and `check_idv_recapture_link()` rejects such a link outright (`20260727000003`), so the invariant holds even from a direct SQL or REST call. Both layers use the same test — **both dates of birth known and different** — so the UI can never offer a reason the trigger rejects. Deliberately DOB-only rather than name-based: DOB is exact, whereas middle names, married names and typos would cause false rejections that block legitimate re-captures. Where either DOB is unknown the test cannot fire and behaviour is unchanged.
9. **Fixed — "one copy on file" was one *row*, not one *copy*.** Privacy policy §3 tells customers *"we keep one copy of your identification on file — not a new copy for every visit"*, and `IdVerificationPage.jsx` repeats it: *"Linked to the copy already on file, so this replaces it rather than adding a second one."* Nothing replaces anything. After R11/R18/R19/R21 the licence `RGN-111222` had **four** stored image pairs against it, every one with `front_image_id` and `back_image_id` populated. `uq_idv_doc_new_capture` constrains one unlinked row; images accumulate freely alongside it. Note the contrast the R26 data made plain: the *reliance* rows (`REG-008`, `REG-009`) stored no image at all and honoured §3 exactly as written, while the *linked re-capture* rows (`REG-002`, `REG-005`) each added another copy despite the UI telling the operator they replace the existing one.
   **Fixed by retention, not by re-wording.** `complete-transaction` now supersedes prior copies of the same document once the transaction is committed: the storage **object** is deleted, and the `ttr.stored_images` **row** is kept, stamped with `superseded_at` / `superseded_by_image_id` (`20260727000001`). The distinction is load-bearing — AML/CTF requires identification records be retained for seven years, and the surviving row still carries `content_hash_sha256`, `captured_by_staff_id` and `captured_at`, so it proves a document was sighted, by whom, when, and what it hashed to. The image itself is genuinely gone, which is what §3 actually promises. `get-id-image-urls` skips superseded rows so an older verification never renders a dead thumbnail, and the supersede step is non-fatal by design: a storage failure must not roll back a completed legal record.
10. **Fixed — conducting person's date of birth: no validation, and the failure was invisible.** Selecting "Is date of birth known? = Yes" and leaving the date blank writes `dob_known: true, date_of_birth: null` and is rejected by `chk_cp_dob` with a raw `23514`. Two separate defects in `ConductingPersonPage.jsx`: `dateOfBirth` is absent from `validate()` and its FormField carries neither `required` nor `error` (every other conditionally-required field on the page *is* validated), and `handleContinue` awaits `saveConductingPerson(data)` with no try/catch, so the rejection escapes as an uncaught promise — console only, nothing on screen, the page silently fails to advance. That is below the bar this document sets under "If something fails" below. Note this became reachable *because of* fix #4: while `dob_known` always saved as `false`, `chk_cp_dob` could never fire. **Fixed both halves.** `validate()` now requires `dateOfBirth` when `dobKnown === 'yes'` (with the field marked required and wired to its error), and `handleContinue` wraps both saves in try/catch behind a `describeSaveError` that translates `chk_cp_dob`, `chk_cp_relationship_other` and `chk_cp_entity` into plain English shown in a `role="alert"` on the page. The second half matters more than the DOB itself: every constraint on that table previously failed invisibly.
11. **Fixed — expiry was not carried to a linked re-capture, and was not required.** `handleCaptureReasonChange` copies `document_type`, `document_number` and `issuer` from the record being linked but not `has_expiry`/`expiry_date`, even though `get_verification_for_document` returns both. Validation only demands a date when `hasExpiry === 'yes'`, and `hasExpiry` is `null` at that point, so Continue accepts a blank expiry and the re-captured row lands without one while the original has it. Not a straightforward bug: `stored_copy_unclear` and `id_changed` share the code path, and the same physical document *should* keep its expiry while a renewed licence *must not* inherit the old one (see R21). Consequence: `evaluateReliance` gates its `⚠ Expired`/`✕ Blocked` badges on `prior.has_expiry && prior.expiry_date`, so a linked re-capture saved without an expiry can never trip expiry-based blocking if it later becomes the record relied upon. **Fixed, reason-aware.** `handleCaptureReasonChange` now copies `has_expiry` / `expiry_date` from the link target for `stored_copy_unclear` (same physical card — the expiry on file is a known fact, and re-keying it only invites a typo) and explicitly **clears** both for `id_changed` (a renewal has moved the expiry, and pre-filling the superseded date is the value most likely to be accepted unchanged by a busy operator). The boolean is converted to the radios' `'yes'`/`'no'` vocabulary rather than passed through — passing it raw is the bug class behind fixes #4 and #5. Expiry remains optional on a *first-time* capture; making it mandatory everywhere was left as a separate decision.

Separately, **TX-B** (`UAT-B-0002`) was completed without actually exercising its intended scenario (the Agent conducting-person path) — `hasConductingPerson` was left at No. Since `ttr.transactions` is permanently immutable once `status = 'complete'` (the `trg_lock_completed` trigger raises on `UPDATE` or `DELETE`), this can't be corrected in place — **TX-B2** and **TX-E3** below are new transactions added to cover this gap and to prove the alias-carryover fix end-to-end.

**Compliance constraint:** a TTR is a legal filing to AUSTRAC. This plan defaults to **offline schema validation** (Part 2 — no data ever reaches AUSTRAC) as the primary verification method; actual AUSTRAC-side acceptance testing (Part 3) requires direct confirmation from AUSTRAC of their current test/UAT process, and is deferred until after prod deploy.

## Known future feature (deferred, not built): conducting-person search

There's currently no way to search for/reuse an existing conducting person across transactions — every conducting person must be manually re-entered in full each time, even though the same real person (e.g. Priya Agent) could be a conducting person on one transaction and a primary party/customer on another. A design for this was scoped (new RPC dedicated to `ConductingPersonPage.jsx`, splitting `conducting_persons.full_name` into first/middle/last to match `parties`, unioning candidates from both `ttr.parties` and `ttr.conducting_persons`) but deliberately deferred — not part of this UAT pass. `CustomerSearchPage.jsx` and its existing RPCs are explicitly out of scope for that future work.

## Known future feature (deferred, not built): trust participants/beneficiaries

TTR-1-0's `TrustDetails` complex type also supports `trustParticipant` (trustees/appointors/settlors, each either an existing party or a fully-detailed individual/organisation) and a beneficiary sub-structure (either up to 10 named beneficiaries or a type/class description). Both are schema-optional (`minOccurs="0"`), and their conditional asserts only fire once `isTenOrLessBeneficiaries` is actually set — this system never sets it, so omitting both keeps generated XML fully schema-valid without needing this much larger recursive-entity feature. Only `isExpressTrust` + `trustType`/`trustName` are captured today.

## Part 0 — Lean regression pass

**Run this first, after a `npx supabase db reset`.** It is the single checklist for verifying the three privacy phases (MFA, access logging, one-copy-of-ID) plus a smoke test proving the AUSTRAC path still works. It deliberately does **not** re-run the full A–J matrix: that matrix exists to validate the XML generator against the TTR-1-0 schema, and none of the privacy work touched generation. Part 1C remains the deep-dive for the ID-reuse rule; this is the routine pass.

**How this is numbered.** One flat sequence, **R1 → R27**, worked top to bottom. Each case is tagged either **▶ Run** (drive a transaction through the wizard — full field data given) or **✓ Check** (an observation or a query, no transaction needed). Cases marked **⚠ critical** are ones where failure is *silent*: the system appears to work while the promise it makes to customers is false. Prioritise those if time is short.

Several checks depend on a transaction created earlier, which is called out where it applies. **R11 is the foundation** — run it before anything in Phase 2 or Phase 3.

**A completed transaction cannot be reopened.** `completeTransaction()` clears the transaction id and all wizard storage, and there is no read-only viewer for past transactions — the only pages are the wizard steps, `/reports` and `/review-batch`. Anything that needs to inspect a transaction's own data has to happen **before** Complete is clicked, or from a later draft (the prior-verification picker) or straight from the database. R12 is the one case where this matters.

**Prerequisite:** two staff accounts (one `admin`, one plain `staff`) and an authenticator app. For anything beyond the local stack, TOTP must also be enabled in the hosted Supabase dashboard — `[auth.mfa]` in `config.toml` configures the **local** stack only.

### Last run — 2026-07-26, cloud project `rygjssczdoyvmumxmymc`

| Case | Result | Evidence |
|---|---|---|
| R18 | **pass** | `new_capture \| NULL \| false`, then `new_capture \| stored_copy_unclear \| true`. Only reachable via the corrected step ordering now documented below |
| R19 | **⚠ FAIL** | Second sub-check. `REG-003` saved as `Barry Doubleton \| id_changed \| linked = true` against Regina's licence. Open finding #8 |
| R20 | **pass** | Options were exactly the three no-collision values, `Stored copy is unclear` correctly absent. `RGN-111222` → 1 unlinked / 2 total; `PRG-998877` → 1 unlinked / 1 total |
| R21 | **pass** | Picker listed both her documents, first eligible pre-selected. `RGN-111222` → 1 unlinked / 3 total — the `id_changed` row linked |
| R22 | **pass** | Both rows `is_conducting_person = true`, row 2 `stored_copy_unclear \| linked`. Required working around finding #10 to get past the Conducting Person page |
| R23 | **pass** | `REG-008` → `relied_on_prior_identification \| original_document_resighted`, both image flags false. Required the `-1` setup correction below |
| R24 | **pass** | Batch for `2026-07-26` covering `REG-001`, `REG-002`, `REG-004`, `REG-006`; `reportCount` matched the `<ttr>` count |
| R25 | **pass** | 0 errors under `XMLSchema11` (`XSD_VERSION 1.1`), with both negative controls returning 1 — the check is not vacuous |
| R11–R17 | **pass** | Foundation transaction, plus all of Phase 2 access logging — image views, export rows, no `xml_content` on page load, append-only enforcement, admin-only reads |
| R26 | **pass** | `REG-009` → `RGN-111222 \| relied_on_prior_identification \| prior_id_reviewed_still_valid \| linked = true \| has_front = false`. Auto-selected the licence — so the reliance row saved against a number that already holds an unlinked `new_capture` row, confirming reliance sits outside the index |
| R27 | **pass** | `REG-001` rejected on the Start page with no navigation; an edited reference started normally; an existing draft reference still resumed with "Existing draft found" |

**R11–R27 complete: 16 of 17 cases passed, R19 failed.** R1–R10 (the migration gate and MFA) were not part of this run.

Four open defects came out of this pass — findings #8–#11 in the Context section above. **None is caught by any existing Deno or Vitest test**; every one needed the wizard driven by hand. #8 is the serious one: it writes a false assertion into data destined for a legal filing.

Two cases also produced drafts that were never completed and still hold data — `REG-003` (the bad cross-person link, worth deleting) and `REG-005`, `REG-008`. `generate-austrac-report` ignores them, since it pulls `status = 'complete'` only.

One thing to confirm as intended rather than log as a defect: the operator entered `14 Regress Rd` and `Metal wholesaling`; the generated filing reads `14 Regress Road` and `Metal Wholesaling`. Something expands street types and title-cases activities. Almost certainly deliberate normalisation, but it is text going verbatim into a legal filing.

### Gate — migrations apply (R1–R2)

Nothing below is meaningful until this passes. (`20260725000002` and `20260726000001` were both confirmed live on the cloud project during the 2026-07-26 pass — `get_verification_for_document` responds, and `chk_idv_reliance_reason_values` includes `original_document_resighted`.)

| # | | Do this | Must happen |
|---|---|---|---|
| R1 | ✓ | `npx supabase db reset` | Completes with no error. Previously failed here on duplicate `POA-11223` |
| R2 | ✓ | Run the object check below | All five rows return `t` |

```sql
SELECT 'index'      AS object, to_regclass('ttr.uq_idv_doc_new_capture') IS NOT NULL AS present
UNION ALL SELECT 'lookup rpc', to_regproc('public.get_verification_for_document') IS NOT NULL
UNION ALL SELECT 'access_log', to_regclass('ttr.access_log') IS NOT NULL
UNION ALL SELECT 'entity col', EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='ttr' AND table_name='id_verifications' AND column_name='reporting_entity_id')
UNION ALL SELECT 'recapture trigger', EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgname='trg_idv_recapture_link');
```

### Phase 1 — MFA (R3–R10)

No transaction data needed for any of these.

| # | | Do this | Must happen |
|---|---|---|---|
| R3 | ✓ | Sign in with an account that has never enrolled | Redirected to `/mfa` with a QR code; the wizard is unreachable |
| R4 | ✓ | Scan it and enter the code | Lands on `/start`. Authenticator entry reads **"Compliance Capture Platform"**, not `localhost` |
| R5 | ✓ | Sign out, sign in again | Code entry only — **no QR**, no re-enrolment |
| R6 | ✓ | Enter `000000` | Rejected, stays on `/mfa` |
| R7 **⚠ critical** | ✓ | Stop at `/mfa` without entering a code, then type `/reports` (or `/id-verification`, `/customers`) in the address bar | Bounced to the **sign-in screen**, and the session is **ended** — the password must be entered again. Not offered the code entry as a shortcut |
| R8 | ✓ | Immediately after R7, return to any other open tab and interact with it | Also signed out. Ending the session is global — the intended cost of this behaviour |
| R9 | ✓ | While signed out, open `/reports` directly, then complete both factors | `/login` → `/mfa` → lands on **`/reports`**, not `/start`. The requested page survives both steps |
| R10 | ✓ | As the non-admin account, complete MFA and open `/reports`. Then sign in fully and hard-refresh a protected page | First: "You are not authorised to view this page" — the role check still runs after MFA. Second: you stay put, confirming the sign-out only fires for genuinely half-authenticated sessions, not in the moment before the assurance level resolves |

*Known and expected:* a password-only token can still call the Supabase REST API directly (curl/Postman). DB-level AAL2 hardening was deliberately deferred.

### Regression cast

Self-contained on purpose — after a `db reset` none of the A–J identities exist. Names are deliberately distinct from that matrix so a collision is never ambiguous about which dataset it came from.

**Individuals**
- **Regina Mae TESTWORTH** — DOB `1983-05-12`, phone `0400123123`, email `regina.testworth@example.test`, occupation `Florist`, gender `F`, citizenship/tax `AU`, residential `14 Regress Rd, Preston, VIC, 3072`. The main Phase 3 subject.
- **Barry DOUBLETON** — DOB `1979-09-30`, phone `0400456456`, email `barry.doubleton@example.test`, occupation `Mechanic`, gender `M`, citizenship/tax `AU`, residential `27 Repeat St, Thornbury, VIC, 3071`. Exists only to collide with Regina's licence number.
- **Colin BROKER** — DOB `1986-02-14`, phone `0400789789`, occupation `Broker`, residential `5 Agent Ave, Carlton, VIC, 3053`. Conducting person, appears on two transactions.

**Company**
- **Wilma Wholesale Pty Ltd** — legal form `Company`, ABN `55667788990`, business address `9 Trade Pl, Carlton, VIC, 3053`, phone `0392223333`, email `accounts@wilmawholesale.example.test`, principal activity `Metal wholesaling`.

**Documents**
- Regina: Driver licence `RGN-111222`, issuer `VicRoads` (front **and** back required); later Passport `PRG-998877`, issuer `Australian Passport Office`
- Barry: attempts Driver licence `RGN-111222` — same number, different person
- Colin: Passport `CLB-334455`, issuer `Australian Passport Office`

Country is `AU` throughout. Any small JPG works as a placeholder image.

---

### Phase 2 — Access logging (R11–R17)

Query used throughout:

```sql
SELECT occurred_at, action, resource_type, resource_id, staff_member_id, detail
FROM ttr.access_log ORDER BY occurred_at DESC LIMIT 20;
```

#### R11 ▶ Run — foundation transaction

**Everything in Phase 2 and Phase 3 leans on this one. Run it first.** It creates Regina, puts her licence on file, and produces a report batch.

- **Start Transaction**: scenario = `Sell bullion to customer`; transactionRef = `REG-001`; dateTime prefilled.
- **Customer Search → Create new customer** (Individual): firstName `Regina`, middleName `Mae`, lastName `Testworth`, dateOfBirth `1983-05-12`, phone `0400123123`, email `regina.testworth@example.test`. Select her, Continue.
- **Transaction Details**: Cash currency = `AUD`; cashAmount = `14000`.
- **Party Details**: fullName `Regina Mae Testworth`; dateOfBirth `1983-05-12`; resStreet `14 Regress Rd`; resSuburb `Preston`; resState `VIC`; resPostcode `3072`; resCountry `Australia`; postal-different unchecked; phone `0400123123`; occupation `Florist`; gender `F`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`.
- **Conducting Person**: hasConductingPerson = **No**.
- **ID Verification**: verificationMethod `Sighted original document`; documentType `Driver licence`; documentNumber `RGN-111222`; issuer `VicRoads`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2030-05-12`; capture front **and back**.
  - **Expect:** no "Reason for taking a new copy" field appears anywhere. She is a first-time customer; nothing is being duplicated. This is the control for the whole of Phase 3 — if a reason is demanded here, the rule is over-firing.
- **Recipient & Delivery**: recipientIsParty = **Yes**; recipient = Regina Mae Testworth; purpose = `Collecting bullion`; delivery method = `Collected`.
- **Bullion Details** — Item 1: metalType `Gold`; productType `Bar`; purity `999.9`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `14000`; description `1kg gold bar`.
- **Review & Submit**: **Complete**.

#### R12 ✓ Check ⚠ critical — viewing an ID image is logged

**Do this during R11, before clicking Complete.** A completed transaction cannot be reopened — `completeTransaction()` clears the transaction id and every wizard storage key, and there is no read-only viewer for past transactions. Once R11 is submitted, its images are only reachable through the prior-verification picker in a *later* draft.

- In R11, after capturing both images and continuing past ID Verification, navigate **back** to the ID Verification step (browser back, or the wizard's step navigator).
- **Expect:** the saved images reload and render. They are fetched as freshly signed URLs, and that is the event being logged — not the original capture.

*Alternative, if R11 is already complete:* start R18 and look at Regina's prior images in the reliance picker. Same mechanism, same log rows.

```sql
SELECT action, resource_type, detail FROM ttr.access_log
 WHERE action = 'view' ORDER BY occurred_at DESC;
-- expect one row per image (front and back), resource_type 'stored_images',
-- detail holding the object path, transaction_id populated
```

#### R13 ✓ Check — exporting a report is logged

- Trigger `generate-austrac-report` for R11's date (see "Triggering report generation on demand" below).
- Open the batch at `/review-batch/<batchId>?token=<approval_token>` and click **Download XML**.
- **Expect:** the file downloads, named `ttr-fbs-<date>.xml`.

```sql
SELECT action, resource_type, detail FROM ttr.access_log
 WHERE action = 'export' ORDER BY occurred_at DESC LIMIT 1;
-- expect 'export' / 'report_batches' / 'ttr-fbs-<date>.xml'
```

#### R14 ✓ Check ⚠ critical — the XML does not reach the browser on page load

- Open DevTools → Network, then load `/review-batch/<batchId>` fresh.
- Find the `report_batches` request and inspect its response.
- **Expect:** **no** `xml_content` field. It should appear only in the `approve-batch` response, and only after clicking Download.
- Before this change the full unredacted XML — every name, address and document number in that batch — was shipped on every page view, whether or not anyone downloaded it.

#### R15 ✓ Check — logging did not tighten who can export

- Open `/review-batch/<batchId>` with **no** `?token=` at all.
- **Expect:** the amber view-only warning; Approve / Reject / Regenerate all disabled; **Download XML still works and still writes an `export` row**. Logging was meant to be additive, not a new access control.

#### R16 ✓ Check ⚠ critical — the log cannot be rewritten

```sql
UPDATE ttr.access_log SET action = 'view' WHERE id = (SELECT id FROM ttr.access_log LIMIT 1);
DELETE FROM ttr.access_log WHERE id = (SELECT id FROM ttr.access_log LIMIT 1);
-- both must raise: Audit log is append-only — UPDATE/DELETE is not permitted
```

#### R17 ✓ Check — ordinary staff cannot read the log

- Sign in as the non-admin account and run `SELECT * FROM ttr.access_log;`
- **Expect:** 0 rows, even though that staff member's own views are recorded in it. An access log everyone can browse is itself a way to study customers.

---

### Phase 3 — One copy of ID on file (R18–R23)

All of these need **R11** to have been completed first. Several can be **abandoned** rather than completed — the collision check deliberately ignores transaction status, so an abandoned draft still holds the number and still blocks.

The first-time-customer control for this phase is inside R11: no reason field should ever have appeared there.

#### R18 ▶ Run — same customer, same document, stored copy unclear

- **Start Transaction**: scenario = `Buy bullion from customer`; transactionRef = `REG-002`.
- **Customer Search**: Individual — firstName `Regina`, lastName `Testworth`, dateOfBirth `1983-05-12` — select the **existing** record from R11.
- **Transaction Details**: Cash currency = `AUD`; cashAmount = `11000`.
- **Party Details**: confirm her details carried over.
- **Conducting Person**: hasConductingPerson = **No**.
- **ID Verification** — the step under test.

  **Precondition:** Regina's `fullName` and `dateOfBirth` must have carried over unchanged on Party Details. The prior lookup is name+DOB keyed, so editing either stops step 1 firing for reasons unrelated to what R18 tests.

  1. **On arrival, before touching anything.** Verification method reads `Relied on prior identification`; `Driver licence` / `RGN-111222` / `VicRoads` are pre-filled; "Reason for reliance" reads `Prior ID reviewed and still valid`; the prior-verification card shows the R11 capture with its images and the "I confirm the person presenting today matches these ID images" checkbox. No camera section is shown.
  2. **⚠ critical** — switch the method to `Sighted original document`. Document type, number **and issuer** must all clear to empty. If `Driver licence` / `RGN-111222` remain, stop and report it: a different document photographed now would be filed under her licence number.
  3. **The "Reason for taking a new copy" field appears immediately**, with the number field still empty. **This is correct, not a defect** — she has ID on file, so any fresh capture needs a reason regardless of which document it turns out to be (`requiresCaptureReason` is satisfied by the name-matched prior alone). At this point it offers `Customer presented a different document`, `ID has changed (e.g. renewed licence)`, `Other`, with helper text *"This customer already has ID on file (Driver licence RGN-111222, verified …). Select 'Relied on prior identification' above to reuse it."* Confirm it sits **above** the camera section, before any photo is taken.
  4. Select documentType `Driver licence` and enter documentNumber `RGN-111222`, then **tab out of the number field**. Either order works — the lookup runs on the number field's blur *and* on a document-type change, so it fires whichever you complete last. (Before finding #14 was fixed, entering the number first silently found nothing and was the most likely way to log a false failure here.)
  5. **This is the assertion R18 exists for** — the reason field changes in place: the options narrow to **exactly three** — `ID has changed (e.g. renewed licence)`, `Stored copy is unclear`, `Different person who shares this document number`. `Other` and `Customer presented a different document` are both **gone**; neither can save against a colliding number. The helper text switches to *"Driver licence RGN-111222 is already on file (captured …). Select 'Relied on prior identification' above to reuse it instead."*
  6. *Optional, costs nothing:* before step 4, select `Other`. After the blur it must clear itself back to "Select reason…" — a value the database would reject must not survive the collision being found.
  7. Select `Stored copy is unclear`. Issuer auto-fills `VicRoads` and the helper text becomes *"Linked to the copy already on file, so this replaces it rather than adding a second one."* This is where the link forms — it is what makes `linked = true` true in the closing SQL.
  8. **Expect `Is there an expiry date?` to arrive pre-filled as `Yes` / `2030-05-12`**, matching R11 — the same physical card cannot have a different expiry. Do not retype it; the point is that it is already correct. (Before finding #11 was fixed this was blank, and nothing forced it, so the re-captured row silently disagreed with the original.)
  9. Capture front **and** back — `Driver licence` is the only type requiring a back image.
- **Recipient & Delivery**: recipientIsParty = **Yes**; purpose = `Dropping off bullion`; delivery method = `Collected`.
- **Bullion Details** — Item 1: metalType `Silver`; productType `Bar`; purity `999`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `11000`.
- **Review & Submit**: **Complete**.

```sql
SELECT verification_basis, new_capture_reason, prior_verification_id IS NOT NULL AS linked
  FROM ttr.id_verifications WHERE document_number = 'RGN-111222' ORDER BY created_at;
-- expect row 1: new_capture | NULL                | false
--        row 2: new_capture | stored_copy_unclear | true
```

#### R19 ▶ Run ⚠ critical — a different person cannot quietly reuse the number

This is the rule itself. Abandon the draft afterwards.

- **Start Transaction**: scenario = `Buy bullion from customer`; transactionRef = `REG-003`.
- **Customer Search → Create new customer** (Individual): firstName `Barry`, lastName `Doubleton`, dateOfBirth `1979-09-30`, phone `0400456456`, email `barry.doubleton@example.test`.
- **Transaction Details**: Cash currency = `AUD`; cashAmount = `10500`.
- **Party Details**: fullName `Barry Doubleton`; dateOfBirth `1979-09-30`; resStreet `27 Repeat St`; resSuburb `Thornbury`; resState `VIC`; resPostcode `3071`; phone `0400456456`; occupation `Mechanic`; gender `M`; citizenship/tax `AU`.
- **Conducting Person**: **No**.
- **ID Verification**: documentType `Driver licence` and documentNumber `RGN-111222` — Regina's number — then tab out. Either order works since finding #14 was fixed.
  - **Expect:** the reason field appears even though Barry has no history of his own. Detection is on the *document*, not the person.
  - **Expect:** with no reason selected, Continue is blocked.
  - Select `Different person who shares this document number`, capture front and back, and continue.
  - **Expect:** it saves. Licence numbers are unique per state, not nationally, so this is a real situation that must have an exit — but one that is recorded rather than silent.

```sql
SELECT p.last_name, idv.new_capture_reason
  FROM ttr.id_verifications idv JOIN ttr.parties p ON p.id = idv.party_id
 WHERE idv.document_number = 'RGN-111222' ORDER BY idv.created_at;
-- Barry's row must carry new_capture_reason = 'different_person'
```

- Now **retry the same step choosing no reason at all**. **Expect rejection** — the prompt refuses to continue. A raw `duplicate key value violates unique constraint` reaching the screen is a finding.

> **⚠ FAILED 2026-07-26 — open finding #8.** This case originally also said to *"pick `ID has changed` and leave it unlinked with the identical number, expect rejection"*. **That state is unreachable from the UI**, so the sub-check could never have passed as phrased: `handleCaptureReasonChange` auto-links `id_changed` whenever a collision exists, and `trg_idv_recapture_link` only validates that the linked record is the same *document* — never the same *person*. So it saves, and it overwrites the `different_person` value set moments earlier on the same row.
>
> Observed result: `REG-003` ended as `Barry Doubleton | id_changed | linked = true`, pointing at Regina's licence record and asserting his document is a renewal of hers.
>
> The question this case should actually ask is whether `id_changed` and `stored_copy_unclear` should be offered **at all** when the colliding record belongs to a different person. Re-run it once finding #8 is fixed, and verify with:
>
> ```sql
> SELECT t.transaction_ref, p.first_name, p.last_name, t.status,
>        idv.new_capture_reason,
>        idv.prior_verification_id IS NOT NULL AS linked
>   FROM ttr.id_verifications idv
>   JOIN ttr.transactions t ON t.id = idv.transaction_id
>   LEFT JOIN ttr.parties p ON p.id = idv.party_id
>  WHERE upper(btrim(idv.document_number)) = 'RGN-111222'
>  ORDER BY idv.created_at;
> -- Barry's row must be different_person / linked = false. Anything linked is finding #8.
> ```

- **Abandon this draft** (Cancel) once checked. Note the draft left behind by the 2026-07-26 run still holds the bad cross-person link and should be deleted.

#### R20 ▶ Run — customer presents a different document

- **Start Transaction**: scenario = `Sell bullion to customer`; transactionRef = `REG-004`.
- **Customer Search**: select the existing **Regina Mae Testworth**.
- **Transaction Details**: Cash currency = `AUD`; cashAmount = `12000`.
- **Conducting Person**: **No**.
- **ID Verification**:
  1. Reliance is auto-selected on her licence. Switch to `Sighted original document` — fields clear again, and the reason field appears straight away with the no-collision options (same as R18 step 3).
  2. documentType `Passport`; documentNumber `PRG-998877`; issuer `Australian Passport Office`; hasExpiry `Yes`; expiryDate `2033-05-12`; tab out of the number.
  3. **Expect:** no collision (that number is new), so the reason field is unchanged from step 1 — it appears because she has a reusable record, not because anything collided. **Expect the options to be** `Customer presented a different document`, `ID has changed (e.g. renewed licence)`, `Other` — note `Stored copy is unclear` is **absent**, since there is nothing to link to.
  4. Select `Customer presented a different document`. Capture front only (passports need no back).
- **Recipient & Delivery / Bullion Details**: any valid values; `Gold` / `Bar` / `999.9` / qty `1` / `1` kg / unitPrice `12000`.
- **Review & Submit**: **Complete**.
- **Expect:** Regina now holds **two** documents, one copy each. The rule is one copy per *document*, not one document per person.

```sql
-- Regina's full ID history — expect exactly 3 rows after R20
SELECT t.transaction_ref, idv.document_type, idv.document_number,
       idv.new_capture_reason,
       idv.prior_verification_id IS NOT NULL AS linked,
       idv.has_expiry, idv.expiry_date
  FROM ttr.id_verifications idv
  JOIN ttr.transactions t ON t.id = idv.transaction_id
  JOIN ttr.parties p      ON p.id = idv.party_id
 WHERE p.last_name ILIKE 'Testworth'
 ORDER BY idv.created_at;
-- REG-001 | Driver licence | RGN-111222 | NULL                | false
-- REG-002 | Driver licence | RGN-111222 | stored_copy_unclear | true
-- REG-004 | Passport       | PRG-998877 | different_document  | false

-- "two documents, one copy each" stated as something checkable
SELECT idv.document_type, idv.document_number,
       count(*) FILTER (WHERE idv.prior_verification_id IS NULL) AS unlinked_copies,
       count(*) AS total_rows
  FROM ttr.id_verifications idv
  JOIN ttr.parties p ON p.id = idv.party_id
 WHERE p.last_name ILIKE 'Testworth'
 GROUP BY 1, 2;
-- RGN-111222 → 1 unlinked / 2 total
-- PRG-998877 → 1 unlinked / 1 total
```

`linked = false` on the passport row is the load-bearing assertion: `different_document` must never link, so the row stays inside `uq_idv_doc_new_capture` and a later unlinked re-capture of that passport is still blocked.

#### R21 ▶ Run — renewed licence, unchanged number

- Start a transaction for Regina as above, transactionRef = `REG-005`.
- At ID Verification, switch off reliance, then select documentType `Driver licence` **first** and enter `RGN-111222` again, tab out. (She now has two documents on file, so note which one reliance auto-selected on arrival — it takes the first *eligible* record, which may be the passport.)
- Select **`ID has changed (e.g. renewed licence)`** and capture fresh images.
- **Expect `Is there an expiry date?` to be BLANK**, not pre-filled — then set it to **Yes** / **`2035-05-12`**, deliberately later than R11's `2030-05-12`. A renewal moves the expiry while keeping the number, so inheriting the old date would be wrong. This is the counterexample proving finding #11's fix is reason-aware rather than a blanket copy.
- **Expect:** it saves, as a **link** to the record on file. Australian licence numbers survive renewal, so "the ID changed" and "the number is unchanged" are both true — before this fix that combination was impossible to record.
- **Complete** rather than abandon. The matrix previously said either was fine, but exiting calls `deleteTransaction()`, which takes the row being verified with it and leaves nothing to check.

```sql
SELECT t.transaction_ref, idv.new_capture_reason,
       idv.prior_verification_id IS NOT NULL AS linked, idv.expiry_date
  FROM ttr.id_verifications idv
  JOIN ttr.transactions t ON t.id = idv.transaction_id
 WHERE upper(btrim(idv.document_number)) = 'RGN-111222'
 ORDER BY idv.created_at;
-- REG-001 | NULL                | false | 2030-05-12
-- REG-002 | stored_copy_unclear | true  | (2030-05-12 if entered — see finding #11)
-- REG-005 | id_changed          | true  | 2035-05-12
```

`linked = true` on REG-005 is the whole point. Before the constraint rewrite in `20260725000002`, `new_capture` rows were hard-required to have `prior_verification_id IS NULL`, which made the dropdown's own worked example — a renewed licence — impossible to save. Re-running the R20 count query should now show `RGN-111222` → **1 unlinked / 3 total**: one copy on file, two tracked re-captures.

#### R22 ▶ Run ⚠ critical — the same conducting person, twice

The Phase 3b case. Conducting persons get no name-based prior lookup, so the document collision is their only route to reuse.

- **Start Transaction**: scenario = `Sell bullion to customer`; transactionRef = `REG-006`.
- **Customer Search → Create new customer** (Company): entityName `Wilma Wholesale Pty Ltd`; abnAcn `55667788990`; suburb `Carlton`; companyPhone `0392223333`; companyEmail `accounts@wilmawholesale.example.test`.
- **Transaction Details**: Cash currency = `AUD`; cashAmount = `15000`.
- **Party Details**: legalForm `Company`; bizStreet `9 Trade Pl`; bizSuburb `Carlton`; bizState `VIC`; bizPostcode `3053`; registration identifier type `ABN`, value `55667788990`; principalActivity `Metal wholesaling`.
- **Conducting Person**: hasConductingPerson = **Yes**; representedPartyId = Wilma Wholesale Pty Ltd; fullName `Colin Broker`; dobKnown `Yes`; dateOfBirth `1986-02-14`; resStreet `5 Agent Ave`; resSuburb `Carlton`; resState `VIC`; resPostcode `3053`; phone `0400789789`; occupation `Broker`; relationship `Agent`; authorityToAct `Authorised to transact on behalf of Wilma Wholesale Pty Ltd.`; isEmployee = **No**; actingViaEntity = **No**.
  - **Also check here:** navigate back to this page before continuing. "Is date of birth known?" must still show **Yes**. It reset to unselected before this pass — a separate read-path bug fixed alongside this work.
- **ID Verification** (Colin only — company parties get no ID record): documentType `Passport`; documentNumber `CLB-334455`; issuer `Australian Passport Office`; hasExpiry `Yes`; expiryDate `2031-02-14`; capture front.
- **Recipient & Delivery**: recipientIsParty = **Yes**; purpose = `Collecting bullion`; delivery method = `Collected`.
- **Bullion Details** — Item 1: `Platinum` / `Bar` / `999.5` / qty `1` / `1` kg / unitPrice `15000`.
- **Review & Submit**: **Complete**.

Then repeat as **REG-007** — same company, same Colin Broker, same passport `CLB-334455`:

- **Expect:** at ID Verification there is **no** auto-selected reliance (conducting persons have no name lookup), but entering `CLB-334455` and tabbing out **does** raise the collision prompt naming the record on file.
- Select `Stored copy is unclear`, capture front, complete.

```sql
SELECT idv.verification_basis, idv.new_capture_reason,
       idv.prior_verification_id IS NOT NULL AS linked,
       idv.party_id IS NULL AS is_conducting_person
  FROM ttr.id_verifications idv
 WHERE idv.document_number = 'CLB-334455' ORDER BY idv.created_at;
-- expect row 2: new_capture | stored_copy_unclear | true | true
```

#### R23 ▶ Run — re-verification window has lapsed

Needs a record older than the entity's window. Easiest is to shorten the window rather than back-date data.

**Pre-flight** — `20260726000001` adds the `original_document_resighted` value this case depends on, and R23 is the only case exercising it:

```sql
SELECT pg_get_constraintdef(oid) LIKE '%original_document_resighted%' AS applied
  FROM pg_constraint WHERE conname = 'chk_idv_reliance_reason_values';
-- must be true. If false, R23 fails at save with a 23514 — and describeSaveError only
-- translates 23505, so the raw Postgres text reaches the screen and reads as a product
-- defect when it is really an unapplied migration.
```

**Setup — use `-1`, not `0`:**

```sql
UPDATE public.reporting_entities SET idv_max_reliance_days = -1;   -- remember to restore
```

`evaluateReliance` blocks on `daysSince > policy.maxRelianceDays`. Every record in this regression cast is created the same day it is tested, so `daysSince = 0` and `0 > 0` is **false** — a window of `0` blocks nothing, reliance auto-selects as normal, and R23 fails its own expectations for a setup reason rather than a product one. `-1` makes `0 > -1` true. The column is a plain `INTEGER NOT NULL DEFAULT 730` with no CHECK, so negatives are accepted. Back-dating `created_at` also works but means editing audit data.

- Start a transaction for **Regina Mae Testworth**, transactionRef = `REG-008`.
- At ID Verification, **expect** her prior records to show a `✕ Blocked` badge and **not** be auto-selected.
- Select `Relied on prior identification` and pick her licence from the picker.
- **Expect:** the reason list offers exactly `Original document re-sighted today` and `Manager approved reliance` — nothing else. The notice states the window has lapsed and that **no second copy is taken**.
- Choose `Original document re-sighted today`, tick the image-match confirmation, and complete.
- **Expect:** no new image is stored by this transaction. This is the whole reason a lapsed window calls for re-sighting rather than re-photographing.

```sql
SELECT t.transaction_ref, idv.verification_basis, idv.reliance_reason,
       idv.new_capture_reason,
       idv.front_image_id IS NOT NULL AS has_front,
       idv.back_image_id  IS NOT NULL AS has_back
  FROM ttr.id_verifications idv
  JOIN ttr.transactions t ON t.id = idv.transaction_id
 WHERE upper(btrim(idv.document_number)) = 'RGN-111222'
 ORDER BY idv.created_at;
-- REG-008 → relied_on_prior_identification | original_document_resighted | NULL | false | false
```

**Both image flags false on REG-008 is the assertion** — that is "no second copy is taken" made checkable.

> **Note the earlier rows.** This query also shows that REG-001, REG-002 and REG-005 each carry their own front *and* back images, so the licence has several stored copies by this point — the reliance row simply does not add another. The claim "Regina still has exactly one copy on file" does **not** hold as stated; `uq_idv_doc_new_capture` guarantees one unlinked *row*, not one *image*. See open finding #9 — this is a live question about whether policy §3 is accurate as written.

```sql
UPDATE public.reporting_entities SET idv_max_reliance_days = 730;  -- restore
```

**Restore this before R26**, which depends on reliance auto-selecting again. Left at `-1`, nothing is eligible, nothing auto-selects, and R26 silently tests nothing.

### AUSTRAC smoke test (R24–R26)

Not a re-run of the matrix — just proof the wizard and generator still work end to end after three phases of change. R11 and R18–R23 have already produced several completed transactions, so this mostly validates their output.

| # | | Do this | Must happen |
|---|---|---|---|
| R24 | ✓ | Trigger `generate-austrac-report` for the date R11 and R18 completed on | A batch is produced covering them |
| R25 | ✓ | Validate that batch's `xml_content` against `docs/schema/TTR-1-0.xsd` using **`xmlschema.XMLSchema11`** (see below) | Valid, including the `xs:assert` rules |
| R26 | ▶ | **First confirm R23 restored `idv_max_reliance_days` to 730.** Then start one more transaction for Regina and this time **accept** the auto-selected reliance rather than overriding it. Complete it. Full steps below | Completes normally. Confirms the ordinary reliance path is untouched by the uniqueness rule — reliance rows sit outside the index. Left at R23's value, nothing auto-selects and this case silently tests nothing |

**R25 — the validator class matters.** `xmllint` and .NET's `System.Xml.Schema` will falsely pass, since neither supports 1.1 — but so will `xmlschema.XMLSchema`, which is that package's **1.0** validator and ignores `xs:assert` entirely. It must be `XMLSchema11`:

```
python -c "import xmlschema; s=xmlschema.XMLSchema11('docs/schema/TTR-1-0.xsd'); \
  print(type(s).__name__, s.XSD_VERSION); \
  print(len(list(s.iter_errors(r'<path-to-batch>.xml'))))"
# expect: XMLSchema11 1.1 / 0
```

**Prove the check isn't vacuous.** "0 errors" and "the validator checked nothing" are indistinguishable from the outside, so run two negative controls against the same file. Each must report exactly 1 error:

```
# 1. ttr id starting with a digit — NCName/xs:ID (context fix #7, first bullet)
d.replace('ttr-<first-uuid>', '<first-uuid>', 1)

# 2. businessStructure C→T with no isExpressTrust — must report "assertion test is false",
#    which is what proves xs:assert is genuinely being evaluated (fix #7, fourth bullet)
d.replace('<businessStructure>C</businessStructure>', '<businessStructure>T</businessStructure>', 1)
```

#### R26 ▶ Run — the ordinary reliance path still works

The control for the whole of Phase 3. Its dependency is easy to miss: R23 sets `idv_max_reliance_days` to a value that blocks everything, so **check it is back to 730 first** or nothing auto-selects and this case silently tests nothing.

```sql
SELECT idv_max_reliance_days FROM public.reporting_entities;   -- must be 730
```

- **Start Transaction**: scenario = `Sell bullion to customer`; transactionRef = `REG-009`.
- **Customer Search**: select the existing **Regina Mae Testworth**.
- **Transaction Details**: Cash currency = `AUD`; cashAmount = `10000`.
- **Party Details**: confirm her details carried over.
- **Conducting Person**: hasConductingPerson = **No**.
- **ID Verification** — the step under test, and the test is that you **change nothing**:
  1. **Expect:** verification method auto-reads `Relied on prior identification`, with "Reason for reliance" pre-set to `Prior ID reviewed and still valid`. Note **which** document it selected — `init` takes the first *eligible* record and she has several by this point.
  2. **Expect:** the prior-verification card shows that record with its stored images, and **no camera section** anywhere.
  3. **Expect: no "Reason for taking a new copy" field at all.** `requiresCaptureReason` is false in reliance mode. This is the control proving the Phase 3 justification rule doesn't leak into the ordinary path.
  4. Tick **"I confirm the person presenting today matches these ID images"** — required whenever the selected prior has a front image; Continue is blocked without it.
- **Recipient & Delivery**: recipientIsParty = **Yes**; purpose = `Collecting bullion`; delivery method = `Collected`.
- **Bullion Details** — Item 1: metalType `Gold`; productType `Bar`; purity `999.9`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `10000`.
- **Review & Submit**: **Complete** — so it lands in a batch.

```sql
SELECT t.transaction_ref, idv.document_number, idv.verification_basis,
       idv.reliance_reason, idv.new_capture_reason,
       idv.prior_verification_id IS NOT NULL AS linked,
       idv.front_image_id IS NOT NULL AS has_front
  FROM ttr.id_verifications idv
  JOIN ttr.transactions t ON t.id = idv.transaction_id
  JOIN ttr.parties p      ON p.id = idv.party_id
 WHERE p.last_name ILIKE 'Testworth'
 ORDER BY idv.created_at;
-- REG-009 → relied_on_prior_identification | prior_id_reviewed_still_valid | NULL | true | false
```

**The assertion is that the row saved at all.** REG-009 carries a document number that already has a `new_capture` row against it, and it saved without touching `uq_idv_doc_new_capture` — that index is scoped `WHERE verification_basis = 'new_capture'`, so reliance rows sit outside it by construction. Re-running R20's count query must show `unlinked_copies` **unchanged at 1** for whichever document was relied on, and `has_front = false` on the new row confirms no image was stored.

### Re-using a completed reference (R27)

#### R27 ▶ Run — a completed transaction's reference cannot be re-used

R11 completed as `REG-001`. Because a completed transaction cannot be reopened and has no read-only viewer, re-entering its reference has no valid destination — the Start page has to say so, not let the wizard run and fail at the insert.

- Go to `/start`, enter transactionRef = `REG-001`, and tab out of the field.
- **Expect:** the field shows *"This reference belongs to a completed transaction and cannot be reused. Enter a different reference."* No "Existing draft found" notice.
- Pick a scenario and click **Start transaction**.
- **Expect:** the page does not navigate to Add Customers. The same message stays on the field.
- Edit the reference to `REG-001X`. **Expect:** the message clears and the transaction starts normally.
- **Regression:** start a transaction with a fresh ref, exit mid-wizard to leave a draft, then re-enter that ref. **Expect:** "Existing draft found — fields pre-filled." and the draft resumes as before.

The uniqueness itself is enforced by `uq_tx_ref_per_entity (reporting_entity_id, transaction_ref)`; the Start-page check just surfaces it before any data entry.

---

## Phase 4 — fix verification (F0–F8)

Proves findings #8–#11 are actually fixed. **Run this against a clean dataset, not the R11–R27 data.** That history cannot prove these fixes: Regina's licence already carries four pre-fix image pairs, Barry's row holds the bad cross-person link, and #9 only supersedes going forward — so a "one live copy" assertion would fail against data that predates the fix. R11–R27 results are recorded above, so nothing is lost by dropping it.

Automated coverage exists for all four (11 Vitest cases, 6 Deno cases), so this phase is about the wizard and the database together, which is where every one of these defects hid.

### F0 ✓ — reset the regression data

Destructive. Confirm the R11–R27 results table above is committed first.

Most child tables cascade (`parties`, `conducting_persons`, `id_verifications`, `recipient_deliveries`, `bullion_items`, `precious_metal_items`), but four things make this more than a `DELETE`:

- `transaction_reports.transaction_id` has no `ON DELETE` clause, so it blocks;
- `stored_images.transaction_id` is `ON DELETE RESTRICT`, so it blocks;
- `id_verifications.front_image_id` / `back_image_id` reference `stored_images(id)` with no cascade, so the **verification rows must go before the images**, even though they would otherwise cascade with the transaction;
- `trg_lock_completed` raises on `DELETE` of a completed transaction.

`ttr.access_log.transaction_id` is deliberately a plain UUID with no FK, so its rows do **not** block the delete and would otherwise survive. Step 6 removes them anyway so the reset is complete, but note that doing so means switching off `trg_access_log_append_only` — the very control R16 exists to verify. That is acceptable for dropping sample data and unacceptable for anything else; step 8 checks both triggers are back on.

```sql
-- 1. Identify the sample transactions
CREATE TEMP TABLE doomed AS
SELECT id FROM ttr.transactions WHERE transaction_ref LIKE 'REG-%';

-- 2. Record the object paths BEFORE deleting anything — this is the only record of what
--    to remove from the 'compliance-media' bucket, and SQL cannot remove them for you.
SELECT object_path FROM ttr.stored_images WHERE transaction_id IN (SELECT id FROM doomed);

-- 3. Report links, then ONLY the batches this cleanup empties (a blanket
--    "delete batches with no transactions" would take unrelated ones with it).
CREATE TEMP TABLE touched_batches AS
SELECT DISTINCT batch_id FROM ttr.transaction_reports
 WHERE transaction_id IN (SELECT id FROM doomed);

DELETE FROM ttr.transaction_reports WHERE transaction_id IN (SELECT id FROM doomed);

DELETE FROM ttr.report_batches b
 WHERE b.id IN (SELECT batch_id FROM touched_batches)
   AND NOT EXISTS (SELECT 1 FROM ttr.transaction_reports tr WHERE tr.batch_id = b.id);

-- 4. Verification rows first — they hold the FKs onto stored_images.
DELETE FROM ttr.id_verifications WHERE transaction_id IN (SELECT id FROM doomed);

-- 5. Clear the supersede self-reference, then the image rows.
--    (Skip the UPDATE if 20260727000001 is not applied yet — the columns won't exist.
--     It is a no-op on data captured before that migration anyway.)
UPDATE ttr.stored_images SET superseded_at = NULL, superseded_by_image_id = NULL
 WHERE transaction_id IN (SELECT id FROM doomed);

DELETE FROM ttr.stored_images WHERE transaction_id IN (SELECT id FROM doomed);

-- 6. Bypass the completion lock, delete (everything else cascades), restore it
ALTER TABLE ttr.transactions DISABLE TRIGGER trg_lock_completed;
DELETE FROM ttr.transactions WHERE id IN (SELECT id FROM doomed);
ALTER TABLE ttr.transactions ENABLE  TRIGGER trg_lock_completed;

-- 7. Prove it is clean — all must return 0
SELECT count(*) FROM ttr.transactions WHERE transaction_ref LIKE 'REG-%';
SELECT count(*) FROM ttr.id_verifications
 WHERE upper(btrim(document_number)) IN ('RGN-111222','PRG-998877','CLB-334455');

-- 8. Prove the lock is back on — a disabled trg_lock_completed silently removes the
--    immutability guarantee the rest of the system depends on, and nothing else warns you.
SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_lock_completed';  -- must be 'O'
```

Then delete the objects listed in step 2 from `compliance-media`.

**Cast:** the same regression cast defined above, reused now the data is genuinely gone. New reference prefix `FIX-`, so a stray `REG-` row is never ambiguous. Country `AU` throughout; any small JPG works as a placeholder.

### F1 ▶ Run — first-time capture (control, and the #9/#11 baseline)

- **Start Transaction**: scenario `Sell bullion to customer`; transactionRef `FIX-001`; dateTime prefilled.
- **Customer Search → Create new customer** (Individual): firstName `Regina`, middleName `Mae`, lastName `Testworth`, dateOfBirth `1983-05-12`, phone `0400123123`, email `regina.testworth@example.test`. Select her, Continue.
- **Transaction Details**: Cash currency `AUD`; cashAmount `14000`.
- **Party Details**: fullName `Regina Mae Testworth`; dateOfBirth `1983-05-12`; resStreet `14 Regress Rd`; resSuburb `Preston`; resState `VIC`; resPostcode `3072`; resCountry `Australia`; postal-different unchecked; phone `0400123123`; occupation `Florist`; gender `F`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`.
- **Conducting Person**: hasConductingPerson **No**.
- **ID Verification**: verificationMethod `Sighted original document`; documentType `Driver licence`; documentNumber `RGN-111222`; issuer `VicRoads`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2030-05-12`; capture front **and** back.
  - **Expect:** no "Reason for taking a new copy" field anywhere. First-time customer, nothing duplicated. If a reason is demanded here, #8's option-narrowing is over-firing.
- **Recipient & Delivery**: recipientIsParty **Yes**; recipient `Regina Mae Testworth`; purpose `Collecting bullion`; delivery method `Collected`.
- **Bullion Details** — Item 1: metalType `Gold`; productType `Bar`; purity `999.9`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `14000`; description `1kg gold bar`.
- **Review & Submit**: **Complete**.

### F2 ▶ Run ⚠ — same document re-captured: #11 pre-fill, #9 supersede

- **Start Transaction**: scenario `Buy bullion from customer`; transactionRef `FIX-002`.
- **Customer Search**: Individual — firstName `Regina`, lastName `Testworth`, dateOfBirth `1983-05-12` — select the **existing** record.
- **Transaction Details**: Cash currency `AUD`; cashAmount `11000`.
- **Party Details**: confirm carried over unchanged.
- **Conducting Person**: **No**.
- **ID Verification**:
  1. Reliance auto-selects on her licence. Switch to `Sighted original document` — type, number, issuer clear.
  2. Select documentType `Driver licence` and documentNumber `RGN-111222`, tab out.
  3. **Expect** three options, and the helper text now **names the owner** — *"…already on file for Regina Mae Testworth (DOB 12/05/1983)…"*. Same person, so all three stay offered.
  4. Select `Stored copy is unclear`.
  5. **#11 — expect expiry pre-filled `Yes` / `2030-05-12`.** Do not retype it.
  6. Capture front **and** back.
- **Recipient & Delivery**: recipientIsParty **Yes**; purpose `Dropping off bullion`; delivery method `Collected`.
- **Bullion Details** — Item 1: `Silver` / `Bar` / `999` / qty `1` / `1` kg / unitPrice `11000`.
- **Review & Submit**: **Complete**.

```sql
-- #9: FIX-001's images superseded by FIX-002's, metadata retained
SELECT t.transaction_ref, si.superseded_at IS NOT NULL AS superseded,
       si.content_hash_sha256 IS NOT NULL AS hash_retained
  FROM ttr.stored_images si
  JOIN ttr.transactions t ON t.id = si.transaction_id
 WHERE t.transaction_ref IN ('FIX-001','FIX-002') ORDER BY si.captured_at;
-- FIX-001 rows: superseded = true,  hash_retained = true   (row kept, object gone)
-- FIX-002 rows: superseded = false, hash_retained = true

-- #11: both rows agree on expiry
SELECT t.transaction_ref, idv.new_capture_reason, idv.expiry_date
  FROM ttr.id_verifications idv JOIN ttr.transactions t ON t.id = idv.transaction_id
 WHERE upper(btrim(idv.document_number)) = 'RGN-111222' ORDER BY idv.created_at;
-- FIX-001 | NULL                | 2030-05-12
-- FIX-002 | stored_copy_unclear | 2030-05-12   ← was NULL before the fix
```

**Then check the bucket.** FIX-001's two objects must be **gone** from `compliance-media` while their `stored_images` rows remain. That pairing is the entire design.

### F3 ▶ Run ⚠ critical — #8, a different person cannot link

The case R19 could never pass. Abandon the draft afterwards.

- **Start Transaction**: scenario `Buy bullion from customer`; transactionRef `FIX-003`.
- **Customer Search → Create new customer** (Individual): firstName `Barry`, lastName `Doubleton`, dateOfBirth `1979-09-30`, phone `0400456456`, email `barry.doubleton@example.test`.
- **Transaction Details**: Cash currency `AUD`; cashAmount `10500`.
- **Party Details**: fullName `Barry Doubleton`; dateOfBirth `1979-09-30`; resStreet `27 Repeat St`; resSuburb `Thornbury`; resState `VIC`; resPostcode `3071`; resCountry `Australia`; phone `0400456456`; occupation `Mechanic`; gender `M`; citizenshipCountryCode `AU`; taxResidencyCountryCode `AU`.
- **Conducting Person**: **No**.
- **ID Verification**: documentType `Driver licence` and documentNumber `RGN-111222`, tab out.
  1. **⚠ The fix — expect exactly ONE option: `Different person who shares this document number`.** `ID has changed (e.g. renewed licence)` and `Stored copy is unclear` must both be **absent**. Their presence is #8 unfixed.
  2. **Expect** the helper text to name Regina and her DOB, and to say the record is a different person's. Without that, `different_person` is a guess rather than the assertion it is meant to record.
  3. Select `Different person who shares this document number`, capture front and back, continue.
  4. **Expect:** it saves, **unlinked**.
- **Abandon the draft** (Cancel) after the SQL below.

```sql
SELECT p.last_name, idv.new_capture_reason,
       idv.prior_verification_id IS NOT NULL AS linked
  FROM ttr.id_verifications idv JOIN ttr.parties p ON p.id = idv.party_id
 WHERE upper(btrim(idv.document_number)) = 'RGN-111222' ORDER BY idv.created_at;
-- Doubleton → different_person | linked = false.  Any linked Doubleton row is #8 unfixed.
```

### F4 ✓ Check ⚠ — #8's trigger, reachable only from SQL

The UI can no longer produce a cross-person link, so prove the database refuses one independently. If only the UI had been fixed, every case above would still pass. Substitute the two verification ids:

```sql
UPDATE ttr.id_verifications
   SET new_capture_reason = 'id_changed',
       prior_verification_id = '<Regina FIX-002 idv id>'
 WHERE id = '<Barry FIX-003 idv id>';
-- MUST raise: re-capture links to a record for a different person (date of birth … vs …)
```

A success here means the invariant is unenforced.

### F5 ▶ Run — #11's counterexample: a renewal must NOT inherit the expiry

- **Start Transaction**: scenario `Sell bullion to customer`; transactionRef `FIX-004`.
- **Customer Search**: select the existing **Regina Mae Testworth**.
- **Transaction Details**: Cash currency `AUD`; cashAmount `13000`.
- **Conducting Person**: **No**.
- **ID Verification**: switch off reliance; documentType `Driver licence` and `RGN-111222`, tab out; select `ID has changed (e.g. renewed licence)`.
  - **⚠ Expect `Is there an expiry date?` to be BLANK**, not pre-filled with `2030-05-12`. A renewal moves the expiry, so inheriting the old one would be wrong — this is what makes #11's fix reason-aware rather than blanket.
  - Enter hasExpiry `Yes`, expiryDate `2035-05-12`. Capture front and back.
- **Recipient & Delivery**: recipientIsParty **Yes**; purpose `Collecting bullion`; delivery `Collected`.
- **Bullion Details** — Item 1: `Gold` / `Bar` / `999.9` / qty `1` / `1` kg / unitPrice `13000`.
- **Review & Submit**: **Complete**.
- **Expect:** FIX-002's images are now superseded in turn, leaving FIX-004's as the only live pair.

### F6 ▶ Run — #10, the conducting person's date of birth

- **Start Transaction**: scenario `Sell bullion to customer`; transactionRef `FIX-005`.
- **Customer Search → Create new customer** (Company): entityName `Wilma Wholesale Pty Ltd`; abnAcn `55667788990`; suburb `Carlton`; companyPhone `0392223333`; companyEmail `accounts@wilmawholesale.example.test`.
- **Transaction Details**: Cash currency `AUD`; cashAmount `15000`.
- **Party Details**: entityName `Wilma Wholesale Pty Ltd`; legalForm `Company`; bizStreet `9 Trade Pl`; bizSuburb `Carlton`; bizState `VIC`; bizPostcode `3053`; bizCountry `Australia`; companyPhone `0392223333`; registration identifier type `ABN`, value `55667788990`; principalActivity `Metal wholesaling`.
- **Conducting Person**: hasConductingPerson **Yes**; representedPartyId `Wilma Wholesale Pty Ltd`; fullName `Colin Broker`; dobKnown **Yes**; **leave dateOfBirth blank**; resStreet `5 Agent Ave`; resSuburb `Carlton`; resState `VIC`; resPostcode `3053`; resCountry `Australia`; phone `0400789789`; occupation `Broker`; relationship `Agent`; authorityToAct `Authorised to transact on behalf of Wilma Wholesale Pty Ltd.`; isEmployee **No**; actingViaEntity **No**. Click Continue.
  1. **⚠ The fix — expect an inline field error on Date of birth**, the page **stays put**, and **no uncaught error in the browser console**. Before the fix this failed silently with a raw `23514` in the console and nothing on screen.
  2. Enter dateOfBirth `1986-02-14` and Continue — now succeeds.
  3. Navigate **back** to this page. "Is date of birth known?" must still read **Yes** and the date must still be `1986-02-14` (guards the fix #4/#5 read-path regression).
- **ID Verification** (Colin only — company parties get no ID record): documentType `Passport`; documentNumber `CLB-334455`; issuer `Australian Passport Office`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2031-02-14`; capture front.
- **Recipient & Delivery**: recipientIsParty **Yes**; recipient `Wilma Wholesale Pty Ltd`; purpose `Collecting bullion`; delivery `Collected`.
- **Bullion Details** — Item 1: `Platinum` / `Bar` / `999.5` / qty `1` / `1` kg / unitPrice `15000`.
- **Review & Submit**: **Complete**.

### F7 ▶ Run — regression: the ordinary reliance path is untouched

- **Start Transaction**: scenario `Sell bullion to customer`; transactionRef `FIX-006`.
- **Customer Search**: select the existing **Regina Mae Testworth**.
- **Transaction Details**: Cash currency `AUD`; cashAmount `10000`.
- **Conducting Person**: **No**.
- **ID Verification**: **change nothing.** Reliance auto-selects; reason reads `Prior ID reviewed and still valid`; **no** "Reason for taking a new copy" field; no camera section. **Expect the prior record's images to render** — they must be FIX-004's surviving pair, not a broken thumbnail pointing at a superseded object. Tick "I confirm the person presenting today matches these ID images".
- **Recipient & Delivery**: recipientIsParty **Yes**; purpose `Collecting bullion`; delivery `Collected`.
- **Bullion Details** — Item 1: `Gold` / `Bar` / `999.9` / qty `1` / `1` kg / unitPrice `10000`.
- **Review & Submit**: **Complete**.

That thumbnail check is the likeliest place #9 breaks something adjacent: an older verification row still points at an image whose object is gone, and that must resolve to nothing rather than a dead link.

### F8 ✓ Check — final state, all four findings at once

```sql
-- #9: exactly ONE live image pair per document, however many captures happened
SELECT idv.document_type, upper(btrim(idv.document_number)) AS doc,
       count(*) FILTER (WHERE si.superseded_at IS NULL) AS live_images,
       count(*)                                        AS total_image_rows
  FROM ttr.id_verifications idv
  JOIN ttr.stored_images si ON si.id IN (idv.front_image_id, idv.back_image_id)
 GROUP BY 1, 2;
-- RGN-111222 → live_images = 2 (front+back), total_image_rows = 6
-- CLB-334455 → live_images = 1 (front only), total_image_rows = 1

-- #8 + #11: the full picture
SELECT t.transaction_ref, p.last_name, idv.new_capture_reason, idv.reliance_reason,
       idv.prior_verification_id IS NOT NULL AS linked, idv.expiry_date
  FROM ttr.id_verifications idv
  JOIN ttr.transactions t ON t.id = idv.transaction_id
  LEFT JOIN ttr.parties p ON p.id = idv.party_id
 WHERE upper(btrim(idv.document_number)) = 'RGN-111222' ORDER BY idv.created_at;
-- FIX-001 | Testworth | NULL                | NULL                          | false | 2030-05-12
-- FIX-002 | Testworth | stored_copy_unclear | NULL                          | true  | 2030-05-12
-- FIX-004 | Testworth | id_changed          | NULL                          | true  | 2035-05-12
-- FIX-006 | Testworth | NULL                | prior_id_reviewed_still_valid | true  | (reliance)
-- No Doubleton row — FIX-003 was abandoned. One present AND linked means #8 regressed.
```

Finally re-run **R24/R25** for the `FIX-` transactions' date: the generator reads `id_verifications`, and both #9 and #11 change what is stored there, so confirm the XML is still schema-valid under `XMLSchema11`.

---

### F9 ▶ Run — entry order no longer matters (#14)

Start any transaction for **Regina** and at ID Verification switch off reliance, then enter the document **number first**, tab out, and only then choose documentType `Driver licence`.

- **Expect** the collision to be found anyway: the reason list narrows to three and the helper text names the record on file. Before #14 was fixed the number-first order silently found nothing, and the resulting unlinked row could not save — which is how #12's dead end was reached.

Abandon the draft afterwards (which also exercises #13).

### F10 ▶ Run ⚠ critical — a failed save can be retried (#12)

The case that matters most in this phase, because failure here used to be terminal. Uses a realistic failure rather than a contrived one.

- Start any transaction, reach **ID Verification**, and capture front and back so Continue is ready.
- Open **DevTools → Network → Offline**.
- Click **Continue**. Expect an on-screen error (not a blank freeze).
- Switch back to **Online**.
- Click **Continue** again.
- **Expect it to succeed and move to Recipient & Delivery.** No *"An image for this person/side already exists"*, and no second upload of the same photo.

Confirm the record points at exactly one image pair, not a duplicated or orphaned set:

```sql
SELECT count(*) AS image_rows
  FROM ttr.stored_images
 WHERE transaction_id = '<the transaction id>';
-- 2 for a driver licence (front + back). More means the retry re-uploaded.
```

If instead you see the "already exists" message, #12 has regressed and the operator is stuck again — stop and report it.

### F11 ▶ Run — Cancel works on a draft holding ID photos (#13)

The escape hatch of last resort, and it was broken.

- Start a transaction, reach ID Verification, capture front and back, then **Cancel** (exit the wizard and confirm).
- **Expect** it to succeed with no error, and to land back on `/start`.

```sql
-- All three must return 0 for that transaction id
SELECT count(*) FROM ttr.transactions     WHERE id = '<id>';
SELECT count(*) FROM ttr.stored_images    WHERE transaction_id = '<id>';
SELECT count(*) FROM ttr.id_verifications WHERE transaction_id = '<id>';
```

Also confirm the transaction's folder is gone from `compliance-media`. A *"Failed to delete transaction record"* error means #13 has regressed.

### F12 ▶ Run ⚠ critical — the reconciliation sweep (#17)

**Why this must be manual.** The sweep's person-safety lives in `ttr.find_unsuperseded_duplicates`'s `PARTITION BY chain_root`, which is SQL and cannot be exercised by a Deno unit test. The automated tests prove the function acts correctly on whatever the RPC returns; only this case proves the RPC returns the right thing. Given finding #15 deleted an innocent customer's ID images, that distinction matters.

**Set up one of each drift class in dev.** Note the ids as you go.

1. **Un-superseded duplicate (class 3)** — take a completed licence chain (F1/F2/F5's `RGN-111222`) and un-stamp one superseded row, so it looks like a supersede that never completed:
   ```sql
   UPDATE ttr.stored_images SET superseded_at = NULL, superseded_by_image_id = NULL
    WHERE id = '<one already-superseded image id for RGN-111222>';
   ```
2. **Orphaned object (class 1)** — delete a `stored_images` row and leave its object in the bucket. Delete the `id_verifications` row first if it references the image.
3. **Missing object (class 2)** — delete an object from `compliance-media` and leave its row, `superseded_at` still null.
4. **Dangling folder (class 4)** — create a folder in the bucket named for a UUID that is not in `ttr.transactions`, with one file in it.
5. **A different person's capture** — confirm Barry's `different_person` row for `RGN-111222` still holds live images. **This is the one that matters.**

**Run the dry-run.** POST `{"apply": false, "full": true}` to `reconcile-stored-images`.

- **Expect** the report to name exactly the four things you created — and **not** Barry's images anywhere in `unsupersededCopies`. If Barry's image ids appear, the RPC is grouping on the wrong key and **stop immediately**: applying it would delete a customer's identification.
- **Expect** `mode: "dry-run"` and every `deleted` / `superseded` count at **0**.

**Then apply.** POST `{"apply": true, "full": true}`.

- Classes 1 and 4: objects gone from the bucket.
- Class 3: object gone, row stamped with `superseded_at` and `superseded_by_image_id`.
- Class 2: **still reported, still untouched** — the row must survive, because it is the only remaining proof that document was sighted.
- Barry's images: **untouched**, in both storage and metadata.

```sql
-- Every stored_images row must still exist — the sweep never deletes rows
SELECT count(*) FROM ttr.stored_images;   -- unchanged from before the run

-- And the standing §3 invariant must now return no rows
SELECT coalesce(idv.prior_verification_id, idv.id) AS chain_root,
       count(*) FILTER (WHERE si.superseded_at IS NULL) AS live_copies
  FROM ttr.id_verifications idv
  JOIN ttr.stored_images si ON si.id IN (idv.front_image_id, idv.back_image_id)
  JOIN ttr.transactions t   ON t.id = idv.transaction_id
 WHERE idv.verification_basis = 'new_capture'
   AND t.status = 'complete'   -- drafts are work in progress; supersede runs on completion
 GROUP BY 1 HAVING count(*) FILTER (WHERE si.superseded_at IS NULL) > 2;
```

Finally confirm the leak is closed: leave a draft with captured ID photos older than `STALE_AFTER_DAYS`, run `cleanup-stale-drafts`, and check it reports `deleted` rather than `skipped`. Before #17 it skipped such drafts on every run, forever.

### If something fails

Record the case number, the exact error, and whether it was a UI message or a raw Postgres error. A raw `23505` or `duplicate key value violates unique constraint` reaching the screen is itself a finding — the collision lookup should have caught it first, and there is a mapping in `handleContinue` (on both ID Verification and Transaction Details) that should have translated it into plain English.

### Quick index

| Range | Covers | Needs |
|---|---|---|
| R1–R2 | Migrations apply, objects exist | Nothing |
| R3–R10 | MFA enrolment, challenge, the AAL1 sign-out, role gate | Two staff accounts |
| R11 | **Foundation transaction** — Regina, licence on file, report batch | R1–R2 |
| R12–R17 | Access logging: views, exports, no XML preload, append-only, admin-only reads | R11 |
| R18–R23 | One copy of ID: unclear re-capture, different person, different document, renewed licence, conducting person, lapsed window | R11 |
| R24–R26 | AUSTRAC XML still valid, reliance path still works | R11, R18 |
| R27 | Completed reference cannot be re-used on the Start page | R11 |
| F0–F8 | **Fix verification** for findings #8–#11 — cross-person links, one copy on file, conducting-person DOB, re-capture expiry | A clean dataset (F0 drops the `REG-` data) |
| F9–F11 | **Fix verification** for findings #12–#14 — entry order, recoverable save failure, working Cancel | Nothing beyond a draft you can abandon |
| F12 | **Fix verification** for #17 — the reconciliation sweep across all four drift classes, and that it spares a different person's images | A completed licence chain (F1/F2/F5) plus Barry's `different_person` row from F3 |

---

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

## Part 1C — Privacy compliance: one copy of ID on file

Separate from AUSTRAC schema validation. These exercise the privacy-policy §3 commitment — *"we keep one copy of your identification on file — not a new copy for every visit"* — implemented by `supabase/migrations/20260725000001_idv_document_uniqueness.sql` and `20260725000002_idv_capture_justification.sql`. Run **after** the reconciliation step below, and after the two migrations are applied.

What the rule actually is: a second **unlinked** capture of the same document, for the same reporting entity, is rejected outright. Re-capturing the *same* document is still allowed, but only as a **linked** re-capture that points at the record it refreshes — so it stays a tracked reuse rather than a silent duplicate.

The rule is **role-agnostic**: it covers conducting persons exactly as it covers customers, since the promise is about *your* identification and doesn't care which side of the counter you were on. It also catches the crossover case the matrix already flags at line 26 — the same real person appearing as a customer on one transaction and a conducting person on another.

Detection is keyed on the **document number**, checked when staff leave the document-number field, which is the same key the database enforces on. That matters: an escape hatch keyed on anything else (a name lookup, say) isn't guaranteed to fire when the database blocks, and every miss would be a raw constraint error with no way forward. Because the check is document-keyed it works for conducting persons, who have no name-based prior lookup at all.

Note on renewed licences: Australian driver licence *numbers* survive renewal (the card changes, the number doesn't). A renewed licence therefore collides with the record on file and is saved as a **link**, not as an independent capture. A genuinely new document number (new passport) doesn't collide and links to nothing.

### How this interacts with the re-verification window

`reporting_entities.idv_max_reliance_days` (default 730) is a separate control, and the two rules meet in four combinations. Only the shaded cell needed new behaviour:

| | **Same document as before** | **Different document** |
|---|---|---|
| **Within the window** | Reliance auto-selected. Override → `ID has changed` / `Stored copy is unclear` / `Different person` | Reliance auto-selected on the *old* document. Override → `Customer presented a different document` / `ID has changed` / `Other` |
| **Past the window** | Reliance is no longer auto-offered. **Re-sight the original** and record it, or get manager approval — either way the copy on file is reused and no second copy is taken | Nothing to reuse and nothing to duplicate: capture proceeds with no reason required |

The deliberate decision behind the bottom-left cell: a lapsed window calls for **re-sighting** the document, not re-photographing it. Staff check the original against the copy already held and record that they did, via the reliance reason `Original document re-sighted today`. That keeps exactly one copy on file, so §3 of the privacy policy stays accurate as written — no third ground for re-copying has to be disclosed. Re-photographing would have needed one.

Because a re-sighting is a reliance row, it is outside the uniqueness index by construction — the two rules never actually contend.

### Step 0 — Reset the database before migrating (this dataset WILL fail otherwise)

The transactions already completed in Part 1 contain three documents captured twice, each as an independent `new_capture`. The unique index cannot be created while they exist:

| Document | Person | Role | Captured in | Why it duplicated |
|---|---|---|---|---|
| `PA1234567` | Jane Alice Citizen | Customer | TX-A, TX-G | Re-verified on a later transaction |
| `DL987654321` | David Paul Sampleton | Customer | TX-B, TX-B2 | TX-B2 re-ran TX-B's scenario |
| `POA-11223` | Tom Employee | **Conducting person** | TX-C, TX-I | TX-I re-ran TX-C's scenario |

Two near-misses that look like duplicates in this document but are not blockers:

- `PA7654321` (Priya Agent) — appears twice here but only **once** in the database; TX-B's conducting-person step was never actually recorded (see the historical note on TX-B).
- `EVS-000123` (Sarah Austen) — appears three times but only once as a `new_capture`; TX-E2 and TX-E3 are reliance rows, which the index ignores by design.

Confirm the real state (this is the pre-flight query from the migration header — note it is not filtered by role):

```sql
SELECT t.reporting_entity_id,
       idv.document_type,
       upper(btrim(idv.document_number)) AS doc_number,
       count(*)
  FROM ttr.id_verifications idv
  JOIN ttr.transactions t ON t.id = idv.transaction_id
 WHERE idv.verification_basis = 'new_capture'
 GROUP BY 1, 2, 3
HAVING count(*) > 1;
```

**Resolution: reset and re-run.** This is fictitious UAT data and the system is not in production, so there is nothing here worth preserving at the cost of a workaround. Deleting the offending rows in place is *not* an option — those verifications belong to completed transactions already bundled into report batches, and removing them would leave those transactions generating XML with no `<identification>` block. Reset the database, apply all migrations including the two Phase 3 ones, and re-run the Part 1 matrix from TX-A.

Re-run the pre-flight query afterwards; it must return zero rows.

**Three transactions behave differently on the re-run**, because the rule they were originally captured under no longer exists:

| Transaction | Was | Now |
|---|---|---|
| **TX-G** (Jane, `PA1234567`) | Fresh capture, same passport as TX-A | ID Verification auto-selects **Relied on prior identification**. Accept it — that is the intended behaviour. Her `<identification>` becomes reliance-shaped, as already covered by TX-E2/E3 |
| **TX-B2** (David, `DL987654321`) | Fresh capture, same licence as TX-B | Same — accept the auto-selected reliance. IdType `D` still appears in the XML, since reliance retains the original document details (TC-209), so TX-B2's Agent/`agencyAuthorisation` coverage is unaffected |
| **TX-I** (Tom, `POA-11223`) | Fresh capture, same card as TX-C | Tom is a conducting person, so there is **no** auto-selected reliance — instead, entering `POA-11223` triggers the collision prompt and a reason is required. Pick **"Stored copy is unclear"** to keep a fresh image while linking to TX-C's record |

For TX-G and TX-B2, if you'd rather keep a real image capture than a reliance record, switch the method back to `Sighted original document` and select **"Stored copy is unclear"** — that stays a `new_capture` with a fresh image while linking to the original, which the index permits.

### TX-K — re-capturing the same document because the stored copy is unclear

Uses **Grace Harbour**, whose `NIC-334455` from TX-H is her only capture — a clean single record, and a physical card, which is the situation the policy wording describes.

- **Start Transaction**: scenario = Buy bullion from customer; transactionRef = `UAT-K-0011`; dateTime prefilled (after TX-J's completion time).
- **Customer Search**: search Individual — firstName `Grace`, lastName `Harbour`, dateOfBirth `1988-08-08` — select the **existing** record from TX-H.
- **Transaction Details**: Cash currency = AUD; cashAmount = `10200`.
- **Party Details**: confirm Grace's details carried over from TX-H.
- **Conducting Person**: hasConductingPerson = **No**.
- **ID Verification** (Grace Harbour) — *this is the step under test*:
  1. On load, verification method should **auto-select "Relied on prior identification"**, because her TX-H record is inside the 730-day reliance window. **No reason field is shown** — nothing is being overridden.
  2. Change verification method to `Sighted original document`. A required **"Reason for taking a new copy"** field appears, with helper text naming the ID already on file (`National identity card NIC-334455`) and its verification date.
  3. Click **Continue** without choosing a reason → blocked with *"This customer already has ID on file — give a reason for taking a new copy"*.
  4. Select **"Stored copy is unclear"**. Document type, document number and issuer **auto-fill** from the record on file (`National identity card` / `NIC-334455` / `Department of Home Affairs`) and the helper text changes to say it replaces the unclear copy rather than adding a second one.
  5. Capture front image; idCountryCode `AU`; hasExpiry `No`. Continue.
- **Recipient & Delivery**: recipientIsParty = **Yes**; recipient = Grace Harbour; purpose = `Dropping off bullion`; delivery method = `Collected`.
- **Bullion Details** — Item 1: metalType `Gold`; productType `Bar`; purity `999.9`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `10200`.
- **Review & Submit**: Complete.
- **Verify in the DB** — the new row must be a linked re-capture, *not* a reliance row:

```sql
SELECT verification_basis, new_capture_reason, reliance_reason,
       prior_verification_id IS NOT NULL AS is_linked
  FROM ttr.id_verifications
 WHERE document_number = 'NIC-334455'
 ORDER BY created_at;
-- expect row 2: new_capture | stored_copy_unclear | NULL | true
```

### TX-L — customer presents a genuinely different document

Uses **Sarah Jane Austen**, whose only `new_capture` is the `EVS-000123` electronic verification from TX-E. Here she presents a physical passport instead, so nothing is being re-captured and no link should be created.

- **Start Transaction**: scenario = Sell precious metal to customer; transactionRef = `UAT-L-0012`; dateTime prefilled (after TX-K's completion time).
- **Customer Search**: search Individual — firstName `Sarah`, lastName `Austen`, dateOfBirth `1975-01-20` — select the **existing** record.
- **Transaction Details**: Cash currency = AUD; cashAmount = `10500`.
- **Party Details**: confirm details and the alias carried over (as in TX-E3).
- **Conducting Person**: hasConductingPerson = **No**.
- **ID Verification** (Sarah Jane Austen):
  1. Change verification method from the auto-selected reliance to `Sighted original document`.
  2. Select reason **"ID has changed (e.g. renewed licence)"** — document fields stay editable and are **not** auto-filled.
  3. documentType `Passport`; documentNumber `PA5566778`; issuer `Australian Passport Office`; idCountryCode `AU`; hasExpiry `Yes`; expiryDate `2032-01-20`; capture front.
- **Recipient & Delivery**: recipientIsParty = **Yes**; recipient = Sarah Jane Austen; purpose = `Collecting precious metal`; delivery method = `Collected`.
- **Precious Metal Details** — Item 1: metalType `Gold`; quantity `1`; weight `1`; weightUnit `kilograms`; unitPrice `10500`.
- **Review & Submit**: Complete.
- **Verify**: the new row has `new_capture_reason = 'id_changed'` and `prior_verification_id IS NULL`. Sarah now legitimately has two distinct documents on file (`EVS-000123`, `PA5566778`) — the rule is one copy per *document*, not one document per person.

### Database-level checks

Run against the completed dataset. Each must be **rejected**; substitute real ids from your data.

| # | Attempt | Expected rejection |
|---|---|---|
| K-1 | Insert a second unlinked `new_capture` of `NIC-334455` for the same entity | `uq_idv_doc_new_capture` unique violation |
| K-2 | Same but with `document_number = ' nic-334455 '` | Also rejected — the index normalises via `upper(btrim(...))`, so case/whitespace is not an escape |
| K-3 | Link a re-capture to a prior verification holding a **different** document number | `re-capture must reference the prior verification of the same document` |
| K-4 | Set `prior_verification_id` with `new_capture_reason = 'other'` | `chk_idv_reliance_reason` violation — only `stored_copy_unclear` and `id_changed` may link |
| K-5 | Set `prior_verification_id` with `new_capture_reason = NULL` | `chk_idv_reliance_reason` violation (the `coalesce` in the constraint exists for exactly this case) |
| K-6 | Reliance row with `new_capture_reason` also set | `chk_idv_reliance_reason` violation — the two justification fields are mutually exclusive |
| K-7 | Insert a duplicate unlinked capture for a **conducting person** (`conducting_person_id` set, `party_id` NULL) | **Rejected** — the index is role-agnostic. This is the case the whole of Phase 3b exists for |
| K-8 | Same document captured once for a party and once for a conducting person, both unlinked | **Rejected** — one person, one copy, regardless of the role they appeared in |
| K-9 | Linked re-capture with `new_capture_reason = 'id_changed'` and an unchanged number | **Accepted** — this is the renewed-licence path |
| K-10 | Unlinked capture with `new_capture_reason = 'different_person'` on a colliding number | **Accepted** — the only value the index exempts |
| K-11 | Same as K-10 but with `'other'` | **Rejected** — the exemption is deliberately narrow, so `other` cannot be used to wave the rule away |

```sql
-- K-1 / K-2: replace <tx> and <party> with a fresh draft transaction and its party
INSERT INTO ttr.id_verifications
  (transaction_id, party_id, verification_method, document_type, document_number,
   verification_description, verification_basis)
VALUES ('<tx>', '<party>', 'Sighted original document', 'National identity card',
        ' nic-334455 ', 'duplicate attempt', 'new_capture');
```

### TX-M — the conducting-person case this rule exists for

Uses **Tom Employee**, whose `POA-11223` proof-of-age card is captured as a conducting person in both TX-C and TX-I. He has no name-based prior lookup, so the document-number collision is his only route to reuse.

- Run TX-I exactly as documented, up to the ID Verification step for Tom.
- Select `Sighted original document`, document type `Proof of age card`, then type `POA-11223` and tab out of the field.
- **Expect:** the "Reason for taking a new copy" field appears, naming `POA-11223` as already on file and offering only `ID has changed` / `Stored copy is unclear` / `Different person…`. Note there is no auto-selected reliance here, unlike a returning customer — that difference is by design.
- Select **"Stored copy is unclear"**, capture a front image, and complete the transaction.
- **Verify:**

```sql
SELECT idv.verification_basis, idv.new_capture_reason,
       idv.prior_verification_id IS NOT NULL AS is_linked,
       idv.party_id IS NULL AS is_conducting_person
  FROM ttr.id_verifications idv
 WHERE idv.document_number = 'POA-11223'
 ORDER BY idv.created_at;
-- expect row 2: new_capture | stored_copy_unclear | true | true
```

### TX-N — customer presents a different document than last time

Uses **Jane Alice Citizen**, whose passport `PA1234567` is on file from TX-A. Today she hands over a driver licence instead. This is the common case — people carry whatever ID they have.

- Start any transaction and select Jane via Customer Search.
- At ID Verification, note that reliance is **auto-selected** on her passport, with `PA1234567` pre-filled.
- Switch the method to `Sighted original document`.
- **Expect:** the document type and number fields are **cleared**. They described the passport, and leaving them would let a licence photo be filed under `PA1234567`. (This was the behaviour before the fix — check it explicitly.)
- Enter document type `Driver licence`, number `DL111222333`, tab out. No collision fires — that number has never been seen.
- **Expect:** the reason field offers `Customer presented a different document` / `ID has changed` / `Other`. Select the first.
- Capture front and back, complete the transaction.
- **Verify:** Jane now has two documents on file, each with one copy. The rule is one copy per *document*, not one document per person.

```sql
SELECT idv.document_type, idv.document_number, idv.new_capture_reason,
       idv.prior_verification_id IS NOT NULL AS is_linked
  FROM ttr.id_verifications idv
  JOIN ttr.parties p ON p.id = idv.party_id
 WHERE lower(p.last_name) = 'citizen'
 ORDER BY idv.created_at;
-- expect: Passport PA1234567 (no reason, unlinked)
--         Driver licence DL111222333 (different_document, unlinked)
```

### TX-O — re-verification window has lapsed

Needs a prior verification older than the entity's `idv_max_reliance_days`. Either set that value low on the reporting entity for the test, or back-date an existing verification's `created_at`.

- Start a transaction for a customer whose only ID record is now outside the window, and reach ID Verification.
- **Expect:** the prior is shown with a `✕ Blocked` badge and is **not** auto-selected.
- Select `Relied on prior identification`, then pick the blocked record from the picker.
- **Expect:** the reason list offers exactly `Original document re-sighted today` and `Manager approved reliance` — nothing else. The notice explains the window has lapsed and states that no second copy is taken.
- Choose `Original document re-sighted today`, confirm the image matches, and complete.
- **Verify:** the new row is `relied_on_prior_identification` with `reliance_reason = 'original_document_resighted'`, and **no new image** was stored. Confirm the customer still has exactly one copy of that document on file.

### Regression

- **Switching away from reliance clears the prior's identifiers** (covered in TX-N, worth checking wherever it appears): any time the method changes from `Relied on prior identification` to a capture method, the document type/number/issuer must blank out. Before this fix they persisted, so a different document could be captured against the number already on file.
- **TX-K, TX-L, TX-M and TX-N all generate valid AUSTRAC XML.** A `stored_copy_unclear` re-capture is a `new_capture` with a real image, so it must appear as a normal `<identification>` block — **not** as a reliance-based one. Confirm TX-K's XML carries the freshly captured document details and a `countryCode` (unlike the OVS/reliance path noted in fix #7).
- **TX-I's employee-role fold still works** (fix #5) — the conducting-person change must not disturb `<agencyAuthorisation>`.
- **Reliance still works unchanged** — re-run the TX-E3 flow (reliance on `EVS-000123`) and confirm it is unaffected by the new constraint, since reliance rows are excluded from the index.
- **First-time customers are unaffected** — run any brand-new individual through end to end; no reason field should ever appear.
- **Conducting-person draft reload** — on the Conducting Person page set "Is date of birth known?" to **Yes**, save, navigate away and back. The answer must still show Yes. (It reset to unselected before this pass; same string/boolean class as fixes #4 and #5, missed on the read path.)

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

0. **Part 0** — after a `db reset`, work the lean regression checklist. This is the routine pass and the one to repeat; the sections below are the deeper one-off validations.
1. **Part 1** — run TX-B2, TX-E3, TX-I, and TX-J (the only transactions not yet completed as of this writing); A–H, E2 are already done.
2. **Part 1C** — reset the database (Step 0), apply all migrations including the three Phase 3 ones, re-run the Part 1 matrix, then run TX-K through TX-O and the database-level checks. The reset must happen before the migrations, or the unique index will fail to create against the existing duplicates.
3. **Part 2** — offline XSD validation of all batches, including the fresh ones from TX-B2/TX-E3/TX-I/TX-J/TX-K/TX-L. Use a real XSD 1.1-capable validator (e.g. Python's `xmlschema` package) — `xmllint`/.NET's `System.Xml.Schema` don't support the `xs:assert` conditional rules this schema relies on and will falsely report every file as valid.
4. Prod deploy.
5. **Part 3** — AUSTRAC acceptance confirmation, only after prod deploy.

## Verification

- TX-B2, TX-E3, TX-I, and TX-J each reach `/review` with the green "ready to complete" banner and complete successfully.
- TX-B2's generated XML shows the Agent/`agencyAuthorisation` structure TX-B was meant to prove; TX-E3's shows `<altName>` without having re-entered the alias; TX-I's shows `employee_role` folded into `<agencyAuthorisation>`, and its draft-reload check confirms "Is employee?" survives a page reload; TX-J's shows `isExpressTrust`/`trustDetails` correctly, with no participant/beneficiary elements.
- Regenerating any existing batch (A–H, E2) shows fix #7's other 3 bugs resolved too, even without a dedicated new transaction for them: every individual's `isAbnHolder`/`abn` are now absent (not just "N"), every OVS identification (Sarah Austen's, reused in TX-E/E2/E3) no longer carries a `countryCode`, and every `<ttr id>` is now prefixed `ttr-` regardless of what the underlying transaction UUID starts with.
- Every batch's XML (including regenerated ones) validates cleanly against the AUSTRAC XSD via Part 2 — including the `xs:assert` business rules, not just structure/types.
- No file is uploaded to AUSTRAC Online until Part 3's confirmation step is satisfied.
