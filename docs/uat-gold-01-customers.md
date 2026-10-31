# UAT: Shared customer table, backfill and TTR search on customers (Gold Phase 1)

**Purpose:** prove that `gold/01-customers` keeps the TTR journey working while it moves "customers" out of query-time guessing and into a real table:
1. TTR customer search now reads `public.customers`, and accepts **first + last name, or last name + date of birth** (it used to demand all three)
2. Picking a search result links the new TTR party to that customer (`ttr.parties.customer_id`)
3. Completing a TTR creates the customer if the person is new, or updates the existing one, and records the change in `customer_audit_log`
4. A returning customer arrives with citizenship, tax residency, sole trader / ABN and postal address already filled in
5. The backfill linked every existing completed party to a customer

This sheet does not re-prove TTR report content. [uat-test-matrix.md](uat-test-matrix.md) covers that, and its TTR smoke rows are re-run in row 1.11.

| | |
|---|---|
| Environment | ________ |
| Build/commit | ________ |
| Run by / date | ________ |

**Setup.**
- A **dev** Supabase project, not the client project and not the one CI deploys `main` to. Before running anything linked, confirm both of these point at dev:
  - `app/.env.local` (`VITE_SUPABASE_URL` contains the dev project ref)
  - the linked project: `npx supabase projects list` (the linked row is marked) and `cat supabase/.temp/project-ref`

  Then, from the branch: `npx supabase db push --linked`. This applies five migrations (`20261101000001` to `20261101000005`) and runs the backfill once on whatever data dev holds. No function deploy is needed: `complete-transaction` is unchanged, and the new linking runs inside the database function it already calls.
- A **Vercel preview deploy** of `gold/01-customers`, with its environment variables pointing at that dev project.
- One **staff** account, already enrolled in MFA. Dev should already hold at least one customer with a completed TTR (for example `Fran Format` from the Phase 0 sheet). SQL below runs in the dev project's SQL editor.
- For rows 1.12–1.13 only: a **staff access token** and the project's anon key. Get the token from a password-only sign-in (`/auth/v1/token?grant_type=password`), as in section G of [uat-security-hardening.md](uat-security-hardening.md).

**Conventions.**
- `<today>` is today's date. `<project>` is the dev project ref.
- Keep DevTools open on the **Console** tab throughout. Any new error fails the row you were on.
- Steps marked ⚠ are where a regression is most likely.
- A completed transaction has `status = 'complete'` in the database (not `completed`).

**Timing.** About 40 minutes.

---

## A · Backfill (SQL editor, right after `db push`)

| # | Do this | Expect |
|---|---|---|
| 1.10 ⚠ | Run:<br>`select count(*) from ttr.parties p join ttr.transactions t on t.id = p.transaction_id where t.status = 'complete' and p.is_complete and p.customer_id is null;` | ☐ `0` |
| 1.10a | Run:<br>`select reporting_entity_id, lower(last_name), lower(first_name), date_of_birth, count(*) from public.customers where customer_type = 'individual' group by 1,2,3,4 having count(*) > 1;` | ☐ No rows. One customer per person, as search showed them before |
| 1.10b | Run:<br>`select count(*) from public.customers;` and compare with the number of different people you expect to see in dev | ☐ About the same. Not one row per TTR |

Run 1.10 again at the end of the sheet, after the new TTRs below. It must still be `0`.

## B · Search (staff account)

Sign in with the staff account and MFA. Start a transaction:
- Scenario: `Sell bullion to customer`
- Transaction reference: `UAT-CUS-001`
- Transaction date and time: `<today>`, current time

On **Add Customers / Parties**, **Individual** tab. Use a customer that has a completed TTR, `<First>` `<Last>` with date of birth `<DOB>`.

| # | Do this | Expect |
|---|---|---|
| 1.1 | Enter **First name** and **Last name** only. Leave Date of birth empty. Press **Search** | ☐ The customer appears in the results |
| 1.2 | Clear First name. Enter **Last name** and **Date of birth** only. Press **Search** | ☐ The customer appears |
| 1.3 | Clear everything except **First name**. Press **Search** | ☐ No search runs ☐ The message reads *Enter First Name and Last Name, or Last Name and Date of Birth, to search.* — both allowed combinations are named |
| 1.3a | Enter only **Last name**. Press **Search** | ☐ The same message |
| 1.8 | Switch to **Company / Business**. (a) Search with only a known company's name. (b) Clear it and search with only its ABN **with spaces** (e.g. `12 345 678 901`). (c) Search with only a suburb | ☐ (a) found ☐ (b) found; repeat without spaces, found again ☐ (c) message: "Enter the Registered Entity Name or ABN / ACN to search." |

(The company tab still needs all three fields; this phase did not change that.)

## C · Linking and updating (staff account)

| # | Do this | Expect |
|---|---|---|
| 1.4 ⚠ | Search the customer from row 1.1, **Add to transaction**, fill in the remaining screens as normal and **complete** `UAT-CUS-001`. Then run:<br>`select p.customer_id, c.first_name, c.last_name from ttr.parties p join ttr.transactions t on t.id = p.transaction_id left join public.customers c on c.id = p.customer_id where t.transaction_ref = 'UAT-CUS-001';` | ☐ One row ☐ `customer_id` is not null ☐ It is the customer you picked: `select id from public.customers where first_name = '<First>' and last_name = '<Last>';` returns the same id |
| 1.5 | Start `UAT-CUS-002`. **Create new customer** → Individual: `Nina` `Newcustomer`, DOB `04/04/1991`, citizenship `AU`, tax residency `AU`, sole trader **No**. Fill the remaining screens and **complete** it. Then run:<br>`select id, source, created_by_staff_id from public.customers where last_name = 'Newcustomer';` | ☐ Exactly one row ☐ `source` is `ttr` ☐ `created_by_staff_id` is your staff id ☐ The party is linked: `select customer_id from ttr.parties p join ttr.transactions t on t.id = p.transaction_id where t.transaction_ref = 'UAT-CUS-002';` returns that same id |
| 1.6 ⚠ | Start `UAT-CUS-003`. Search **Nina Newcustomer** and add her. On **Party Details** change the **street address** to `99 New Road`, set citizenship to `NZ`, answer sole trader **Yes** with ABN `11223344556`. Fill the remaining screens and **complete** it. Then run:<br>`select res_street, citizenship_country_code, is_sole_trader, abn from public.customers where last_name = 'Newcustomer';`<br>`select changed_at, source, changed_by, changes from public.customer_audit_log where customer_id = (select id from public.customers where last_name = 'Newcustomer') order by changed_at;`<br>`select t.transaction_ref, p.res_street from ttr.parties p join ttr.transactions t on t.id = p.transaction_id where t.transaction_ref in ('UAT-CUS-002','UAT-CUS-003') order by t.transaction_ref;` | ☐ The customer now shows `99 New Road`, `NZ`, sole trader `true` and the ABN ☐ One audit row: `source` = `ttr_completion`, `changed_by` = your staff id, and `changes` holds old → new for each field, for example `"res_street": {"old": "...", "new": "99 New Road"}` ☐ **Earlier party copies are unchanged:** `UAT-CUS-002`'s party still has its original street, `UAT-CUS-003`'s has `99 New Road` ☐ Still one `Newcustomer` customer |
| 1.7 | Start `UAT-CUS-004`. **Create new customer** → Individual: `Olive` `Abandoned`, DOB `05/05/1992`. Continue to **Party Details**, then press **Exit** and confirm. Then run:<br>`select count(*) from public.customers where last_name = 'Abandoned';` | ☐ `0`. Abandoning a draft leaves no customer behind ☐ The draft `UAT-CUS-004` is gone |

## D · Prefill (staff account)

| # | Do this | Expect |
|---|---|---|
| 1.9 | Start `UAT-CUS-005`. Search **Nina Newcustomer**, add her, and go to **Party Details** | ☐ **Citizenship** shows `NZ` ☐ **Tax residency** shows the value saved in 1.6 ☐ **Is this person a sole trader?** shows **Yes** with the ABN `11223344556` already in the box ☐ The address shows `99 New Road` ☐ Nothing is locked: each field can still be edited |

Press **Exit** and confirm to discard `UAT-CUS-005`.

## E · The browser cannot write customers (terminal)

Use a **password-only** token from the Setup list.

| # | Do this | Expect |
|---|---|---|
| 1.12 ⚠ | `curl -s -X POST "https://<project>.supabase.co/rest/v1/customers" -H "apikey: <anon key>" -H "Authorization: Bearer <access_token>" -H "Content-Type: application/json" -H "Prefer: return=representation" -d '{"customer_type":"individual","source":"gold","first_name":"X","last_name":"Y","reporting_entity_id":"<your entity id>"}'` | ☐ A permission error (`42501`). No row is created: `select count(*) from public.customers where last_name = 'Y' and first_name = 'X';` is `0` |
| 1.13 | `curl -s "https://<project>.supabase.co/rest/v1/customers?select=id&limit=1" -H "apikey: <anon key>" -H "Authorization: Bearer <access_token>"` | ☐ `[]`, even though customers exist. A password-only session is below the second factor the database now requires |

## F · Existing smoke rows

| # | Do this | Expect |
|---|---|---|
| 1.11 | Re-run the TTR smoke rows of [uat-test-matrix.md](uat-test-matrix.md) (the AUSTRAC smoke test, R24–R26) | ☐ All pass as recorded before the change |

Finally, run row **1.10** again. ☐ Still `0`.

**What a failure looks like:**
- **1.1 or 1.2 returns nothing for a person who plainly has TTRs.** The backfill did not run on that data, or search is reading an empty `customers` table. Run 1.10b: a count of `0` means the migration ran before the data was there.
- **1.3 searches anyway, or shows the old message** *Enter First Name, Last Name and Date of Birth to search.* The preview is serving the old build.
- **1.4 shows a null `customer_id`.** The picked customer's id was not carried into the new party. Check `migrateNewParties` in DevTools → Network: the `parties` insert body should contain `customer_id`.
- **1.5 or 1.6 fails at Complete with an error.** Linking runs inside `ttr.complete_transaction`, so a linking failure stops the completion. The message is a generic *Unexpected database error*; the cause is in Supabase → Logs → Postgres.
- **1.5 creates two `Newcustomer` rows, or 1.6 creates a second one.** The match key (last name, first name, date of birth, ignoring case) did not match. Compare the DOB entered in each TTR.
- **1.6 has no audit row, or one with `source` empty.** The audit trigger ran without the completion path setting its source.
- **1.9 shows blank citizenship / sole trader.** The search results are missing the new columns: `select * from public.search_individual_customers('Nina','Newcustomer',null);` should return `citizenship_country_code`, `is_sole_trader` and `abn`.

---

## Sign-off

☐ All checks pass · Notes: ______________________________________________
