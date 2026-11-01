# UAT: Gold customer writes (Gold Phase 6)

**Purpose:** prove that `gold/06-customer-writes` lets staff create a gold customer, replace their ID and correct their details, safely:
1. `gold-create-customer` saves the customer, aliases, a customer-level ID capture, the photos and an audit row **in one transaction**, and warns about duplicate ID numbers, names and phones
2. `gold-update-customer-id` records a new ID for the reason staff give, and replaces the old photos **of the same document only**
3. `gold-update-customer` lets managers and admins correct profile fields (never ID details), audits old → new, and leaves past TTR party copies alone
4. `update_customer_phone` changes a phone (8+ digits) for any signed-in staff member, audited
5. Every function refuses while gold is switched off, without a token, below `aal2`, for inactive staff, for the wrong role and for another business's customers
6. Nothing a client sends decides who did it or which business it belongs to, and the logs hold no personal data

Screens come in Phase 8, purchases in Phase 7. Everything here is called with `curl` or SQL.

| | |
|---|---|
| Environment | ________ |
| Build/commit | ________ |
| Run by / date | ________ |

**Timing.** About 90 minutes the first time. Do sections A to J in order: later sections reuse the customers made earlier.

Spec references are to [gold-due-diligence-spec.md](gold-due-diligence-spec.md).

---

## 0 · Setup

**Environment.** The **dev** project with `npx supabase db push --linked` and `npx supabase functions deploy gold-create-customer gold-update-customer-id gold-update-customer` done, **or** a local stack started from this branch (`npx supabase stop && npx supabase start && npx supabase db reset`). Locally the flag is already on (`[edge_runtime.secrets]` in `supabase/config.toml`). On dev run `npx supabase secrets set GOLD_JOURNEY_ENABLED=true` first. Create the `compliance-media` bucket as private if the project has none.

**Accounts.** Five staff members, each with a password and a TOTP factor enrolled:

| Label | Role | Business | Notes |
|---|---|---|---|
| `S1` | staff | Entity One | |
| `M1` | manager | Entity One | |
| `A1` | admin | Entity One | |
| `I1` | staff | Entity One | after enrolling, set `is_active = false` in `staff_members` |
| `X1` | manager | Entity Two | a different `reporting_entity_id` |

**Tokens.** For each account get two access tokens: `<label>_AAL1` from `POST $API/auth/v1/token?grant_type=password` (password only), and `<label>_AAL2` from the same session after `POST $API/auth/v1/factors/{id}/challenge` and `/verify` with a current TOTP code. Also `ANON` (the project's anon key).

**Files** in the working directory:
- `front.jpg`, `back.jpg`: two different JPEGs under 1 MB. Note `sha256sum front.jpg back.jpg`.
- `front2.jpg`, `back2.jpg`, `front3.jpg`, `back3.jpg`: more JPEGs, all different (any re-saved copies will do).
- `big.jpg`: a file of exactly 10,485,760 bytes; `toobig.jpg`: exactly 10,485,761 bytes. Send both as `image/jpeg`.
- `doc.pdf`: any PDF.

**Shell helpers** (`$API` is the project URL):

```
create() { curl -s -w "\nHTTP %{http_code}\n" -X POST "$API/functions/v1/gold-create-customer" -H "apikey: $ANON" -H "Authorization: Bearer $1" -F "payload=$2" "${@:3}"; }
updid()  { curl -s -w "\nHTTP %{http_code}\n" -X POST "$API/functions/v1/gold-update-customer-id" -H "apikey: $ANON" -H "Authorization: Bearer $1" -F "payload=$2" "${@:3}"; }
edit()   { curl -s -w "\nHTTP %{http_code}\n" -X POST "$API/functions/v1/gold-update-customer" -H "apikey: $ANON" -H "Authorization: Bearer $1" -H "Content-Type: application/json" -d "$2"; }
phone()  { curl -s -w "\nHTTP %{http_code}\n" -X POST "$API/rest/v1/rpc/update_customer_phone" -H "apikey: $ANON" -H "Authorization: Bearer $1" -H "Content-Type: application/json" -d "{\"p_customer_id\":\"$2\",\"p_phone\":\"$3\"}"; }
FRONT='-F front=@front.jpg;type=image/jpeg'   BACK='-F back=@back.jpg;type=image/jpeg'
```

**Payload notation.** `B1[phone="1234567"]` means: take payload `B1` below and change that key (`jq -c '.phone="1234567"' b1.json`). `B1[-phone]` deletes the key. `B1[id.hasExpiry=false]` sets a nested key.

**`B1`, the base create payload** (Alice):

```json
{"firstName":"Alice","middleName":"Q","lastName":"Uatsix","dateOfBirth":"1985-03-14","phone":"0412 345 601",
 "email":"alice.uatsix@example.test","aliases":["Ally Uatsix","A. Uatsix"],
 "residentialAddress":{"street":"10 Test Street","suburb":"Coburg","state":"VIC","postcode":"3058"},
 "id":{"documentType":"Driver licence","documentNumber":"UAT6-DL-100","issuer":"VIC","idCountryCode":"AU","hasExpiry":true,"expiryDate":"2030-06-30"}}
```

**SQL checks** (SQL editor or `psql`; the browser's role cannot run these). Each row says which one and the customer id (`<cid>`) from the response.

| Name | Query |
|---|---|
| Q1 | `select id, source, customer_type, created_by_staff_id, reporting_entity_id, first_name, middle_name, last_name, date_of_birth, phone, email, res_street, res_suburb, res_state, res_postcode, res_country, updated_at from public.customers where last_name = 'Uatsix' order by created_at;` |
| Q2 | `select alias, sort_order from public.customer_aliases where customer_id = '<cid>' order by sort_order;` |
| Q3 | `select id, customer_id, transaction_id, party_id, conducting_person_id, verification_basis, new_capture_reason, prior_verification_id, document_type, document_number, issuer, id_country_code, has_expiry, expiry_date, is_complete, front_image_id, back_image_id, reporting_entity_id, created_at from ttr.id_verifications where customer_id = '<cid>' order by created_at;` |
| Q4 | `select i.id, i.object_path, i.content_hash_sha256, i.byte_size, i.captured_by_staff_id, i.superseded_at, i.superseded_by_image_id, (select count(*) from storage.objects o where o.bucket_id = i.storage_bucket and o.name = i.object_path) as object_exists from ttr.stored_images i where i.customer_id = '<cid>' order by i.created_at;` |
| Q5 | `select source, changed_by, changed_at, changes from public.customer_audit_log where customer_id = '<cid>' order by changed_at;` |
| Q6 | `select (select count(*) from public.customers where last_name = 'Uatsix') as customers, (select count(*) from ttr.stored_images where customer_id in (select id from public.customers where last_name = 'Uatsix')) as images, (select count(*) from storage.objects where bucket_id = 'compliance-media' and name like 'customers/%') as objects, (select count(*) from public.customer_audit_log where customer_id in (select id from public.customers where last_name = 'Uatsix')) as audit_rows;` (the "totals" check: run before and after a refused call; the four numbers must not change) |

---

## A · Access: every function refuses what it should (spec 2.2, 4.5, 6.1)

Run these with `Erin` as the target where a customer id is needed: create her first (row 6.24) or use any customer of Entity One. Rows 6.1 to 6.3 change the secret: do them **last** on dev, or skip locally (the unit tests cover the same refusal).

| # | Spec | Action | Expect |
|---|---|---|---|
| 6.1 | §2.2 | On dev: `npx supabase secrets unset GOLD_JOURNEY_ENABLED`, wait a minute, then `create "$S1_AAL2" "$(cat b1.json)" $FRONT $BACK` | HTTP **403** `{"error":"gold_disabled"}`. Q6 totals unchanged |
| 6.2 | §2.2 | Same state: `updid "$S1_AAL2" '{"customerId":"<any uuid>","reason":"renewed"}'` and `edit "$M1_AAL2" '{"customerId":"<any uuid>","changes":{"firstName":"X"}}'` | Both **403** `gold_disabled`, even with valid tokens |
| 6.3 | §2.2 | Set the secret to `TRUE`, then to `1`, then back to `true` (`secrets set`), repeating the `create` call each time | `TRUE` and `1`: 403 `gold_disabled`. `true`: the call proceeds (a 201, or a 409 if the customer already exists). Only the exact value `true` switches gold on |
| 6.4 | §6.1 | `create` with no `Authorization` header (`curl -X POST $API/functions/v1/gold-create-customer -H "apikey: $ANON" -F payload=...`) | HTTP **401**. Same for `gold-update-customer-id` and `gold-update-customer` |
| 6.5 | §6.1 | `create "$ANON" ...` (the anon key as the bearer token) for each of the three functions | HTTP **401** or **403**, never 2xx. Q6 totals unchanged |
| 6.6 | §6.1 | `create "$S1_AAL1" "$(cat b1.json)" $FRONT $BACK` (password-only token) | HTTP **403** `{"error":"mfa_required"}`. Same for `updid` and `edit` with `M1_AAL1`. Q6 totals unchanged |
| 6.7 | §6.1 | `create "$I1_AAL2" ...`, `updid "$I1_AAL2" ...`, `edit "$I1_AAL2" ...` with the inactive account | Each **403** `{"error":"forbidden"}`. Q6 totals unchanged |
| 6.8 | §2.2, §4.5 | `edit "$S1_AAL2" '{"customerId":"<Erin id>","changes":{"firstName":"Nope"}}'` (ordinary staff) | HTTP **403** `forbidden`. Erin's first name is unchanged and Q5 shows no new row |
| 6.9 | §2.2 | The same call with `M1_AAL2`, then `A1_AAL2` | Both HTTP **200** (managers **and admins** pass). Use `{"firstName":"Erin"}` so nothing changes |
| 6.10 | §2.2, §4.5 | `create "$S1_AAL2" ...` with a staff token | Allowed (any active staff member): see row 6.15. `updid "$S1_AAL2" ...` is allowed too (row 6.83) |
| 6.11 | §6.1 | As `X1_AAL2` (another business): `edit "$X1_AAL2" '{"customerId":"<Erin id>","changes":{"firstName":"Nope"}}'`, `updid "$X1_AAL2" '{"customerId":"<Erin id>","reason":"renewed", ...valid Erin document fields...}' $FRONT $BACK`, `phone "$X1_AAL2" <Erin id> "0499 000 000"` | `edit` and `updid`: HTTP **404** `customer_not_found`. `phone`: an error (HTTP 4xx, code `P0002`, message `customer_not_found`). Erin is unchanged; Q6 totals unchanged. A made-up uuid gives the same answer, so nothing reveals that Erin exists |
| 6.12 | §4.5 | `curl -X POST $API/rest/v1/rpc/gold_create_customer -H "apikey: $ANON" -H "Authorization: Bearer $S1_AAL2" -H "Content-Type: application/json" -d '{}'`, and the same for `gold_update_customer_id`, `gold_update_customer`, `_gold_assert_staff` | Each an error (HTTP 401, 403 or 404, "permission denied" or "not found"), never a result. The write functions are reachable only by the service role |
| 6.13 | §4.5 | As `M1_AAL2` (REST, `Content-Type: application/json`, `Prefer: return=minimal`): `POST /rest/v1/customers` with `{"reporting_entity_id":"<Entity One id>","customer_type":"individual","source":"gold","first_name":"Direct","last_name":"Uatsix"}`; `POST /rest/v1/customer_aliases`; `POST /rest/v1/customer_audit_log`; `PATCH /rest/v1/customers?id=eq.<Erin id>` with `{"first_name":"Direct"}`; `POST /rest/v1/stored_images` and `POST /rest/v1/id_verifications` with header `Content-Profile: ttr` and a customer-level body | Every one is refused (HTTP 401 or 403, or `permission denied`). No `Direct` row exists, Erin is unchanged. The browser can only read these tables |
| 6.14 | §4.5 | As `S1_AAL2`: `GET /rest/v1/customers?last_name=eq.Uatsix&select=id,first_name`; as `X1_AAL2` the same | `S1`: Entity One's `Uatsix` customers. `X1`: an empty list |

---

## B · Create customer (spec 1.6, 4.2, 4.5, 5.2)

Use `S1_AAL2` unless the row says otherwise.

| # | Spec | Action | Expect |
|---|---|---|---|
| 6.15 | §4.5, §5.2 | `create "$S1_AAL2" "$(cat b1.json)" $FRONT $BACK` | HTTP **201** with `customerId`, `verificationId`, `frontImageId`, `backImageId` (all UUIDs). Note `customerId` as `<alice>` |
| 6.16 | §4.2, §4.5 | Q1 | One `Alice Q Uatsix` row: `source` = `gold`, `customer_type` = `individual`, `created_by_staff_id` = `S1`'s staff id, `reporting_entity_id` = Entity One, DOB `1985-03-14`, phone `0412 345 601`, email, `10 Test Street`, `Coburg`, `VIC`, `3058`, `res_country` = `Australia` |
| 6.17 | §4.2 | Q2 for `<alice>` | `Ally Uatsix` sort 0, `A. Uatsix` sort 1 |
| 6.18 | §1.6 | Q3 for `<alice>` | One row: `transaction_id`, `party_id`, `conducting_person_id` all **null**; `customer_id` = `<alice>`; `verification_basis` = `new_capture`; `new_capture_reason` and `prior_verification_id` **null**; `document_type` = `Driver licence`, number `UAT6-DL-100`, `issuer` = `VIC`, `id_country_code` = `AU`, `has_expiry` true, expiry `2030-06-30`; `is_complete` true; both image ids set; `reporting_entity_id` = Entity One |
| 6.19 | §1.6, §6.1 | Q4 for `<alice>` | Two rows. `object_path` starts `customers/<alice>/`, one `…/front-…jpg`, one `…/back-…jpg`. `content_hash_sha256` equals `sha256sum front.jpg` and `sha256sum back.jpg` respectively. `byte_size` equals each file's size. `captured_by_staff_id` = `S1`. `superseded_at` null. `object_exists` = 1 for both |
| 6.20 | §4.2 | Q5 for `<alice>` | Exactly **one** row: `source` = `gold_create`, `changed_by` = `S1`, and `changes` holds `{"old": null, "new": …}` for the values saved (`first_name` → `"Alice"`, `phone`, address fields, `aliases` → `["Ally Uatsix","A. Uatsix"]`) |
| 6.21 | §4.5 | Q6 before and after row 6.15 | Customers +1, images +2, objects +2, audit rows +1. No `ttr.transactions` or `ttr.parties` row was created (`select count(*) from ttr.parties where customer_id = '<alice>'` → 0) |
| 6.22 | §4.5 | `create "$S1_AAL2" "$(jq -c '.id.documentNumber="UAT6-DL-101" \| .firstName="Alicia" \| .phone="0412 345 611" \| .dateOfBirth="1986-01-01" \| . + {createdByStaffId:"<M1 staff id>", reportingEntityId:"<Entity Two id>", source:"ttr"}' b1.json)" $FRONT $BACK` | **201**. Q1: that customer has `created_by_staff_id` = `S1` (not `M1`), `reporting_entity_id` = Entity One, `source` = `gold`. Nothing the client sends decides who or which business |
| 6.23 | §4.5, §6.1 | Create with a hostile hash: `jq -c '. + {contentHashSha256:"deadbeef"}'` of a fresh payload (number `UAT6-DL-102`, name `Alma`, phone `0412 345 612`, DOB `1987-02-02`) | **201**. Q4: the stored hash is the real SHA-256 of the file, not `deadbeef`. The server hashes |
| 6.24 | §5.2 | Create `Erin` (`E1`): `B1[firstName="Erin", middleName="", aliases=[], email="", dateOfBirth="1980-05-05", phone="0412 345 605", id.documentNumber="UAT6-DL-500"]` with front and back | **201**. Q1 shows Erin with no middle name and no email; Q2 empty. Note `<erin>` |
| 6.25 | §5.2 | `Frank` (`F1`): `B1[firstName="Frank", dateOfBirth="1981-06-06", phone="0412 345 606", id.documentNumber="UAT6-DL-600"]` with front and back | **201**. Note `<frank>` |

### Back photo and expiry follow CCP's per-type rules (spec 1.6, 5.2)

Use fresh names, DOBs and phones for each row so no duplicate prompt interferes: name `T<n> Uatsix`, DOB `1990-01-<n>`, phone `0412 345 7<nn>`, and the document number shown.

| # | Spec | Action | Expect |
|---|---|---|---|
| 6.26 | §5.2 | `B1[...]` as a **Driver licence** (`UAT6-DL-710`) with the front photo only | HTTP **400** `{"error":"validation_failed","fields":{"backImage":"…"}}`. Q6 totals unchanged. No object uploaded |
| 6.27 | §5.2 | A Driver licence (`UAT6-DL-711`) with front and back | **201** |
| 6.28 | §5.2 | The same document types **without a back photo**, one call each: `Passport` `UAT6-PP-720`, `Proof of age card` `UAT6-PA-721`, `National identity card` `UAT6-NI-722`, `Medicare card` `UAT6-MC-723`, `Other government document` `UAT6-OG-724` | Each **201**, one image row, `back_image_id` null |
| 6.29 | §5.2 | `Other` (`UAT6-OT-725`, `"documentTypeOther":"Student card"`) with front only | **201**; Q3 `document_type` = `Other`, `document_type_other` = `Student card`, `verification_description` = `Original Student card sighted in person` |
| 6.30 | §5.2 | `Other` with no `documentTypeOther` | **400**, field `id.documentTypeOther` |
| 6.31 | §5.2 | A passport with front **and** back | **201**, two image rows (the back is optional where not required) |
| 6.32 | §5.2 | A passport with no photos at all | **400**, field `frontImage` |
| 6.33 | §5.2 | `documentType` = `Birth certificate`, then `Electronic verification source`, then `` (empty) | Each **400**, field `id.documentType` |
| 6.34 | §1.6, §5.2 | `id.hasExpiry=true` with `id.expiryDate` = `2031-01-31` | **201**, Q3 `has_expiry` true, `expiry_date` `2031-01-31` |
| 6.35 | §1.6, §5.2 | `id.hasExpiry=false` and **no** `expiryDate` | **201**, `has_expiry` false, `expiry_date` null |
| 6.36 | §1.6, §5.2 | `id.hasExpiry=true` and no `expiryDate`; then `expiryDate` = `""`; then `2031-02-30`; then `31/01/2031` | Each **400**, field `id.expiryDate`. Nothing stored |
| 6.37 | §1.6, §5.2 | `id.hasExpiry` missing; then the string `"yes"` | Each **400**, field `id.hasExpiry` |

### Required fields and the phone rule (spec 4.3, 5.2)

Each row sends `B1` with one change. Expect HTTP **400** `validation_failed`, the named field in `fields`, and Q6 totals unchanged. Use a fresh `id.documentNumber` each time so the number is never the reason. Rows that expect **201** also need a fresh `firstName`, `dateOfBirth` and (unless the row sets it) `phone`, so the call is not held as a possible duplicate of Alice.

| # | Spec | Change to `B1` | Field expected in `fields` |
|---|---|---|---|
| 6.38 | §4.3 | `phone="1234567"` (7 digits) | `phone` |
| 6.39 | §4.3 | `phone="12-34-56-7"` (7 digits with punctuation) | `phone` |
| 6.40 | §4.3 | `phone=""`; then remove `phone` | `phone` |
| 6.41 | §4.3 | `phone="12345678"` (8 digits) | none: **201** (boundary accepted) |
| 6.42 | §4.3 | `phone="+61 (3) 9123-4567"` (11 digits) | none: **201** |
| 6.43 | §5.2 | `firstName=""`; `firstName="   "`; remove `firstName` | `firstName` |
| 6.44 | §5.2 | `lastName=""`; remove `lastName` | `lastName` |
| 6.45 | §5.2 | Remove `dateOfBirth`; `dateOfBirth="1990-02-30"`; `dateOfBirth="14/03/1985"` | `dateOfBirth` |
| 6.46 | §5.2 | Remove `residentialAddress` | `residentialAddress.street`, `.suburb`, `.state`, `.postcode` |
| 6.47 | §5.2 | `residentialAddress.street=""`; `.suburb=""`; `.state="XX"`; `.state=""`; `.postcode="305"`; `.postcode="30580"`; `.postcode="30A8"` | `residentialAddress.street`, `.suburb`, `.state`, `.state`, `.postcode` (×3) respectively |
| 6.48 | §5.2 | `residentialAddress.state="nt"` | none: **201** (state is case-insensitive) |
| 6.49 | §1.6 | `id.documentNumber=""`; remove it | `id.documentNumber` |
| 6.50 | §1.6 | `id.issuer=""` | `id.issuer` |
| 6.51 | §1.6 | `id.idCountryCode=""`; `"AUS"`; `"A1"` | `id.idCountryCode` |
| 6.52 | §1.6 | `id.idCountryCode="au"` | none: **201**, stored as `AU` |
| 6.53 | §5.2 | `aliases` omitted; `aliases=["", "  "]` | none: **201**, Q2 empty (blank aliases are dropped) |
| 6.54 | §5.2 | `email` omitted | none: **201**, `email` null |

### Request shape (spec 4.5, 6.1)

| # | Spec | Action | Expect |
|---|---|---|---|
| 6.55 | §4.5 | `curl -X POST ... -H "Content-Type: application/json" -d "$(cat b1.json)"` to `gold-create-customer` (JSON, not multipart) | HTTP **400** `{"error":"invalid_request"}` |
| 6.56 | §4.5 | `create "$S1_AAL2" 'not json' $FRONT $BACK` | HTTP **400** `invalid_request` |
| 6.57 | §4.5 | `curl -X GET $API/functions/v1/gold-create-customer` with a valid `S1_AAL2` token | HTTP **405** `method_not_allowed` |
| 6.58 | §6.1 | `curl -i -X OPTIONS $API/functions/v1/gold-create-customer -H "Origin: http://localhost:3000" -H "Access-Control-Request-Method: POST"` with no token | HTTP **204** with `Access-Control-Allow-Origin` (the browser's preflight carries no credentials) |

---

## C · Duplicates and collisions (spec 1.6 "Uniqueness and collisions", 5.2)

`Alice` (row 6.15) holds Driver licence `UAT6-DL-100`, phone `0412 345 601`, DOB `1985-03-14`. Each refused call must leave Q6 totals unchanged and upload nothing.

| # | Spec | Action | Expect |
|---|---|---|---|
| 6.59 | §1.6, §5.2 | Create `Bob` (`B2`): `B1[firstName="Bob", dateOfBirth="1970-07-07", phone="0412 345 602", email="", aliases=[]]` (same Driver licence number `UAT6-DL-100`) with front and back | HTTP **409** `{"error":"id_on_file","owner":{…}}`. `owner.customerId` = `<alice>`, `owner.name` = `Alice Q Uatsix`, `owner.dateOfBirth` = `1985-03-14`, `owner.documentType` = `Driver licence` |
| 6.60 | §1.6 | `B2[id.documentNumber="uat6-dl-100 "]` (lower case, trailing space) | **409** `id_on_file` for Alice (the number is compared trimmed and upper-cased) |
| 6.61 | §1.6 | `B2[firstName="Bea", dateOfBirth="1969-06-06", phone="0412 345 672", id.documentType="Passport", id.documentNumber="UAT6-DL-100"]` with front only | **201**. The same number on a different document type is not a collision. Note this customer id as `<bea>` |
| 6.62 | §1.6, §5.2 | Resend row 6.59 with `differentPerson` true: `B2[+differentPerson=true]` | **201**. Q3 for the new customer (`<bob>`): `new_capture_reason` = `different_person`, `prior_verification_id` null. Q3 for `<alice>` is unchanged |
| 6.63 | §1.6 | A third person with the same number: `B2[firstName="Cara", dateOfBirth="1971-08-08", phone="0412 345 603", +differentPerson=true]` | **201**, `different_person` again (`<cara>`) |
| 6.64 | §1.6 | `differentPerson` on a number nobody holds: `B2[id.documentNumber="UAT6-DL-103", firstName="Dora", dateOfBirth="1972-09-09", phone="0412 345 604", +differentPerson=true]` | **201**, and Q3 `new_capture_reason` is **null** (the flag only applies when there is a collision, so a later real collision is still caught) |
| 6.65 | §1.6 | Creating `Dora`'s number again without the flag: `B2[firstName="Dee", id.documentNumber="UAT6-DL-103", dateOfBirth="1973-10-10", phone="0412 345 608"]` | **409** `id_on_file` naming Dora |
| 6.66 | §1.6 | As `X1_AAL2` (Entity Two): create `Xena Uatsix` (DOB `1990-01-01`, phone `0412 345 699`) with Driver licence `UAT6-DL-100`, front and back | **201**. The uniqueness is per business: Alice's number is not a collision in Entity Two. Note `<xena>` (Entity Two) |
| 6.67 | §1.6 | Name + date of birth: `B1[phone="0412 345 650", id.documentNumber="UAT6-DL-150"]` (Alice's name and DOB, new phone and number) | **409** `{"error":"possible_duplicates","duplicates":[…]}`. `duplicates[0]`: `customerId` = `<alice>`, `firstName`, `lastName`, `dateOfBirth`, `phone`, `matchReason` = `name_dob` |
| 6.68 | §1.6 | The same with `firstName="ALICE"`, `lastName="UATSIX"` | **409** `possible_duplicates` (case-insensitive) |
| 6.69 | §1.6 | Phone: `B1[firstName="Gina", dateOfBirth="1992-12-12", phone="+61 412 345 601", id.documentNumber="UAT6-DL-151"]` (Alice's phone written with `+61`) | **409** `possible_duplicates`, `matchReason` = `phone`, `customerId` = `<alice>` |
| 6.70 | §1.6 | Date of birth one day off: `B1[dateOfBirth="1985-03-15", phone="0412 345 651", id.documentNumber="UAT6-DL-152"]` | **201**: not a duplicate (name + the same date of birth is required) |
| 6.71 | §1.6 | Different phone number differing in the last digit: `B1[firstName="Hal", dateOfBirth="1993-01-13", phone="0412 345 609", id.documentNumber="UAT6-DL-153"]` | **201** |
| 6.72 | §1.6, §5.2 | Resend row 6.67 with `confirmNew` true: `B1[phone="0412 345 650", id.documentNumber="UAT6-DL-150", +confirmNew=true]` | **201**: a second `Alice Q Uatsix` with the same DOB now exists (no unique key on name + DOB) |
| 6.73 | §1.6 | `confirmNew` does **not** override an ID collision: `B2[+confirmNew=true]` (Alice's number, no `differentPerson`) | **409** `id_on_file` |
| 6.74 | §1.6 | When both apply: Alice's name, DOB **and** number, `B1[phone="0412 345 660"]` | **409** `id_on_file` (the number is checked first) |
| 6.75 | §6.1 | As `X1_AAL2`: create a customer with Alice's exact name, DOB and phone (`B1` with number `UAT6-DL-900`) | **201**, no `possible_duplicates`: another business's customers are never shown |
| 6.76 | §1.6 | Photos for a refused call: after 6.59, 6.60, 6.67 and 6.73 compare Q6 `objects` with the value before them | Unchanged: refusals happen before any photo is stored |

---

## D · Atomic writes (spec 4.5)

**Dev only.** These rows break the database on purpose with a check constraint that only the dummy values trip, then remove it. Run the SQL as the project owner.

| # | Spec | Action | Expect |
|---|---|---|---|
| 6.77 | §4.5 | Note Q6. Run `alter table ttr.id_verifications add constraint uat6_block check (document_number <> 'UAT6-FAIL-1') not valid;`. Then `create "$S1_AAL2" "$(jq -c '.id.documentNumber="UAT6-FAIL-1" \| .firstName="Fay" \| .dateOfBirth="1994-04-04" \| .phone="0412 345 640"' b1.json)" $FRONT $BACK` | HTTP **500** `{"error":"create_failed"}`. Q6 again: **all four numbers unchanged**: no customer, alias, image, audit row, and the two photo objects uploaded for the attempt are gone from storage. `select count(*) from public.customers where first_name = 'Fay'` → 0 |
| 6.78 | §4.5 | Remove the constraint (`alter table ttr.id_verifications drop constraint uat6_block;`). Resend the same call | **201**: the customer exists once. (`Fay` is a normal customer from here) |
| 6.79 | §4.5 | `alter table ttr.id_verifications add constraint uat6_block2 check (document_number <> 'UAT6-FAIL-2') not valid;`. Update an ID: `updid "$S1_AAL2" '{"customerId":"<frank>","reason":"different_document","documentType":"Passport","documentNumber":"UAT6-FAIL-2","issuer":"Australia","idCountryCode":"AU","hasExpiry":false}' -F front=@front2.jpg\;type=image/jpeg` | HTTP **500** `{"error":"update_failed"}`. Q3 and Q4 for `<frank>` show no new capture and no new image; Q6 `objects` unchanged. Drop the constraint afterwards |
| 6.80 | §4.5 | `alter table public.customers add constraint uat6_block3 check (last_name <> 'Uatsixblock') not valid;`. `edit "$M1_AAL2" '{"customerId":"<erin>","changes":{"firstName":"Changed","lastName":"Uatsixblock"}}'` | HTTP **500** `update_failed`. Q1: Erin's first name is **still** `Erin` (neither field changed); Q5 has no new row. Drop the constraint |
| 6.81 | §4.5 | `select * from information_schema.routine_privileges where routine_name in ('gold_create_customer','gold_update_customer_id','gold_update_customer') and grantee in ('anon','authenticated','PUBLIC');` | **No rows**: execute is held by the service role only |
| 6.82 | §4.5 | In the Edge Function logs (Dashboard → Edge Functions → `gold-create-customer` → Logs, or `docker logs supabase_edge_runtime_*` locally) look for the 6.77 failure | A line `gold-create-customer: save failed` with the staff id, customer id and an error code (such as `23514`). **No name, phone, date of birth or ID number** appears |

---

## E · Update ID (spec 1.6 "Gold Update ID", 5.2)

Create two customers first with `S1_AAL2`:
- **Carol** (`C1`): `B1[firstName="Carol", dateOfBirth="1979-11-02", phone="0412 345 702", email="", aliases=[], id.documentNumber="UAT6-DL-200"]`, front and back. Note `<carol>`.
- **Dan** (`D1`): `B1[firstName="Dan", dateOfBirth="1968-04-04", phone="0412 345 703", email="", aliases=[], id.documentNumber="UAT6-DL-200", +differentPerson=true]`, front and back (a different person who shares Carol's number). Note `<dan>`.

Update-ID payload `U1`: `{"customerId":"<carol>","reason":"renewed","documentType":"Driver licence","documentNumber":"UAT6-DL-200","issuer":"VIC","idCountryCode":"AU","hasExpiry":true,"expiryDate":"2035-06-30"}`. Send it with `-F front=@front2.jpg;type=image/jpeg -F back=@back2.jpg;type=image/jpeg` unless the row says otherwise.

| # | Spec | Action | Expect |
|---|---|---|---|
| 6.83 | §1.6 | Renewal, same number: `updid "$S1_AAL2" "$U1"` + front2/back2 | HTTP **201**, `superseded` = **2**. Q3 for `<carol>`: a second row, `new_capture_reason` = `id_changed`, `prior_verification_id` = the first row's id, `transaction_id`/`party_id`/`conducting_person_id` null, new expiry `2035-06-30` |
| 6.84 | §1.6 | Q4 for `<carol>` after row 6.83 | Four rows. The **old** two (`front-`/`back-` from creation): `superseded_at` set, `superseded_by_image_id` = the new front image's id, `object_exists` = **0** (the photo is deleted), the row **kept** with its hash, `captured_by_staff_id` and `created_at`. The **new** two: `superseded_at` null, `object_exists` = 1, hashes match `front2.jpg`/`back2.jpg` |
| 6.85 | §1.6 | Q4 and Q3 for `<dan>` | Dan's two photos are **untouched** (`superseded_at` null, `object_exists` = 1) although he shares Carol's number: only the same person's document is replaced |
| 6.86 | §1.6 | Different document: `updid "$S1_AAL2" '{"customerId":"<carol>","reason":"different_document","documentType":"Passport","documentNumber":"UAT6-PP-200","issuer":"Australia","idCountryCode":"AU","hasExpiry":true,"expiryDate":"2033-01-31"}' -F front=@front3.jpg\;type=image/jpeg` | **201**, `superseded` = **0**. Q3: a new row with `new_capture_reason` = `different_document`, `prior_verification_id` **null**. Q4: every earlier live photo (the renewal's two) still has `superseded_at` null and `object_exists` = 1; one new photo added |
| 6.87 | §1.6 | Photo unclear: `updid "$S1_AAL2" "$(jq -c '.reason="photo_unclear"' <<<"$U1")" -F front=@front3.jpg\;type=image/jpeg -F back=@back3.jpg\;type=image/jpeg` | **201**, `superseded` = **2**. Q3: `new_capture_reason` = `stored_copy_unclear`, `prior_verification_id` = the **first** (original) row's id (the capture of this document with no link). Q4: the renewal's two photos are now superseded and deleted; the **passport photo is still live**; the two new photos are live; the originals stay superseded (not stamped again: `superseded_by_image_id` unchanged) |
| 6.88 | §1.6 | Renewal with a new number: `updid "$S1_AAL2" "$(jq -c '.documentNumber="UAT6-DL-201"' <<<"$U1")"` + front2/back2 | **201**, `superseded` = **0**. Q3: `new_capture_reason` = `id_changed`, `prior_verification_id` **null** (a new number is a new document). Q4: the `UAT6-DL-200` photos remain live |
| 6.89 | §1.6 | Photo unclear for a document not on file: `updid "$S1_AAL2" "$(jq -c '.reason="photo_unclear" \| .documentNumber="UAT6-DL-999"' <<<"$U1")"` + front2/back2 | HTTP **409** `{"error":"document_not_on_file"}`. Q6 totals unchanged, nothing uploaded |
| 6.90 | §1.6 | `different_document` with a number the customer already has: `"$(jq -c '.reason="different_document"' <<<"$U1")"` (UAT6-DL-200) | **409** `id_on_file`. Q6 totals unchanged |
| 6.91 | §1.6, §5.2 | Another customer's number: `"$(jq -c '.documentNumber="UAT6-DL-100"' <<<"$U1")"` for Carol with each of the three reasons in turn (`renewed`, `photo_unclear`, `different_document`) | Each **409** `id_on_file`, `owner.customerId` = `<alice>`, `owner.name` = `Alice Q Uatsix`. Q6 totals unchanged |
| 6.92 | §1.6 | Reason: missing; `"because"`; `""`; `"id_changed"` (the stored value, not an API reason) | Each **400**, field `reason`. Q6 totals unchanged |
| 6.93 | §5.2 | `customerId` missing; `"nope"` | **400**, field `customerId` |
| 6.94 | §5.2 | A Driver licence update with front only; with no photos | Front only: **400** `backImage`. No photos: **400** `frontImage`. Q6 totals unchanged. (A passport update with front only is valid: row 6.86) |
| 6.95 | §1.6 | Document fields invalid: `documentNumber=""`, `issuer=""`, `idCountryCode="AUS"`, `hasExpiry` missing, `hasExpiry=true` with no `expiryDate`, `documentType="Credit card"` | **400** with `documentNumber`, `issuer`, `idCountryCode`, `hasExpiry`, `expiryDate`, `documentType` named (top-level names here, not `id.…`) |
| 6.96 | §6.1 | A customer id that does not exist (`00000000-0000-4000-8000-000000000999`) | HTTP **404** `customer_not_found`. Q6 totals unchanged |
| 6.97 | §6.1 | `X1_AAL2` updating `<carol>` | **404** `customer_not_found` (row 6.11); Carol's rows unchanged |
| 6.98 | §1.6 | Customer ID current after the sequence: `select * from public.customer_current_id('<carol>')` run as `S1` (REST: `POST /rest/v1/rpc/customer_current_id` with `S1_AAL2`) | The newest capture (`UAT6-DL-201`) is returned: the current ID is the newest `new_capture` |
| 6.99 | §4.5 | Q5 for `<carol>` after the whole section | Exactly **one** row (`gold_create`). Updating an ID changes no customer column, so it writes no customer audit row; the capture row and the supersede stamps are the record |
| 6.100 | §6.1 | Storage: `select name from storage.objects where bucket_id = 'compliance-media' and name like 'customers/<carol>/%'` | Every path starts `customers/<carol>/<verification id>/`. Every live image is under its own capture's folder |

---

## F · Update customer details, managers and admins (spec 4.5, 5.2 "Edit rows")

Target: `<erin>` (row 6.24). Before starting, save her ID rows: `select md5(string_agg(to_jsonb(v)::text, '|' order by id)) from ttr.id_verifications v where customer_id = '<erin>';` as `<erin-id-hash>`.

**Past TTR copy fixture** (run once as the project owner; `<entity1>` is Entity One's id). It stands in for a completed TTR where Erin appeared:

```sql
insert into ttr.transactions (id, reporting_entity_id, scenario, transaction_ref, transaction_datetime, designated_service,
  location_snapshot, staff_member_name, staff_member_email, cash_currency, cash_amount, aud_value, status, completed_at)
values ('00000000-0000-4000-8000-0000000006a1', '<entity1>', 'bullion_sell', 'UAT6-TX-1', '2026-01-01',
  'Sale of bullion for physical cash', 'Coburg, VIC', 'Staff', 'staff@example.test', 'AUD', 15000, 15000, 'complete', '2026-01-01');
insert into ttr.parties (id, transaction_id, party_type, first_name, last_name, date_of_birth, phone, res_street, res_suburb, res_state, res_postcode, customer_id)
values ('00000000-0000-4000-8000-0000000006a2', '00000000-0000-4000-8000-0000000006a1', 'individual', 'Erin', 'Uatsix',
  '1980-05-05', '0412 345 605', '10 Test Street', 'Coburg', 'VIC', '3058', '<erin>');
```

Save `select md5(to_jsonb(p)::text) from ttr.parties p where id = '00000000-0000-4000-8000-0000000006a2';` as `<party-hash>`.

| # | Spec | Action | Expect |
|---|---|---|---|
| 6.101 | §4.5, §5.2 | `edit "$M1_AAL2" '{"customerId":"<erin>","changes":{"firstName":"Erina","residentialAddress":{"street":"22 New Street","suburb":"Brunswick","state":"VIC","postcode":"3056"}}}'` | HTTP **200** `{"customerId":"<erin>","changed":[…]}` listing exactly `first_name`, `res_street`, `res_suburb`, `res_postcode` (the state was `VIC` already, so it is not listed). Q1: Erin now `Erina`, `22 New Street`, `Brunswick`, `3056`; `updated_at` moved on |
| 6.102 | §4.2 | Q5 for `<erin>` | One new row beside the `gold_create` one: `source` = `gold_edit`, `changed_by` = `M1`'s staff id, `changes` = `{"first_name":{"old":"Erin","new":"Erina"},"res_street":{"old":"10 Test Street","new":"22 New Street"},"res_suburb":{"old":"Coburg","new":"Brunswick"},"res_postcode":{"old":"3058","new":"3056"}}` and **nothing else** |
| 6.103 | §4.5 | Re-run the party hash query | Equal to `<party-hash>`: the past TTR party copy still says `Erin`, `10 Test Street`, `Coburg`, `3058`, and is still linked to `<erin>` |
| 6.104 | §5.2 | Re-run the ID hash query | Equal to `<erin-id-hash>`: ID details are untouched |
| 6.105 | §5.2 | `edit "$A1_AAL2" '{"customerId":"<erin>","changes":{"firstName":"Erin"}}'` | **200**, `changed` = `["first_name"]`. Q5: a row with `changed_by` = `A1`, `first_name` Erina → Erin (admins may edit) |
| 6.106 | §4.2 | Every field kind in one call as `M1`: `{"customerId":"<erin>","changes":{"middleName":"R","lastName":"Uatsix","dateOfBirth":"1980-05-06","gender":"f","phone":"0412 345 615","email":"erin@example.test","occupation":"Jeweller","citizenshipCountryCode":"nz","taxResidencyCountryCode":"au"}}` | **200**; `changed` = `middle_name`, `date_of_birth`, `gender`, `phone`, `email`, `occupation`, `citizenship_country_code`, `tax_residency_country_code` (`last_name` was already `Uatsix`). Q1: `gender` = `F`, codes `NZ`/`AU`. Q5: one more row with exactly those columns, each `old` → `new` |
| 6.107 | §4.2 | Clearing optional fields: `changes` = `{"middleName":"","email":"","occupation":"","gender":"","citizenshipCountryCode":""}` | **200**; those columns become null; Q5 shows `old` → `null` for each |
| 6.108 | §4.2 | Sending the current values: `changes` = `{"firstName":"Erin","lastName":"Uatsix"}` | **200**, `"changed":[]`. Q5: **no** new row |
| 6.109 | §5.2 | ID details and ownership are refused: `changes` = `{"documentNumber":"UAT6-DL-777"}`; `{"documentType":"Passport"}`; `{"issuer":"NSW"}`; `{"source":"ttr"}`; `{"reportingEntityId":"<entity2>"}`; `{"customerType":"company"}`; `{"id":"<new uuid>"}`; `{"aliases":["X"]}` | Each HTTP **400** `{"error":"validation_failed","fields":{"<that key>":"…"}}`. Q1, Q3 and Q5 unchanged (ID hash still `<erin-id-hash>`) |
| 6.110 | §5.2 | A mix: `{"firstName":"Ok","documentNumber":"X"}` | **400** naming `documentNumber`; `firstName` is **not** applied (Erin unchanged) |
| 6.111 | §4.3 | `{"phone":"1234567"}`; `{"phone":""}`; `{"phone":null}` | Each **400**, field `phone`; Erin's phone unchanged |
| 6.112 | §4.3 | `{"phone":"1234 5678"}` | **200**, `changed` = `["phone"]` |
| 6.113 | §5.2 | `{"firstName":""}`; `{"lastName":"  "}` | **400** `firstName` / `lastName` (a required name cannot be cleared) |
| 6.114 | §5.2 | `{"dateOfBirth":"2999-01-01"}`; `{"dateOfBirth":"1899-12-31"}`; `{"dateOfBirth":"1980-13-01"}`; `{"dateOfBirth":""}` | Each **400**, field `dateOfBirth` |
| 6.115 | §5.2 | `{"gender":"X"}`; `{"email":"erin@"}`; `{"citizenshipCountryCode":"NZL"}` | **400**, fields `gender`, `email`, `citizenshipCountryCode` |
| 6.116 | §5.2 | `{"residentialAddress":{"street":"1 A St"}}` | **400**, fields `residentialAddress.suburb`, `.state`, `.postcode` (the whole address is replaced, so every part is needed) |
| 6.117 | §5.2 | `changes` = `{}`; `changes` missing; `changes` = `[]`; `customerId` missing; body that is not JSON | **400** `validation_failed` with field `changes` (or `customerId`); `invalid_request` for a non-JSON body |
| 6.118 | §6.1 | A made-up customer id; `<xena>` as `M1` (Entity Two's customer); `<erin>` as `X1_AAL2` | Each **404** `customer_not_found` |
| 6.119 | §5.2 | A **company** customer (no gold screen makes one; run in SQL: `insert into public.customers (reporting_entity_id, customer_type, source, entity_name, reg_identifier) values ('<entity1>','company','ttr','Uatsix Pty Ltd','12345678901') returning id;`) edited as `M1` with `{"firstName":"X"}` | **404** `customer_not_found` (gold edits individuals only) |
| 6.120 | §6.1 | Logs for 6.101 to 6.119 | IDs and error codes only; none of `Erin`, `Erina`, `Uatsix`, `0412 345`, `1980-05` appears |

---

## G · Change a phone (spec 4.6 `updateCustomerPhone`)

Target: `<frank>` (row 6.25, phone `0412 345 606`). Call with `phone "$TOKEN" "<frank>" "<number>"`. The function is a database RPC called directly by the signed-in user.

| # | Spec | Action | Expect |
|---|---|---|---|
| 6.121 | §4.6 | `phone "$S1_AAL2" <frank> "0488 777 666"` (ordinary staff) | HTTP **200**, body `true`. Q1: Frank's phone is `0488 777 666` |
| 6.122 | §4.2, §4.6 | Q5 for `<frank>` | A `phone_change` row: `changed_by` = `S1`'s staff id, `changes` = `{"phone":{"old":"0412 345 606","new":"0488 777 666"}}` and nothing else |
| 6.123 | §4.6 | `phone "$S1_AAL2" <frank> " 0488 777 666 "` (same number, padded) | **200**, body `false`. Q5: no new row |
| 6.124 | §4.3, §4.6 | `"1234567"`; `"123 4567"`; `"+61 (0) 12-34"`; `""`; `"   "` | Each an error: HTTP **400**, `code` `22023`, `message` `invalid_phone`. Frank's phone unchanged |
| 6.125 | §4.3, §4.6 | `"12345678"`; then `"(03) 9123 4567"` | Each **200**, body `true` (8 digits is accepted; punctuation does not count) |
| 6.126 | §4.6 | `phone "$M1_AAL2"` and `phone "$A1_AAL2"` with a valid number | **200**: every active role may change a phone |
| 6.127 | §6.1 | `phone "$S1_AAL1" <frank> "0499 111 333"` | Error, code `42501`, message `forbidden`. Frank unchanged |
| 6.128 | §6.1 | `phone "$ANON" <frank> "0499 111 333"` | HTTP 401 or 403 (`permission denied`). Frank unchanged |
| 6.129 | §6.1 | `phone "$I1_AAL2" <frank> "0499 111 333"` | Error, code `42501`. Frank unchanged |
| 6.130 | §6.1 | `phone "$X1_AAL2" <frank> "0499 111 333"` (another business); a made-up id as `S1`; a company customer as `S1` | Each an error with `message` `customer_not_found` (code `P0002`). Frank unchanged |
| 6.131 | §4.5 | A TTR party copy: link a party to Frank as in the fixture above row 6.101 (a second transaction `00000000-0000-4000-8000-0000000006b1` with party `…6b2`, phone `0412 345 606`, `customer_id` = `<frank>`), change his phone with row 6.121, then compare the party's hash | The party copy still has `0412 345 606` |

---

## H · Storage, TTR and the rest (spec 1.6, 6.1)

| # | Spec | Action | Expect |
|---|---|---|---|
| 6.132 | §6.1 | `curl -s -o /dev/null -w "%{http_code}" "$API/storage/v1/object/public/compliance-media/<an object_path from Q4>"` and the same with the anon key as `Authorization` (`/object/authenticated/…`) | Not 200 (the bucket is private; photos are served only by signed URL) |
| 6.133 | §1.6 | In the TTR wizard (the existing app, signed in as `S1` at `aal2`): start a TTR, add an individual party, go to ID verification, choose Driver licence and enter number `UAT6-DL-100` | The existing collision prompt appears, naming Alice's gold capture as the owner (open that customer or confirm a different person). A number gold holds is a collision in TTR too |
| 6.134 | §1.6 | In the same wizard enter a Driver licence number nobody holds, e.g. `UAT6-DL-8888` | No prompt |
| 6.135 | §1.6 | In the wizard, a party named `Alice Q Uatsix`, DOB `1985-03-14`, with a prior-ID lookup | The gold-captured ID appears as a prior verification for the same person (shared ID store) |
| 6.136 | §6.1 | Sweep: run `reconcile-stored-images` in dry-run mode (`curl -X POST $API/functions/v1/reconcile-stored-images -H "Authorization: Bearer <secret key>" -d '{}'`), after at least one hour has passed since row 6.77 | No orphan object under `customers/` from the failed attempts of rows 6.77 and 6.79 (they were removed when the save failed) |
| 6.137 | §4.4 | Existing TTR behaviour | `npx supabase test db` and `cd app && npm run uat` pass; also run R24 to R26 of [uat-test-matrix.md](uat-test-matrix.md) |

---

## I · Decisions the spec leaves open (sign off with the product owner)

The spec does not set these limits. The build chose them; each row proves the choice and is signed by the client rather than traced to a spec clause.

| # | Decision | Action | Expect |
|---|---|---|---|
| 6.138 | Date of birth cannot be in the future, and not before 1900-01-01 (today is the Melbourne date) | `B1[dateOfBirth=<today's Melbourne date>]` with fresh name/number/phone; then `<tomorrow>`; then `1900-01-01`; then `1899-12-31` | **201**; **400** `dateOfBirth`; **201**; **400** |
| 6.139 | Names, address lines and the issuer: 100 characters at most; ID number 100 at most (AUSTRAC's limit) | `firstName` of 100 `a`s; of 101; `id.documentNumber` of 100 `9`s; of 101 | **201**; **400** `firstName`; **201**; **400** `id.documentNumber` |
| 6.140 | Email, if given, must look like an address | `email="alice@"`; `email="alice@example.test"` | **400** `email`; accepted |
| 6.141 | Photos: JPEG, PNG or WebP, not empty, 10 MB at most (the bucket's limit) | Front `doc.pdf`; front `toobig.jpg`; front `big.jpg`; an empty file as front | **400** `frontImage` (×2 for the PDF and toobig; the empty file too); `big.jpg` **201** |
| 6.142 | The address is Australian (state and territory list, 4-digit postcode); `res_country` is always Australia | `residentialAddress.state="VIC"`, `.postcode="0800"` | **201** (any four digits) |
| 6.143 | `hasExpiry` false stores no expiry date even if one is sent | `B1[id.hasExpiry=false, id.expiryDate="2031-01-31"]` with fresh name/number/phone | **201**; Q3 `has_expiry` false, `expiry_date` null |
| 6.144 | `differentPerson` is honoured only when the number really collides (row 6.64) and `confirmNew` never overrides an ID collision (row 6.73) | see rows 6.64 and 6.73 | as there |
| 6.145 | An ID collision is reported before a name/DOB or phone match (row 6.74) | see row 6.74 | as there |
| 6.146 | Update ID writes no customer audit row (row 6.99); issuer holds the issuing state or authority (there is no separate state column) | Q3 for any customer | `issuer` = `VIC` as typed |
| 6.147 | Edit refuses company customers, aliases, postal address, sole-trader and ABN fields in this phase (rows 6.109, 6.119) | see those rows | as there |
| 6.148 | Update ID has no "different person" option: another customer's number is always `id_on_file` (row 6.91) | see row 6.91 | as there |

---

## J · Hosted checks (dev project, then client project after merge)

| # | Spec | Do this | Expect |
|---|---|---|---|
| 6.149 | §2.2 | `npx supabase db push --linked` then `npx supabase functions deploy gold-create-customer gold-update-customer-id gold-update-customer` against **dev**, with `app/.env.local` and `supabase/.temp/project-ref` pointing at dev | Both succeed. The three functions show in the dashboard with **Verify JWT** on |
| 6.150 | §2.2 | `npx supabase secrets list` on dev | `GOLD_JOURNEY_ENABLED` is listed only if you set it in step 0. Deploying never sets it |
| 6.151 | §2.2 | **After merge, on the client project** (use the client ref): `npx supabase secrets list --project-ref <client ref>` | No `GOLD_JOURNEY_ENABLED`. (`supabase/config.toml`'s `[edge_runtime.secrets]` is read only by the local CLI; it is never pushed by `db push` or `functions deploy`) |
| 6.152 | §2.2 | On the client project: `create "$S1_AAL2"`-style call with a client staff token | HTTP **403** `gold_disabled` (or 404 if the function is not deployed there). The customer tables are untouched |
| 6.153 | §2.2 | In the repository, `git grep -n GOLD_JOURNEY_ENABLED -- supabase/config.toml .github` | Only `supabase/config.toml` (local) is listed; no workflow or hosted config sets it |

**What a failure looks like:**
- **A call returns `Function not found` locally.** The local edge runtime serves the directory `supabase start` ran in. Run `npx supabase stop && npx supabase start && npx supabase db reset` from this branch.
- **`upload_failed` locally.** The `compliance-media` bucket does not exist in a fresh local stack. Create it (private) in Studio or with the service-role key.
- **A `gold_disabled` you did not expect.** The secret is not exactly `true`. Locally check `[edge_runtime.secrets]` in `supabase/config.toml`; on dev, `secrets list`.
- **A 404 on the phone RPC.** The migration `20261106000002` did not apply, or PostgREST has not reloaded its schema cache: `notify pgrst, 'reload schema';`.

---

## Clean-up

Dev only, as the project owner. Remove the dummy data (customers, then the rows that reference them):

```sql
-- the TTR fixtures above row 6.101 and in row 6.131
delete from ttr.parties where id in ('00000000-0000-4000-8000-0000000006a2', '00000000-0000-4000-8000-0000000006b2');
delete from ttr.transactions where id in ('00000000-0000-4000-8000-0000000006a1', '00000000-0000-4000-8000-0000000006b1');
```

Photos of superseded and live captures stay referenced by `stored_images` rows, which the app never deletes. Keep this data on dev, or reset the dev database. Do not run any row of this sheet on the client project.

---

## Sign-off

☐ Sections A to H pass on commit ________ · ☐ Section I decisions accepted by ________ · ☐ Section J hosted checks on dev · ☐ the client-project rows of J after merge · Notes: ______________________________________________
