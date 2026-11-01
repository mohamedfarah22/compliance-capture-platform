# UAT: Shared ID store (Gold Phase 2)

**Purpose:** prove that `gold/02-id-store` keeps the TTR ID-verification journey working while ID captures and photos can now belong to a **customer** instead of a TTR:
1. A customer-level ID capture (no transaction) can exist, with its photos stored under `customers/{customer_id}/…` in the same private bucket
2. `upload-id-image` accepts a customer as the owner, and `get-id-image-urls` signs those photos and logs every view to `ttr.access_log`
3. A TTR for that customer is offered the customer-level capture as the prior ID, and a new TTR capture of the same document number meets the existing collision prompt
4. Completing a TTR stamps `customer_id` on the party's ID captures
5. `reconcile-stored-images` treats customer photos that have a row as valid, not as orphans
6. The TTR behaviour that existed before (reliance, stored images, renewals) is unchanged

Nothing in the app creates a customer-level capture yet (Gold's New customer screen arrives in a later phase), so rows 2.4–2.8 create one by hand: the SQL editor plays the part of that later function, and `curl` plays the browser.

This sheet does not re-prove TTR report content. [uat-test-matrix.md](uat-test-matrix.md) covers that, and its TTR smoke rows are re-run in row 2.9.

| | |
|---|---|
| Environment | ________ |
| Build/commit | ________ |
| Run by / date | ________ |

**Setup.**
- A **dev** Supabase project, not the client project and not the one CI deploys `main` to. Before running anything linked, confirm both of these point at dev:
  - `app/.env.local` (`VITE_SUPABASE_URL` contains the dev project ref)
  - the linked project: `npx supabase projects list` (the linked row is marked) and `cat supabase/.temp/project-ref`

  Then, from the branch:
  ```
  npx supabase db push --linked
  npx supabase functions deploy upload-id-image get-id-image-urls reconcile-stored-images complete-transaction
  ```
  `db push` applies five migrations (`20261102000001` to `20261102000005`) and runs the ID backfill once. `complete-transaction` now takes the prior ID's entity from `id_verifications.reporting_entity_id` instead of its transaction, because a customer-level capture has none; the new linking runs inside the database function it already calls.
- A **Vercel preview deploy** of `gold/02-id-store`, with its environment variables pointing at that dev project.
- One **staff** account, already enrolled in MFA, in entity A. Dev should hold at least one customer with a completed TTR **that has ID photos** (for example `Fran Format` from the earlier sheets). Optional but recommended: one staff account in a **second** entity B, for the cross-entity checks.
- For rows 2.4–2.8 only:
  - the project's **anon key** and **secret key** (`sb_secret_…`), Project Settings → API Keys;
  - a **staff access token that has completed MFA** (`aal2`). A password-only token will not do, and 2.4a shows why. Sign in to the preview, enter the code, then DevTools → Application → Local Storage → the `sb-<project>-auth-token` entry → copy `access_token`. It expires after an hour; copy a new one if a call returns 401;
  - a small JPEG on disk called `front.jpg` (any photo under 10 MiB).
- SQL below runs in the dev project's SQL editor (service role).

**Conventions.**
- `<today>` is today's date. `<project>` is the dev project ref. `<anon key>` and `<secret key>` are from Setup. `<access_token>` is the `aal2` token.
- Keep DevTools open on the **Console** tab throughout. Any new error fails the row you were on.
- Steps marked ⚠ are where a regression is most likely.
- A completed transaction has `status = 'complete'` in the database (not `completed`).

**Timing.** About 60 minutes.

---

## A · TTR behaviour unchanged (staff account)

Sign in with the staff account and MFA.

| # | Do this | Expect |
|---|---|---|
| 2.1 ⚠ | Start a transaction (scenario `Sell bullion to customer`, reference `UAT-IDS-001`, `<today>`). Search the returning customer that has ID photos (e.g. Fran Format) and **Add to transaction**. Fill in the customer screens and go to **ID Verification** | ☐ The prior ID is offered and **Relied on prior identification** is selected for you ☐ The stored front (and back) images **render** ☐ Clicking a thumbnail enlarges it ☐ The line under the prior ID reads `Verified <date> by <name> · Ref: <reference>` ☐ No error in the Console. Press **Exit** and confirm |
| 2.2 | Start `UAT-IDS-002`. **Create new customer** → Individual: `Colin` `Collide`, DOB `03/03/1993`. On **ID Verification** choose **Sighted original document**, type **Driver licence**, and enter the **same document number** as the returning customer's licence in 2.1 (find it with `select document_number from ttr.id_verifications where document_type = 'Driver licence' order by created_at limit 5;`). Click out of the field | ☐ The existing collision prompt appears, naming the person who holds that licence ☐ The reasons offered are the ones that were offered before this change. Press **Exit** and confirm |
| 2.3 | Start `UAT-IDS-003` for the returning customer in 2.1. On **ID Verification** choose a new capture of the **same licence number**, reason **ID has changed (renewed)**, capture new photos, and **complete** the transaction. Then run:<br>`select id, object_path, superseded_at, superseded_by_image_id from ttr.stored_images where id in (select front_image_id from ttr.id_verifications where document_number = '<licence number>' union select back_image_id from ttr.id_verifications where document_number = '<licence number>') order by captured_at;` | ☐ The **old** images have `superseded_at` set and `superseded_by_image_id` pointing at a new image ☐ The new images do not ☐ In Storage → `compliance-media`, the old objects are gone and the new ones are there (unchanged behaviour) |

## B · A customer-level capture, by hand (SQL editor and terminal)

**Create the test customer** (SQL editor). Use the entity of your staff account:

```sql
select id, reporting_entity_id from public.staff_members where email = '<staff email>';

insert into public.customers (reporting_entity_id, customer_type, source, first_name, last_name, date_of_birth, phone)
values ('<reporting_entity_id>', 'individual', 'gold', 'Gina', 'Goldtest', '1988-08-08', '0400000222')
returning id;                                   -- <customer id>

select gen_random_uuid();                       -- <verification id>
```

| # | Do this | Expect |
|---|---|---|
| 2.4a | A password-only token cannot upload for the customer. Get one as in section G of [uat-security-hardening.md](uat-security-hardening.md), then:<br>`curl -s -X POST "https://<project>.supabase.co/functions/v1/upload-id-image" -H "apikey: <anon key>" -H "Authorization: Bearer <password-only token>" -F customerId=<customer id> -F verificationId=<verification id> -F side=front -F "file=@front.jpg;type=image/jpeg"` | ☐ `{"error":"Customer not found"}`, status 404. Nothing is uploaded |
| 2.4 | Upload the front photo with the `aal2` token:<br>`curl -s -X POST "https://<project>.supabase.co/functions/v1/upload-id-image" -H "apikey: <anon key>" -H "Authorization: Bearer <access_token>" -F customerId=<customer id> -F verificationId=<verification id> -F side=front -F "file=@front.jpg;type=image/jpeg"` | ☐ Status 201 and JSON `{"id":"<front image id>","objectPath":"customers/<customer id>/<verification id>/front-<uuid>.jpg","contentHashSha256":"…"}` ☐ `sha256sum front.jpg` equals `contentHashSha256` ☐ The object is in Storage → `compliance-media` → `customers/<customer id>/<verification id>/` ☐ `select object_path, customer_id, transaction_id, content_hash_sha256, captured_by_staff_id from ttr.stored_images where id = '<front image id>';` returns one row: `customer_id` is the customer, `transaction_id` is **null**, `captured_by_staff_id` is your staff id |
| 2.4b | Insert the customer-level capture that uses the photo:<br>`insert into ttr.id_verifications (id, customer_id, verification_method, document_type, document_number, issuer, has_expiry, expiry_date, verification_description, front_image_id, is_complete) values ('<verification id>', '<customer id>', 'Sighted original document', 'Driver licence', 'UATGOLD2-001', 'VIC', true, '2030-01-01', 'Driver licence sighted in person', '<front image id>', true);`<br>then `select transaction_id, party_id, conducting_person_id, customer_id, reporting_entity_id, number_norm from ttr.id_verifications where id = '<verification id>';` | ☐ The insert succeeds ☐ `transaction_id`, `party_id` and `conducting_person_id` are all null ☐ `customer_id` is the customer ☐ `reporting_entity_id` is your entity (taken from the customer) ☐ `number_norm` is `UATGOLD2001` (dash removed, upper case) |
| 2.4c | Refused shapes. Run each; each must fail:<br>(1) a reliance row: `insert into ttr.id_verifications (customer_id, verification_method, document_type, document_number, verification_description, verification_basis, prior_verification_id, reliance_reason) values ('<customer id>', 'Sighted original document', 'Passport', 'UATGOLD2-X1', 'x', 'relied_on_prior_identification', '<verification id>', 'customer_known_to_business');`<br>(2) the same document again: `insert into ttr.id_verifications (customer_id, verification_method, document_type, document_number, verification_description) values ('<customer id>', 'Sighted original document', 'Driver licence', 'uatgold2-001', 'x');` | ☐ (1) fails with *a customer-level capture must be a new capture* ☐ (2) fails with a duplicate-key error on `uq_idv_doc_new_capture` (case differs, still a duplicate) |
| 2.5 | Ask for a signed URL with the `aal2` token:<br>`curl -s -X POST "https://<project>.supabase.co/functions/v1/get-id-image-urls" -H "apikey: <anon key>" -H "Authorization: Bearer <access_token>" -H "Content-Type: application/json" -d '{"imageIds":["<front image id>"]}'`<br>Open the URL in the response in a browser tab. Then run:<br>`select action, resource_type, resource_id, transaction_id, staff_member_id, detail, occurred_at from ttr.access_log where resource_id = '<front image id>' order by occurred_at desc;` | ☐ Response `{"urls":{"<front image id>":"https://…/object/sign/compliance-media/customers/…?token=…"}}` ☐ The URL shows your photo ☐ One `access_log` row: `action` = `view`, `resource_type` = `stored_images`, `transaction_id` **null**, `staff_member_id` your staff id, `detail` = the `customers/…` path |
| 2.5a | Repeat the 2.5 call with the **password-only** token | ☐ `{"urls":{}}` ☐ **No** new `access_log` row ☐ (Optional) with the second entity's `aal2` token the result is the same: nothing signed, nothing logged |

## C · The TTR journey finds the customer's ID (staff account)

| # | Do this | Expect |
|---|---|---|
| 2.6 ⚠ | Start `UAT-IDS-004`. On **Add Customers / Parties** search **First** `Gina`, **Last** `Goldtest` and **Add to transaction**. Fill in the customer screens and go to **ID Verification** | ☐ The customer's **Driver licence UATGOLD2-001** is offered as the prior ID, and reliance is selected for you ☐ The front image **renders**; clicking it enlarges it ☐ The line reads `Verified <date> by <your name>` with **no** `· Ref:` and no empty `Transaction:` line (a customer-level capture has no TTR) ☐ `select * from ttr.access_log where resource_id = '<front image id>' order by occurred_at desc;` shows a new `view` row for these thumbnails |
| 2.6a ⚠ | Continue with **Reason for reliance** = *Customer known to business*, fill in the remaining screens and **complete** `UAT-IDS-004`. Then run:<br>`select v.verification_basis, v.customer_id, p.customer_id as party_customer, v.prior_verification_id from ttr.id_verifications v join ttr.parties p on p.id = v.party_id join ttr.transactions t on t.id = v.transaction_id where t.transaction_ref = 'UAT-IDS-004';` | ☐ One row ☐ `customer_id` equals `party_customer` and is the Gina Goldtest customer ☐ `prior_verification_id` is `<verification id>` |
| 2.7 | Start `UAT-IDS-005`. **Create new customer** → Individual: `Hal` `Otherperson`, DOB `06/06/1985`. On **ID Verification** choose **Sighted original document**, type **Driver licence**, number **`uatgold2-001`** (lower case), and click out of the field | ☐ The existing collision prompt appears and names **Gina Goldtest** (and her date of birth), the holder of the customer-level capture ☐ It does not wait for **Save** to fail with a duplicate-key error. Press **Exit** and confirm |

## D · The reconcile sweep (terminal)

| # | Do this | Expect |
|---|---|---|
| 2.8 ⚠ | Run the sweep in dry-run mode with the secret key. `full` makes it look at every transaction folder too:<br>`curl -s -X POST "https://<project>.supabase.co/functions/v1/reconcile-stored-images" -H "apikey: <secret key>" -H "Authorization: Bearer <secret key>" -H "Content-Type: application/json" -d '{"apply": false, "full": true}'` | ☐ Status 200, `"mode":"dry-run"` ☐ `orphanObjects.paths` contains **no** path starting `customers/` ☐ `danglingFolders.folders` does **not** contain `customers` ☐ `missingObjects.imageIds` does **not** contain `<front image id>` ☐ `scanned.objectsInspected` counts the customer photo (it is higher than the number of transaction images alone) |

Never run this with `"apply": true` on dev just to check: it deletes objects.

## E · Existing smoke rows

| # | Do this | Expect |
|---|---|---|
| 2.9 | Re-run the TTR smoke rows of [uat-test-matrix.md](uat-test-matrix.md) (the AUSTRAC smoke test, R24–R26) | ☐ All pass as recorded before the change |

**What a failure looks like:**
- **2.1 shows no prior ID, or the images do not render.** The prior-ID lookup returned nothing for a customer who has captures. Run `select * from public.get_prior_verifications_individual(p_customer_id := '<customer id>');` as that staff member's session, or check `select count(*) from ttr.id_verifications where party_id is not null and customer_id is null;` — it should be `0` for parties that have a customer (the backfill did not run).
- **2.2 saves, then fails with *duplicate key value violates unique constraint "uq_idv_doc_new_capture"*.** The collision lookup did not find the existing record. `select * from public.get_verification_for_document('Driver licence', '<number>');` should return it.
- **2.3 leaves the old objects in Storage.** `complete-transaction`'s supersede step failed (it is non-fatal by design). Check the function logs for `supersede:` lines.
- **2.4 returns 404 *Customer not found* for the right customer.** The token is not `aal2` (see 2.4a), or the customer belongs to another entity than the staff account.
- **2.4 returns 500 *Failed to record image metadata*.** The `stored_images` row was refused. Check the logs for the Postgres code; `23514` means the path rule or the one-owner rule rejected it. The object is removed again, so Storage should show nothing new.
- **2.5 returns the URL but there is no `access_log` row.** Must not happen: the function fails closed. If it does, the deployed function is the old one; redeploy.
- **2.6 offers nothing for Gina.** The TTR party was not linked to the customer (typed in by hand rather than picked), and the name + DOB fallback needs the **same date of birth** as the customer. Pick her from search.
- **2.6 shows `Ref:` with nothing after it.** The preview is serving the old build.
- **2.6a refuses to complete with *Prior verification does not belong to this reporting entity*.** The deployed `complete-transaction` is the old one, which looked the entity up through the prior ID's transaction; redeploy it.
- **2.8 lists `customers/…` paths under `orphanObjects` or `customers` under `danglingFolders`.** The deployed `reconcile-stored-images` is the old one; redeploy it.

---

## Sign-off

☐ All checks pass · Notes: ______________________________________________
