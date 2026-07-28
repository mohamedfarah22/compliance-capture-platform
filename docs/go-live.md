# Production go-live checklist

**Khalij Gold and Diamonds** · Seller ID & Purchase Records · launch date: ________ · commit: ________

**Prerequisite: [dev-test-sheet.md](dev-test-sheet.md) fully signed off.** That sheet proves the *behaviour* is correct. This one proves the *production environment* is configured and deployed correctly — a much shorter job, because it deliberately does not re-test logic already established in dev.

What can only be proven here: that every migration and function actually arrived, that the project is hosted where the privacy policy says it is, that MFA works with real accounts on a new project, and that a transaction can be completed and filed end to end.

**Do not launch with any item red.** §4's gap register is the only place "not done" is acceptable, and it needs the compliance owner's signature.

---

## 1 · Environment and deployment

### 1.1 Migrations arrived

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

☐ **All eight `t`.** `two grounds only` false means the §3 restriction is missing and the app can offer a reason the published policy forbids.

### 1.2 Immutability triggers enabled

```sql
SELECT tgname, tgenabled = 'O' AS enabled FROM pg_trigger
 WHERE tgname IN ('trg_lock_completed','trg_access_log_append_only','trg_audit_append_only');
```

☐ All `true`. A disabled trigger silently removes the tamper-evidence §4 promises, and nothing else reports it.

### 1.3 All eight functions deployed, from the launch commit

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

☐ All eight. **This is the item most likely to be missed and its failure is silent** — a stale `complete-transaction` disables the whole of §3 while every screen looks correct. It caused two false failure reports during dev testing.

### 1.4 Frontend built and deployed from the same commit

☐ Same commit as 1.3. The §3 reason list and the ID-capture recovery fixes are frontend-only; a stale bundle reintroduces the dead-end where staff can neither continue nor cancel.

### 1.5 Data residency — a factual claim to customers

☐ Supabase project region is **Australian** (`ap-southeast-2` or `ap-southeast-4`). Region: ________

§4 tells customers their information *"is stored in a data centre located in Australia."* This is the only item on this list that cannot be fixed after launch without migrating the project.

### 1.6 Storage bucket

☐ `compliance-media` exists, is **private** (not public), and its policies are applied
☐ Bucket is **empty** — no dev artefacts

### 1.7 Reporting entity configured

```sql
SELECT austrac_account_number, idv_max_reliance_days, idv_block_on_expired,
       name, address_line, suburb, state, postcode
  FROM public.reporting_entities;
```

☐ 9-digit AUSTRAC account number — becomes `<reAustracAccountNumber>` in every report
☐ `idv_max_reliance_days` = **730**
☐ Entity address correct — it becomes `<txnLocation>` on every transaction

### 1.8 Scheduled functions

☐ `cleanup-stale-drafts` scheduled (daily)
☐ `reconcile-stored-images` scheduled with **`{"apply": false}`** — dry-run only. See gap G6; enable `apply` after reviewing one report against real data
☐ `generate-austrac-report` scheduling decided and recorded: ________

### 1.9 Staff accounts

☐ One `admin` and at least one `staff` account created, each with an individual login
☐ **No shared accounts** — §4 states this explicitly
☐ TOTP enabled in the Supabase dashboard for this project (`[auth.mfa]` in `config.toml` configures the *local* stack only)

---

## 2 · MFA and access control

**Must be re-run here.** Enrolment lives in `auth.users`, so dev results do not carry over to a new project with new accounts, and TOTP is per-project configuration.

| # | Do this | Must happen | ✓ |
|---|---|---|---|
| 2.1 | Sign in with an account that has never enrolled | Redirected to `/mfa` with a QR code; the wizard is unreachable | ☐ |
| 2.2 | Scan it and enter the code | Lands on `/start`. The authenticator entry reads **"Compliance Capture Platform"**, not a hostname | ☐ |
| 2.3 | Sign out, sign in again | Code entry only — no QR, no re-enrolment | ☐ |
| 2.4 | Enter `000000` | Rejected, stays on `/mfa` | ☐ |
| 2.5 ⚠ | Stop at `/mfa` without entering a code, then type `/reports` in the address bar | Bounced to the **sign-in screen** and the session is **ended** — the password must be entered again. Not offered the code entry as a shortcut | ☐ |
| 2.6 | Immediately after 2.5, interact with another open tab | Also signed out. Ending the session is global — the intended cost | ☐ |
| 2.7 | While signed out, open `/reports` directly, then complete both factors | `/login` → `/mfa` → lands on **`/reports`**. The requested page survives both steps | ☐ |
| 2.8 | As the non-admin account, complete MFA and open `/reports` | "You are not authorised to view this page" — the role check still runs after MFA | ☐ |
| 2.9 | As a fully signed-in user, hard-refresh a protected page | You stay put — the sign-out fires only for genuinely half-authenticated sessions | ☐ |

*Known and accepted:* a password-only token can still call the Supabase REST API directly via curl or Postman. DB-level AAL2 hardening was deliberately deferred.

---

## 3 · Production smoke test

Not a re-run of dev. One real transaction through the live environment, plus the checks that only production data can satisfy. Use a **real transaction you would file anyway**, or a clearly-marked test one you are content to leave in the record — remember completed transactions are immutable and cannot be deleted.

| # | Check | Must happen | ✓ |
|---|---|---|---|
| 3.1 | Complete one transaction end to end: create a customer, capture ID front and back, complete | Completes with no error | ☐ |
| 3.2 | On that customer's ID Verification step, before completing | **No "Reason for taking a new copy" field** — first-time customer, nothing duplicated | ☐ |
| 3.3 | Start a second transaction for the **same** customer | Reliance auto-selects; **the stored ID images render**. Confirms storage, signed URLs and access logging are all wired | ☐ |
| 3.4 | Switch that second one to `Sighted original document`, re-enter the same document number, tab out | Reason field narrows to three options, helper text names the customer, and **`Other` is absent** — the §3 restriction is live | ☐ |
| 3.5 ⚠ | Capture front and back, go **offline** in DevTools, Continue, back online, Continue again | Succeeds. No *"An image for this person/side already exists"*. Staff can recover from a dropped connection at the counter | ☐ |
| 3.6 | Complete it, then check the images | Exactly **one live pair** for that document; the first transaction's objects are gone from the bucket, its rows retained | ☐ |
| 3.7 | Start a third transaction, capture photos, then **Cancel** | Deletes cleanly, no error, bucket folder gone | ☐ |
| 3.8 | Re-enter the first transaction's reference on `/start` | *"This reference belongs to a completed transaction and cannot be reused."* | ☐ |
| 3.9 | Trigger `generate-austrac-report` for today | A batch is produced covering the completed transactions | ☐ |
| 3.10 ⚠ | Validate that batch against the XSD with **`xmlschema.XMLSchema11`**, plus both negative controls | 0 errors; each control reports exactly 1. Without the controls you cannot tell a valid file from a validator that checked nothing | ☐ |
| 3.11 | Open `/review-batch/<id>` fresh with DevTools → Network | **No `xml_content`** in the `report_batches` response | ☐ |
| 3.12 | Click **Download XML** | Downloads; an `export` row appears in `ttr.access_log` | ☐ |
| 3.13 | As the non-admin account, `SELECT * FROM ttr.access_log;` | 0 rows | ☐ |

Then the standing §3 invariant — **must return no rows**:

```sql
SELECT coalesce(idv.prior_verification_id, idv.id) AS chain_root,
       count(*) FILTER (WHERE si.superseded_at IS NULL) AS live_copies
  FROM ttr.id_verifications idv
  JOIN ttr.stored_images si ON si.id IN (idv.front_image_id, idv.back_image_id)
  JOIN ttr.transactions t   ON t.id = idv.transaction_id
 WHERE idv.verification_basis = 'new_capture'
   AND t.status = 'complete'   -- drafts are work in progress; supersede runs on completion
 GROUP BY 1 HAVING count(*) FILTER (WHERE si.superseded_at IS NULL) > 2;
```

☐ No rows. Keep this query — it is the machine-checkable form of *"we keep one copy of your identification on file"*, and it is worth running periodically, not just today.

---

## 4 · Accepted gaps

**These are compliance decisions, not engineering ones.** Each needs the compliance owner's signature in §6.

| # | Gap | Risk on day one | Interim control | Owner | Due |
|---|---|---|---|---|---|
| G1 | §6 automated 7-year deletion is not implemented | **None for seven years** — no record can mature before then | Build well before the first records mature. Track the earliest `completed_at` | | |
| G2 | §6 dormant-customer image eligibility not implemented | Same as G1 | Same as G1 | | |
| G3 | §7 access request has no export tooling | A request can arrive in week one | Privacy Officer runbook, §5 | | |
| G4 | §7 correction has no in-system mechanism | Same as G3 | Runbook + register. "Preserves the original" is **procedural, not technical** | | |
| G5 | Completed transactions' **child rows** are mutable, with no change history | Not reachable through the app — the wizard cannot reopen a completed transaction | Restrict direct database access to the Privacy Officer; register records before/after | | |
| G6 | Reconciliation sweep runs **dry-run only** | Drift is detected but not healed | Review one report, then enable `apply` | | |

**On G5.** `trg_lock_completed` protects the `ttr.transactions` row. Its children — `parties`, `id_verifications`, `bullion_items`, `conducting_persons`, `recipient_deliveries`, `precious_metal_items` — carry no immutability trigger and retain no prior value. §4 says *"any correction preserves the original"* and §7 promises corrections are possible; together those require an **append-only change history**, which does not exist. Until it does, the register supplies the "preserves the original" half. It is also what makes the §7 correction procedure possible at all.

---

## 5 · Privacy Officer runbook (§7)

This stands in for the tooling G3 and G4 describe. Both procedures require identity verification first, and both must be recorded in the **Privacy Officer register** with date, requester, what was provided or changed, and by whom. §7 and §9 commit to a response *"normally within 30 days"*. Policy Part C's escalation rule applies.

### 5a · Access request — "what do you hold about me?"

Substitute surname, given name and date of birth.

```sql
-- 1. Every party snapshot for this person, across all transactions
SELECT p.id, p.transaction_id, p.first_name, p.middle_name, p.last_name, p.date_of_birth,
       p.res_street, p.res_suburb, p.res_state, p.res_postcode, p.occupation, p.created_at
  FROM ttr.parties p
 WHERE lower(p.last_name) = lower('SURNAME')
   AND lower(p.first_name) = lower('GIVEN')
   AND p.date_of_birth = 'YYYY-MM-DD';

-- 2. The transactions those snapshots belong to
SELECT t.transaction_ref, t.transaction_datetime, t.scenario, t.aud_value, t.status,
       t.staff_member_name, t.completed_at
  FROM ttr.transactions t
 WHERE t.id IN (SELECT transaction_id FROM ttr.parties WHERE id IN (/* ids from 1 */));

-- 3. Identification records held
SELECT idv.document_type, idv.document_number, idv.issuer, idv.expiry_date,
       idv.verification_method, idv.verification_basis, idv.new_capture_reason, idv.created_at,
       idv.front_image_id, idv.back_image_id
  FROM ttr.id_verifications idv WHERE idv.party_id IN (/* ids from 1 */);

-- 4. Which ID images are still held — superseded ones were deleted, per §3
SELECT si.id, si.object_path, si.content_type, si.captured_at, si.captured_by_staff_id,
       si.superseded_at IS NOT NULL AS deleted_because_replaced
  FROM ttr.stored_images si WHERE si.id IN (/* image ids from 3 */);

-- 5. Items sold
SELECT b.* FROM ttr.bullion_items b        WHERE b.transaction_id IN (/* ids from 2 */);
SELECT m.* FROM ttr.precious_metal_items m WHERE m.transaction_id IN (/* ids from 2 */);

-- 6. Who has viewed their ID, and when — information about them, so it is disclosable
SELECT al.occurred_at, al.action, al.resource_type, al.staff_member_id, al.detail
  FROM ttr.access_log al
 WHERE al.resource_id IN (/* image ids from 4 */)
    OR al.transaction_id IN (/* ids from 2 */)
 ORDER BY al.occurred_at DESC;
```

**Retrieve the images through the application, not from storage directly**, so the retrieval is logged. The log will then show the Privacy Officer viewing them on this date — that is the audit trail working, not a problem.

Rows in step 4 with `deleted_because_replaced = true` are the honest answer to *"you said you keep one copy"*: that copy was replaced, its image deleted, and the record of it retained.

### 5b · Correction request — "this detail is wrong"

1. **Verify identity** and establish exactly what is incorrect.
2. **Record before and after values in the register — before changing anything.** The system retains no prior values (G5), so the register is the only place the original survives. Skipping this breaks §4's *"any correction preserves the original"*.
3. **Apply the correction** to the relevant `ttr.parties` row(s). `ttr.parties` is a **per-transaction snapshot**, so the correction carries forward to future transactions without rewriting the historical filing — which is the behaviour §4 describes.
4. **Do not alter a submitted AUSTRAC report.** If a corrected detail has already been filed, that is a re-filing question for the compliance owner, not a database edit.
5. **Confirm in writing** what was changed.

If the customer asks for **deletion**, §7 is explicit and staff should say so plainly: records cannot be deleted before the 7-year retention period ends, even on request. Policy Part C has the approved wording.

---

## 6 · Sign-off

| Section | Attested by | Role | Date |
|---|---|---|---|
| Dev test sheet signed off | | | |
| 1 — environment and deployment | | | |
| 2 — MFA and access control | | | |
| 3 — production smoke test | | | |
| 4 — gap register **accepted** | | **Compliance owner** | |
| Authorised to go live | | | |

**The gap register requires the compliance owner specifically.** G1–G6 are judgements about acceptable risk against a published privacy policy, the AML/CTF Act and the Second-Hand Dealers and Pawnbrokers Act 1989 (Vic). They are not engineering's to accept.
