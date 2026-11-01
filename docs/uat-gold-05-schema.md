# UAT: Gold schema, read-only access and the access helper (Gold Phase 5)

**Purpose:** prove that `gold/05-schema` gives Gold a database it can read and the browser cannot write:
1. The `gold` schema, its tables and the private `gold-goods` bucket exist, and `gold` is exposed through the API
2. A signed-in staff member can **read** their own entity's purchases and call the read functions, and **cannot insert, update or delete** anything in `gold`, even with a valid MFA token
3. Another entity's staff, and a password-only (`aal1`) token, see **nothing**
4. `search_customers` finds people by name, alias, phone and ID number, and puts exact matches first
5. The database refuses changes to a saved purchase that the rules forbid (sellers, type, ID, the invoice number once set) and writes an audit row for every allowed change
6. Every future `gold-*` function can use `requireGoldStaff` to refuse calls while `GOLD_JOURNEY_ENABLED` is not `true`
7. On the client project, after merge, none of this is reachable

Nothing in the app uses Gold yet.

| | |
|---|---|
| Environment | ________ |
| Build/commit | ________ |
| Run by / date | ________ |

**Timing.** About 5 minutes: two commands and three dashboard checks.

---

## A · Automated rows

Every row below is proved by an automated test against a freshly reset local database. The tests seed their own data inside a transaction, so there is nothing to seed or clean up, no tokens to copy and no stub function to deploy.

```
npx supabase start            # once
npx supabase db reset         # applies every migration, including 20261105000001 to 20261105000005
npx supabase test db          # pgTAP: expect "All tests successful" and Result: PASS
cd supabase/functions && deno task test   # expect 0 failed
```

☐ `supabase test db` passes · ☐ `deno task test` passes

| # | What is proved | Covered by |
|---|---|---|
| 5.0 | The `gold` schema, its four tables, and a **private** `gold-goods` bucket | `supabase/tests/05_gold_rls.test.sql` ("the gold-goods bucket exists and is private"); every gold test uses the four tables |
| 5.1 ⚠ | Staff with an `aal2` token cannot insert into `gold.purchases` (`42501`) | `05_gold_rls.test.sql` |
| 5.2 ⚠ | Nor update or delete one ("an admin cannot update a purchase", "staff cannot delete a purchase") | `05_gold_rls.test.sql` |
| 5.2a | Nor write to `goods_photos`, `purchase_audit_log` or `export_audit_log` | `05_gold_rls.test.sql` |
| 5.3 | Staff read their own entity's purchases only; another entity's staff read nothing | `05_gold_rls.test.sql` |
| 5.3a ⚠ | A password-only (`aal1`) session sees no purchases | `05_gold_rls.test.sql` |
| 5.3b | The anon key alone reads nothing and can call no gold RPC | `05_gold_rls.test.sql` ("anon cannot read gold.purchases", "anon cannot call a gold RPC") |
| 5.3c | Staff cannot read the export audit log; a manager can, but not at `aal1` | `05_gold_rls.test.sql` |
| 5.3d | The browser cannot list or upload to `gold-goods` | `05_gold_rls.test.sql` ("and cannot list it") |
| 5.4 ⚠ | `search_customers` by last name, middle name, alias, `+61` phone, 4-digit phone, ID number with spaces; nothing for 3 digits, one character or `%%`; the current ID on each row | `supabase/tests/07_search_customers.test.sql` |
| 5.4a | The same search as another entity or at `aal1` returns nothing | `07_search_customers.test.sql` |
| 5.4b | An exact phone match ranks before a number that only contains it | `07_search_customers.test.sql` |
| 5.4c | `customer_current_id`, `find_possible_duplicate_customers`, `customer_ttr_ready` | `supabase/tests/08_gold_reads.test.sql` |
| 5.4d | `list_incomplete_purchases`, `linked_parts`, `invoice_purchases`, `search_gold_purchases`, `list_recorded_by`, `purchase_id_used` | `08_gold_reads.test.sql` |
| 5.4e | Those calls return nothing for another entity or at `aal1` | `05_gold_rls.test.sql`, `08_gold_reads.test.sql` |
| 5.5 ⚠ | `requireGoldStaff` refuses with 403 `gold_disabled` while `GOLD_JOURNEY_ENABLED` is not exactly `true` | `supabase/functions/_shared/goldAuth.test.ts` ("flag off: 403 gold_disabled, before any token or network check") |
| 5.5a | With the flag on, an active staff member passes | `goldAuth.test.ts` |
| 5.5b | `aal1` → 403 `mfa_required`; no `Authorization` → 401; staff calling a manager-only function → 403 `forbidden` | `goldAuth.test.ts` |
| 5.7 ⚠ | A saved purchase's sellers, type, ID, counter answers, sale date and creator cannot change; the invoice number cannot change or be removed once set; `completed_at` only comes with the update that adds the invoice; completing writes one audit row (who, source, old and new invoice); the audit log is append-only | `supabase/tests/06_gold_constraints.test.sql` (each refusal asserts SQLSTATE `23001`) |
| 5.9 | Existing TTR behaviour, including TTR customer search | `npx supabase test db` (`01`–`04`) and the `frontend` and `functions` CI jobs. Until the Playwright `uat` job runs on these PRs, also run the AUSTRAC smoke rows R24–R26 of [uat-test-matrix.md](uat-test-matrix.md) |

## B · Hosted checks (dev project, dashboard and one anonymous call)

The local stack can't see the hosted project's own settings. Before running anything linked, confirm `app/.env.local` and `supabase/.temp/project-ref` both point at **dev**, then `npx supabase db push --linked`.

| # | Do this | Expect |
|---|---|---|
| H1 | Dashboard → Project Settings → Data API → **Exposed schemas** | ☐ `gold` is listed next to `public` and `ttr` |
| H2 | `curl -s "https://<project>.supabase.co/rest/v1/purchases?select=id" -H "apikey: <anon key>" -H "Accept-Profile: gold"` | ☐ A permission error (401 or 403) and no rows. **Not** `PGRST106`, which means `gold` is not exposed |
| H3 | Storage → `gold-goods` | ☐ Listed as **Private** |

## C · Client project, after merge

Run only after this branch is merged and the migrations reach the client project. Use the **client** project ref.

| # | Do this | Expect |
|---|---|---|
| 5.6 | Confirm the client project's Exposed schemas do **not** list `gold`, and `npx supabase secrets list --project-ref <client ref>` shows no `GOLD_JOURNEY_ENABLED`. Then:<br>`curl -s -w "\nHTTP %{http_code}\n" "https://<client ref>.supabase.co/rest/v1/purchases?select=id" -H "apikey: <client anon key>" -H "Accept-Profile: gold"` | ☐ HTTP **406** with `PGRST106` (*The schema must be one of the following*): the gold tables are unreachable ☐ No `GOLD_JOURNEY_ENABLED`, so any future `gold-*` function returns 403 `gold_disabled` ☐ In Storage, `gold-goods` exists and is private |

**What a failure looks like:**
- **`supabase test db` fails.** The failing test names the assertion. For RLS and grants, `select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'gold' and grantee in ('anon', 'authenticated');` must show `SELECT` for `authenticated` only. For 5.7, `select tgname from pg_trigger where tgrelid = 'gold.purchases'::regclass;` should list `trg_gp_immutable` and `trg_gp_audit`.
- **H2 returns `PGRST106`.** `gold` is not in the dev project's Exposed schemas. Add it and retry.
- **A gold RPC returns HTTP 404 on dev.** The migrations did not apply (`select proname from pg_proc where proname = 'search_customers';`) or PostgREST has not reloaded its schema cache: run `notify pgrst, 'reload schema';`.

---

## Sign-off

☐ Section A passes on commit ________ · ☐ Hosted checks H1–H3 · ☐ 5.6 after merge · Notes: ______________________________________________
