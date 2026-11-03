# UAT: Gold customer writes (Gold Phase 6)

**Purpose:** prove that `gold/06-customer-writes` lets staff create a gold customer, replace their ID and correct their details, safely:
1. `gold-create-customer` saves the customer, aliases, a customer-level ID capture, the photos and an audit row **in one transaction**, and warns about duplicate ID numbers, names and phones
2. `gold-update-customer-id` records a new ID for the reason staff give, and replaces the old photos **of the same document only**
3. `gold-update-customer` lets managers and admins correct profile fields (never ID details), audits old → new, and leaves past TTR party copies alone
4. `update_customer_phone` changes a phone (8+ digits) for any signed-in staff member, audited
5. Every function refuses while gold is switched off, without a token, below `aal2`, for inactive staff, for the wrong role and for another business's customers
6. Nothing a client sends decides who did it or which business it belongs to, and the logs hold no personal data

Screens come in Phase 8, purchases in Phase 7. Nothing in the app calls these functions yet.

| | |
|---|---|
| Environment | ________ |
| Build/commit | ________ |
| Run by / date | ________ |

**Timing.** Section A runs by itself (about 2 minutes of tests, plus CI). Section B is about 10 minutes on the dev project. Section C needs the product owner.

Spec references are to [gold-due-diligence-spec.md](gold-due-diligence-spec.md). The original manual rows 6.1 to 6.153 keep their numbers; rows 6.154 to 6.163 are *(added by UAT)*.

---

## A · Automated rows

Every row below is proved by an automated test against a freshly reset local stack. The tests create their own staff (two businesses; staff, manager, admin, inactive and password-only sessions with real second-factor tokens), customers and photos, so there is nothing to seed, no tokens to copy and no curl to type.

**Local gold switch.** The functions refuse unless the `GOLD_JOURNEY_ENABLED` secret is exactly `true`. Locally `supabase/config.toml` sets it under `[edge_runtime.secrets]`, which only the local CLI (`supabase start`) and the CI `uat` job read, so no setup is needed. It cannot be toggled on the running local stack, so rows 6.1 to 6.3 are proved with the functions' own handlers in Deno.

**Run from a worktree.** The local edge runtime serves the functions from the directory where `supabase start` ran. From this branch:

```
npx supabase stop && npx supabase start && npx supabase db reset
cd app && npm run uat:gold06                     # Playwright: expect 0 failed
cd .. && npx supabase test db                    # pgTAP: expect Result: PASS (includes gold06_uat.test.sql)
cd supabase/functions && deno task test          # Deno: expect 0 failed (includes gold06Flag.test.ts)
```

`npm run uat` (the CI `uat` job) runs `uat:gold06` after the TTR projects.

☐ CI green on this commit (`frontend`, `functions`, `uat`) · ☐ the three commands above pass locally

Layers: **E2E** = `app/e2e/gold06/*.e2e.js` (real JWTs at `aal1` and `aal2`, real storage and database). **pgTAP** = `supabase/tests/gold06_uat.test.sql`. **Deno** = `supabase/functions/_shared/gold06Flag.test.ts`.

### A1 · Access (spec 2.2, 4.5, 6.1)

| # | What is proved | Covered by |
|---|---|---|
| 6.1 ⚠ | With the secret unset, or `false`, all three functions answer 403 `gold_disabled` and touch nothing, even for a valid admin token | Deno `gold06Flag.test.ts` ("6.1", "6.2" × 3 functions) |
| 6.2 ⚠ | Same, for `update-customer-id` and `update-customer` with valid tokens | Deno `gold06Flag.test.ts` ("6.2") |
| 6.3 ⚠ | `TRUE`, `1`, `True`, ` true`, `yes` and empty are still off; exactly `true` gets past the gate | Deno `gold06Flag.test.ts` ("6.3") |
| 6.4 ⚠ | No `Authorization` header: 401 from all three functions, nothing stored | E2E `01-access` |
| 6.5 ⚠ | The anon key as the bearer token is refused (never 2xx) by all three | E2E `01-access` |
| 6.6 ⚠ | A password-only (`aal1`) token: 403 `mfa_required` from all three | E2E `01-access` |
| 6.7 ⚠ | An inactive staff member at `aal2`: 403 `forbidden` from all three | E2E `01-access` |
| 6.8 ⚠ | Ordinary staff cannot edit details: 403 `forbidden`, nothing changes, no audit row | E2E `01-access` |
| 6.9 | Managers and admins both pass the manager check | E2E `01-access` |
| 6.10 | Any active staff member may create a customer and update an ID | E2E `01-access` |
| 6.11 ⚠ | Another business: edit and update-ID answer 404 `customer_not_found` (made-up ids the same), the phone RPC answers HTTP 404 `P0002 customer_not_found` (defect fixed in `9597dbe`); nothing changes | E2E `01-access`; pgTAP (the SQL function refuses an actor from another business) |
| 6.12 ⚠ | The SQL write functions and `_gold_assert_staff` are not reachable through REST for staff, managers or anon (`42501`) | E2E `01-access`; pgTAP (permission denied, service role allowed) |
| 6.13 ⚠ | A manager cannot insert, update or delete customers, aliases, audit rows, photo rows or ID captures directly | E2E `01-access`; pgTAP |
| 6.14 | Customers are readable inside the business and invisible to another business | E2E `01-access`; pgTAP |

### A2 · Create customer (spec 1.6, 4.2, 4.3, 4.5, 5.2)

| # | What is proved | Covered by |
|---|---|---|
| 6.15 | Create with front and back photos: 201 with four UUIDs | E2E `02-create` |
| 6.16 | The customer row: `gold`, `individual`, created by S1 in Entity One, every detail as typed, `res_country` Australia | E2E `02-create` |
| 6.17 | Aliases saved in order | E2E `02-create` |
| 6.18 | One customer-level `new_capture` row: no transaction, party or conducting person; every document field; `is_complete` | E2E `02-create` |
| 6.19 ⚠ | Two photos under `customers/<id>/…`, server-computed SHA-256 and sizes, S1 as capturer, objects in storage | E2E `02-create` |
| 6.20 | Exactly one `gold_create` audit row, by S1, old null → new, with a sensible time | E2E `02-create` |
| 6.21 | One create adds 1 customer, 2 images, 2 objects, 1 audit row; no TTR transaction or party | E2E `02-create` |
| 6.22 ⚠ | Who and which business come from the token; a body that names another staff member, business or `source` is ignored | E2E `02-create` |
| 6.23 ⚠ | A client-supplied hash is ignored | E2E `02-create` |
| 6.24 | No middle name, no email, no aliases: nulls and no alias rows | E2E `02-create` |
| 6.25 | A second ordinary customer is created with its own id | E2E `02-create` |
| 6.26 ⚠ | Driver licence with the front photo only: 400 `backImage`, nothing stored | E2E `02b-validation` |
| 6.27 | Driver licence with both photos: 201 | E2E `02b-validation` |
| 6.28 | Passport, Proof of age card, National identity card, Medicare card, Other government document need no back photo | E2E `02b-validation` |
| 6.29 | `Other` with a description is stored with it and the sentence "Original Student card sighted in person" | E2E `02b-validation` |
| 6.30 | `Other` with no description: 400 `id.documentTypeOther` | E2E `02b-validation` |
| 6.31 | A passport with front and back stores both | E2E `02b-validation` |
| 6.32 | A passport with no photos: 400 `frontImage` | E2E `02b-validation` |
| 6.33 | Birth certificate, Electronic verification source, empty type: 400 `id.documentType` | E2E `02b-validation` |
| 6.34 | `hasExpiry` true with a date stores both | E2E `02b-validation` |
| 6.35 | `hasExpiry` false with no date: `has_expiry` false, date null | E2E `02b-validation` |
| 6.36 ⚠ | `hasExpiry` true with a missing, empty, impossible or non-ISO date: 400 `id.expiryDate` | E2E `02b-validation` |
| 6.37 | `hasExpiry` missing or `"yes"`: 400 `id.hasExpiry` | E2E `02b-validation` |
| 6.38 ⚠ | Phone of 7 digits: 400 `phone` | E2E `02b-validation` |
| 6.39 ⚠ | Phone of 7 digits with punctuation: 400 `phone` | E2E `02b-validation` |
| 6.40 | Empty or missing phone: 400 `phone` | E2E `02b-validation` |
| 6.41 | Exactly 8 digits accepted | E2E `02b-validation` |
| 6.42 | 11 digits with punctuation accepted | E2E `02b-validation` |
| 6.43 | Empty, blank or missing first name: 400 `firstName` | E2E `02b-validation` |
| 6.44 | Empty or missing last name: 400 `lastName` | E2E `02b-validation` |
| 6.45 | Missing, impossible or non-ISO date of birth: 400 `dateOfBirth` | E2E `02b-validation` |
| 6.46 | Missing residential address names all four parts | E2E `02b-validation` |
| 6.47 | Each bad address part is named (street, suburb, state unknown or empty, postcode of 3 or 5 digits or with letters) | E2E `02b-validation` |
| 6.48 | A lower-case state is accepted and stored upper case | E2E `02b-validation` |
| 6.49 | Empty or missing ID number: 400 `id.documentNumber` | E2E `02b-validation` |
| 6.50 | Empty issuer: 400 `id.issuer` | E2E `02b-validation` |
| 6.51 | Empty, 3-letter or alphanumeric country code: 400 `id.idCountryCode` | E2E `02b-validation` |
| 6.52 | A lower-case country code is stored upper case | E2E `02b-validation` |
| 6.53 | Omitted or blank aliases: accepted, no alias rows | E2E `02b-validation` |
| 6.54 | Omitted email: accepted, null | E2E `02b-validation` |
| 6.55 | A JSON body instead of multipart: 400 `invalid_request` | E2E `02b-validation` |
| 6.56 | A payload that is not JSON: 400 `invalid_request` | E2E `02b-validation` |
| 6.57 | GET: 405 `method_not_allowed` | E2E `02b-validation` |
| 6.58 | The CORS preflight without credentials succeeds with `Access-Control-Allow-Origin` (the local gateway answers 200; the handler's own answer is 204 with the allowed headers and no credential check) | E2E `02b-validation`; Deno `gold06Flag.test.ts` ("6.58") |

### A3 · Duplicates and collisions (spec 1.6 "Uniqueness and collisions", 5.2, 6.1)

| # | What is proved | Covered by |
|---|---|---|
| 6.59 ⚠ | Alice's licence number on another person: 409 `id_on_file` naming Alice (id, name, date of birth, document type) | E2E `02c-duplicates` |
| 6.60 ⚠ | The number is compared trimmed and upper-cased | E2E `02c-duplicates` |
| 6.61 | The same number on a different document type is not a collision | E2E `02c-duplicates` |
| 6.62 ⚠ | `differentPerson` saves `different_person`, unlinked; Alice's capture is unchanged | E2E `02c-duplicates` |
| 6.63 | A third person with the same number is also `different_person` | E2E `02c-duplicates` |
| 6.64 ⚠ | `differentPerson` on a number nobody holds saves a null reason | E2E `02c-duplicates` |
| 6.65 ⚠ | That number is then a collision for the next person | E2E `02c-duplicates` |
| 6.66 | Another business may use the same number | E2E `02c-duplicates` |
| 6.67 ⚠ | Same name and date of birth: 409 `possible_duplicates` (`name_dob`) with the customer's details | E2E `02c-duplicates` |
| 6.68 | The name match is case-insensitive | E2E `02c-duplicates` |
| 6.69 ⚠ | The same phone written with `+61`: 409 `possible_duplicates` (`phone`) | E2E `02c-duplicates` |
| 6.70 | Date of birth one day off: not a duplicate | E2E `02c-duplicates` |
| 6.71 | A phone differing in the last digit: not a duplicate | E2E `02c-duplicates` |
| 6.72 ⚠ | `confirmNew` creates a second customer with the same name and date of birth | E2E `02c-duplicates` |
| 6.73 ⚠ | `confirmNew` does not override an ID collision | E2E `02c-duplicates` |
| 6.74 | Number, name and date of birth all matching: the ID collision is reported first | E2E `02c-duplicates` |
| 6.75 ⚠ | Another business's customers are never shown as duplicates | E2E `02c-duplicates` |
| 6.76 | Refused calls store no photo (object count unchanged) | E2E `02c-duplicates` |

### A4 · Atomic writes (spec 4.5)

A check constraint that only the dummy values trip makes the database refuse part-way through; each test adds and drops its own.

| # | What is proved | Covered by |
|---|---|---|
| 6.77 ⚠ | A failed create leaves no customer, alias, image, audit row or object | E2E `03-atomic` |
| 6.78 | With the fault removed the same call succeeds and the customer exists once | E2E `03-atomic` |
| 6.79 ⚠ | A failed Update ID adds no capture, image or object | E2E `03-atomic` |
| 6.80 ⚠ | A failed edit changes none of the fields sent and writes no audit row | E2E `03-atomic` |
| 6.81 ⚠ | `anon`, `authenticated` and `PUBLIC` hold no execute on the write functions; the service role holds it | pgTAP |
| 6.82 | A failed create is logged with staff id, customer id and an error code, and none of the personal data | E2E `03-atomic` |

### A5 · Update ID (spec 1.6 "Gold Update ID", 5.2, 6.1)

| # | What is proved | Covered by |
|---|---|---|
| 6.83 ⚠ | Renewal with the same number: `id_changed`, linked to the first capture, supersedes its two photos (`superseded` 2) | E2E `04-update-id` |
| 6.84 ⚠ | Old photos stamped superseded by the new front image, objects deleted, rows kept with hash, capturer and time; the new ones live | E2E `04-update-id` |
| 6.85 ⚠ | Another person who shares the number keeps both photos | E2E `04b-update-id-refusals` |
| 6.86 ⚠ | A different document is unlinked, supersedes nothing, adds one photo | E2E `04-update-id` |
| 6.87 ⚠ | Photo unclear links to the original capture, supersedes the renewal photos but never the passport; earlier stamps are not rewritten | E2E `04-update-id` |
| 6.88 ⚠ | Renewal with a new number is unlinked and leaves the old number's photos live | E2E `04-update-id` |
| 6.89 | Photo unclear for a document not on file: 409 `document_not_on_file`, nothing stored | E2E `04b-update-id-refusals` |
| 6.90 | `different_document` with the customer's own number: 409 `id_on_file` | E2E `04b-update-id-refusals` |
| 6.91 ⚠ | Another customer's number with any reason: 409 `id_on_file` naming them | E2E `04b-update-id-refusals` |
| 6.92 | Missing, unknown, empty or stored-value reason: 400 `reason` | E2E `04b-update-id-refusals` |
| 6.93 | Missing or malformed `customerId`: 400 `customerId` | E2E `04b-update-id-refusals` |
| 6.94 | Driver licence update: front only is 400 `backImage`; no photos 400 `frontImage` | E2E `04b-update-id-refusals` |
| 6.95 | Invalid document fields are named at the top level | E2E `04b-update-id-refusals` |
| 6.96 | A customer id that does not exist: 404, nothing stored | E2E `04b-update-id-refusals` |
| 6.97 ⚠ | Another business cannot update the ID: 404, rows unchanged | E2E `04b-update-id-refusals` |
| 6.98 | The current ID is the newest capture | E2E `04-update-id`; pgTAP |
| 6.99 | Updating an ID writes no customer audit row | E2E `04-update-id` |
| 6.100 | Every image sits under `customers/<customer>/<its own capture>/` | E2E `04-update-id` |

### A6 · Update customer details (spec 4.2, 4.3, 4.5, 5.2 "Edit rows")

| # | What is proved | Covered by |
|---|---|---|
| 6.101 | Manager edit: 200 listing exactly the columns that changed (state unchanged is not listed), `updated_at` moves | E2E `05-edit` |
| 6.102 | One `gold_edit` audit row by M1 with old → new for exactly those columns | E2E `05-edit` |
| 6.103 ⚠ | The past TTR party copy is byte-for-byte unchanged and still linked | E2E `05-edit` |
| 6.104 | ID details are untouched | E2E `05-edit` |
| 6.105 | An admin may edit; audited as A1 | E2E `05-edit` |
| 6.106 | Every field kind in one call is saved, normalised (`F`, `NZ`, `AU`) and audited column by column | E2E `05-edit` |
| 6.107 | Clearing optional fields sets null and audits old → null | E2E `05-edit` |
| 6.108 | Sending the current values changes nothing and writes no audit row | E2E `05-edit` |
| 6.109 ⚠ | ID details and ownership keys (document number/type, issuer, source, business, customer type, id, aliases) are 400 naming the key | E2E `05b-edit-refusals` |
| 6.110 | A valid field mixed with a forbidden one applies neither | E2E `05b-edit-refusals` |
| 6.111 | Phone of 7 digits, empty or null: 400 `phone` | E2E `05b-edit-refusals` |
| 6.112 | Phone of 8 digits accepted | E2E `05b-edit-refusals` |
| 6.113 | A required name cannot be cleared | E2E `05b-edit-refusals` |
| 6.114 | Future, too-early, impossible or empty date of birth: 400 `dateOfBirth` | E2E `05b-edit-refusals` |
| 6.115 | Unknown gender, malformed email, 3-letter country: each refused by name | E2E `05b-edit-refusals` |
| 6.116 | A partial address is refused (the whole address is replaced) | E2E `05b-edit-refusals` |
| 6.117 | Empty, missing or array `changes`, missing `customerId`, non-JSON body | E2E `05b-edit-refusals` |
| 6.118 ⚠ | Made-up customer, another business's customer, Entity Two as the caller: 404 | E2E `05b-edit-refusals` |
| 6.119 | A company customer cannot be edited (404) | E2E `05b-edit-refusals` |
| 6.120 | A failed edit is logged with ids and an error code only | E2E `05b-edit-refusals` |

### A7 · Change a phone (spec 4.6 `updateCustomerPhone`)

| # | What is proved | Covered by |
|---|---|---|
| 6.121 | Staff change a phone: 200 `true`, saved | E2E `06-phone-storage` |
| 6.122 | A `phone_change` audit row by S1: phone old → new and nothing else | E2E `06-phone-storage` |
| 6.123 | The same number padded with spaces: `false`, no audit row | E2E `06-phone-storage` |
| 6.124 ⚠ | Fewer than 8 digits, empty or blank: `22023 invalid_phone` | E2E `06-phone-storage` |
| 6.125 | Exactly 8 digits and a punctuated number accepted | E2E `06-phone-storage` |
| 6.126 | Managers and admins may change a phone too | E2E `06-phone-storage` |
| 6.127 ⚠ | `aal1`: `42501 forbidden`, nothing changes | E2E `06c-phone-refusals` |
| 6.128 ⚠ | The anon key is refused | E2E `06c-phone-refusals` |
| 6.129 ⚠ | An inactive staff member: `42501` | E2E `06c-phone-refusals` |
| 6.130 ⚠ | Another business, a made-up id and a company customer: `P0002 customer_not_found`, HTTP 404 (it was a 500 until the fix in `9597dbe`, migration `20261106000003`) | E2E `06b-phone-notfound` |
| 6.131 ⚠ | A phone change leaves the past TTR party copy of the number alone | E2E `06-phone-storage` |

### A8 · Storage, TTR and the rest (spec 1.6, 6.1)

| # | What is proved | Covered by |
|---|---|---|
| 6.132 ⚠ | The `compliance-media` bucket is private: a stored photo is not served by a public or anon URL | E2E `06d-ttr-lookups` |
| 6.133 ⚠ | A licence number gold holds raises the existing collision lookup and prompt in the TTR wizard | E2E `06d-ttr-lookups` (lookup), `07-ttr-wizard` (the wizard's own prompt, real login and second factor) |
| 6.134 | A number nobody holds raises no prompt | E2E `06d-ttr-lookups`, `07-ttr-wizard` |
| 6.135 | A gold customer found by name and date of birth brings their gold-captured ID as the prior verification | E2E `06d-ttr-lookups`, `07-ttr-wizard` |
| 6.136 | No orphan photo is left under `customers/` after failed creates and failed Update IDs (checked directly, not after an hour) | E2E `03-atomic` |
| 6.137 | Existing TTR behaviour | The same CI run: `npm run uat` (part0, phase4, part1) and `npx supabase test db`; for the AUSTRAC smoke rows R24 to R26 of [uat-test-matrix.md](uat-test-matrix.md) run them by hand until the `uat` job covers them |

### A9 · Rows added by UAT

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 6.154 | §6.1 | An **inactive manager** and an **inactive admin** are refused by `gold-update-customer` (isolates the active check from the role check that 6.7 also trips) | E2E `01-access` |
| 6.155 | §4.1, §4.2 | The customer audit log is append-only: update and delete are refused for the owner role and for a manager | pgTAP |
| 6.156 | §1.6 | No client update or delete of customer photo rows or ID captures; the rows are unchanged | pgTAP |
| 6.157 | §1.6 | Customer photo rows, ID captures and audit rows are readable only inside the business and only at `aal2` | pgTAP |
| 6.158 | §4.3, §4.6 | A `null` phone to `update_customer_phone` is `22023 invalid_phone` | E2E `06c-phone-refusals` |
| 6.159 | §1.6 | A renewal typed in lower case with spaces still links to the same document and supersedes its photos | E2E `04b-update-id-refusals` |
| 6.160 | §4.2, §5.2 | Edit also refuses `createdByStaffId`, `createdAt`, `updatedAt` and company-only fields | E2E `01-access` |
| 6.161 | §4.5, §6.1 | Update ID ignores a client-supplied staff id, business and hash | E2E `04b-update-id-refusals` |
| 6.162 | §1.5, §5.2 | Update ID for a company customer is 404 `customer_not_found` (gold writes individuals only) | E2E `01-access` |
| 6.163 | §6.1 "Logs" | Across the whole run the edge runtime logs hold none of the dummy names, phones, emails or ID numbers (the failures of sections A4 and A6 are in the logs, so the check reads real output) | E2E `98-logs` |

---

## B · Manual test for the user (dev project, about 10 minutes)

Only what a local stack cannot see: deploying, the secret and a real session on hosted dev. Nothing here touches the client project until the last block, after merge.

**Before you start.**
- Dev project linked (`supabase/.temp/project-ref` is the dev ref; `cat` it to check).
- This branch checked out, `cd app && npm ci` done.
- A dev staff account with a manager or admin role and MFA enrolled, and an ordinary staff account with MFA, both in the same business.
- Two small JPEGs saved as `front.jpg` and `back.jpg`, and `front2.jpg` and `back2.jpg` (any four different images under 1 MB).

**1 · Deploy (3 minutes)**

```
npx supabase db push --linked
npx supabase functions deploy gold-create-customer gold-update-customer-id gold-update-customer
npx supabase secrets set GOLD_JOURNEY_ENABLED=true
npx supabase secrets list
```

☐ `db push` applies `20261106000001`, `20261106000002` and `20261106000003` without error (6.149)
☐ the three functions deploy; in the dashboard each shows **Verify JWT** on (6.149)
☐ `secrets list` shows `GOLD_JOURNEY_ENABLED`, and it is there because you just set it (deploying never sets it) (6.150)

**2 · One real call to each function (5 minutes)**

Sign in to the dev app as the **ordinary staff** account (password and MFA code), then in the browser's developer tools copy `access_token` from the `sb-…-auth-token` entry of Local Storage. Set `API` to the dev project URL, `ANON` to its anon key and `TOKEN` to that value. Do the same for the manager account later and call its token `MTOKEN`.

Create (staff token):

```
curl -s -w "\nHTTP %{http_code}\n" -X POST "$API/functions/v1/gold-create-customer" \
  -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" \
  -F 'payload={"firstName":"Lena","middleName":"M","lastName":"Hostedsix","dateOfBirth":"1988-08-08","phone":"0412 000 606","email":"lena.hostedsix@example.test","aliases":["L. Hostedsix"],"residentialAddress":{"street":"6 Dummy Street","suburb":"Coburg","state":"VIC","postcode":"3058"},"id":{"documentType":"Driver licence","documentNumber":"HOSTED6-DL-001","issuer":"VIC","idCountryCode":"AU","hasExpiry":true,"expiryDate":"2030-06-30"}}' \
  -F "front=@front.jpg;type=image/jpeg" -F "back=@back.jpg;type=image/jpeg"
```

☐ HTTP **201** with `customerId`, `verificationId`, `frontImageId`, `backImageId`. Note `customerId` as `<lena>`.

Update ID (staff token), renewing the same licence:

```
curl -s -w "\nHTTP %{http_code}\n" -X POST "$API/functions/v1/gold-update-customer-id" \
  -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" \
  -F 'payload={"customerId":"<lena>","reason":"renewed","documentType":"Driver licence","documentNumber":"HOSTED6-DL-001","issuer":"VIC","idCountryCode":"AU","hasExpiry":true,"expiryDate":"2035-06-30"}' \
  -F "front=@front2.jpg;type=image/jpeg" -F "back=@back2.jpg;type=image/jpeg"
```

☐ HTTP **201** with `"superseded":2`

Update details: first with the **staff** token, then with the manager's (`MTOKEN`):

```
curl -s -w "\nHTTP %{http_code}\n" -X POST "$API/functions/v1/gold-update-customer" \
  -H "apikey: $ANON" -H "Authorization: Bearer <TOKEN or MTOKEN>" -H "Content-Type: application/json" \
  -d '{"customerId":"<lena>","changes":{"occupation":"Jeweller"}}'
```

☐ with the staff token: HTTP **403** `{"error":"forbidden"}`
☐ with the manager token: HTTP **200** `{"customerId":"<lena>","changed":["occupation"]}`

In the dev SQL editor:

```
select source from public.customer_audit_log where customer_id = '<lena>' order by changed_at;
select superseded_at is not null as superseded from ttr.stored_images where customer_id = '<lena>' order by created_at;
```

☐ the first query lists `gold_create` then `gold_edit`
☐ the second lists `true, true, false, false` (the two original photos replaced, the two new ones live)

**3 · After merge, on the client project (2 minutes)**

Use a client-project staff session (password and MFA) and the client project's URL and anon key:

```
curl -s -w "\nHTTP %{http_code}\n" -X POST "$CLIENT_API/functions/v1/gold-create-customer" \
  -H "apikey: $CLIENT_ANON" -H "Authorization: Bearer $CLIENT_TOKEN" -F 'payload={}'
npx supabase secrets list --project-ref <client ref>
```

☐ HTTP **403** `{"error":"gold_disabled"}` (or 404 if the function is not deployed there) (6.152)
☐ `secrets list` does **not** show `GOLD_JOURNEY_ENABLED` (6.151)

**Clean-up.** None needed: the dummy customer `Lena Hostedsix` can stay on dev (the audit log is append-only, so her rows are not deleted). Never run any of this on the client project except the last block of step 3.

---

## C · Decisions the spec leaves open (sign off with the product owner)

The spec does not set these limits. The build chose them; each is proved by a test (shown) and is signed by the client rather than traced to a spec clause.

| # | Decision | Covered by |
|---|---|---|
| 6.138 | Date of birth cannot be in the future (today is the Melbourne date) or before 1900-01-01 | E2E `02b-validation` |
| 6.139 | Names, address lines and the issuer: 100 characters at most; ID number 100 at most (AUSTRAC's limit) | E2E `02b-validation` |
| 6.140 | Email, if given, must look like an address | E2E `02b-validation` |
| 6.141 | Photos: JPEG, PNG or WebP, not empty, 10 MB at most (the bucket's limit) | E2E `02b-validation` |
| 6.142 | The address is Australian (state and territory list, 4-digit postcode, `0800` allowed); `res_country` is always Australia | E2E `02b-validation` |
| 6.143 | `hasExpiry` false stores no expiry date even if one is sent | E2E `02b-validation` |
| 6.144 | `differentPerson` is honoured only when the number really collides, and `confirmNew` never overrides an ID collision | E2E `02c-duplicates` |
| 6.145 | An ID collision is reported before a name/DOB or phone match | E2E `02c-duplicates` |
| 6.146 | Update ID writes no customer audit row; `issuer` holds the issuing state or authority as typed | E2E `04-update-id`, `02b-validation` |
| 6.147 | Edit refuses company customers, aliases, postal address, sole-trader and ABN fields in this phase | E2E `05b-edit-refusals` |
| 6.148 | Update ID has no "different person" option: another customer's number is always `id_on_file` | E2E `04b-update-id-refusals` |

---

**What a failure looks like:**
- **A call returns `Function not found`, or an old behaviour, locally.** The local edge runtime serves the directory `supabase start` ran in. Run `npx supabase stop && npx supabase start && npx supabase db reset` from this branch.
- **`upload_failed` locally.** The `compliance-media` bucket does not exist in a fresh local stack. The Playwright global setup creates it (private).
- **A `gold_disabled` you did not expect.** The secret is not exactly `true`. Locally check `[edge_runtime.secrets]` in `supabase/config.toml`; on dev, `secrets list`.
- **A 404 on the phone RPC for a customer that exists, or a 500 for one that does not.** The migrations `20261106000002` and `20261106000003` did not both apply (the second makes an unknown customer an HTTP 404), or PostgREST has not reloaded its schema cache: `notify pgrst, 'reload schema';`.

---

## Sign-off

☐ Section A green on commit ________ · ☐ Section B on dev · ☐ the client-project block of B after merge · ☐ Section C decisions accepted by ________ · Notes: ______________________________________________
