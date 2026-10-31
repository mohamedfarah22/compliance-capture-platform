# UAT: Security hardening (MFA in the database, logged access, scheduled-function keys)

**Purpose:** prove the security fixes on `security-hardening` did not break normal use, and that the holes they close stay closed:
1. MFA is enforced by the database (migration `20261030000001`), not only by the browser
2. Staff can no longer edit their own staff record (including their role)
3. ID images and report XML are only reachable through the logged paths, and admins can no longer edit batches directly
4. `cleanup-stale-drafts` and `reconcile-stored-images` require the secret key
5. Login only redirects inside the app, sign-out clears unfinished transactions from the browser, and the site sends security headers (CSP)

This sheet does not re-prove TTR report content. [uat-ttr-report-fixes.md](uat-ttr-report-fixes.md) and [dev-test-sheet.md](dev-test-sheet.md) cover that.

| | |
|---|---|
| Environment | ________ |
| Build/commit | ________ |
| Run by / date | ________ |

**Setup.**
- A **dev** Supabase project, not one holding real customer data and not the one CI deploys `main` to. From the branch:
  `npx supabase db push --linked` then `npx supabase functions deploy`
- A **Vercel preview deploy** of `security-hardening`, with its environment variables pointing at that dev project. The security headers only exist on Vercel, so `npm run dev` does not test section E.
- One **staff** and one **admin** account, both already enrolled in MFA.
- The project's **secret key** (`sb_secret_…`, Project Settings → API Keys → Secret keys) and **anon/publishable key**, for sections F and G.

**Conventions.**
- `<project>` is the dev project ref. `<today>` is today's date.
- Keep DevTools open on the **Console** tab throughout. Any "Content Security Policy" error fails the row you were on.
- Steps marked ⚠ are where a regression is most likely.

**Timing.** About 45 minutes.

---

## A · Sign-in and redirects (staff account)

| # | Do this | Expect |
|---|---|---|
| A1 | Sign out completely. Sign in with the staff email and password | ☐ Code entry screen (`/mfa`), not the wizard |
| A2 ⚠ | Enter the code. **Do not refresh** from here until B5 is done | ☐ Lands on `/start` |
| A3 | Sign out. Open `/login?redirect=//example.com`, sign in, enter the code | ☐ Lands on `/start`. Never leaves the app |
| A4 | Sign out. Open `/login?redirect=%2F%5Cexample.com`, sign in, enter the code | ☐ Lands on `/start` |
| A5 | Sign out. Open `/reports` directly, sign in, enter the code | ☐ "You are not authorised to view this page" (staff account) — the requested page survived both steps |

After A5, sign out and back in once more, and again **do not refresh** before B5.

## B · Staff transaction end to end (staff account)

**Start Transaction**
- Scenario: `Sell bullion to customer`
- Transaction reference: `UAT-SEC-001`
- Transaction date and time: `<today>`, current time

| # | Do this | Expect |
|---|---|---|
| B1 | On **Add Customers / Parties**, search for an existing customer by last name | ☐ Results appear |
| B2 | **Create new customer** → Individual: `Uma` `Secure`, DOB `02/02/1990`. Fill the remaining screens as normal | ☐ Saves, and every **Continue** works |
| B3 | On **ID Verification**, choose a sighted document and capture front and back with the **camera** | ☐ Camera preview appears ☐ Both captured images show |
| B4 | Continue to **Recipient / Delivery** and on to **Review & Submit** | ☐ Every screen loads without an error |
| B5 ⚠ | On **Review & Submit**, check the reporting entity section | ☐ Legal name, ABN, AUSTRAC account number and address are all shown — not `—` and not *"Not configured — contact your system administrator"* |
| B6 | Complete the transaction | ☐ Completes with no error |
| B7 ⚠ | Start `UAT-SEC-002` for **the same customer** and go to **ID Verification** | ☐ Reliance auto-selects ☐ The stored ID images from `UAT-SEC-001` render ☐ Clicking a thumbnail opens the enlarged view |
| B8 | Continue to **Recipient / Delivery**, then **Exit** and confirm | ☐ Confirmation appears ☐ Deletes cleanly with no error |

**What a failure looks like:**
- B5 shows `—` or *"Not configured"*, but a page refresh fixes it. The company details were read before MFA and not re-read after. Before this change the app could read them with a password alone.
- B7 shows no images, or broken image icons. ID images now come only from the `get-id-image-urls` function. Check that it deployed and that its call in DevTools → Network returns URLs.

## C · Admin reports (admin account)

**Setup:** generate today's batch with the secret key, as in the Postman collection (`supabase/functions/generate-austrac-report/`) or:
```
curl -X POST https://<project>.supabase.co/functions/v1/generate-austrac-report \
     -H "apikey: <secret key>" -H "Authorization: Bearer <secret key>" \
     -H "Content-Type: application/json" -d '{"reportDate":"<today>"}'
```

| # | Do this | Expect |
|---|---|---|
| C1 | Sign in as admin (both factors). Open **Reports** | ☐ Today's batch is listed |
| C2 | Open the batch | ☐ Summary shows ☐ `UAT-SEC-001` is in its transaction list |
| C3 | DevTools → Network → the `report_batches` request → Response | ☐ No `xml_content` field |
| C4 | Click **Download XML** | ☐ File downloads ☐ An `export` row appears: `SELECT * FROM ttr.access_log ORDER BY created_at DESC LIMIT 1;` |
| C5 | **Reject** the batch | ☐ Status becomes rejected |
| C6 | **Regenerate** it | ☐ A new pending batch is produced and the page shows it |
| C7 ⚠ | Copy the new batch's review link (from the approval email, or the Reports page): `/review-batch/<id>?token=…`. Sign out, open that link, sign in, enter the code | ☐ Lands on **that batch's review page**, not `/start` ☐ **Submit** and **Reject** are available |
| C8 | **Submit** it | ☐ Status becomes submitted |

**What a failure looks like:** C7 lands on `/start`. The redirect check refused the approval link, so admins would lose the one-click link in the email.

## D · Sign-out clears the browser (staff account)

| # | Do this | Expect |
|---|---|---|
| D1 | Start `UAT-SEC-003`, add a customer, and stop on **ID Verification**. Refresh the page | ☐ The customer is still there (only a sign-out clears it). An ID photo not yet saved with **Continue** is not kept, by design |
| D2 | Sign out. DevTools → Application → Session Storage → the site | ☐ No `ttr.customers`, `ttr.idVerification` or other `ttr.*` keys |
| D3 | Sign back in (both factors) and open the wizard | ☐ No trace of the `UAT-SEC-003` customer |

## E · Security headers (preview deploy)

| # | Do this | Expect |
|---|---|---|
| E1 | DevTools → Network → the first document request → Response Headers | ☐ `Content-Security-Policy` ☐ `X-Frame-Options: DENY` ☐ `Referrer-Policy: no-referrer` ☐ `Permissions-Policy` with `camera=(self)` |
| E2 | Review the Console from sections A–D | ☐ No "Content Security Policy" errors at any point |

## F · Scheduled functions (terminal)

```
# F1 — expect 200 and {"processed":…,"deleted":…,"skipped":…}
curl -X POST https://<project>.supabase.co/functions/v1/cleanup-stale-drafts \
     -H "apikey: <secret key>" -H "Authorization: Bearer <secret key>" \
     -H "Content-Type: application/json" -d '{}'

# F2 — expect 200 and "mode":"dry-run"
curl -X POST https://<project>.supabase.co/functions/v1/reconcile-stored-images \
     -H "apikey: <secret key>" -H "Authorization: Bearer <secret key>" \
     -H "Content-Type: application/json" -d '{"apply": false}'

# F3 — expect 401
curl -X POST https://<project>.supabase.co/functions/v1/reconcile-stored-images \
     -H "apikey: <anon key>" -H "Authorization: Bearer <anon key>" \
     -H "Content-Type: application/json" -d '{"apply": false}'

# F4 — expect 401
curl -X POST https://<project>.supabase.co/functions/v1/cleanup-stale-drafts \
     -H "Content-Type: application/json" -d '{}'
```

| # | Check | Pass |
|---|---|---|
| F1 | `cleanup-stale-drafts` with the secret key returns 200 and a JSON summary | ☐ |
| F2 | `reconcile-stored-images` with the secret key returns 200, `"mode":"dry-run"` | ☐ |
| F3 ⚠ | `reconcile-stored-images` with the anon key returns **401** | ☐ |
| F4 | `cleanup-stale-drafts` with no key returns **401** | ☐ |
| F5 | Any scheduled job for these two functions sends the **secret key** in both headers | ☐ |

**What a failure looks like:** F1/F2 return 401. The key is the legacy JWT `service_role` key, not the `sb_secret_…` key the runtime holds (see the Postman collection notes). A 200 on F3 means anyone with the public key can delete ID images.

## G · The closed holes stay closed (terminal)

Get a **password-only** token (no second factor) for the staff account and copy its `access_token`:
```
curl -s -X POST "https://<project>.supabase.co/auth/v1/token?grant_type=password" \
     -H "apikey: <anon key>" -H "Content-Type: application/json" \
     -d '{"email":"<staff email>","password":"<password>"}'
```

| # | Do this | Expect |
|---|---|---|
| G1 ⚠ | Read customers with it: `curl -s "https://<project>.supabase.co/rest/v1/parties?select=id&limit=1" -H "apikey: <anon key>" -H "Authorization: Bearer <access_token>" -H "Accept-Profile: ttr"` | ☐ `[]`, even though the account has customers |
| G2 ⚠ | Try to make the account an admin: `curl -s -X PATCH "https://<project>.supabase.co/rest/v1/staff_members?id=eq.<staff user id>" -H "apikey: <anon key>" -H "Authorization: Bearer <access_token>" -H "Content-Type: application/json" -H "Prefer: return=representation" -d '{"role":"admin"}'` | ☐ `[]` ☐ `SELECT role FROM public.staff_members WHERE id = '<staff user id>';` still says `staff` |
| G3 | List every company's drafts with only the public key: `curl -s -X POST "https://<project>.supabase.co/rest/v1/rpc/get_stale_draft_ids" -H "apikey: <anon key>" -H "Content-Profile: ttr" -H "Content-Type: application/json" -d '{"older_than_days":0}'` | ☐ A permission error, not a list of IDs |

Direct ID-image downloads, direct reads of report XML, and admins editing batches need an MFA-verified token to try by hand. Those were proven closed against every migration in a database test before merge, and C3 covers the visible part.

---

## Sign-off

☐ All checks pass · Notes: ______________________________________________
