# UAT run log — security hardening

Results for [uat-security-hardening.md](uat-security-hardening.md). The sheet itself is left blank so it can be reused.

| | |
|---|---|
| Environment | Supabase `rygjssczdoyvmumxmymc` (dev, ap-northeast-1). Frontend: local `npm run dev` for the first pass of A–D, then a Vercel preview of `security-hardening` for E and the re-run of A–D |
| Build/commit | **`d920737`** (`security-hardening`). Uncommitted changes at test time were docs only |
| Edge functions | All deployed 2026-10-31 06:10 UTC from `d920737`: `cleanup-stale-drafts` v15, `reconcile-stored-images` v2, `get-id-image-urls` v5, `approve-batch` v13, `generate-austrac-report` v15, `complete-transaction` v18, `upload-id-image` v16, `delete-draft-transaction` v15 |
| Migration | `20261030000001_security_hardening` applied to dev on 2026-10-31, partway through the run (see issue 1) |
| Run by / date | Mohamed Farah / 2026-10-31 |

## Results

| Case | Result | Notes |
|---|---|---|
| A1–A4 | ✅ Pass | |
| A5 | ⚠ Not proven | Dev has only one account, an admin, so the staff-only "not authorised" check could not be run as staff. |
| B1–B8 | ✅ Pass | `UAT-SEC-001` / `UAT-SEC-002`. Customer acting on their own behalf: answered **No** to *"Is a different person conducting the transaction on behalf of a party?"* |
| C1–C2 | ✅ Pass | |
| C3 | ✅ Pass | The `report_batches` response has no `xml_content`. `approval_token` is present, as expected: C7 builds the review link from it. |
| C4–C8 | ✅ Pass | |
| D1 | ✅ Pass (sheet corrected) | An ID photo captured without pressing **Continue** did not survive a refresh. By design: it isn't saved until Continue. The sheet expected it to survive and has been corrected. |
| D2–D3 | ✅ Pass | No `ttr.*` keys in Session Storage after sign-out. |
| E1 | ✅ Pass (2nd attempt) | 1st attempt was against the local Vite dev server, which sends none of the headers. Environment, not a defect: the headers come from `app/vercel.json`, which only Vercel applies. Passed on the preview. |
| E2 | ✅ Pass | No Content Security Policy errors on the preview. |
| F1–F2 | ✅ Pass | 200. F1 `{"processed":0,"deleted":0,"skipped":0}`; F2 `"mode":"dry-run"`. Re-run after the migration with the same result. |
| F3 | ✅ Pass | 401 with the legacy anon key, and also 401 with the publishable key. |
| F4 | ✅ Pass | 401 |
| F5 | ✅ Pass (after fix) | The nightly job sent no key. Fixed on dev (issue 2). |
| G1 | ✅ Pass (2nd run) | `[]`. A control query with the secret key returns a party, so the company does have customers. 1st run returned a party (issue 1). |
| G2 | ✅ Pass (2nd run) | `[]`, role unchanged. 1st run the update went through (issue 1). |
| G3 | ✅ Pass (2nd run) | `42501 permission denied for schema ttr` (HTTP 401) with both the legacy anon and publishable keys. 1st run returned two draft IDs (issue 1). |

**A–D were run twice.** The first pass was before the migration reached dev, so it didn't exercise it. All passed again on the Vercel preview after the migration.

**How G was run.** The first-factor-only token came from an admin magic link verified straight away (`aal1`, `amr: otp`) instead of the password grant. It has the same assurance level. With no staff account on dev, G2 used the admin account and wrote back its current role (`admin`), so a wrongful success would change nothing. On the 1st (pre-migration) run that write succeeded; only `updated_at` changed.

## Environment issues (not code defects)

### 1 — Migration not applied to dev

- **Found by:** G1–G3 all failing. `supabase migration list` showed `20261030000001` locally but not on the remote. The functions had been deployed, but `db push` had not been run.
- **Fix:** `npx supabase db push --linked`, 2026-10-31. G re-run: all pass. F re-run: unchanged.
- **Go-live:** after deploying, confirm `migration list` shows `20261030000001` on the remote. F still passes without it, so only G would catch it.

### 2 — Nightly cleanup job sent no key

- **Found by:** F5. The `cleanup-stale-drafts` cron job (`0 2 * * *`) called the function with only a `Content-Type` header. The function now requires the secret key, so every nightly run was a silent 401 and abandoned drafts (customer details, ID photos) would never be deleted.
- **Fix on dev:** stored the secret key in Vault as `functions_secret_key` and rescheduled the job to send it in `apikey` and `Authorization: Bearer`. The first attempt stored the placeholder text, which returned `401 Invalid API key`; once that was corrected, running the job's stored command returned **200**.
- **Go-live:** production needs the same, with its own URL and its own secret key (go-live.md §1.8). It must be in place by the time the new functions are deployed there.

```sql
select vault.create_secret('<production sb_secret_ key>', 'functions_secret_key');

select cron.schedule('cleanup-stale-drafts', '0 2 * * *', $$
  select net.http_post(
    url := 'https://<project>.supabase.co/functions/v1/cleanup-stale-drafts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'functions_secret_key'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'functions_secret_key')
    ),
    body := '{}'::jsonb
  );
$$);

-- check: run it once, then read the response (expect 200)
do $$ begin execute (select command from cron.job where jobname = 'cleanup-stale-drafts'); end $$;
select status_code, content from net._http_response order by created desc limit 1;
```

## Issues with the test sheet

- **D1** expected the ID photo to survive a refresh. Corrected: it now checks only the customer and says an unsaved photo is not kept.
- **B2** doesn't say how to answer the "different person conducting" question. Answered **No**. Not changed.

## Sign-off

☑ A–G pass, except **A5 (not proven — no staff account on dev)** · Code defects found: **0** · Environment issues: **2, both fixed on dev**

**Before this run can stand for go-live:**

1. ☐ Commit this log and `uat-security-hardening.md` (both uncommitted at time of writing).
2. ☐ Create a staff account on dev and run A5, or record it as waived.
3. ☐ Production cleanup job sends the secret key (issue 2), in place no later than the functions deploy. CI deploys `main` to the project in the `SUPABASE_PROJECT_REF` secret; if that is production, this is due at merge.
4. ☐ After the production deploy, confirm the migration is on the remote (issue 1).
