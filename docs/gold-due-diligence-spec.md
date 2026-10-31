# Gold Due Diligence in CCP: implementation spec

Status: draft for review · 31 October 2026

**Sources this spec refers to:**
- **Handover:** the client's clickable demo in the `gold-due-diligence` repo. § numbers refer to its `HANDOFF.md`.
- **CCP:** this repo. Paths are relative to the repo root.
- **Privacy policy:** the client's "Privacy Policy — Second-Hand Gold Purchases" (draft). The client holds it outside this repo; § numbers refer to its Part A.
- **Go-live risk register:** `docs/go-live.md`, risks G1–G6.

---

## Summary

CCP gets a second journey. After sign-in and MFA, staff choose **TTR** (the existing wizard) or **Gold due diligence**: find or create a customer, record a scrap or bullion purchase, complete it later with the ERP invoice number, and hand off to a TTR when the purchase is reportable.

Main design points:

1. **Shared customer table.** `public.customers` gives every person a stable ID across both journeys. Existing TTR parties are backfilled into it, and TTR search moves onto it.
2. **Shared ID store.** `ttr.id_verifications` and `ttr.stored_images` can belong to a customer without a TTR transaction. A TTR started from gold reuses the counter ID through a reliance row; no photos are copied.
3. **Handoff to TTR.** The ERP invoice number is always the TTR reference.
   - **Case A** (customer ready on file, and they confirm their details at the counter): the TTR is created when the invoice is added and can be finished without the customer.
   - **Case B** (anything else): the invoice is required at the counter and the TTR opens straight away.
   - A mixed scrap + bullion invoice gets one TTR per type.
4. **Server-enforced rules.** All gold writes go through edge functions that import the same rules module as the browser (`goldRules.js`, from the handover's `purchase.js`). The browser can only read gold tables.
5. **Same look and code style as CCP.** CCP components and CSS Modules. The whole app is reformatted to the house style with Prettier before gold work starts.

**Terms used:**

| Term | Meaning |
|---|---|
| TTR | Threshold transaction report to AUSTRAC (cash of $10,000 or more) |
| Reportable | `isReportable` in the rules module: cash of $10,000 or more on the sale |
| Capture | An `id_verifications` row with `verification_basis = 'new_capture'`: an ID that was photographed |
| Reliance row | An `id_verifications` row with `verification_basis = 'relied_on_prior_identification'`, pointing at a capture |
| Linked parts | Purchases for the same customer, same invoice and same day, treated as one sale (handover §4.0a) |
| Case A / case B | The two handoff paths in section 3.3 |

---

## 1. Customer search and identity

### 1.1 How CCP search works today

| Aspect | Behaviour | Where |
|---|---|---|
| Entry points | RPCs `public.search_individual_customers(p_first_name, p_last_name, p_dob)` and `public.search_company_customers(p_entity_name, p_reg_identifier, p_suburb)` | `supabase/migrations/20260715000001_customer_search_dedup_tiebreak.sql` (individual), `20260717000001_customer_search_company_missing_fields.sql` (company) |
| Client | `searchIndividualCustomers`, `searchCompanyCustomers` | `app/src/lib/wizardApi.js:581`, `:618` |
| UI | Individual / Company tabs; a Search button, not live search. The UI requires first + last + DOB, although the hint says "First + Last, or Last + DOB" and the RPC accepts any combination | `app/src/pages/customers/CustomerSearchPage.jsx:74-84, 275` |
| Source | `ttr.parties` joined to `ttr.transactions`, scoped to `public.reporting_entity_id()`, `is_complete = true`, filtered by `party_type` | |
| Matching | Case-insensitive prefix (`ILIKE 'x%'`) on first and last name; DOB exact. Company: name prefix, ABN/ACN prefix with spaces removed, suburb or postcode prefix | |
| Identity | No customer table. `parties.transaction_id` is `NOT NULL`, so each TTR has its own party copies. Search builds "customers" at query time with `DISTINCT ON (lower(last), lower(first), dob)`, preferring the copy with aliases, then the newest `updated_at`, then `id`. Max 20 | `20260621000010_parties.sql:6` |
| Returned fields | Name parts, DOB, gender, phone, email, occupation, residential address, aliases. No ID document data | |
| Picking a result | Copies the fields into a new `ttr.parties` row on the new transaction. The result's `party_id` is only a template | `wizardApi.js:101-130` (`migrateNewParties`) |
| ID documents | `ttr.id_verifications` per transaction per party; photos in `ttr.stored_images`, scoped to the transaction. Reuse via `get_prior_verifications_individual` (name + DOB) and the `prior_verification_id` chain. Collision check via `get_verification_for_document` and unique index `uq_idv_doc_new_capture` | `20260621000015_id_verifications.sql`, `20260725000002_idv_capture_justification.sql:165` |
| ID types | `id_doc_type`: Driver licence, Passport, Proof of age card, National identity card, Medicare card, Other government document, Electronic verification source, Other | `20260621000003_enums.sql:13` |

### 1.2 Gaps between the handover and CCP

The handover's assumptions come from `HANDOFF.md` §5–6, `src/lib/api.js:101` (`searchCustomers`) and `src/components/CustomerPicker.jsx`.

| # | Handover assumes | CCP reality | Resolved by |
|---|---|---|---|
| H1 | A `customers` table with a stable `id` | No stable person ID; `party_id` belongs to one transaction | Shared customer table (1.3) |
| H2 | "New customer" creates a standalone record | A party can't exist without a TTR transaction | Shared customer table (1.3) |
| H3 | One live search box matching ID number, phone or any part of the name | First/last prefix + DOB, Search button; no phone or ID number | New search RPC (1.5) |
| H4 | No date of birth | Identity, search and prior-ID lookup key on DOB; TTR requires it | DOB added to New customer (3.3) |
| H5 | `full_name` as one string | `first_name` / `middle_name` / `last_name`; Party Details has one `fullName` input | Match how Party Details splits names (build check) |
| H6 | Results show ID type, number and status | Search returns no ID data | Search returns the current ID (1.5) |
| H7 | One current ID per customer plus an ID history table | ID per transaction; history is natural | Shared ID store (1.6) |
| H8 | Duplicate warning on ID number, phone or exact name | Deduplicates at search time on name + DOB; document-number uniqueness on type + number | Collision prompt + name/DOB/phone prompts (1.6) |
| H9 | 4 ID types | 8-value enum | CCP enum |
| H10 | No tenancy | Every query scoped to `reporting_entity_id()` | Same scoping in all gold code |
| H11 | Individuals only | Individuals and companies | Customer table holds both; gold creates individuals only (1.4) |
| H12 | Purchases search by seller name, phone or ID number | Same as H3 | Same columns as 1.5 |
| H13 | — | Only a btree index on `(last_name, first_name)` | Normalised columns + `pg_trgm` (1.5) |

### 1.3 Shared customer table

`public.customers` is used by both journeys. It gives gold a stable customer ID for the customer page, purchase history, joint seller and handoff, and lets a customer exist without a TTR transaction.

- `ttr.parties` gets a nullable `customer_id`. Parties stay per-transaction copies, because a TTR must keep the details as reported.
- Columns: section 4.2.
- **Rejected:**
  - one customer copy per purchase (CCP's current pattern), because the customer page would be rebuilt by name + DOB matching, which merges or splits people;
  - gold purchases as a `ttr.transactions` type, because it mixes two record types and still has no stable person ID.

### 1.4 Backfill, and TTR search on the customer table

**Customer types.** `customer_type` is `individual` | `company` (same values as `party_kind`), with the individual and company profile fields. Gold creates individuals only.

**Backfill (one-off migration):**

No production data exists yet. The backfill still runs, for dev data and any data present when it is deployed.

- Group completed parties by `reporting_entity_id` + the key search already uses:
  - individuals: `lower(last_name), lower(first_name), date_of_birth`;
  - companies: `lower(entity_name)`, `reg_identifier` without spaces.

  This is the same grouping search applies today, so results don't change.
- Customer fields come from the copy search picks today: has aliases, then newest `updated_at`, then `id`. Aliases go to `public.customer_aliases`.
- Set `ttr.parties.customer_id` on every party in each group.

**TTR after the switch:**
- `search_individual_customers` / `search_company_customers` read the customer table and return `customer_id`. The returned columns stay the same, so `CustomerSearchPage.jsx` keeps its form.
- Search accepts what its hint says: first + last name, or last name + DOB. Change the all-three check at `CustomerSearchPage.jsx:79`.
- Picking a result copies from the customer into the new party and sets `customer_id` (`migrateNewParties`).
- **On TTR completion**, `complete-transaction` (service role; the browser can't write customers):
  - links each party that has no `customer_id` to an existing customer by the backfill key, or creates one;
  - sets `id_verifications.customer_id`;
  - updates the linked customers from the party copies. The party copies stay as reported.

  Abandoned drafts leave no customers behind. Drafts in progress during the deploy are linked the same way.

### 1.5 Gold search

- **RPC** `search_customers(p_q text)`:
  - `SECURITY DEFINER`, scoped to `reporting_entity_id()`, individuals only, up to 20 rows;
  - replaces the demo `searchCustomers(q)` and is also used by the joint-seller picker.
- **Match rules** (2+ characters; 250 ms client debounce, as in `CustomerPicker.jsx`):
  - name: case-insensitive, any part of first + middle + last name, and aliases;
  - phone: when the term has 4+ digits; digits only, leading `61` / `+61` treated as `0`;
  - ID number: upper case, spaces and dashes removed.
- **Order:** exact ID number or phone match first, then last name, first name.
- **Indexes:** generated normalised columns (`name_search`, `phone_digits`, ID `number_norm`), a `pg_trgm` GIN index on `name_search`, and btree indexes on the other two.
- **Each row returns:** customer id, name parts, DOB, phone, and the current ID (type, number, expiry, capture date) for `IdStatusBadge`.
- **The Purchases screen search** uses the same columns and rules.
- **TTR** keeps its structured form over the customer table.

### 1.6 Shared ID store

**What CCP has today:**
- **`ttr.id_verifications`:**
  - `transaction_id NOT NULL`, and exactly one of `party_id` / `conducting_person_id` in the same transaction (`trg_idv_consistency`, which also fills `reporting_entity_id`);
  - `verification_basis`: `new_capture` | `relied_on_prior_identification`. Reliance rows point at a capture via `prior_verification_id` and hold no images;
  - `new_capture_reason`: `id_changed`, `stored_copy_unclear`, `different_document`, `different_person`, `other`. A renewed licence keeps its number, so it saves as `id_changed` linked to the prior capture (`trg_idv_recapture_link`);
  - `uq_idv_doc_new_capture`: unique on (`reporting_entity_id`, `document_type`, `upper(btrim(document_number))`) for unlinked captures, except `different_person`. The UI's collision lookup is `get_verification_for_document`.
- **`ttr.stored_images`:**
  - `transaction_id NOT NULL`, path starts `{transaction_id}/`, insert only while the transaction is a draft, no client update or delete;
  - on a linked re-capture of the same document, `complete-transaction` deletes the old photo object and keeps its metadata row (`superseded_at`, `superseded_by_image_id`, hash, who, when) (`20260727000001_stored_images_supersede.sql`).
- **`get_prior_verifications_individual`:** name + DOB, completed transactions only, captures only, newest per document.
- **`reporting_entities.idv_max_reliance_days`:** re-verification window, measured from when the document was photographed.

**Changes:**
- **`ttr.id_verifications`:**
  - add `customer_id`, set on every row;
  - allow a customer-level capture: `transaction_id`, `party_id` and `conducting_person_id` all null, `customer_id` set, `verification_basis = 'new_capture'`;
  - `trg_idv_consistency` takes `reporting_entity_id` from the customer when there is no transaction.
- **`ttr.stored_images`:**
  - `transaction_id` nullable, add `customer_id`, exactly one of the two;
  - customer photos stored under `customers/{customer_id}/…`;
  - RLS select and insert for customer photos, scoped by the customer's `reporting_entity_id`. No client update or delete.
- **Uniqueness and collisions** cover both journeys. Gold's "duplicate ID number" warning on New customer becomes the existing collision prompt: open that customer, or confirm a different person.
- **Current ID** = the customer's newest `new_capture` row by `customer_id`.
- **Gold Update ID** inserts a `new_capture` row:
  - `id_changed`, linked when the number is the same;
  - `stored_copy_unclear`, linked;
  - or `different_document`, unlinked.

  A service-role function then marks the old photos superseded, using `_shared/supersede.ts`.
- **Each gold purchase stores the ID used:** `main_id_verification_id`, `joint_id_verification_id`.
- **TTR follow-on:** `get_prior_verifications_individual` looks up by `customer_id`.
- **Backfill:** set `id_verifications.customer_id` from `parties.customer_id`. Conducting-person rows stay unlinked.

### 1.7 ID rules that differ from the handover

| # | Handover | Requirement | Reason |
|---|---|---|---|
| C1 | Records and downloads show the ID photo taken at the time of the purchase (§5, §7a) | Show the ID details used at the time (type, number, expiry, captured by and when). If that capture's photos were replaced, show the newest capture of the same document (follow `prior_verification_id` to the newest unsuperseded images), labelled "Newer copy of this ID, taken {date}". Zips include that copy, and the CSV says which copy each photo is | CCP deletes replaced photos of the same document (privacy policy §3, "one copy on file"). A different document is a separate capture, and its photos stay |
| C2 | Checks ID expiry only | Where a current ID is required (reportable, or bullion with $5,000+ cash; `needsCurrentId`), an ID photographed longer ago than `idv_max_reliance_days` blocks saving like an expired ID, with "Update ID now". Other purchases show an amber notice. `IdStatusBadge` gets a "re-verify" state | Same window TTR applies (`IdVerificationPage.jsx:150-156`) |
| C3 | "Customer and ID sighted in person today" is ticked by default (§4.1, §11) | Unticked and required on every purchase: "ID sighted today and matches the record on file" ("Both people's IDs…" for a joint sale), with the hint "Doesn't match the record? Update ID first" | Privacy policy §3: sight the ID every visit and confirm it matches the record. TTR asks for the same confirmation (`IdVerificationPage.jsx:761-762`) |

---

## 2. Sign-in and journey picker

### 2.1 What CCP has today

- **Sign-in:** Supabase email + password (`app/src/pages/login/LoginPage.jsx`), then TOTP MFA (`app/src/pages/mfa/MfaGatePage.jsx`). `ProtectedRoute.jsx:18` signs out any session below `aal2`.
- **Staff:** `AuthContext.jsx:15` loads `staff_members` (`reporting_entity_id`, `role`, `job_title`) with `reporting_entities` (including `idv_max_reliance_days`, `idv_block_on_expired`).
- **Roles:** `staff_role` is `staff | manager | admin`; `public.has_role()`. `ProtectedRoute requiredRole="admin"` guards `/reports` and `/review-batch/:batchId`.
- **Routes:** `react-router-dom`. `/` shows `StartTransactionPage`; `/start` and `*` redirect to `/`.
- **Sessions:** `jwt_expiry = 3600`. There is no idle sign-out.

### 2.2 Design

- **Sign-in and staff data come from CCP.** The handover's `SignIn.jsx` and the demo `signIn` / `signOut` are dropped. Gold uses `useAuth()`.
- **Gold and TTR are the same reporting entity:** customers, IDs and staff are shared within one `reporting_entity_id`.
- **Journey picker at `/`:** two cards, "Threshold transaction report (TTR)" and "Gold due diligence", plus Reports for admins.
  - `StartTransactionPage` moves to `/start`, replacing the redirect. Existing `navigate('/start')` calls, such as `CustomerSearchPage.jsx:157`, still reach it.
  - The Gold card is behind `GOLD_JOURNEY_ENABLED` in `app/src/config/featureFlags.js`, read from the build variable `VITE_GOLD_JOURNEY_ENABLED` (on for Vercel previews, off in production until go-live). While it is off, `/gold` routes redirect to `/`.
  - Every `gold-*` edge function also checks a server secret, `GOLD_JOURNEY_ENABLED`, and refuses calls unless it is `true`. Gold code deploys to the client project phase by phase, so this keeps it unusable there until go-live.
- **Gold routes**, all inside `ProtectedRoute`. Route names are constants (`GOLD_ROUTES`):

  | Route | Screen |
  |---|---|
  | `/gold` | Find customer |
  | `/gold/customers/new` | New customer |
  | `/gold/customers/:customerId` | Customer page (joint-sale panel is a modal) |
  | `/gold/customers/:customerId/update-id` | Update ID |
  | `/gold/customers/:customerId/edit` | Edit details (managers and admins) |
  | `/gold/to-complete` | To complete |
  | `/gold/purchases` | Purchases. Status, type, cash, dates and recorded-by go in the URL query. The search text stays in memory, never in the URL, because it can be a name, phone or ID number (handover §8) |
  | `/gold/purchases/:purchaseId` | Purchase record |
  | `/gold/purchases/:purchaseId/complete` | Complete purchase |

- **Gold header:** "To complete (n)", "Purchases", staff name, "Switch journey" (to `/`), Sign out.
- **Purchase drafts:** `GoldDraftContext`, mounted in `GoldLayout`, replaces `drafts` in the handover's `App.jsx`. It stays in memory only, so no ID data is left on the device, and is cleared on save, sign-out and idle sign-out.
- **Who recorded it:** `created_by_staff_id` / `completed_by_staff_id` are set on the server from `auth.uid()`. The "Recorded by" filter lists `staff_members.full_name`.

### 2.3 Access, idle sign-out, exports

- **Access:** every signed-in staff member can use both journeys. Admin-only pages stay admin-only.
- **Idle sign-out after 10 minutes, across the whole app:**
  - an idle timer in `AuthContext`, reset on pointer, keyboard and touch, calls `signOut()`;
  - a matching Supabase session inactivity limit in `config.toml` and the hosted project.
- **Downloads and prints: managers and admins only.**
  - The buttons are hidden for `staff`.
  - The `gold-export` edge function checks the role and writes the audit row before signing any photo URL (6.3).

---

## 3. Handoff from gold to TTR

This replaces the handover's `src/lib/austrac.js` and `screens/AustracHandoff.jsx`. In CCP the "AUSTRAC form" is the TTR wizard in the same app.

### 3.1 What CCP has today

- **Scenarios** (`StartTransactionPage.jsx:140-175`, `wizardApi.js:37`): `bullion_buy`, `bullion_sell`, `precious_metal_buy`, `precious_metal_sell`. One scenario per transaction.
- **`ttr.transactions` requires** `scenario`, `transaction_ref`, `transaction_datetime`, `designated_service`, `location_snapshot`, `staff_member_name` / `_email`, `cash_currency`, `cash_amount > 0`, `aud_value > 0`. `status` starts as `draft`.
- **Placeholder amount:** the fast path creates a draft with a placeholder cash amount of 1 until Transaction Details sets the real figure (`CustomerSearchPage.jsx:14-27`).
- **Self-conducted fast path:** one individual acting for themselves goes Customers → ID verification (`CustomerSearchPage.jsx:60, 166-195`).
- **Item capture is off** (`ITEM_AND_DELIVERY_CAPTURE_ENABLED = false`).
- **Reopening a draft:** `findTransactionByRef(ref)` (`wizardApi.js:144`) makes a matching draft the session's active transaction (`sessionStorage['ttr.transactionId']`). The loaders (`loadTransaction`, `loadCustomers`, `loadIdVerifications`, …) then read from the database.
- **`transaction_ref`:** staff type it on the Start page (`wizardApi.js:72`). It is unique per business (`uq_tx_ref_per_entity`). Completed transactions are locked (`trg_lock_completed`).
- **Completing:** any active staff member of the business can complete a TTR (`20260621000018_complete_transaction.sql:39-42`).
- **`location_snapshot`** is `'Coburg, VIC'` (`wizardApi.js:75`). It stays; the handoff uses the same value through one shared constant.
- **No due date** or ERP invoice field exists in CCP.

### 3.2 `gold-start-ttr`

An edge function (service role, after the access checks in 6.2), called with a purchase:

- **Runs only when the purchase has an ERP invoice number.** Case B requires it at save; case A runs when it is added (3.3).
- **Idempotent per type:** if the purchase, or a linked part of the same type, already has `ttr_transaction_id`, use that TTR.
- **Creates a `ttr.transactions` draft:**
  - `transaction_ref` = the ERP invoice number;
  - `scenario` = `precious_metal_buy` for scrap jewellery, `bullion_buy` for bullion;
  - `transaction_datetime` = the gold purchase's `created_at`, when the sale happened;
  - `cash_amount` / `aud_value` = this type's cash across the invoice's linked parts, or the placeholder when no amount was entered;
  - staff snapshot fields from the signed-in staff member.
- **Creates `ttr.parties`** for the main and joint seller, copied from the customer table with `customer_id` set. Missing required fields leave `is_complete = false`, so Party Details asks for them.
- **Creates reliance rows in `ttr.id_verifications`** for each party, pointing at `main_id_verification_id` / `joint_id_verification_id`:
  - the row copies `document_type`, `document_number`, `issuer`, `id_country_code`, `has_expiry` and `expiry_date` from the capture, because `generate-austrac-report` builds `<identification>` from the party's own row (`supabase/functions/generate-austrac-report/index.ts:132-133`);
  - reliance reason `customer_confirmed_details_unchanged` in case A;
  - the counter confirmation (C3: staff, time) is copied onto the row;
  - no photos are copied.
- **Sets `ttr_transaction_id`** on the purchase and its linked parts of the same type.

**Navigation:**
- Gold calls `openTransaction(id)`, a new export in `wizardApi.js` that sets the active transaction, then opens the first step that needs input. It opens by ID because two TTRs can share a reference (3.4).
- If another TTR draft is already active in the session, warn first: "You have another AUSTRAC report in progress ({ref}). It stays saved; reopen it from the TTR start page."
- **Case A:** the self-conducted fast path, with details already confirmed.
- **Case B:** the wizard asks for whatever is missing (third party, changed details, the conducting person for a joint sale).
- **`IdVerificationPage`** accepts the copied counter confirmation instead of asking for the `imageApproved` tick again.

**Status in gold:** "AUSTRAC pending" = reportable and the TTR isn't complete. "AUSTRAC" = the TTR is complete. The purchase record links to the TTR; the TTR review shows "From gold purchase(s) on invoice {invoice}".

### 3.3 When the TTR starts

**The TTR's `transaction_ref` is always the ERP invoice number.** That keeps the ERP, gold and TTR in step, and `uq_tx_ref_per_entity`, widened in 3.4, allows one TTR per invoice per type.

| Case | When | Invoice at the counter | TTR |
|---|---|---|---|
| **A. Ready on file** | Single seller; the customer record has every field in the table below; the ID is valid and inside the re-verification window; both counter questions (3.3a) answered Yes | Optional | Created when the invoice is added on Complete purchase, fully prefilled; can be finished without the customer |
| **B. Not ready** | Anything else: missing fields (e.g. a customer only ever seen in gold), a No answer, or a joint sale | **Required to save** | Opens at the counter straight after the save |

**Rules:**
- **Ready check:** server function `customer_ttr_ready(customer_id)` returns the missing fields. If a reportable sale isn't ready, the form requires the invoice: "Enter the ERP invoice number. {Name}'s AUSTRAC details are incomplete, so the report must be started now."
- **Duplicate invoices:** on a reportable purchase, an invoice number already used by a purchase that isn't a same-day linked part blocks saving. Non-reportable purchases only warn, as in the handover.
- **Deadline:** the sale's `created_at` + 10 business days, Mon–Fri (handover §4.3). Public holidays are not skipped, which makes the deadline earlier, the safe side.
- **Case B not finished at the counter:** the draft stays, and To complete shows "Resume TTR".
- **After a TTR is completed,** its details are saved back to the customer (1.4), so the next reportable sale can be case A.
- **Becoming reportable on Complete purchase** (e.g. the cash answer changed after the customer left): adding the invoice still creates and opens the TTR, with an amber notice, "The customer wasn't asked to confirm their details at the counter. Contact them to confirm before completing the TTR."

**Fields Party Details requires for an individual** (`PartyDetailsPage.jsx:154-175`):

| Field | Copied by TTR search today | Gold collects |
|---|---|---|
| Full legal name | yes | yes |
| Date of birth | yes | yes (new) |
| Residential street, suburb, state, postcode, country | yes | yes (new; privacy policy §2 records every seller's residential address) |
| Phone | yes | yes |
| Occupation | yes | no, TTR asks |
| Gender (`M`/`F`/`U`) | yes | no, TTR asks |
| Citizenship country code | no | no, TTR asks |
| Tax residency country code | no | no, TTR asks |
| Sole trader (yes/no), ABN if yes | no | no, TTR asks |
| Postal address (if flagged) | no | no, TTR asks |
| ID issuing country (`id_country_code`) | from the prior ID | yes (new) |
| ID issuer / state (licence numbers are unique per state only) | from the prior ID | yes (new) |

Today a returning TTR customer retypes citizenship, tax residency, sole trader / ABN and postal address on every TTR. The customer table holds these fields, and search and the handoff copy them.

### 3.3a Counter questions for case A

Shown on the purchase form only when the sale is reportable, has a single seller, and `customer_ttr_ready` passes:

1. "Is {name} acting on their own behalf?" Yes / No.
2. "Are these details still correct?" Shows the residential address, occupation, citizenship and tax residency on file. Yes / No.

- **Both Yes:** case A. The answers are saved on the purchase (`ttr_self_conducted`, `ttr_details_confirmed`) with staff and time.
- **Any No:** case B.
- **Not shown on non-reportable sales.**

**Why case A is sound:**
- **CCP's ID-reuse rule** (`IdVerificationPage.jsx:150-156, 761-762`) allows reliance on an ID on file when it is within `idv_max_reliance_days`, it hasn't expired (or `idv_block_on_expired` is off), and staff confirm the images match the person present. Gold applies the same window, blocks any expired ID on reportable sales, and takes the match confirmation at the counter with the customer present.
- **Privacy policy re-check rules:**

  | Policy | Case A coverage |
  |---|---|
  | §2 no ID, no transaction | ID sighted on every purchase (C3) |
  | §3 sight the ID every visit and confirm it matches the record | Required C3 box |
  | §3 new copy only if the ID changed or the copy is unclear | An ID that doesn't match can't be ticked; staff run Update ID ("renewed" or "photo unclear") first |
  | §2 / Part B name and residential address held | Question 2; No → case B |
  | §7 correction on request | Question 2 No → case B, or a manager edit (audited) |

- **AUSTRAC guidance (reform):** a previously identified customer need not be re-identified on every transaction, but ongoing customer due diligence still applies. See [Transitioning existing customers](https://www.austrac.gov.au/amlctf-reform/reforms-guidance/amlctf-program-reform/customer-due-diligence-reform/transitioning-existing-customers-reform) and [Ongoing customer due diligence](https://www.austrac.gov.au/industry-and-business/obligations-and-guidance/your-amlctf-program/customer-due-diligence/ongoing-customer-due-diligence).
- **Not covered here:** AML/CTF triggers that aren't about ID or personal details (suspicion, unusual activity, risk-rating changes). They belong to the AML/CTF program and its own processes (suspicious matter reports, enhanced CDD). See open items.

### 3.4 Mixed scrap + bullion invoice

Example: Jane, same day, `INV-900`, a scrap chain for $6,000 cash and a bullion bar for $6,000 cash.

- **Reportable** when the cash across all same-day linked parts reaches $10,000 (handover §4.0a): $12,000 here.
- **One TTR per type with cash above $0:** scrap parts → `precious_metal_buy`, bullion parts → `bullion_buy`. A type paid only by bank transfer gets no TTR.
- **Each TTR carries its own type's cash:** $6,000 each. The two add up to the sale total.
- **Linking:** each part links to its type's TTR. `gold-start-ttr` is idempotent per invoice + sale date + customer + type.
- **Case A / B** is decided once for the invoice; both TTRs are created together.
- **References:** both TTRs use exactly `INV-900`. CCP changes:
  - `uq_tx_ref_per_entity` becomes (`reporting_entity_id`, `transaction_ref`, `scenario`);
  - `findTransactionByRef` also takes the scenario;
  - the Start page duplicate-reference check includes the scenario, and `describeSaveError` explains the rule.
- **AUSTRAC file** (checked against `docs/schema/TTR-1-0.xsd`):
  - the only uniqueness rule is on `id` attributes (`xs:ID`, `:629`), which includes the report ID `<ttr id="ttr-{TTR id}">` (`generate-austrac-report/index.ts:586`). That is unique per TTR;
  - `txnRefNo` (`:251`, type `TRN`, `:1434`) has no uniqueness rule, so two reports can send `INV-900`;
  - **fallback** if AUSTRAC ever rejects an upload for a repeated `txnRefNo`: the generator writes `{invoice}-{designated service}` in the file only.
- **Finishing both:** gold opens the first TTR. `TransactionCompletePage` then shows "Another AUSTRAC report for INV-900 is waiting". To complete lists both until both are complete.

### 3.5 A later part on an invoice that already has a TTR

Example: 10:00, Jane sells scrap for $12,000 cash on `INV-900`, and the TTR is completed. 14:00, staff record another $3,000 scrap part on the same invoice.

- **TTR still a draft:** the part joins it, and `gold-save-purchase` updates the draft's `cash_amount` / `aud_value` for that type.
- **TTR completed:** blocked, because completed TTRs are locked and CCP has no amendment flow. The message: "The AUSTRAC report for {invoice} is already finished. Use a new ERP invoice number for this purchase." This applies to new parts and to an invoice number added on Complete purchase.

---

## 4. Data model

### 4.1 CCP patterns followed

- **Schemas:** TTR tables in `ttr`; shared entities in `public`. Gold tables go in a new `gold` schema, exposed in the Supabase API settings.
- **Tenancy:** RLS `reporting_entity_id = public.reporting_entity_id()`.
- **Audit:** append-only via `ttr.deny_audit_mutation()` / `trg_audit_append_only`, select-only policy (`20260621000009_transaction_audit_log.sql`).
- **Server work in edge functions:** `upload-id-image`, `get-id-image-urls`, `complete-transaction`, `_shared/supersede.ts`, `delete-draft-transaction`, `cleanup-stale-drafts`, `reconcile-stored-images`, `generate-austrac-report`, `approve-batch`.

### 4.2 Tables

**`public.customers`**
- `id`, `reporting_entity_id`, `customer_type` (`party_kind`), `source` (`gold` | `ttr`), `created_by_staff_id`, `created_at`, `updated_at`.
- **Individual:** `first_name`, `middle_name`, `last_name`, `date_of_birth`, `gender`, `phone`, `email`, `occupation`, `res_*`, `has_postal_address`, `post_*`, `citizenship_country_code`, `tax_residency_country_code`, `is_sole_trader`, `abn`.
- **Company** (as on `ttr.parties`): `entity_name`, `company_trading_name`, `legal_form`, `reg_id_type`, `reg_identifier`, `company_phone`, `principal_activity`, `biz_*`, `co_post_*`, trust fields.
- **Generated search columns:** `name_search` (trigram index), `phone_digits`.
- No unique key on name + DOB; duplicate checks are prompts.

**`public.customer_aliases`:** `customer_id`, `alias`, `sort_order`.

**`public.customer_audit_log`:** append-only. Who, when, old → new for every customer change: gold edits, phone changes, and updates from completed TTRs.

**`gold.purchases`**

| Column | Notes |
|---|---|
| `id`, `reporting_entity_id` | |
| `customer_id`, `joint_customer_id` | FK to `public.customers`; `CHECK (joint_customer_id <> customer_id)` |
| `main_id_verification_id`, `joint_id_verification_id` | FK to `ttr.id_verifications`: the ID used. Joint required when there is a joint seller |
| `purchase_type` | `scrap` \| `bullion`; immutable |
| `cash_band`, `cash_10k_or_more`, `cash_amount` (`>= 0` or null) | Handover names. `cash_10k_or_more` = `isReportable` |
| `invoice_cash_total` | Snapshot of the linked total shown when this part was saved; never rewritten by later parts |
| `erp_invoice_no`, `erp_invoice_norm` | `erp_invoice_no` is null until added and can't be removed once set. `erp_invoice_norm` = `upper(btrim(…))`, generated and indexed |
| `sale_date` | Local date in `Australia/Melbourne` (the same shared constant as `location_snapshot`), set by the server. Used for linking and the deadline |
| `phone` | Phone given at this purchase |
| `id_sighted` | Must be true |
| `id_expired_at_time`, `id_outside_window_at_time` | ID state at capture |
| `ttr_self_conducted`, `ttr_details_confirmed` | Counter answers (3.3a); null when not asked |
| `ttr_transaction_id` | FK to `ttr.transactions`, `ON DELETE SET NULL` |
| `created_at`, `created_by_staff_id`, `completed_at`, `completed_by_staff_id`, `updated_at` | Set by the server only |

**Linked parts** are found by query: same `reporting_entity_id`, the customer as main or joint seller, same `erp_invoice_norm`, same `sale_date`.
- One shared query serves `findSameDayInvoicePurchases`, the API's computed `linked_transaction_ids`, and the server re-checks.
- A part that gets its invoice later links automatically.
- The total is recalculated on the server on every save.
- The handover's stored `linked_transaction_ids` array and `lib/invoiceLinks.js` are dropped.
- "Cash paid on that part" (filling a missing amount on an earlier part) is an audited update through `gold-save-purchase`.

**`gold.goods_photos`**
- `id`, `purchase_id`, `reporting_entity_id`, `storage_bucket` (private `gold-goods`), `object_path` (`{purchase_id}/goods-{n}.jpg`), `content_hash_sha256`, `content_type`, `byte_size`, `captured_by_staff_id`, `captured_at`, `sort_order`.
- Append-only; kept apart from `ttr.stored_images`, so the one-copy ID rules never touch goods photos.

**`gold.purchase_audit_log`:** append-only. A trigger on `gold.purchases` writes who, when, old → new for each changed column (handover §5).

**`gold.export_audit_log`:** append-only. Staff, time, kind (`zip` | `record`), filters, purchase IDs.

**Changes to `ttr` tables:**
- `parties.customer_id`;
- `id_verifications.customer_id`, with nullable transaction, party and conducting person;
- `stored_images.customer_id`, with nullable transaction;
- `uq_tx_ref_per_entity` widened to include `scenario`.

### 4.3 Rules enforced on the server

- At least one goods photo on create; photos are append-only.
- Joint seller ≠ main seller; at most one joint seller.
- Immutable after capture: sellers, `purchase_type`, ID references, ID flags, `created_*`, counter answers.
- The invoice number can't be removed once set. `completed_*` is set only when it is added after capture.
- `cash_amount >= 0` or null; phone 8+ digits; `id_sighted` true.
- `isReportable`, `needsCurrentId`, the expired / out-of-window ID blocks (C2), same-day linking and the cash totals are recalculated on the server.
- **Reportable purchases:** the invoice is required in case B; a duplicate invoice blocks unless it's a same-day linked part.
- A part can't link to an invoice whose TTR for that type is completed.

### 4.4 Changes to existing CCP functions

| Function | Change |
|---|---|
| `cleanup-stale-drafts` | Skip TTR drafts linked to a gold purchase. An old linked draft is an overdue report and shows in To complete |
| `delete-draft-transaction` (TTR "Exit") | Allowed. `ON DELETE SET NULL` clears the gold link, and the purchase shows "Start TTR" |
| `upload-id-image` | Accepts a customer as the owner |
| `get-id-image-urls` | Signs customer-owned photos. It already logs every view to `ttr.access_log` |
| `_shared/supersede.ts` | Also used by gold Update ID |
| `complete-transaction` | Links or creates customers and updates them from the party copies (1.4) |
| `reconcile-stored-images` | Also sweeps orphaned `gold-goods` objects |
| `generate-austrac-report`, `approve-batch` | No change |

### 4.5 Write path

- **Shared rules:** the handover's pure `src/lib/purchase.js` becomes `supabase/functions/_shared/goldRules.js`, imported by the browser (form feedback) and the edge functions (enforcement).
- **Edge functions:**
  - `gold-create-customer`;
  - `gold-update-customer` (details; managers and admins);
  - `gold-update-customer-id`;
  - `gold-save-purchase`;
  - `gold-complete-purchase`;
  - `gold-start-ttr`;
  - `gold-export`.
- **The browser only reads** `gold.*` and `public.customers` (select policies only).
- **Photos** are sent in the same request as the save (multipart; compressed JPEGs, max 1600 px). The function hashes and stores them and writes the rows in one transaction. Objects left by a failed save are swept by `reconcile-stored-images`.
- **Goods photo URLs** come from an extended `get-id-image-urls` or a sibling `get-gold-photo-urls`.

### 4.6 Handover `api.js` → CCP

| Handover function | CCP implementation |
|---|---|
| `signIn`, `signOut` | `AuthContext` |
| `searchCustomers(q)` | RPC `search_customers` |
| `getCustomer(id)` | Select customer + current ID |
| `findPossibleDuplicates` | RPC: name + DOB, phone, plus `get_verification_for_document` |
| `createCustomer` | `gold-create-customer` |
| `updateCustomerId` | `gold-update-customer-id` |
| `updateCustomerPhone` | RPC (8+ digits; audited) |
| new `updateCustomerDetails` | `gold-update-customer` |
| `listTransactions(customerId)` | Select purchases where main or joint = customer |
| `getTransaction(id)` | Select purchase + photos + ID details used |
| `listIncompleteTransactions` | RPC: no invoice, or reportable with the TTR not complete |
| `searchTransactions(filters)` | RPC `search_gold_purchases` (paged) |
| `findSameDayInvoicePurchases` | RPC (linked-parts query) |
| `listRecordedBy` | Staff in the business who recorded purchases |
| `recordDownload` | `gold-export` |
| `invoiceExists` | RPC on `erp_invoice_norm` |
| `createTransaction` | `gold-save-purchase` |
| `updateTransaction` | `gold-complete-purchase` |
| `goToAustracForm` | `gold-start-ttr` + `openTransaction(id)` |

---

## 5. Rules and screens

### 5.1 Rules module

`goldRules.js` takes these from `purchase.js` unchanged, plus `idStatus`, `addBusinessDays` and `parseAud` from `utils.js` and the thresholds from `config.js`: `PURCHASE_TYPES`, `BULLION_BANDS`, `bandLabel`, `typeLabel`, `claimsCash10k`, `cashBand`, `isIncomplete`, `cashAmountValue`, `isReportable`, `needsCurrentId`, `evaluateCash`, `austracDueDate`.

| Rule | Change | Section |
|---|---|---|
| `idStatus` | Takes the current ID (`expiry_date`, `captured_at`) and `idv_max_reliance_days`; adds `reverify` | C2 |
| `validatePurchase` | `blocked` includes sellers whose ID is outside the window when `cash.needsId`; `errors.idSighted` when the box isn't ticked | C2, C3 |
| `evaluateCash` | `alreadyReported` = a linked part of the same type has a `ttr_transaction_id`; cash per type for mixed invoices | 3.2, 3.4 |
| new `ttrCase({ cash, isJoint, readiness, answers })` | Returns `null`, `'A'` or `'B'`, plus `invoiceRequired` | 3.3 |
| `validatePurchase`, `validateCompletion` | `errors.erp_invoice_no` when `invoiceRequired`; duplicate-invoice block for reportable non-linked purchases; error when a linked part's TTR of the same type is completed | 3.3, 3.5 |
| `validateCompletion` | `blocked` also when `id_outside_window_at_time` and reportable | C2 |

- **Server only:** `nameKey`, `phoneKey`, `idKey`.
- **Browser only** (`pages/gold/shared/format.js`): `formatDate`, `formatDateTime`, `formatAud`, `daysUntil`, `businessDaysUntil`, `compressImage`, `blobToDataURL`.

### 5.2 Screens

| Handover screen | CCP page | Changes |
|---|---|---|
| `SignIn.jsx` | dropped | CCP sign-in + MFA |
| `Search.jsx` + `CustomerPicker.jsx` | `GoldSearchPage` | `search_customers`; results show DOB and the re-verify state |
| `CustomerForm` (create) | `GoldCustomerFormPage` `mode="create"` | Adds DOB, residential address, name parts, ID issuing country and state, CCP's ID types. Back photo and expiry follow CCP's per-type rules (`BACK_REQUIRED_TYPES`, `has_expiry`). Duplicates: the collision prompt plus name + DOB and phone matches |
| `CustomerForm` (update) | same page `mode="update"` | Asks why: renewed, different document, or photo unclear. The old copy of the same document is replaced |
| — | same page `mode="edit"` | Managers and admins correct name, DOB and other profile fields (not ID details). Audited. Past TTR party copies are unchanged |
| `CustomerDetail.jsx` | `GoldCustomerPage` | "ID last updated" = current capture date; re-verify state. Purchase form: required sighted box with hint; counter questions (3.3a); invoice required in case B; duplicate invoice blocks when reportable; case B opens the TTR after save |
| `JointSellerPanel.jsx` | modal on `GoldCustomerPage` | A joint reportable sale is always case B |
| `ToComplete.jsx` | `GoldToCompletePage` | Also lists reportable purchases whose TTR isn't complete: "Resume TTR" for drafts, "Start TTR" when the draft was deleted |
| `CompletePurchase.jsx` | `GoldCompletePurchasePage` | Adding the invoice to a reportable case A purchase creates and opens the TTR; amber notice if it became reportable here without the counter answers |
| `Purchases.jsx` | `GoldPurchasesPage` | Server paging; filters in the URL except the search text; Download hidden for `staff` |
| `PurchaseRecord.jsx` | `GoldPurchaseRecordPage` | ID details used, with the newer copy label when replaced (C1); TTR status and link; Download record hidden for `staff` |
| `AustracHandoff.jsx` | dropped | Replaced by the TTR wizard |

**Unchanged from the handover:**
- the goods photo as the only required field on a non-reportable sale;
- purchase types and cash questions;
- the `LinkedInvoice` panel;
- phone change rules;
- the draft surviving navigation;
- the deadline countdown;
- copy rules (sentence case, en-AU, errors say what to do);
- the dev "Fill with test data" buttons, gated by `import.meta.env.DEV`.

### 5.3 Code structure

```
app/src/pages/gold/
  GoldLayout.jsx                         shell: header, To complete (n), Purchases, Switch journey, Sign out; <Outlet />
  GoldSearchPage.jsx
  GoldCustomerFormPage.jsx               create / update / edit
  GoldCustomerPage.jsx
  GoldToCompletePage.jsx
  GoldCompletePurchasePage.jsx
  GoldPurchasesPage.jsx
  GoldPurchaseRecordPage.jsx             each page has a matching .module.css
  shared/
    GoldDraftContext.jsx                 guarded useGoldDraft(); reset() from INITIAL_STATE
    routes.js                            GOLD_ROUTES
    format.js  zip.js  exportPurchases.js
    CustomerPicker.jsx  JointSellerPanel.jsx  CashQuestion.jsx  LinkedInvoice.jsx
    ImageField.jsx  CameraCapture.jsx  IdStatusBadge.jsx  PurchaseTags.jsx  YesNo.jsx  Lightbox.jsx
    index.js
app/src/lib/goldApi.js                   handover api.js names and shapes, implemented against Supabase
supabase/functions/_shared/goldRules.js
supabase/functions/gold-*/index.ts
```

- **Separate files only where needed:**
  - `CustomerPicker`, `CashQuestion`, `LinkedInvoice`, `ImageField`, `IdStatusBadge`, `PurchaseTags`, `YesNo` and `Lightbox` are each used by two or more screens;
  - `JointSellerPanel` is a modal;
  - `CameraCapture` is a hardware integration.

  Anything else stays inline in its screen.
- **CCP components are reused:** `components/ui/Button`, `FormField`, `TextInput`, `DatePicker`, `ConfirmModal`. The handover's `Field`, `.btn-*` and `.input` are not ported.
- **Routing:** `App.jsx` adds a `/gold` parent route with `GoldLayout` inside `ProtectedRoute`. `GoldDraftContext` is mounted in `GoldLayout`.

### 5.4 Look

- Gold screens use CCP's components and CSS Modules. No Tailwind; the handover's `index.css` tokens and `tailwind.config.js` are not ported.
- **Kept from handover §9:**
  - colour meaning (valid / attention / blocking);
  - one main action per screen;
  - copy rules;
  - accessibility (labels, focus rings, `role="radiogroup"` on `YesNo`, `role="status"` / `role="alert"`, Escape closes panels, focus returns after the joint-sale panel);
  - 1280 px at the counter, usable down to 390 px.

### 5.5 Code formatting

- **Step 0, in its own commit:**
  - add `app/.prettierrc` (`tabWidth: 4`, `singleQuote: false`, `semi: true`, `trailingComma: "es5"`, `printWidth: 120`) and a `format` script;
  - reformat `app/src`, with formatting changes only;
  - add the commit to `.git-blame-ignore-revs`;
  - do it when no other branches are open.
- Whether `supabase/functions` is included is decided at build time.
- **New gold code** follows the house style in full.
- **`AGENTS.md`:** update it to say formatting is enforced by Prettier.
- **ESLint:** if `app/eslint.config.js` has conflicting style rules, add `eslint-config-prettier`.

---

## 6. Downloads, audit, security

### 6.1 Access and storage

- **Every `gold-*` edge function verifies** the JWT, `aal = 'aal2'`, and the staff member's `reporting_entity_id` and role. `ProtectedRoute` is a browser-only check.
- **Storage:** ID photos in `compliance-media` (under `customers/{customer_id}/…` for gold captures); goods photos in the private `gold-goods` bucket. Both are served only through short-lived signed URLs.
- **Logs:** edge functions log IDs and error codes only, never names, phone numbers, ID numbers or amounts.
- **HTTPS:** the webcam needs it.

### 6.2 Exports and printing

- **Zip, built in the browser and gated by the server:**
  - `zip.js` and `exportPurchases.js` move to `pages/gold/shared/`;
  - "Download (n)" calls `gold-export` with `{ kind: "zip", filters, purchaseIds }`, which checks the role, writes `gold.export_audit_log`, and returns the CSV rows plus 5-minute signed URLs for each photo (the current copy where one was replaced);
  - at most 200 purchases per export.
- **CSV:**
  - keeps the handover's protections (UTF-8 with BOM; cells starting `= + - @` prefixed with `'`);
  - adds `ttr_status`, `ttr_reference`, `id_document_used`, `id_photo_copy_taken`.
- **Printing:**
  - print styles hide ID photos by default;
  - "Download record" calls `gold-export` with `{ kind: "record", … }` first, then shows ID photos for that one print (class removed on `afterprint`);
  - a plain Ctrl+P print shows purchase details and goods photos only.
- **Viewing:** gold shows ID photos only through `get-id-image-urls`, which logs every view to `ttr.access_log` (privacy policy §4).

### 6.3 Retention

The privacy policy (§6) promises deletion 7 years after the transaction, and deletion of a dormant customer's ID image. CCP hasn't built this yet; it is accepted risk G1 / G2 in `docs/go-live.md:221-222`. Gold adds no deletion of its own. `gold.purchases`, `gold.goods_photos`, `public.customers` and customer-owned ID captures must be in scope when that job is built.

### 6.4 Privacy policy check

| Policy | How gold meets it |
|---|---|
| §2 full name and residential address | Collected on New customer |
| §2 photo ID, or two approved non-photo documents | Photo ID only (see open items) |
| §2 photo and description of the items | Photo in gold; description in the ERP invoice (see open items) |
| §2 date, time, price, staff member | `created_at`, `created_by_staff_id`; price in the ERP via the invoice |
| §3 one copy of ID; new copy only if changed or unclear | Shared ID store with supersede (1.6), Update ID reasons, C1 |
| §3 sight the ID every visit and confirm it matches | C3 |
| §4 encryption, Australian hosting, individual MFA logins | CCP platform; region checked at go-live (`docs/go-live.md:110`) |
| §4 every ID image view and every export logged | `ttr.access_log` (views), `gold.export_audit_log` (exports) |
| §4 no paper copies | Managers can print records with ID photos and download zips with ID photos (see open items) |
| §4 records can't be silently altered | Audit logs; no client writes |
| §5 every disclosure logged | Export audit log (who, when, what) |
| §6 deletion after 7 years | CCP risk G1 / G2 (6.3) |
| §7 access request | Privacy Officer runbook (CCP risk G3), with gold added: customer page + Purchases export filtered to the customer |
| §7 correction | Manager edit, audited |

---

## 7. Open items

**Client sign-off** (differences from the handover):
- **C1:** when a customer's ID was re-captured, past records and downloads show the newer copy of the same ID, labelled with its date (§5, §7a).
- **C3:** the sighted box is unticked and required on every purchase. This reverses §11, but matches the client's own privacy policy §3.
- **New customer** requires date of birth, residential address, and the ID's issuing country and state.
- **The invoice is required at the counter** for a reportable sale in case B (narrows §11).
- **A duplicate invoice blocks** a reportable purchase instead of only warning (§4.1).
- **Downloads and prints** are limited to managers and admins (§12).
- **Customer details** can be corrected by managers and admins (new).

**Compliance officer:**
- **AML/CTF triggers:** confirm the AML/CTF program has no trigger beyond ID and personal details (e.g. suspicion, unusual activity, a risk-rating change) that should stop a TTR being finished later without the customer (3.3a).
- **Privacy risks:** accept these and add them to the `docs/go-live.md` risk register next to G1–G6:
  - an incomplete purchase has no item description until its ERP invoice is added (§2);
  - a seller without photo ID can't be recorded in gold (§2);
  - printed records and zips can contain ID copies (§4 "no paper copies").

**Build-time checks:**
- `id_verifications` `NOT NULL` columns a customer-level capture must fill (e.g. `verification_method`).
- Whether `has_role()` treats admin as above manager.
- TTR pages that `navigate('/')` and expect the TTR start.
- A TTR in progress can be picked up again after an idle sign-out.
- Which wizard pages read `wizardStorage` instead of the database loaders (e.g. `CustomerSearchPage.jsx:46`); seed them on handoff or switch them to the loaders.
- How Party Details splits `fullName` into first / middle / last (H5).
- The Vite app can import `supabase/functions/_shared/goldRules.js`, and the Deno bundler accepts it.
- The Supabase project is in an Australian region and serves HTTPS.

**Out of scope for v1:**
- merging duplicate customers;
- walk-in bullion without ID (handover §4.0);
- two non-photo documents instead of a photo ID;
- a customer access-request export (runbook, G3);
- 7-year deletion (G1 / G2);
- adding or changing the joint seller on Complete purchase (handover §12);
- server-side zip.

---

## 8. Build order

Each step leaves TTR working.

0. Prettier reformat of the CCP app, formatting only (5.5).
1. `public.customers`, backfill, TTR search on customers, `migrateNewParties` and `complete-transaction` changes (1.4).
2. Shared ID store: `id_verifications` / `stored_images` changes; `upload-id-image`, `get-id-image-urls`, `supersede.ts` (1.6).
3. Journey picker at `/`, TTR start at `/start`, idle sign-out, `GOLD_JOURNEY_ENABLED` (2). Steps 1–3 can ship before gold is finished.
4. `gold` schema, `goldRules.js` with unit tests, `gold-*` edge functions (4, 5.1).
5. Gold screens, layout, draft context and routes (5).
6. Handoff: `gold-start-ttr`, case A / B, the `uq_tx_ref_per_entity` change, `openTransaction`, the `cleanup-stale-drafts` change (3, 4.4).
7. Exports, printing and the export audit log (6).

---

## 9. Verification

- **Unit tests (Vitest):** `goldRules.js` with handover §10 cases 1–30, plus C2, C3, `ttrCase` A/B, the duplicate-invoice block and the completed-TTR block.
- **Edge function tests (Deno),** following `supabase/functions/complete-transaction/index.test.ts`:
  - access is refused without `aal2`, for another business's records, and for `staff` on `gold-export`;
  - every rule in 4.3 holds when the client sends bad data.
- **Database tests (pgTAP),** in `supabase/tests/`, run with `npx supabase test db` against a freshly reset local database. They cover RLS, constraints, triggers and RPCs.
- **Migration checks,** as pgTAP tests on seeded fixtures (no production data exists yet):
  - one customer per distinct search key;
  - every completed party has a `customer_id`;
  - TTR search returns the same people for the fixture queries before and after step 1 (the old search functions are copied into the test and compared with the new ones).
- **Regression:** existing CCP app and function tests pass after steps 0–2 (e.g. `CustomerSearchPage.test.jsx`, `wizardFlow.test.jsx`, `IdVerificationPage.test.jsx`, `PartyDetailsPage.test.jsx`). Re-run the TTR rows of `docs/uat-test-matrix.md`.
- **AUSTRAC file:**
  - generate batches with gold-started TTRs: single type, a mixed invoice (two reports with `txnRefNo` `INV-900`), and a joint sale;
  - validate with `xmlschema.XMLSchema11` against `docs/schema/TTR-1-0.xsd`, with both negative controls (`docs/go-live.md` 3.10, `docs/uat-test-matrix.md` R25). Expect 0 errors, and exactly 1 per control;
  - check `<identification>` has the document number, issuer and country.
- **RLS** (pgTAP):
  - the browser can't insert into or update `gold.*` or `public.customers`;
  - another business's rows are invisible.
- **End to end** (local Supabase + `npm run dev` in `app/`):
  1. Sign in + MFA → journey picker → both journeys. After 10 minutes idle, staff are signed out and the draft is cleared.
  2. New customer with DOB, address and licence (issuing country and state). The same licence number on another new customer shows the collision prompt.
  3. Non-reportable scrap with a photo only → saves as Incomplete; the header count goes up.
  4. **Case A:**
     - a returning customer, cash Yes, no invoice, both questions Yes → AUSTRAC pending;
     - Complete with the invoice → the TTR opens prefilled, with reference = invoice and the reliance row attached;
     - completing the TTR → gold shows AUSTRAC.
  5. **Case B:**
     - a gold-only customer, cash Yes → the invoice is required;
     - save → the TTR opens at Party Details;
     - after completion the customer has the new details, and their next reportable sale is case A.
  6. A joint reportable sale is always case B.
  7. **ID state:**
     - an expired or out-of-window ID blocks with "Update ID now";
     - Update ID (renewed, same number) replaces the old photo;
     - the earlier record shows the newer copy, labelled;
     - Update ID with a different document leaves the earlier licence photos in place.
  8. **Same-day parts:**
     - same type, $6,000 + $6,000 → one TTR for $12,000;
     - scrap $6,000 + bullion $6,000 → two TTRs, both `INV-900`, the second offered after the first;
     - scrap $12,000 cash + bullion by bank transfer → one precious metal TTR;
     - after the TTR is completed, a new same-day part on `INV-900` is blocked.
  9. A reportable purchase with another customer's invoice number is blocked; a non-reportable one only warns.
  10. **Exports:**
      - `staff` see no download buttons and `gold-export` refuses them;
      - a manager's zip writes an audit row;
      - Ctrl+P hides ID photos; "Download record" shows them;
      - viewing an ID photo writes a `ttr.access_log` row.
  11. **TTR drafts:**
      - Exit in a gold-linked TTR → gold shows "Start TTR";
      - `cleanup-stale-drafts` leaves linked drafts alone.
  12. The TTR journey alone is unchanged: first + last name, or last name + DOB, finds customers, and picking one links `customer_id`.
  13. A Purchases search by name leaves no name in the URL.
