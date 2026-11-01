# UAT: Gold schema, read-only access and the access helper (Gold Phase 5)

**Purpose:** prove that `gold/05-schema` gives Gold a database it can read and the browser cannot write:
1. The `gold` schema, its tables and the private `gold-goods` bucket exist, and `gold` is exposed through the API
2. A signed-in staff member can **read** their own entity's purchases and call the read functions, and **cannot insert, update or delete** anything in `gold`, even with a valid MFA token
3. Another entity's staff, and a password-only (`aal1`) token, see **nothing**
4. `search_customers` finds people by name, alias, phone and ID number, and puts exact matches first
5. The database refuses changes to a saved purchase that the rules forbid (sellers, type, ID, the invoice number once set) and writes an audit row for every allowed change
6. Every future `gold-*` function can use `requireGoldStaff` to refuse calls while `GOLD_JOURNEY_ENABLED` is not `true`
7. On the client project, after merge, none of this is reachable

Nothing in the app uses Gold yet. This sheet is run with `curl` (playing the browser) and the SQL editor (playing the Phase 6 and 7 functions, which do the writes).

This sheet does not re-prove TTR behaviour. Phase 5 changes no TTR code; row 5.9 re-runs the smoke rows anyway.

| | |
|---|---|
| Environment | ________ |
| Build/commit | ________ |
| Run by / date | ________ |

**Setup.**
- A **dev** Supabase project, not the client project and not the one `main` is deployed to. Before running anything linked, confirm both of these point at dev:
  - `app/.env.local` (`VITE_SUPABASE_URL` contains the dev project ref)
  - the linked project: `npx supabase projects list` (the linked row is marked) and `cat supabase/.temp/project-ref`

  Then, from the branch:
  ```
  npx supabase db push --linked
  ```
  `db push` applies five migrations (`20261105000001` to `20261105000005`). It creates the schema `gold`, the tables, the triggers, the `gold-goods` bucket and the read functions. No edge function is deployed by this phase.
- **Expose `gold` in the dev project's API.** Dashboard → Project Settings → Data API (older dashboards: API) → **Exposed schemas** → add `gold` next to `public` and `ttr` → Save. Without this, every `gold` call below returns `PGRST106` (*The schema must be one of the following: …*). `supabase/config.toml` already lists it for the local stack, but the hosted project has its own setting.
- **Set the server flag on dev only** (used by row 5.5):
  ```
  npx supabase secrets set GOLD_JOURNEY_ENABLED=true
  ```
  `GOLD_JOURNEY_ENABLED` is a **function secret**. Every `gold-*` function refuses calls unless it is exactly `true` (`supabase/functions/_shared/goldAuth.ts`). It is a different switch from the browser's `VITE_GOLD_JOURNEY_ENABLED`. Before running the command, confirm the linked project is dev. Never set it on the client project before go-live.
- Two **staff** accounts, both enrolled in MFA: **A** in entity 1 and **B** in entity 2 (the second reporting entity from the pre-flight). Optional: a **manager** account in entity 1 for row 5.8.
- The project's **anon key** (Project Settings → API Keys), shown as `<anon key>` below.
- A **staff access token that has completed MFA** (`aal2`) for each of A and B. Sign in to any build of the app that points at dev, enter the code, then DevTools → Application → Local Storage → the `sb-<project>-auth-token` entry → copy `access_token`. It expires after an hour; copy a new one if a call returns 401. Call them `<token A>` and `<token B>`.
- A **password-only token** (`aal1`) for A: sign in, and copy the `access_token` **before** entering the MFA code (see section G of [uat-security-hardening.md](uat-security-hardening.md)). Call it `<token A aal1>`.
- Commands are written for a Unix shell (Git Bash, macOS, Linux). In PowerShell use `curl.exe` and put each JSON body in a file (`-d @body.json`).
- SQL runs in the dev project's SQL editor (service role).

**Conventions.**
- `<project>` is the dev project ref. `https://<project>.supabase.co` is its URL.
- Steps marked ⚠ are where a regression is most likely.
- A completed transaction has `status = 'complete'` in the database (not `completed`).
- Gold tables are reached with `Accept-Profile: gold` (reads) and `Content-Profile: gold` (writes and gold functions). `public` functions such as `search_customers` need neither.

**Timing.** About 45 minutes.

---

## A · Seed the test data (SQL editor)

Replace `<staff A email>` and run once. Everything is marked `UAT5` so it can be found and removed.

```sql
do $$
declare
    v_staff  uuid;
    v_entity uuid;
    v_alice  uuid := gen_random_uuid();
    v_bob    uuid := gen_random_uuid();
    v_carol  uuid := gen_random_uuid();
    v_img_a  uuid := gen_random_uuid();
    v_img_c  uuid := gen_random_uuid();
    v_cap_a  uuid := gen_random_uuid();
    v_cap_b  uuid := gen_random_uuid();
    v_cap_c  uuid := gen_random_uuid();
begin
    select id, reporting_entity_id into v_staff, v_entity
    from public.staff_members where email = '<staff A email>';
    if v_staff is null then raise exception 'no staff member with that email'; end if;

    insert into public.customers (id, reporting_entity_id, customer_type, source, created_by_staff_id,
        first_name, middle_name, last_name, date_of_birth, phone, res_street, res_suburb, res_state, res_postcode)
    values
        (v_alice, v_entity, 'individual', 'gold', v_staff, 'Alice', 'Marie', 'UAT5Smith', '1980-01-01', '+61 412 345 678', '1 Test St', 'Coburg', 'VIC', '3058'),
        (v_bob,   v_entity, 'individual', 'gold', v_staff, 'Bob',   null,    'UAT5Smith', '1975-05-05', '0499 111 222',    '2 Test St', 'Coburg', 'VIC', '3058'),
        (v_carol, v_entity, 'individual', 'gold', v_staff, 'Carol', null,    'UAT5Jones', '1990-02-02', '0455 000 999',    '3 Test St', 'Coburg', 'VIC', '3058');
    insert into public.customer_aliases (customer_id, alias) values (v_carol, 'Caz UAT5Smythe');

    -- Alice and Carol have a photographed ID (a database row only; there is no real object behind it).
    insert into ttr.stored_images (id, customer_id, object_path, content_hash_sha256, captured_by_staff_id) values
        (v_img_a, v_alice, 'customers/' || v_alice || '/' || v_cap_a || '/front-uat5.jpg', 'uat5', v_staff),
        (v_img_c, v_carol, 'customers/' || v_carol || '/' || v_cap_c || '/front-uat5.jpg', 'uat5', v_staff);
    insert into ttr.id_verifications (id, customer_id, verification_method, document_type, document_number, issuer,
        id_country_code, has_expiry, expiry_date, verification_description, is_complete, front_image_id) values
        (v_cap_a, v_alice, 'Sighted original document', 'Driver licence', 'UAT5-AB-1234', 'VIC', 'AU', true, '2030-01-01', 'Sighted in person', true, v_img_a),
        (v_cap_c, v_carol, 'Sighted original document', 'Passport', 'UAT5-PA-777', null, 'AU', true, '2031-01-01', 'Sighted in person', true, v_img_c),
        (v_cap_b, v_bob, 'Sighted original document', 'Medicare card', 'UAT5-MC-555', null, 'AU', true, '2029-01-01', 'Sighted in person', true, null);

    insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band,
        cash_10k_or_more, erp_invoice_no, phone, id_sighted, created_by_staff_id, sale_date) values
        ('00000000-0000-0000-0005-000000000001', v_entity, v_alice, v_cap_a, 'scrap',   'under_10k', false, null,         '0412 345 678', true, v_staff, current_date),
        ('00000000-0000-0000-0005-000000000002', v_entity, v_alice, v_cap_a, 'scrap',   '10k_plus',  true,  'UAT5-INV-1', '0412 345 678', true, v_staff, current_date),
        ('00000000-0000-0000-0005-000000000003', v_entity, v_bob,   v_cap_b, 'bullion', '5k_to_10k', false, 'UAT5-INV-2', '0499 111 222', true, v_staff, current_date);
    insert into gold.purchases (id, reporting_entity_id, customer_id, joint_customer_id, main_id_verification_id,
        joint_id_verification_id, purchase_type, cash_band, cash_10k_or_more, erp_invoice_no, phone, id_sighted,
        created_by_staff_id, sale_date) values
        ('00000000-0000-0000-0005-000000000004', v_entity, v_bob, v_alice, v_cap_b, v_cap_a, 'scrap', 'under_10k', false, 'UAT5-INV-3', '0499 111 222', true, v_staff, current_date);
end $$;
```

| # | Do this | Expect |
|---|---|---|
| 5.0 | `select count(*) from gold.purchases where id::text like '00000000-0000-0000-0005-%';`<br>`select id, public from storage.buckets where id = 'gold-goods';`<br>`select schemaname, tablename from pg_tables where schemaname = 'gold' order by 2;` | ☐ `4` ☐ One row, `public` = **false** ☐ Four tables: `export_audit_log`, `goods_photos`, `purchase_audit_log`, `purchases` |

## B · The browser can read and cannot write (terminal)

Set these once: `BASE=https://<project>.supabase.co` and `KEY=<anon key>`.

| # | Do this | Expect |
|---|---|---|
| 5.1 | ⚠ Insert as staff A with an `aal2` token:<br>`curl -s -w "\nHTTP %{http_code}\n" -X POST "$BASE/rest/v1/purchases" -H "apikey: $KEY" -H "Authorization: Bearer <token A>" -H "Content-Profile: gold" -H "Content-Type: application/json" -d '{"purchase_type":"scrap"}'` | ☐ HTTP **403** ☐ `"code":"42501"` and `permission denied for table purchases` ☐ `select count(*) from gold.purchases;` is unchanged |
| 5.2 | ⚠ Update, then delete, a seeded purchase:<br>`curl -s -w "\nHTTP %{http_code}\n" -X PATCH "$BASE/rest/v1/purchases?id=eq.00000000-0000-0000-0005-000000000001" -H "apikey: $KEY" -H "Authorization: Bearer <token A>" -H "Content-Profile: gold" -H "Content-Type: application/json" -d '{"cash_amount":1}'`<br>`curl -s -w "\nHTTP %{http_code}\n" -X DELETE "$BASE/rest/v1/purchases?id=eq.00000000-0000-0000-0005-000000000001" -H "apikey: $KEY" -H "Authorization: Bearer <token A>" -H "Content-Profile: gold"` | ☐ Both HTTP **403**, `42501` ☐ `select cash_amount from gold.purchases where id = '00000000-0000-0000-0005-000000000001';` is still null and the row still exists |
| 5.2a | Same refusal for the other gold tables (insert to each of `goods_photos`, `purchase_audit_log`, `export_audit_log`; `-d '{}'`) | ☐ Each HTTP **403**, `42501` |
| 5.3 | Read as staff A, then as staff B:<br>`curl -s "$BASE/rest/v1/purchases?select=id,erp_invoice_no&order=id" -H "apikey: $KEY" -H "Authorization: Bearer <token A>" -H "Accept-Profile: gold"`<br>`curl -s "$BASE/rest/v1/purchases?select=id" -H "apikey: $KEY" -H "Authorization: Bearer <token B>" -H "Accept-Profile: gold"` | ☐ A gets the **four** seeded rows (`UAT5-INV-1`, `-2`, `-3` and one `null`), plus any other purchases in entity 1 ☐ B gets `[]` |
| 5.3a ⚠ | Same read as A with the **password-only** token:<br>`curl -s "$BASE/rest/v1/purchases?select=id" -H "apikey: $KEY" -H "Authorization: Bearer <token A aal1>" -H "Accept-Profile: gold"` | ☐ `[]` (MFA is enforced in the database, not only in the browser) |
| 5.3b | `curl -s "$BASE/rest/v1/purchases?select=id" -H "apikey: $KEY" -H "Accept-Profile: gold"` (anon key only, no user token) | ☐ HTTP 401 or 403, no rows |
| 5.3c | Staff cannot read the export audit log. As A: `curl -s "$BASE/rest/v1/export_audit_log?select=id" -H "apikey: $KEY" -H "Authorization: Bearer <token A>" -H "Accept-Profile: gold"`.<br>Optional, if you have a manager account: insert a row in the SQL editor (`insert into gold.export_audit_log (reporting_entity_id, staff_member_id, kind) select reporting_entity_id, id, 'zip' from public.staff_members where email = '<manager email>';`) and read it with the manager's `aal2` token | ☐ `[]` for staff A ☐ (optional) the manager sees one row, staff A still sees none |
| 5.3d | The goods bucket is closed to the browser. Open the project's Storage page and check `gold-goods`. Then as A: `curl -s -o /dev/null -w "HTTP %{http_code}\n" "$BASE/storage/v1/object/list/gold-goods" -H "apikey: $KEY" -H "Authorization: Bearer <token A>" -H "Content-Type: application/json" -d '{"prefix":""}'` | ☐ `gold-goods` is listed as **Private** ☐ The list call returns an empty list or an error status, never object names. A successful upload by the browser is a failure |

## C · The read functions (terminal)

| # | Do this | Expect |
|---|---|---|
| 5.4 | ⚠ Search as A. Run each:<br>`curl -s -X POST "$BASE/rest/v1/rpc/search_customers" -H "apikey: $KEY" -H "Authorization: Bearer <token A>" -H "Content-Type: application/json" -d '{"p_q":"<term>"}'`<br>with `<term>` =<br>(a) `UAT5smith`<br>(b) `marie`<br>(c) `smythe`<br>(d) `+61 412 345 678`<br>(e) `0412`<br>(f) `041`<br>(g) `uat5-ab 1234`<br>(h) `u`<br>(i) `%%` | ☐ (a) Alice then Bob (last name equal, so first name order) ☐ (b) Alice only (middle name) ☐ (c) Carol only (alias) ☐ (d) Alice only (`+61` read as `0`) ☐ (e) Alice (4 digits is enough for a phone) ☐ (f) `[]` (3 digits is not) ☐ (g) Alice (the ID number `UAT5-AB-1234` found with spaces and a dash dropped) ☐ (h) `[]` (one character) ☐ (i) `[]` (wildcards are literal) ☐ Alice's row carries `current_id_document_type` `Driver licence`, `current_id_document_number` `UAT5-AB-1234`, `current_id_expiry_date` `2030-01-01` and a `current_id_captured_at`; Bob's row shows his `Medicare card` / `UAT5-MC-555` |
| 5.4a | The same search as B (`<token B>`) and with `<token A aal1>` | ☐ Both `[]` |
| 5.4b | Exact ranks first. In the SQL editor add a customer whose phone merely *contains* Bob's: `insert into public.customers (reporting_entity_id, customer_type, source, first_name, last_name, phone) select reporting_entity_id, 'individual', 'gold', 'Aaron', 'UAT5Aaronson', '0499 111 2223' from public.staff_members where email = '<staff A email>';`<br>Search `0499111222` as A | ☐ Bob (exact) comes **before** Aaron (whose number only contains it), although Aaronson sorts first by name |
| 5.4c | The current ID, duplicates and readiness:<br>`curl -s -X POST "$BASE/rest/v1/rpc/customer_current_id" … -d '{"p_customer_id":"<Alice id>"}'`<br>`curl -s -X POST "$BASE/rest/v1/rpc/find_possible_duplicate_customers" … -d '{"p_first_name":"alice","p_last_name":"uat5smith","p_dob":"1980-01-01","p_phone":null}'`<br>`curl -s -X POST "$BASE/rest/v1/rpc/customer_ttr_ready" … -d '{"p_customer_id":"<Alice id>"}'`<br>(`<Alice id>`: `select id from public.customers where first_name = 'Alice' and last_name = 'UAT5Smith';`. `<sale date>`: `select sale_date from gold.purchases where id = '00000000-0000-0000-0005-000000000002';`) | ☐ The first returns Alice's licence (`document_number` `UAT5-AB-1234`, `captured_by_name` staff A's name, `front_image_id` set) ☐ The second returns Alice with `match_reason` `name_dob` ☐ The third returns a list that includes `occupation`, `gender`, `citizenship_country_code`, `tax_residency_country_code` and `is_sole_trader` (Gold never collects those), and does **not** include `date_of_birth`, `res_street` or `phone` |
| 5.4d | Purchases, with `-H "Content-Profile: gold"` on each:<br>`rpc/list_incomplete_purchases` `-d '{}'`<br>`rpc/linked_parts` `-d '{"p_customer_id":"<Alice id>","p_invoice_norm":"uat5-inv-1","p_sale_date":"<sale date>"}'`<br>`rpc/invoice_purchases` `-d '{"p_invoice":" uat5-inv-3 "}'`<br>`rpc/search_gold_purchases` `-d '{"p_filters":{"q":"alice","status":"incomplete"},"p_page":1,"p_page_size":10}'`<br>`rpc/list_recorded_by` `-d '{}'`<br>`rpc/purchase_id_used` `-d '{"p_purchase_id":"00000000-0000-0000-0005-000000000004"}'` | ☐ `list_incomplete_purchases`: the purchase with no invoice (`…0001`) **and** `…0002` (reportable, no TTR), each with `customer_first_name` and `ttr_status` null ☐ `linked_parts`: `…0002` (the invoice typed in lower case still matches) ☐ `invoice_purchases`: `…0004` (the spaces and case are ignored) ☐ `search_gold_purchases`: those same two, each with `total_count` 2 ☐ `list_recorded_by`: staff A ☐ `purchase_id_used`: two rows, `main` (Bob's Medicare card) and `joint` (Alice's licence), `photos_replaced` false |
| 5.4e | Repeat the five calls in 5.4d that return rows with `<token B>`, then with `<token A aal1>` | ☐ Every response is `[]` |

## D · The flag (terminal)

There is no `gold-*` function yet. To prove the access helper end to end, deploy a throw-away stub to dev. Save this as `supabase/functions/gold-auth-check/index.ts` **without committing it**:

```ts
import { requireGoldStaff } from "../_shared/goldAuth.ts";

Deno.serve(async (req) => {
  const ctx = await requireGoldStaff(req, { minRole: new URL(req.url).searchParams.get("role") === "manager" ? "manager" : "staff" });
  if (ctx instanceof Response) return ctx;
  return new Response(JSON.stringify({ ok: true, role: ctx.staff.role }), { headers: { "Content-Type": "application/json" } });
});
```

Add to `supabase/config.toml` for the deploy only (do not commit): `[functions.gold-auth-check]` with `verify_jwt = true`. Then `npx supabase functions deploy gold-auth-check --project-ref <project>` (dev).

| # | Do this | Expect |
|---|---|---|
| 5.5 | ⚠ With the secret **unset**: `npx supabase secrets unset GOLD_JOURNEY_ENABLED`, then<br>`curl -s -w "\nHTTP %{http_code}\n" -X POST "$BASE/functions/v1/gold-auth-check" -H "apikey: $KEY" -H "Authorization: Bearer <token A>"` | ☐ HTTP **403** `{"error":"gold_disabled"}` |
| 5.5a | `npx supabase secrets set GOLD_JOURNEY_ENABLED=true`. Wait about 10 seconds. Repeat the call | ☐ HTTP 200 `{"ok":true,"role":"staff"}` |
| 5.5b | With the secret on, try the failure cases:<br>(1) the same call with `<token A aal1>`<br>(2) the same call with no `Authorization` header and only the anon key<br>(3) the call with `<token A>` to `…/gold-auth-check?role=manager` (staff A is not a manager) | ☐ (1) HTTP **403** `{"error":"mfa_required"}` ☐ (2) HTTP 401 ☐ (3) HTTP **403** `{"error":"forbidden"}` ☐ (optional) with a manager's token, (3) returns 200 |
| 5.5c | Clean up: `npx supabase functions delete gold-auth-check --project-ref <project>`, delete the local stub file and the `config.toml` lines | ☐ The function is gone; `git status` shows no stub |

## E · The database refuses forbidden changes (SQL editor)

Run each statement on its own; the first four must fail.

```sql
update gold.purchases set purchase_type = 'bullion', cash_band = 'under_5k'
    where id = '00000000-0000-0000-0005-000000000001';               -- (1)
update gold.purchases set erp_invoice_no = 'UAT5-INV-X'
    where id = '00000000-0000-0000-0005-000000000002';               -- (2)
update gold.purchases set erp_invoice_no = null
    where id = '00000000-0000-0000-0005-000000000002';               -- (3)
update gold.purchases set completed_at = now(), completed_by_staff_id = (select id from public.staff_members where email = '<staff A email>')
    where id = '00000000-0000-0000-0005-000000000001';               -- (4)
```

Then the allowed completion, in one block:

```sql
begin;
select set_config('app.actor_staff_id', (select id::text from public.staff_members where email = '<staff A email>'), true),
       set_config('app.change_source', 'uat5', true);
update gold.purchases
   set erp_invoice_no = 'UAT5-INV-9', completed_at = now(),
       completed_by_staff_id = (select id from public.staff_members where email = '<staff A email>')
 where id = '00000000-0000-0000-0005-000000000001';
commit;

select changes, changed_by, source from gold.purchase_audit_log
 where purchase_id = '00000000-0000-0000-0005-000000000001';
update gold.purchase_audit_log set source = 'x';                      -- (5)
```

| # | Do this | Expect |
|---|---|---|
| 5.7 | ⚠ Run (1) to (4), the completion block, and (5) | ☐ (1) *a gold purchase cannot change its sellers, type, ID, counter answers, sale date or creator after it is saved* ☐ (2) and (3) *the ERP invoice number cannot be changed or removed once it is set* ☐ (4) *completed_at can only be set by the update that adds the ERP invoice number* ☐ The completion block succeeds ☐ The audit query returns **one** row: `changes` has `erp_invoice_no` (`old` null, `new` `UAT5-INV-9`), `completed_at` and `completed_by_staff_id`; `changed_by` is staff A; `source` is `uat5` ☐ (5) *Audit log is append-only* |

## F · Client project, after merge (terminal)

Run only after this branch is merged and the migrations reach the client project. Use the **client** project ref and an `aal2` token for one client staff member.

| # | Do this | Expect |
|---|---|---|
| 5.6 | Before exposing anything, confirm the client project's Exposed schemas do **not** list `gold`, and the secret is unset: `npx supabase secrets list --project-ref <client ref>` shows no `GOLD_JOURNEY_ENABLED`. Then:<br>`curl -s -w "\nHTTP %{http_code}\n" "https://<client ref>.supabase.co/rest/v1/purchases?select=id" -H "apikey: <client anon key>" -H "Authorization: Bearer <client token>" -H "Accept-Profile: gold"` | ☐ HTTP **406** with `PGRST106` (*The schema must be one of the following*): the gold tables are unreachable ☐ The secrets list has no `GOLD_JOURNEY_ENABLED`, so any future `gold-*` function returns 403 `gold_disabled` ☐ In the client project's Storage, `gold-goods` exists and is private |

## G · Existing smoke rows

| # | Do this | Expect |
|---|---|---|
| 5.9 | Re-run the TTR smoke rows of [uat-test-matrix.md](uat-test-matrix.md) (the AUSTRAC smoke test, R24–R26), and search for a returning customer in a TTR | ☐ All pass as before ☐ The TTR customer search still finds the `UAT5` customers by first + last name |

## Clean up (SQL editor, service role)

```sql
delete from gold.purchases where id::text like '00000000-0000-0000-0005-%';
delete from ttr.id_verifications where document_number like 'UAT5-%';
delete from ttr.stored_images where content_hash_sha256 = 'uat5';
delete from public.customers where last_name like 'UAT5%';
```

The audit rows written in 5.7 stay: the audit log is append-only by design, and the rows carry no personal details (only column names and the test values above).

**What a failure looks like:**
- **Any gold call returns `PGRST106`.** `gold` is not in the project's Exposed schemas (Setup). Add it and retry.
- **5.1 or 5.2 returns 2xx.** A write path is open to the browser. Stop: `select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'gold' and grantee in ('anon', 'authenticated');` must show `SELECT` for `authenticated` only.
- **5.3 shows B the rows of A, or 5.3a shows rows.** RLS is wrong or `public.reporting_entity_id()` is not enforcing `aal2`. Compare with `select public.reporting_entity_id();` run as each token's user.
- **5.4 returns Bob before Alice for `UAT5smith`.** Sort order is last name then first name: Alice before Bob. If the order differs, the function body is not the one in the migration.
- **5.4 returns HTTP 404 for `rpc/search_customers`.** The migrations did not apply (`select proname from pg_proc where proname = 'search_customers';`) or PostgREST has not reloaded its schema cache: run `notify pgrst, 'reload schema';`.
- **5.5 returns 401 with a good token.** The function was deployed with `verify_jwt = false` and a stale deployment, or the token expired. Fetch a new token.
- **5.5a still returns `gold_disabled`.** Secrets reach a function on its next start; wait a minute or redeploy the stub.
- **5.7 (2) succeeds.** The immutability trigger is missing (`select tgname from pg_trigger where tgrelid = 'gold.purchases'::regclass;` should list `trg_gp_immutable` and `trg_gp_audit`).

---

## Sign-off

☐ All checks pass · Notes: ______________________________________________
