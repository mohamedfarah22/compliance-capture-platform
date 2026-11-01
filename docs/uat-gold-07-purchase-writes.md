# UAT: Gold purchase writes (Gold Phase 7)

**Purpose:** prove that `gold/07-purchase-writes` lets staff record and complete gold purchases through the server, and that the server, not the browser, decides every rule:
1. `gold-save-purchase` saves a purchase with its goods photos in **one transaction**, and refuses what the rules forbid (photo required, sighted box, cash thresholds, expired or out-of-window ID, case B invoice, duplicate invoice, completed TTR)
2. Every computed value (cash band, reportable flag, totals, sale date, ID flags, ID used, who recorded it, counter answers) is worked out **on the server**. A client that sends different values is ignored
3. `gold-complete-purchase` adds the ERP invoice number once, with `completed_at` / `completed_by_staff_id` in the same update, and applies the same rules
4. `get-gold-photo-urls` returns short-lived signed URLs, only for the caller's own business
5. `reconcile-stored-images` reports and sweeps orphaned goods photo objects, safely (dry run by default, never deletes a row)
6. Every function refuses while `GOLD_JOURNEY_ENABLED` is not `true`, below `aal2`, for anonymous callers and across businesses
7. A saved purchase stays immutable, every allowed change is audited, and logs carry IDs and error codes only

No screen uses these functions yet (Phase 8), so every row is a direct call to the function plus a check in the database.

| | |
|---|---|
| Environment | ________ |
| Build/commit | ________ |
| Run by / date | ________ |

**Timing.** About 90 minutes for the whole sheet on a local stack.

**Where the rules come from.** Spec §1.7 (C1 to C3), §3.3, §3.3a, §3.4, §3.5, §4.2 to §4.6, §5.1 and §6.1 of `docs/gold-due-diligence-spec.md`. The "Spec" column names the clause each row proves. Where the spec fixes a behaviour but not a response code, the code is given as *(contract: ...)* and is the one documented in the header comment of the function.

---

## Setup

### 1 · Stack

Local stack from this branch's directory, so that the functions served are this branch's:

```
npx supabase stop && npx supabase start && npx supabase db reset
```

`supabase/config.toml` carries `[edge_runtime.secrets] GOLD_JOURNEY_ENABLED = "true"`, which the local CLI hands to the local functions. It is read by the local CLI only. It never reaches a hosted project. On a hosted **dev** project, run `npx supabase secrets set GOLD_JOURNEY_ENABLED=true`.

Check the stack is serving the three new functions and gold is on:

```
curl -s -X POST http://127.0.0.1:54321/functions/v1/gold-save-purchase -H "apikey: <anon key>" -H "Authorization: Bearer <anon key>"
```

☐ Returns `{"error":"unauthorized"}` (gold is on and an anon key is not a staff session). Not `Function not found` (the stack was started from another directory) and not `gold_disabled` (the secret is missing).

### 2 · Variables and helpers

Use bash 4 or later (Git Bash is fine). `npx supabase status -o env` prints the URL and keys.

```bash
export API=http://127.0.0.1:54321
export ANON=<ANON_KEY>  SERVICE=<SERVICE_ROLE_KEY>
export DB=supabase_db_compliance-capture-platform

q()    { docker exec -i $DB psql -U postgres -At -c "$1"; }          # SQL as the database owner
pid()  { sed -n 's/.*"purchaseId":"\([^"]*\)".*/\1/p' | head -1; }   # purchase id from a response

# sp key=value ...   gold-save-purchase as $TOKEN (default $T1).
# Defaults: purchaseType=scrap cash10k=false phone="0412 345 678" idSighted=true and the photo(s) in $PHOTOS
# (default goods1.jpg). key=- drops a default. PHOTOS="" sends no photo.
sp() {
  declare -A kv=([purchaseType]=scrap [cash10k]=false [phone]="0412 345 678" [idSighted]=true)
  local args=() a k p
  for a in "$@"; do kv[${a%%=*}]=${a#*=}; done
  for k in "${!kv[@]}"; do [ "${kv[$k]}" = "-" ] || args+=(-F "$k=${kv[$k]}"); done
  for p in ${PHOTOS-goods1.jpg}; do args+=(-F "photos=@$p;type=image/jpeg"); done
  curl -s -w '\nHTTP %{http_code}\n' -X POST "$API/functions/v1/gold-save-purchase" \
    -H "apikey: $ANON" -H "Authorization: Bearer ${TOKEN:-$T1}" "${args[@]}"
}
# cp_ '<json>'   gold-complete-purchase as $TOKEN
cp_()  { curl -s -w '\nHTTP %{http_code}\n' -X POST "$API/functions/v1/gold-complete-purchase" \
           -H "apikey: $ANON" -H "Authorization: Bearer ${TOKEN:-$T1}" -H 'Content-Type: application/json' -d "$1"; }
# gu <purchaseId>   get-gold-photo-urls as $TOKEN
gu()   { curl -s -w '\nHTTP %{http_code}\n' -X POST "$API/functions/v1/get-gold-photo-urls" \
           -H "apikey: $ANON" -H "Authorization: Bearer ${TOKEN:-$T1}" -H 'Content-Type: application/json' -d "{\"purchaseId\":\"$1\"}"; }
# rec '<json>'   reconcile-stored-images with the service-role key
rec()  { curl -s -w '\nHTTP %{http_code}\n' -X POST "$API/functions/v1/reconcile-stored-images" \
           -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" -H 'Content-Type: application/json' -d "${1:-{\}}"; }
```

Photos. The server checks the JPEG signature (`FF D8 FF`), the content type and the size, not the picture, so tiny files do for everything except the signed-URL rows, which are clearer with a real photo (resize any photo to 1600 px or less, under 5 MiB):

```bash
for n in 1 2 3; do printf '\xff\xd8\xff\xe0UAT-goods-photo-%s-0123456789\xff\xd9' $n > goods$n.jpg; done
head -c 100 /dev/zero | tr '\0' 'x' >> goods2.jpg; head -c 100 /dev/zero | tr '\0' 'x' >> goods3.jpg   # goods1.jpg is 34 bytes, the others 134
printf '\x89PNG\r\n\x1a\n-not-a-jpeg' > notjpeg.png
printf 'plain text pretending to be a jpeg' > fake.jpg
head -c 5300000 /dev/zero | tr '\0' 'x' > big.jpg; printf '\xff\xd8\xff' | dd of=big.jpg conv=notrunc 2>/dev/null   # 5.3 MB, over the cap
```

### 3 · Dummy data

One business (**One**) with two staff, a second business (**Two**), and seven customers. Create the staff logins through the Auth admin API (fixed ids, so the SQL below can refer to them), then seed with SQL.

```bash
mk_user() { curl -s -X POST "$API/auth/v1/admin/users" -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" \
  -H 'Content-Type: application/json' -d "{\"id\":\"$1\",\"email\":\"$2\",\"password\":\"uat-password-1\",\"email_confirm\":true}" | head -c 80; echo; }
mk_user a0000000-0000-4000-8000-000000000001 uat-gold-staff1@example.test    # S1: active staff, business One
mk_user a0000000-0000-4000-8000-000000000002 uat-gold-staff2@example.test    # S2: active staff, business Two
mk_user a0000000-0000-4000-8000-000000000003 uat-gold-gone@example.test      # S3: deactivated staff, business One
```

```sql
-- psql as the database owner:  docker exec -i $DB psql -U postgres
insert into public.reporting_entities (id, legal_name, idv_max_reliance_days) values
  ('e0000000-0000-4000-8000-000000000001', 'UAT Gold One Pty Ltd', 730),
  ('e0000000-0000-4000-8000-000000000002', 'UAT Gold Two Pty Ltd', 730);

insert into public.staff_members (id, reporting_entity_id, full_name, email, role, is_active) values
  ('a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'UAT Staff One', 'uat-gold-staff1@example.test', 'staff', true),
  ('a0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002', 'UAT Staff Two', 'uat-gold-staff2@example.test', 'staff', true),
  ('a0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000001', 'UAT Staff Gone', 'uat-gold-gone@example.test', 'staff', false);

-- READY has every field a TTR needs (case A possible). GOLDONLY lacks occupation, gender, citizenship,
-- tax residency and sole-trader (case B). The rest differ only in their ID.
insert into public.customers (id, reporting_entity_id, customer_type, source, first_name, last_name, date_of_birth, phone,
    res_street, res_suburb, res_state, res_postcode, res_country,
    occupation, gender, citizenship_country_code, tax_residency_country_code, is_sole_trader) values
  ('c0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'individual', 'gold', 'Ruth',   'Ready',    '1980-01-01', '0411 111 111', '1 Test St', 'Coburg', 'VIC', '3058', 'AU', 'Jeweller', 'F', 'AU', 'AU', false),
  ('c0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', 'individual', 'gold', 'Gina',   'Goldonly', '1981-02-02', '0422 222 222', '2 Test St', 'Coburg', 'VIC', '3058', 'AU', null, null, null, null, null),
  ('c0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000001', 'individual', 'gold', 'Eddie',  'Expired',  '1982-03-03', '0433 333 333', '3 Test St', 'Coburg', 'VIC', '3058', 'AU', 'Jeweller', 'M', 'AU', 'AU', false),
  ('c0000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000001', 'individual', 'gold', 'Olive',  'Old',      '1983-04-04', '0444 444 444', '4 Test St', 'Coburg', 'VIC', '3058', 'AU', 'Jeweller', 'F', 'AU', 'AU', false),
  ('c0000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-000000000001', 'individual', 'gold', 'Jack',   'Joint',    '1984-05-05', '0455 555 555', '5 Test St', 'Coburg', 'VIC', '3058', 'AU', 'Jeweller', 'M', 'AU', 'AU', false),
  ('c0000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-000000000001', 'individual', 'gold', 'Nina',   'Noid',     '1985-06-06', '0466 666 666', '6 Test St', 'Coburg', 'VIC', '3058', 'AU', 'Jeweller', 'F', 'AU', 'AU', false),
  ('c0000000-0000-4000-8000-000000000007', 'e0000000-0000-4000-8000-000000000002', 'individual', 'gold', 'Fiona',  'Foreign',  '1986-07-07', '0477 777 777', '7 Test St', 'Coburg', 'VIC', '3058', 'AU', 'Jeweller', 'F', 'AU', 'AU', false);

-- One ID capture each, except NOID. READY, GOLDONLY, JOINT and FOREIGN: licence valid to 2031, photographed 10 days ago.
-- EXPIRED: licence expired 2020-01-01. OLD: valid to 2031 but photographed 800 days ago (outside the 730-day window).
insert into ttr.stored_images (id, customer_id, object_path, content_hash_sha256, captured_by_staff_id)
select ('b0000000-0000-4000-8000-00000000000' || n)::uuid, ('c0000000-0000-4000-8000-00000000000' || n)::uuid,
       'customers/c0000000-0000-4000-8000-00000000000' || n || '/f0000000-0000-4000-8000-00000000000' || n || '/front-uat.jpg',
       'uat-hash-' || n, 'a0000000-0000-4000-8000-000000000001'
from generate_series(1, 7) n where n <> 6;

insert into ttr.id_verifications (id, customer_id, verification_method, document_type, document_number, issuer, id_country_code,
    has_expiry, expiry_date, verification_description, is_complete, front_image_id, created_at)
select ('f0000000-0000-4000-8000-00000000000' || n)::uuid, ('c0000000-0000-4000-8000-00000000000' || n)::uuid,
       'Sighted original document', 'Driver licence', 'UAT-LIC-' || n, 'VIC', 'AU', true,
       case n when 3 then date '2020-01-01' else date '2031-01-01' end, 'Sighted in person', true,
       ('b0000000-0000-4000-8000-00000000000' || n)::uuid,
       case n when 4 then now() - interval '800 days' else now() - interval '10 days' end
from generate_series(1, 7) n where n <> 6;
```

```bash
export READY=c0000000-0000-4000-8000-000000000001   GOLDONLY=c0000000-0000-4000-8000-000000000002
export EXPIRED=c0000000-0000-4000-8000-000000000003 OLD=c0000000-0000-4000-8000-000000000004
export JOINTC=c0000000-0000-4000-8000-000000000005  NOID=c0000000-0000-4000-8000-000000000006
export FOREIGN=c0000000-0000-4000-8000-000000000007
export S1=a0000000-0000-4000-8000-000000000001      S2=a0000000-0000-4000-8000-000000000002
export E1=e0000000-0000-4000-8000-000000000001      E2=e0000000-0000-4000-8000-000000000002
export READYVER=f0000000-0000-4000-8000-000000000001 JOINTVER=f0000000-0000-4000-8000-000000000005
```

### 4 · Tokens

Run from the repository root. The function uses `@supabase/supabase-js` and `otpauth` from `app/node_modules`. It enrols an authenticator on each login and loads the tokens into the shell.

```bash
tokens() {
  (cd app && node --input-type=module -e '
import { createClient } from "@supabase/supabase-js";
import { Secret, TOTP } from "otpauth";
const { API, ANON } = process.env;
const login = async (email) => {
  const c = createClient(API, ANON, { auth: { persistSession: false } });
  const { data: a1, error } = await c.auth.signInWithPassword({ email, password: "uat-password-1" });
  if (error) throw error;
  const { data: f } = await c.auth.mfa.enroll({ factorType: "totp" });
  const { data: ch } = await c.auth.mfa.challenge({ factorId: f.id });
  const code = new TOTP({ secret: Secret.fromBase32(f.totp.secret) }).generate();
  const { data: a2 } = await c.auth.mfa.verify({ factorId: f.id, challengeId: ch.id, code });
  return [a1.session.access_token, a2.access_token];
};
const [t1aal1, t1] = await login("uat-gold-staff1@example.test");
const [, t2] = await login("uat-gold-staff2@example.test");
const [, t3] = await login("uat-gold-gone@example.test");
console.log(`export T1_AAL1=${t1aal1}\nexport T1=${t1}\nexport T2=${t2}\nexport T3=${t3}`);
  ') > uat-tokens.env && source uat-tokens.env
}
tokens
```

`T1` is staff of One at `aal2`, `T1_AAL1` the same person with the password only, `T2` staff of Two, `T3` the deactivated staff member. Tokens last 5 minutes locally (`jwt_expiry = 300`): **run `tokens` again when rows start returning 401**. Delete `uat-tokens.env` afterwards.

Check once: `q "select count(*) from gold.purchases"` returns `0`.

☐ Setup done

**Conventions.**
- Responses are shown as JSON followed by `HTTP <status>`.
- "Nothing written" means: no new row in `gold.purchases` or `gold.goods_photos`, no new object in the `gold-goods` bucket, and no change to any existing purchase. Check with:
  ```bash
  snap() { q "select (select count(*) from gold.purchases), (select count(*) from gold.goods_photos), (select count(*) from storage.objects where bucket_id='gold-goods'), (select count(*) from gold.purchase_audit_log)"; }
  ```
  Run `snap` before and after, and expect the same line.
- `<today>` is today's date in Melbourne.
- Rows marked ⚠ are where a regression does the most harm.
- Rows depend on earlier rows only where they say so ("uses P10" means the purchase id saved by row 7.10). Keep a note of each id, or `export P10=...`.

---

## A · Refusals (all three functions)

For each row, call **every** function (`sp`, `cp_`, `gu`) with a purchase that exists, as in `PHOTOS=goods1.jpg TOKEN=... sp customerId=$READY`, `cp_ '{"purchaseId":"<P10>","erpInvoiceNo":"INV-UAT-X"}'`, `gu <P10>` (do 7.10 first, or use any existing purchase id; the refusal happens before it is looked up).

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.1 ⚠ | §2.2 (server secret) | Switch gold off: local, comment out the `[edge_runtime.secrets]` lines of `supabase/config.toml` and run `npx supabase stop && npx supabase start`; dev, `npx supabase secrets unset GOLD_JOURNEY_ENABLED`. Call each function with `TOKEN=$T1` | ☐ Each returns **403** `{"error":"gold_disabled"}` ☐ `snap` unchanged ☐ Put the setting back and restart. Re-check with the setup probe (401 `unauthorized`) |
| 7.2 ⚠ | §6.1 (verify JWT) | Call each function with **no** `Authorization` header, then with `Authorization: Bearer $ANON` (the anon key) | ☐ Each returns **401** (no body detail beyond `unauthorized`, or the gateway's own 401) ☐ `snap` unchanged |
| 7.3 ⚠ | §6.1 (`aal2`) | `TOKEN=$T1_AAL1` and call each function (password-only session) | ☐ Each returns **403** `{"error":"mfa_required"}` ☐ `snap` unchanged |
| 7.4 | §6.1 (active staff) | `TOKEN=$T3` (deactivated staff member, with MFA) and call each function | ☐ Each returns **403** `{"error":"forbidden"}` ☐ `snap` unchanged |
| 7.5 ⚠ | §6.1, §4.3 (entity scope) | `TOKEN=$T2` (staff of Two): `sp customerId=$READY` | ☐ **404** `{"error":"customer_not_found"}` (contract), the same answer as for an id that does not exist ☐ `snap` unchanged |
| 7.6 ⚠ | §6.1, §4.3 | `TOKEN=$T2`: `cp_` on a purchase of One (use P10 once it exists); then `gu` on it | ☐ Both **404** `purchase_not_found` (contract) ☐ P10 still has no invoice (`q "select erp_invoice_no from gold.purchases where id='<P10>'"` is empty) |
| 7.7 | §6.1, §4.3 | `TOKEN=$T1` (staff of One): `sp customerId=$FOREIGN` (a customer of Two) | ☐ **404** `customer_not_found` ☐ `snap` unchanged |
| 7.8 | §4.5 ("any active staff") | `TOKEN=$T1` is a plain `staff` role. Rows 7.10 onward all run as `$T1` | ☐ A plain staff member can save, complete and get URLs (7.10, 7.90, 7.110 pass) |

## B · Saving a purchase, and the photo rule

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.10 ⚠ | §4.5, §4.2, §4.3 | `sp customerId=$READY` (non-reportable scrap, one photo). Keep the id as **P10** | ☐ **201** `{"purchaseId":"<uuid>","ttr":null,"warnings":{}}` ☐ `q "select purchase_type, cash_band, cash_10k_or_more, cash_amount, erp_invoice_no, id_sighted, phone, created_by_staff_id, reporting_entity_id, completed_at from gold.purchases where id='<P10>'"` returns, in that order, `scrap`, `under_10k`, `f`, an **empty** cash amount, an **empty** invoice, `t`, `0412 345 678`, S1's id, E1's id and an **empty** `completed_at` ☐ `main_id_verification_id` is `$READYVER` and the `joint_*` columns are null ☐ `sale_date` = `q "select (now() at time zone 'Australia/Melbourne')::date"` |
| 7.11 ⚠ | §4.2 (`gold.goods_photos`) | `PHOTOS="goods1.jpg goods2.jpg goods3.jpg" sp customerId=$READY` → **P11** | ☐ 201 ☐ `q "select sort_order, object_path, content_type, storage_bucket, byte_size from gold.goods_photos where purchase_id='<P11>' order by sort_order"` has three rows: sort order 0, 1, 2; paths `<P11>/goods-1.jpg`, `goods-2.jpg`, `goods-3.jpg`; `image/jpeg`; `gold-goods`; sizes equal each file's size ☐ `content_hash_sha256` of each row equals `sha256sum goodsN.jpg` ☐ `q "select name from storage.objects where bucket_id='gold-goods' and name like '<P11>/%' order by name"` lists the same three paths ☐ The captured-by of each photo is S1 |
| 7.12 ⚠ | §4.3 (photo required) | Before: `snap`. `PHOTOS="" sp customerId=$READY` | ☐ **422** `{"error":"validation_failed","errors":{"photos":"Add at least one photo of the items purchased."}, ...}` ☐ `snap` unchanged |
| 7.13 | §4.5 (JPEG, size cap) | Each with `snap` before and after: `PHOTOS=notjpeg.png sp customerId=$READY`; `PHOTOS=fake.jpg sp customerId=$READY` (a text file sent with content type `image/jpeg`); `PHOTOS="goods1.jpg big.jpg" sp customerId=$READY`; `PHOTOS="goods1.jpg goods1.jpg goods1.jpg goods1.jpg goods1.jpg goods1.jpg goods1.jpg goods1.jpg goods1.jpg goods1.jpg goods1.jpg" sp customerId=$READY` (11 photos) | ☐ **415** `photo_not_jpeg` ☐ **415** `photo_not_jpeg` (a wrong signature is refused even with the right content type) ☐ **413** `photo_too_large` (contract: over 5 MiB) ☐ **400** `bad_request` field `photos` (contract: more than 10) ☐ `snap` unchanged every time, including that no `goods1.jpg` from the oversize request was stored |
| 7.14 ⚠ | §1.7 C3 | `sp customerId=$READY idSighted=-` (box not sent); then `idSighted=false`; then `idSighted=yes`. Then a joint sale: `sp customerId=$READY jointCustomerId=$JOINTC idSighted=false` | ☐ Each of the first three: **422** with `errors.idSighted` = "ID must be sighted today and match the record on file. Doesn't match the record? Update ID first." ☐ The joint sale: `errors.idSighted` starts "Both people's IDs must be sighted today and match the records on file." ☐ `snap` unchanged |
| 7.15 | §4.3 (phone 8+ digits) | `sp customerId=$READY phone=-`; `sp customerId=$READY phone=1234567`; `sp customerId=$READY phone="04 1234 5678"` | ☐ First: **422** `errors.phone` (a phone is required) ☐ Second: **422** `errors.phone` "Phone number looks too short." ☐ Third: **201** and the row's phone is `04 1234 5678` |
| 7.16 | §5.1 (`parseAud`) | `sp customerId=$READY cash10k=true cashAmount="ten grand" erpInvoiceNo=INV-UAT-16` | ☐ **422** `errors.cashAmount` "Enter an amount like 12,500 or 12500.50." ☐ `snap` unchanged |
| 7.17 | §4.3 | `sp customerId=$READY purchaseType=diamonds`; `sp customerId=not-a-uuid`; `sp customerId=$READY cash10k=-` (scrap without the cash answer) | ☐ Each **400** `bad_request` naming the field (contract) ☐ `snap` unchanged |

## C · Cash thresholds (computed on the server)

All with `customerId=$READY`, a valid ID, and no invoice unless stated. Read the row back with `q "select cash_band, cash_10k_or_more, cash_amount from gold.purchases where id='<id>'"`. Where a sale is reportable and READY is ready on file, the form asks the two counter questions, so rows that save a reportable sale send `ttrSelfConducted=true ttrDetailsConfirmed=true` (case A, see section E).

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.20 ⚠ | §3.3 (Reportable), §5.1 | Scrap, Yes, **$9,999.99**: `sp customerId=$READY cash10k=true cashAmount=9,999.99` | ☐ 201 `ttr: null` ☐ `under_10k`, `f`, `9999.99` |
| 7.21 ⚠ | §3.3, §5.1 | Scrap, Yes, **exactly $10,000**: `sp customerId=$READY cash10k=true cashAmount=10000 ttrSelfConducted=true ttrDetailsConfirmed=true` → **P21** | ☐ 201 `ttr: "A"` ☐ `10k_plus`, `t`, `10000.00` |
| 7.22 | §5.1 | Scrap, Yes, **no amount**: `sp customerId=$GOLDONLY cash10k=true erpInvoiceNo=INV-UAT-22` | ☐ 201 `ttr: "B"` ☐ `10k_plus`, `t`, amount empty |
| 7.23 | §5.1 | Scrap, Yes but **$8,000**: `sp customerId=$READY cash10k=true cashAmount=8000` | ☐ 201 `ttr: null` ☐ `under_10k`, `f`, `8000.00` (the amount decides) |
| 7.24 | §5.1 | Scrap paid by bank transfer, with a stray amount: `sp customerId=$READY cash10k=false cashAmount=50000` | ☐ 201 `ttr: null` ☐ `under_10k`, `f`, amount **empty** (the amount is only read when the answer is Yes) |
| 7.25 | §5.1 | Bullion under $5,000: `sp customerId=$READY purchaseType=bullion cash10k=- bullionBand=under_5k` | ☐ 201 ☐ `under_5k`, `f` |
| 7.26 ⚠ | §1.7 C2, §5.1 (`needsCurrentId`) | Bullion $5,000 to $9,999 with a current ID: `sp customerId=$READY purchaseType=bullion cash10k=- bullionBand=5k_to_10k`. Then with an expired ID: `sp customerId=$EXPIRED purchaseType=bullion cash10k=- bullionBand=5k_to_10k` | ☐ First: 201 `ttr: null`, `5k_to_10k`, `f` ☐ Second: **422** `blocked: [{"customerId":"<EXPIRED>","role":"main","status":"expired"}]`, `snap` unchanged |
| 7.27 | §5.1 | Bullion $10,000 or more: `sp customerId=$GOLDONLY purchaseType=bullion cash10k=- bullionBand=10k_plus erpInvoiceNo=INV-UAT-27`. Bullion Yes with **$7,000**: `sp customerId=$READY purchaseType=bullion cash10k=- bullionBand=10k_plus cashAmount=7000` | ☐ First: 201 `ttr: "B"`, `10k_plus`, `t` ☐ Second: 201 `ttr: null`, `5k_to_10k`, `f`, `7000.00` (not reportable, but still needs a current ID) |

## D · ID rules (C2) and the ID used

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.30 ⚠ | §1.7 C2, §4.3 | Reportable with an **expired** ID: `sp customerId=$EXPIRED cash10k=true ttrSelfConducted=true ttrDetailsConfirmed=true erpInvoiceNo=INV-UAT-30` | ☐ **422** `{"error":"validation_failed", ..., "blocked":[{"customerId":"<EXPIRED>","role":"main","status":"expired"}]}` ☐ `snap` unchanged |
| 7.31 ⚠ | §1.7 C2 | Reportable with an ID photographed **800 days ago** (window 730): `sp customerId=$OLD cash10k=true ttrSelfConducted=true ttrDetailsConfirmed=true erpInvoiceNo=INV-UAT-31` | ☐ **422** with `blocked` status `reverify` ☐ `snap` unchanged |
| 7.32 ⚠ | §1.7 C2 (window is the business setting) | `q "update public.reporting_entities set idv_max_reliance_days=5 where id='$E1'"`. Then `sp customerId=$READY cash10k=true ttrSelfConducted=true ttrDetailsConfirmed=true` (READY photographed 10 days ago). Then restore: `q "update public.reporting_entities set idv_max_reliance_days=730 where id='$E1'"` and repeat the call | ☐ With 5 days: **422** `blocked` status `reverify` ☐ With 730 days: **201** `ttr: "A"` (save as **P32**) |
| 7.33 ⚠ | §1.7 C2, §4.2 (flags) | Where no current ID is needed the sale saves and the state is recorded. `sp customerId=$EXPIRED` → **P33a**; `sp customerId=$OLD` → **P33b**; `sp customerId=$READY` → **P33c** | ☐ All 201 ☐ `q "select id_expired_at_time, id_outside_window_at_time from gold.purchases where id='<P33a>'"` → `t|f`; P33b → `f|t`; P33c → `f|f` |
| 7.34 | §1.7 C2 | Joint sale where the **joint** seller's ID is expired and the sale is reportable: `sp customerId=$READY jointCustomerId=$EXPIRED cash10k=true erpInvoiceNo=INV-UAT-34` | ☐ **422** with `blocked: [{"customerId":"<EXPIRED>","role":"joint","status":"expired"}]` (the main seller's ID is fine and is not listed) ☐ `snap` unchanged |
| 7.35 | §2 ("no ID, no transaction"), §4.2 | `sp customerId=$NOID` | ☐ **422** `{"error":"no_id_on_file","role":"main"}` (contract) ☐ `snap` unchanged |
| 7.36 | §1.6 (ID used), §4.2 | Give READY a newer, different document, then save: `q "insert into ttr.stored_images (id, customer_id, object_path, content_hash_sha256, captured_by_staff_id) values ('b0000000-0000-4000-8000-0000000000a1','$READY','customers/$READY/f0000000-0000-4000-8000-0000000000a1/front-uat.jpg','uat-hash-a1','$S1'); insert into ttr.id_verifications (id, customer_id, verification_method, document_type, document_number, issuer, id_country_code, has_expiry, expiry_date, verification_description, is_complete, front_image_id, new_capture_reason) values ('f0000000-0000-4000-8000-0000000000a1','$READY','Sighted original document','Passport','UAT-PASS-1','AU','AU',true,'2032-01-01','Sighted in person',true,'b0000000-0000-4000-8000-0000000000a1','different_document')"`, then `sp customerId=$READY` → **P36** | ☐ 201 ☐ P36's `main_id_verification_id` is `f0000000-0000-4000-8000-0000000000a1` (the newest capture), not `$READYVER` ☐ P10's `main_id_verification_id` is still `$READYVER` (an earlier purchase keeps the ID it used) ☐ From here on READY's current ID is this passport, valid and photographed today, so later rows use it |

## E · TTR case and counter answers (§3.3, §3.3a)

READY is ready on file; GOLDONLY has details missing; a joint sale is always case B.

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.40 ⚠ | §3.3 case A | READY, reportable, both answers Yes, **no invoice**: `sp customerId=$READY cash10k=true ttrSelfConducted=true ttrDetailsConfirmed=true` → **P40** | ☐ 201 `ttr: "A"` ☐ `q "select ttr_self_conducted, ttr_details_confirmed, erp_invoice_no from gold.purchases where id='<P40>'"` → `t|t|` ☐ No TTR was started: `ttr_transaction_id` is empty and `q "select count(*) from ttr.transactions"` did not change |
| 7.41 ⚠ | §3.3 case B, §4.3 | GOLDONLY, reportable, no invoice: `sp customerId=$GOLDONLY cash10k=true`. Then with an invoice: `sp customerId=$GOLDONLY cash10k=true erpInvoiceNo=" INV-UAT-41 "` → **P41** | ☐ First: **422** `errors.erp_invoice_no` = "Enter the ERP invoice number. Gina Goldonly's AUSTRAC details are incomplete, so the report must be started now." (and no counter-question errors: they are not asked), `snap` unchanged ☐ Second: 201 `ttr: "B"`, stored `erp_invoice_no` is `INV-UAT-41` (trimmed), `completed_at` empty, `ttr_self_conducted` / `ttr_details_confirmed` empty |
| 7.42 | §3.3a (any No is case B) | READY, `ttrSelfConducted=true ttrDetailsConfirmed=false`, no invoice; then with invoice `INV-UAT-42` | ☐ First: **422** `errors.erp_invoice_no` "...The AUSTRAC report for Ruth Ready must be started now." ☐ Second: 201 `ttr: "B"`, stored answers `t|f` |
| 7.43 | §3.3a (both asked) | READY, reportable, answers not sent: `sp customerId=$READY cash10k=true`. Then only one: `... ttrSelfConducted=true` | ☐ **422** with `errors.ttrSelfConducted` and `errors.ttrDetailsConfirmed` (contract) ☐ Then only `errors.ttrDetailsConfirmed` ☐ `snap` unchanged |
| 7.44 ⚠ | §3.3a ("not shown on non-reportable sales"), §4.3 | Not reportable, answers sent anyway: `sp customerId=$READY cash10k=false ttrSelfConducted=true ttrDetailsConfirmed=true` → **P44** | ☐ 201 `ttr: null` ☐ P44's answers are **empty** (null when not asked) |
| 7.45 ⚠ | §3.3 (joint is always B), §5.2 | Joint, reportable, both answers Yes, no invoice: `sp customerId=$READY jointCustomerId=$JOINTC cash10k=true ttrSelfConducted=true ttrDetailsConfirmed=true`. Then with invoice `INV-UAT-45` → **P45** | ☐ First: **422** `errors.erp_invoice_no` ☐ Second: 201 `ttr: "B"`; the row's `joint_customer_id` is `$JOINTC`, `joint_id_verification_id` is `$JOINTVER`, and the answers are **empty** (not asked of a joint sale) |
| 7.46 | §4.2 (`CHECK joint <> customer`), §4.3 | `sp customerId=$READY jointCustomerId=$READY` | ☐ **422** `errors.joint` "The second person must be a different customer." ☐ `snap` unchanged |
| 7.47 | §4.3 | Joint, not reportable: `sp customerId=$READY jointCustomerId=$JOINTC` → **P47** | ☐ 201 `ttr: null` ☐ Both ID ids stored (main = READY's newest, joint = `$JOINTVER`) |

## F · Invoice rules: duplicates and a completed TTR (§3.3, §3.5)

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.50 ⚠ | §3.3 (duplicate invoices), §4.3 | P41 holds `INV-UAT-41` for GOLDONLY. A reportable purchase by **another** customer on the same invoice: `sp customerId=$READY cash10k=true ttrSelfConducted=true ttrDetailsConfirmed=true erpInvoiceNo=INV-UAT-41`. Repeat as `erpInvoiceNo=" inv-uat-41 "` | ☐ Both **422** `errors.erp_invoice_no` "The ERP invoice number INV-UAT-41 is already used by another purchase. A reportable purchase needs its own invoice number." (case and spaces do not matter for finding the duplicate; the message repeats the number as typed, trimmed, so `inv-uat-41` the second time) ☐ `snap` unchanged |
| 7.51 | §3.3 ("non-reportable ... only warn") | Not reportable, same invoice: `sp customerId=$READY erpInvoiceNo=INV-UAT-41` → **P51** | ☐ **201** `warnings.duplicateInvoice` = "The ERP invoice number INV-UAT-41 is already recorded on another purchase." ☐ The purchase **is** saved (it has the invoice number) |
| 7.52 | §3.3 (same-day linked part is not a duplicate) | See 7.60: a second part for the same customer, same invoice, same day is saved with no duplicate error | ☐ Confirmed by 7.60 |
| 7.53 ⚠ | §3.3, §4.2 (linked parts: same day) | Uses the capture added in 7.36. Make a part from another day: `q "insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more, erp_invoice_no, sale_date, phone, id_sighted, created_by_staff_id) values ('d0000000-0000-4000-8000-0000000000f1','$E1','$READY','f0000000-0000-4000-8000-0000000000a1','scrap','under_10k',false,'INV-UAT-53', (now() at time zone 'Australia/Melbourne')::date - 1,'0411 111 111',true,'$S1')"`. Then `sp customerId=$READY cash10k=true ttrSelfConducted=true ttrDetailsConfirmed=true erpInvoiceNo=INV-UAT-53` | ☐ **422** `errors.erp_invoice_no` (already used): a part from another day is not a linked part, so it is a duplicate |
| 7.54 ⚠ | §3.5 (completed TTR blocks a new part) | Make a TTR that is complete for a scrap part of `INV-UAT-54`: `sp customerId=$READY cash10k=true cashAmount=9000 erpInvoiceNo=INV-UAT-54` → **P54** ($9,000 scrap: not reportable alone); then `q "insert into ttr.transactions (id, reporting_entity_id, scenario, transaction_ref, transaction_datetime, designated_service, location_snapshot, staff_member_name, staff_member_email, cash_currency, cash_amount, aud_value, status, completed_at) values ('d0000000-0000-4000-8000-0000000000f2','$E1','precious_metal_buy','INV-UAT-54', now(), 'Purchase of precious metal for cash','Coburg, VIC','UAT','uat@example.test','AUD',12000,12000,'complete', now()); update gold.purchases set ttr_transaction_id='d0000000-0000-4000-8000-0000000000f2' where id='<P54>'"`. Now add a **scrap** part: `sp customerId=$READY cash10k=true partAmount=3000 erpInvoiceNo=INV-UAT-54 ttrSelfConducted=true ttrDetailsConfirmed=true`. Then a **bullion** part: `sp customerId=$READY purchaseType=bullion cash10k=- bullionBand=under_5k partAmount=100 erpInvoiceNo=INV-UAT-54` (total $9,100, not reportable) | ☐ Scrap part (total $12,000): **422** `errors.erp_invoice_no` = "The AUSTRAC report for INV-UAT-54 is already finished. Use a new ERP invoice number for this purchase." ☐ Bullion part (other type): **201** (the finished report is for scrap only) ☐ `snap` shows only the bullion part added |
| 7.55 | §3.5 (draft TTR does not block) | Same as 7.54 but set the TTR to a draft: `q "update gold.purchases set ttr_transaction_id=null where id='<P54>'; update ttr.transactions set status='draft', completed_at=null where id='d0000000-0000-4000-8000-0000000000f2'; update gold.purchases set ttr_transaction_id='d0000000-0000-4000-8000-0000000000f2' where id='<P54>'"` and repeat the scrap part with `partAmount=3000` | ☐ **201** (a part may join a draft report; starting or updating that report is a later phase) |

## G · Linked parts and totals (§3.4, §4.2)

Parts are the same customer, same invoice (case and spaces ignored), same Melbourne day.

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.60 ⚠ | §3.4, §4.2 ("cash paid on that part"), §4.5 | Part 1: `sp customerId=$READY erpInvoiceNo=INV-UAT-60` → **P60a** (scrap, no cash amount saved). Part 2, bullion, without the amounts: `sp customerId=$READY purchaseType=bullion cash10k=- bullionBand=5k_to_10k erpInvoiceNo=inv-uat-60` ; then `... partAmount=6000` ; then `... partAmount=6000 linkedAmounts='{"<P60a>":"5000"}' ttrSelfConducted=true ttrDetailsConfirmed=true` → **P60b** | ☐ No amounts: **422** `errors.partAmount` "Enter the cash paid for this part. Enter 0 if none was cash." ☐ Part amount only: **422** `errors["linked_<P60a>"]` "Enter the cash paid on that part. Enter 0 if none was cash." ☐ Both: **201** `ttr: "A"`, no duplicate error ☐ P60b: `cash_amount` 6000.00, `invoice_cash_total` 11000.00, `cash_10k_or_more` `t` (reportable by the total), `cash_band` `5k_to_10k` ☐ P60a now has `cash_amount` 5000.00 and one `gold.purchase_audit_log` row: source `save_purchase`, changed_by S1, `changes` = `{"cash_amount":{"old":null,"new":5000.00}}` and nothing else |
| 7.61 | §3.4 (the total decides) | Part 1 `sp customerId=$READY cash10k=true cashAmount=2000 erpInvoiceNo=INV-UAT-61` → **P61a** (saved amount 2000, not reportable). Part 2 `sp customerId=$READY partAmount=3000 erpInvoiceNo=INV-UAT-61` | ☐ 201 `ttr: null` ☐ Part 2: `invoice_cash_total` 5000.00, `cash_10k_or_more` `f`, `cash_amount` 3000.00 ☐ P61a's amount is not touched (no audit row for it) |
| 7.62 ⚠ | §3.4 (mixed scrap + bullion), §3.3 | Jane-style example with exact figures: part 1 `sp customerId=$READY cash10k=true cashAmount=6000 erpInvoiceNo=INV-UAT-62` (scrap, $6,000 cash) → **P62a**; part 2 `sp customerId=$READY purchaseType=bullion cash10k=- bullionBand=5k_to_10k partAmount=6000 erpInvoiceNo=INV-UAT-62 ttrSelfConducted=true ttrDetailsConfirmed=true` → **P62b** | ☐ P62a: 201 `ttr: null` (a $6,000 scrap sale alone is not reportable) ☐ P62b: 201 `ttr: "A"`; `invoice_cash_total` 12000.00; `cash_10k_or_more` `t`; `cash_amount` 6000.00 (it is its own type's part, not the total) ☐ No fill was needed or written (P62a's amount was already saved): no audit row for P62a |
| 7.63 | §3.4, §4.2 (snapshot never rewritten) | Add a third part to `INV-UAT-62`: `sp customerId=$READY partAmount=1000 erpInvoiceNo=INV-UAT-62 ttrSelfConducted=true ttrDetailsConfirmed=true` → **P63** | ☐ 201 ☐ P63 `invoice_cash_total` 13000.00 ☐ P62b `invoice_cash_total` is still 12000.00 (the snapshot is not rewritten by later parts) |
| 7.64 ⚠ | §4.3 ("recalculated on the server"), §4.2 | An earlier part that already has an amount is never overwritten, and a client cannot fill someone else's part: on `INV-UAT-62`, `sp customerId=$READY partAmount=500 erpInvoiceNo=INV-UAT-62 linkedAmounts='{"<P62a>":"1","d0000000-0000-4000-8000-0000000000f1":"1"}' ttrSelfConducted=true ttrDetailsConfirmed=true` | ☐ 201 ☐ P62a `cash_amount` is still 6000.00 ☐ The part `d0000000-...-0000000000f1` (another day, other invoice) has no amount ☐ `invoice_cash_total` = 6000 + 6000 + 1000 + 500 = 13500.00 (the saved amounts, not the values the client sent) |
| 7.65 | §3.4 (linking is by customer, main or joint) | `sp customerId=$GOLDONLY erpInvoiceNo=INV-UAT-62` (a different customer, same invoice) | ☐ **201** with `warnings.duplicateInvoice` (not linked to READY's parts; the invoice is simply used elsewhere). Not reportable, so a warning only |
| 7.66 | §3.4 (joint seller's parts count) | `sp customerId=$JOINTC erpInvoiceNo=INV-UAT-66` → **P66a**. Then `sp customerId=$READY jointCustomerId=$JOINTC partAmount=100 erpInvoiceNo=INV-UAT-66 linkedAmounts='{"<P66a>":"50"}'` | ☐ 201 ☐ `invoice_cash_total` 150.00 (the joint seller's earlier part is linked) ☐ P66a `cash_amount` 50.00 |

## H · Values a client sends that lie

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.70 ⚠ | §4.3 ("never trust client-computed values"), §6.1 | READY, a non-reportable sale, with every server-computed value forged: `sp customerId=$READY cashBand=10k_plus cash_band=10k_plus cash10kOrMore=true cash_10k_or_more=true saleDate=2001-01-01 sale_date=2001-01-01 createdByStaffId=$S2 created_by_staff_id=$S2 idExpiredAtTime=true id_expired_at_time=true idOutsideWindowAtTime=true mainIdVerificationId=$JOINTVER main_id_verification_id=$JOINTVER invoiceCashTotal=99999 invoice_cash_total=99999 reportingEntityId=$E2 reporting_entity_id=$E2 id=11111111-1111-4111-8111-111111111111 ttrSelfConducted=true ttrDetailsConfirmed=true completedAt=2001-01-01 completedByStaffId=$S2` → **P70** | ☐ 201 ☐ `q "select id, cash_band, cash_10k_or_more, sale_date, created_by_staff_id, reporting_entity_id, main_id_verification_id, id_expired_at_time, id_outside_window_at_time, invoice_cash_total, ttr_self_conducted, completed_at from gold.purchases where id='<P70>'"` shows: a generated id (not `1111...`), `under_10k`, `f`, today's Melbourne date, S1, E1, READY's current ID, `f`, `f`, empty, empty, empty |
| 7.71 ⚠ | §4.2 (`sale_date`: Melbourne, set by server) | Save any purchase: `sp customerId=$READY` → **P71**. Compare in one statement: `q "select sale_date = (now() at time zone 'Australia/Melbourne')::date, sale_date = (now() at time zone 'UTC')::date from gold.purchases where id='<P71>'"` | ☐ First value `t` always. The second is `f` when run between 13:00 and 24:00 UTC (it is already tomorrow in Melbourne), which shows the date is not the UTC or the client's |
| 7.72 | §4.3 | Reportable sale where the client claims it is not: `sp customerId=$GOLDONLY cash10k=false cashAmount=20000` (answer No, amount forged) | ☐ 201 `ttr: null`, `cash_amount` empty (the amount is ignored when the answer is No): the answer decides, and a stray amount cannot make a sale reportable or hide one |

## I · Atomicity: rows and storage (§4.5)

Run these on a **local or dev** database only; each induces a failure and then removes it.

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.80 ⚠ | §4.5 ("one transaction"; objects removed on failure) | (1) Save an earlier part: `sp customerId=$READY erpInvoiceNo=INV-UAT-80` → **P80a** (no amount saved). (2) Make the database refuse photo rows: `q "alter table gold.goods_photos add constraint uat_block check (sort_order < 0) not valid"`. (3) `snap`. (4) `PHOTOS="goods1.jpg goods2.jpg" sp customerId=$READY partAmount=500 erpInvoiceNo=INV-UAT-80 linkedAmounts='{"<P80a>":"700"}'`. (5) `snap`. (6) `q "alter table gold.goods_photos drop constraint uat_block"` | ☐ **500** `{"error":"save_failed"}` ☐ `snap` after is identical to `snap` before: no purchase row, no photo row, **no object left in `gold-goods`** (the two uploaded files were removed), no audit row ☐ P80a's `cash_amount` is still empty (the fill rolled back with the rest) ☐ After dropping the constraint, the same call succeeds (201) |
| 7.81 ⚠ | §4.5 | Make storage refuse the second photo only: `q "update storage.buckets set file_size_limit = 40 where id='gold-goods'"` (`goods1.jpg` is smaller than 40 bytes, `goods2.jpg` and `goods3.jpg` are 41 bytes or more: if not, grow the files with `printf` padding). `snap`; `PHOTOS="goods1.jpg goods2.jpg" sp customerId=$READY`; `snap`. Restore: `q "update storage.buckets set file_size_limit = null where id='gold-goods'"` | ☐ **500** `{"error":"storage_failed"}` ☐ `snap` unchanged: the first photo that did upload was removed again, and no purchase row exists ☐ After restoring the limit the same call returns 201 |
| 7.82 | §4.4 (`reconcile-stored-images`), §4.5 | An object left behind (cleanup failed) is swept: covered by rows 7.130 to 7.132 | ☐ See there |
| 7.83 | §4.5 | A clean save leaves no stray objects: after 7.11, `q "select count(*) from storage.objects where bucket_id='gold-goods' and name not in (select object_path from gold.goods_photos)"` | ☐ `0` (after rows 7.80 and 7.81 as well) |

## J · Completing a purchase (`gold-complete-purchase`)

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.90 ⚠ | §4.5, §4.3 (`completed_*` with the invoice) | `cp_ '{"purchaseId":"<P10>","erpInvoiceNo":" INV-UAT-90 "}'` | ☐ **200** `{"purchaseId":"<P10>","ttr":null,"warnings":{}}` ☐ `q "select erp_invoice_no, erp_invoice_norm, completed_by_staff_id, completed_at is not null from gold.purchases where id='<P10>'"` → `INV-UAT-90|INV-UAT-90|<S1>|t` (trimmed, normalised) ☐ `gold.purchase_audit_log` has **one** row for P10: source `complete_purchase`, changed_by S1, and `changes` with exactly the keys `completed_at`, `completed_by_staff_id`, `erp_invoice_no` (old null, new the value) |
| 7.91 | §4.3 (invoice required) | `cp_ '{"purchaseId":"<P11>","erpInvoiceNo":""}'`, then with `"   "`, then with the field missing | ☐ Each **422** `errors.erp_invoice_no` = "Enter the ERP invoice number for this purchase." ☐ P11 still has no invoice, no audit row |
| 7.92 ⚠ | §4.3 (set once, never changed or removed) | `cp_ '{"purchaseId":"<P10>","erpInvoiceNo":"INV-UAT-92"}'` (already completed); `cp_ '{"purchaseId":"<P41>","erpInvoiceNo":"INV-UAT-92"}'` (P41 got its invoice at the counter) | ☐ Both **409** `{"error":"already_has_invoice"}` (contract) ☐ P10 and P41 invoices unchanged |
| 7.93 ⚠ | §3.3 case A | `cp_ '{"purchaseId":"<P40>","erpInvoiceNo":"INV-UAT-93"}'` (P40: case A saved with no invoice) | ☐ **200** `ttr: "A"` ☐ `erp_invoice_no` `INV-UAT-93`, `completed_at` and `completed_by_staff_id` set in the same update (one audit row with all three keys) ☐ **No TTR started**: P40's `ttr_transaction_id` is empty and `q "select count(*) from ttr.transactions"` is unchanged |
| 7.94 | §3.3 (duplicate invoice) | Reportable P21 (READY, case A, no invoice): `cp_ '{"purchaseId":"<P21>","erpInvoiceNo":"INV-UAT-41"}'` (used by P41 of GOLDONLY). Non-reportable P44: `cp_ '{"purchaseId":"<P44>","erpInvoiceNo":"INV-UAT-41"}'` | ☐ P21: **422** `errors.erp_invoice_no` "...already used by another purchase. A reportable purchase needs its own invoice number." and P21 unchanged ☐ P44: **200** with `warnings.duplicateInvoice`, and the invoice is saved |
| 7.95 ⚠ | §3.5 ("applies to an invoice number added on Complete purchase") | P54 (scrap, on `INV-UAT-54`, TTR complete again: `q "update ttr.transactions set status='complete', completed_at=now() where id='d0000000-0000-4000-8000-0000000000f2'"`). Save an earlier scrap part with no invoice for the same customer, same day: `sp customerId=$READY` → **P95**. Then `cp_ '{"purchaseId":"<P95>","erpInvoiceNo":"INV-UAT-54","partAmount":"100"}'` | ☐ **422** `errors.erp_invoice_no` "The AUSTRAC report for INV-UAT-54 is already finished. Use a new ERP invoice number for this purchase." ☐ P95 still has no invoice |
| 7.96 ⚠ | §5.1 (`validateCompletion`: reportable + ID at time), §1.7 C2 | P33a is non-reportable, saved with an **expired** ID (flag `t`). Make it reportable by linking at completion: `sp customerId=$EXPIRED erpInvoiceNo=INV-UAT-96 cash10k=true cashAmount=9000` → another saved part for the same customer and day (an expired ID, and at $9,000 not reportable on its own, so it saves); then `cp_ '{"purchaseId":"<P33a>","erpInvoiceNo":"INV-UAT-96","partAmount":"2000"}'` (total $11,000, reportable) | ☐ **422** `blocked: true` ☐ P33a has no invoice and `cash_amount` still empty |
| 7.97 | §4.2, §4.5 | Amounts on completion: P60a-style. `sp customerId=$READY erpInvoiceNo=INV-UAT-97a` → **P97a**; `sp customerId=$READY` → **P97b** (no invoice). `cp_ '{"purchaseId":"<P97b>","erpInvoiceNo":"INV-UAT-97a"}'`, then with `"partAmount":"700"`, then with `"partAmount":"700","linkedAmounts":{"<P97a>":"300"}` | ☐ First: **422** `errors.partAmount` and `errors["linked_<P97a>"]` ☐ Second: **422** `errors["linked_<P97a>"]` only ☐ Third: **200**; P97b gets the invoice, `completed_*` and `cash_amount` 700.00 in **one** audit row; P97a gets `cash_amount` 300.00 with its own audit row (source `complete_purchase`) ☐ Either all of it or nothing: a failed call changed no amount |
| 7.98 | §3.3 (becoming reportable on Complete purchase) | Using 7.97's pattern with larger amounts so the total is $10,000 or more and no counter answers were taken (new P98a with invoice `INV-UAT-98`, P98b without; complete P98b with `partAmount` 6000, `linkedAmounts` for P98a 5000) | ☐ **200** `ttr: "B"` (reportable here without the counter answers; the TTR is started later) |
| 7.99 | §4.3 ("never trust the client") | `cp_ '{"purchaseId":"<P44b>","erpInvoiceNo":"INV-UAT-99","cashBand":"10k_plus","ttrSelfConducted":true,"completedAt":"2001-01-01","completedByStaffId":"<S2>","purchaseType":"bullion","idExpiredAtTime":true}'` (P44b: a fresh `sp customerId=$READY`) | ☐ **200** `ttr: null` ☐ The row's `completed_by_staff_id` is S1, `completed_at` is now, purchase type is still `scrap`, band `under_10k`, flags `f`: only the invoice (and what the server sets) changed |
| 7.100 | §6.1, §4.3 | `cp_ '{"purchaseId":"00000000-0000-4000-8000-000000000000","erpInvoiceNo":"INV-X"}'`; `cp_ '{"purchaseId":"nope","erpInvoiceNo":"INV-X"}'`; `cp_ 'not json'` | ☐ **404** `purchase_not_found`; **400** `bad_request` field `purchaseId`; **400** `bad_request` field `body` |

## K · Signed photo URLs (`get-gold-photo-urls`)

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.110 ⚠ | §4.5, §6.1 | `gu <P11>` (3 photos) | ☐ **200** `{"urls":[{"id":"<uuid>","sortOrder":0,"url":"..."}, {...sortOrder 1}, {...sortOrder 2}]}` in photo order ☐ Each URL returns **200** with the exact file (locally the URL host is `http://kong:8000`; replace it with `http://127.0.0.1:54321` to open it, as for ID photos). `curl -s "<url>" \| sha256sum` equals that photo's `content_hash_sha256` |
| 7.111 ⚠ | §6.1 (short-lived) | Decode the URL's `token` query parameter (a JWT; the payload is the middle part) | ☐ `exp` minus `iat` is **300 seconds or less** ☐ After the expiry, the same URL no longer returns the file (400 or 403) |
| 7.112 ⚠ | §6.1 (entity-checked) | `TOKEN=$T2 gu <P11>`; `TOKEN=$T1 gu 00000000-0000-4000-8000-000000000000`; `TOKEN=$T1 gu nope` | ☐ **404** `purchase_not_found` for both the other business's purchase and an unknown one (indistinguishable), with **no** `urls` ☐ **400** `bad_request` field `purchaseId` |
| 7.113 | §6.1 (private bucket) | `curl -s -o /dev/null -w '%{http_code}' $API/storage/v1/object/public/gold-goods/<P11>/goods-1.jpg`; `curl -s -o /dev/null -w '%{http_code}' -H "apikey: $ANON" -H "Authorization: Bearer $T1" $API/storage/v1/object/gold-goods/<P11>/goods-1.jpg`; list the bucket with `$T1`: `curl -s -X POST $API/storage/v1/object/list/gold-goods -H "apikey: $ANON" -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"prefix":"","limit":10}'` | ☐ The first two return **400** or **404** (not 200) ☐ The listing returns an empty list or an error, never the file names |
| 7.114 | §4.5 | A purchase with no photos (made directly: `q "insert into gold.purchases (id, reporting_entity_id, customer_id, main_id_verification_id, purchase_type, cash_band, cash_10k_or_more, phone, id_sighted, created_by_staff_id) values ('d0000000-0000-4000-8000-0000000000f3','$E1','$READY','f0000000-0000-4000-8000-0000000000a1','scrap','under_10k',false,'0411 111 111',true,'$S1')"`) → `gu d0000000-0000-4000-8000-0000000000f3` | ☐ **200** `{"urls":[]}` |

## L · Immutability and audit (§4.3, §4.2)

Run the updates as the service role, which is how the functions write: `q "set role service_role; update gold.purchases set ... where id='<P36>'"`. `psql` prints `SET` first and then the error, so look at the line after `SET`. If no error follows `SET`, the update succeeded and the row fails.

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.120 ⚠ | §4.3 (immutable after capture) | One statement each, on a saved purchase: set `customer_id='$GOLDONLY'`; `joint_customer_id='$JOINTC'` (on P36); `purchase_type='bullion'`; `main_id_verification_id='$JOINTVER'`; `id_sighted=false`; `id_expired_at_time=true`; `id_outside_window_at_time=true`; `ttr_self_conducted=true`; `ttr_details_confirmed=true`; `sale_date='2001-01-01'`; `created_by_staff_id='$S2'`; `created_at=now()` | ☐ Every statement fails with `restrict_violation` ("a gold purchase cannot change its sellers, type, ID, counter answers, sale date or creator after it is saved") (SQLSTATE `23001`) ☐ The row is unchanged |
| 7.121 ⚠ | §4.3 (invoice never changed or removed) | On P10 (invoice set): `set erp_invoice_no='OTHER'`; `set erp_invoice_no=null`. On a purchase with no invoice (P11): `set completed_at=now(), completed_by_staff_id='$S1'` (without the invoice) | ☐ All fail with `restrict_violation` (`completed_at can only be set by the update that adds the ERP invoice number` for the last) |
| 7.122 | §4.2 (`goods_photos` append-only) | As the owner: `update gold.goods_photos set sort_order=9 where purchase_id='<P11>'`; `delete from gold.goods_photos where purchase_id='<P11>'` | ☐ Both fail (append-only), rows unchanged. (A purchase with photos also cannot be deleted: `delete from gold.purchases where id='<P11>'` fails with a foreign key error) |
| 7.123 ⚠ | §4.2 (`purchase_audit_log` append-only), §6.4 | `q "update gold.purchase_audit_log set source='x'"`; `q "delete from gold.purchase_audit_log"` | ☐ Both fail; no row changed |
| 7.124 ⚠ | §4.2 (audit: who, when, old to new) | `q "select purchase_id, source, changed_by, changes from gold.purchase_audit_log order by changed_at"` after the rows above | ☐ A plain **save** wrote no audit row (nothing changed) ☐ Rows exist only for: the earlier-part fills (source `save_purchase`) and completions / fills at completion (source `complete_purchase`) ☐ Every row has `changed_by` = S1 (the session's staff member, not a client value), `changed_at` close to the call, and `changes` as `{"column":{"old":...,"new":...}}` ☐ `updated_at` and `erp_invoice_norm` never appear in `changes` |
| 7.125 ⚠ | §4.5 (browser only reads), §6.1 | With the **browser** token `$T1`: `curl -s -X POST $API/rest/v1/purchases -H "apikey: $ANON" -H "Authorization: Bearer $T1" -H 'Content-Profile: gold' -H 'Content-Type: application/json' -d '{}'`; `curl -s -X PATCH "$API/rest/v1/purchases?id=eq.<P10>" ... -d '{"phone":"0400000000"}'` (same headers); `curl -s -X POST $API/rest/v1/rpc/save_purchase -H "apikey: $ANON" -H "Authorization: Bearer $T1" -H 'Content-Profile: gold' -H 'Content-Type: application/json' -d '{}'`; and the same for `complete_purchase` | ☐ Each is refused (**401** or **403**, `42501` permission denied, or the function is not found for that role). Nothing changes. The write functions are not callable by `authenticated` or `anon` |
| 7.126 | §4.5 | `q "select has_function_privilege('anon','gold.save_purchase(uuid,uuid,jsonb,jsonb,jsonb)','execute'), has_function_privilege('authenticated','gold.save_purchase(uuid,uuid,jsonb,jsonb,jsonb)','execute'), has_function_privilege('service_role','gold.save_purchase(uuid,uuid,jsonb,jsonb,jsonb)','execute')"`; the same for `gold.complete_purchase(uuid,uuid,uuid,text,numeric,jsonb)` | ☐ `f|f|t` for both |

## M · `reconcile-stored-images`: orphaned goods photos (§4.4)

Prepare an orphan: upload an object with no `gold.goods_photos` row.

```bash
ORPHAN=$(node -p "crypto.randomUUID()")
curl -s -X POST "$API/storage/v1/object/gold-goods/$ORPHAN/goods-1.jpg" -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" -H 'Content-Type: image/jpeg' --data-binary @goods1.jpg
```

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.130 ⚠ | §4.4 (dry run by default; a save in flight is not an orphan) | `rec` with an empty body, right after the upload | ☐ **200**; `"mode":"dry-run"` ☐ The report has a `goldGoods` section with `objectsInspected` (the number of objects in `gold-goods`), `orphanObjects` and `missingObjects` ☐ The new object is **not** listed as an orphan (younger than one hour: it may be a save in flight) ☐ Nothing is deleted |
| 7.131 ⚠ | §4.4 | Age it: `q "update storage.objects set created_at = now() - interval '2 hours' where bucket_id='gold-goods' and name like '$ORPHAN/%'"`, then `rec` (dry run) | ☐ `goldGoods.orphanObjects.count` is 1 and `paths` is `["$ORPHAN/goods-1.jpg"]`; `deleted` is 0 ☐ The object still exists (`q "select count(*) from storage.objects where bucket_id='gold-goods' and name like '$ORPHAN/%'"` is 1) |
| 7.132 ⚠ | §4.4 | `rec '{"apply":true}'` | ☐ `"mode":"apply"`, `orphanObjects.deleted` is 1 ☐ The orphan object is gone ☐ **Every** object that has a goods photo row is still there; `q "select count(*) from gold.goods_photos"` is the same as before ☐ Objects in `compliance-media` are untouched (`goldGoods` only sweeps `gold-goods`) |
| 7.133 ⚠ | §4.4 (rows are never deleted; missing object reported) | Delete a photo's object through the Storage API: `curl -s -X DELETE "$API/storage/v1/object/gold-goods/<P11>/goods-2.jpg" -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE"`; then `rec '{"apply":true}'` | ☐ `goldGoods.missingObjects.count` is at least 1 and its `photoIds` include that photo row's id ☐ The `gold.goods_photos` row is **still there** (apply never deletes a row) ☐ Nothing else is removed |
| 7.134 ⚠ | §4.4 (refuse if the listing fails) | Stop storage: `docker stop supabase_storage_compliance-capture-platform`; `rec '{"apply":true}'`; `docker start supabase_storage_compliance-capture-platform` | ☐ The call fails (**500** or a non-200) ☐ Nothing is reported as deleted and no object or row is removed ☐ Once storage is back, `rec` returns 200 again |
| 7.135 | §4.4 (safety rules kept) | `curl -s -w '\nHTTP %{http_code}\n' -X POST $API/functions/v1/reconcile-stored-images -H "apikey: $ANON" -H "Authorization: Bearer $T1" -d '{"apply":true}'` | ☐ Refused (**401**): only the service-role key may run it |
| 7.136 | §4.4 | Existing behaviour: read the same report's ID-image sections | ☐ `orphanObjects`, `missingObjects`, `unsupersededCopies` and `danglingFolders` are all still present ☐ With this sheet's data, `missingObjects` lists the seven ID captures seeded in Setup 3, because the seed created capture rows without files in `compliance-media`. That is expected and is not about goods photos. `orphanObjects`, `unsupersededCopies` and `danglingFolders` are zero |

## N · Logs (§6.1)

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.140 ⚠ | §6.1 (IDs and error codes only) | Repeat 7.80 (the failed save) with a recognisable payload: customer READY ("Ruth", "Ready"), phone `0498 765 432`, invoice `INV-UAT-SECRET-77`, cash amount `12345.67`. Read the edge runtime log: `docker logs supabase_edge_runtime_compliance-capture-platform 2>&1 \| tail -200` | ☐ The failure is logged (for example `gold-save-purchase: save failed: <purchase id> <code>`) ☐ The log contains **none** of: `Ruth`, `Ready`, `0498`, `765 432`, `INV-UAT-SECRET`, `12345` ☐ Remove the constraint afterwards |
| 7.141 | §6.1 | Look at the log lines written by the successful calls of this sheet | ☐ The three gold functions wrote **nothing** for successful calls |

## O · TTR is unaffected

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.150 ⚠ | §8 ("each step leaves TTR working") | `cd app && npm run uat` (resets the database and runs Part 0, Phase 4 and Part 1) | ☐ Passes. This resets the dummy data of this sheet |
| 7.151 | §9 | `npx supabase db reset && npx supabase test db`; `cd supabase/functions && deno task test` | ☐ All pgTAP files pass (including the Phase 7 file) ☐ `deno task test` reports 0 failed |

## P · Client project, after merge

Run only once this branch is merged and its migrations and functions reach the **client** project. Use the client project ref.

| # | Spec | Do | Expect |
|---|---|---|---|
| 7.160 ⚠ | §2.2 ("unusable there until go-live") | `npx supabase secrets list --project-ref <client ref>` shows no `GOLD_JOURNEY_ENABLED`. Then call each function with any signed-in staff token: `curl -s -w "\nHTTP %{http_code}\n" -X POST https://<client ref>.supabase.co/functions/v1/gold-save-purchase -H "apikey: <client anon key>" -H "Authorization: Bearer <staff aal2 token>"` (and `gold-complete-purchase`, `get-gold-photo-urls`) | ☐ No `GOLD_JOURNEY_ENABLED` in the list ☐ Each returns **403** `{"error":"gold_disabled"}` ☐ `reconcile-stored-images` still runs for ID images as before |

**What a failure looks like:**
- **Every call returns `Function not found`.** The local stack was started from another directory. Run `npx supabase stop && npx supabase start && npx supabase db reset` from this branch.
- **Every call returns `gold_disabled`.** The `GOLD_JOURNEY_ENABLED` secret is missing: see Setup 1.
- **Calls return 401 after a few minutes.** The tokens expired; rerun Setup 4.
- **`save_failed` on a plain save.** The migration did not apply (`q "select proname from pg_proc where proname = 'save_purchase'"`), or `gold` is not exposed through the API (hosted: Project Settings → Data API → Exposed schemas).
- **Signed URLs do not open locally.** Replace `http://kong:8000` with `http://127.0.0.1:54321`.

---

## Sign-off

☐ Sections A to N pass on commit ________ · ☐ TTR (7.150, 7.151) · ☐ 7.160 after merge · Notes: ______________________________________________
