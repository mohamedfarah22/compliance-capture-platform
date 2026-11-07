# UAT: Gold customer screens (Gold Phase 8a)

**Purpose:** prove that `gold/08a-customer-screens` gives staff the customer half of the gold journey in the browser, and that every rule the spec puts on those screens holds:
1. `/gold` replaces the placeholder: find a customer, create one, update their ID, correct their details (managers and admins), see their details and change their phone
2. The screens call the Phase 5 to 7 server pieces (`search_customers`, `gold-create-customer`, `gold-update-customer-id`, `gold-update-customer`, `update_customer_phone`, `customer_current_id`, the duplicate and ID-collision lookups) and show what the server answers, including every refusal
3. ID status (valid, expiring, expired, re-verify, none) is worked out with the shared `goldRules.js` and the business's `idv_max_reliance_days`
4. Photos always leave the browser as a JPEG of 1600 px or less on the long side, from the camera and from Upload
5. The purchase form, joint seller, To complete, Complete purchase, Purchases and Purchase record are **not** here (Phase 8b)

| | |
|---|---|
| Environment | Local Supabase stack (`supabase start`), Vite on 5199, flag on |
| Build/commit | see the sign-off line |
| Run by / date | independent UAT agent (uat-automation), 2026-11-03 |

**Where the rules come from.** Spec §1.5, §1.6, §1.7 (C2), §2.2, §2.3, §4.6, §5.2 (Search, CustomerForm create / update / edit, CustomerDetail view), §5.3, §5.4 of `docs/gold-due-diligence-spec.md`. The "Spec" column names the clause each row proves.

**Set-up for every row.** The build variable `VITE_GOLD_JOURNEY_ENABLED=true`, and the local functions have `GOLD_JOURNEY_ENABLED=true` (`supabase/config.toml` `[edge_runtime.secrets]`). Staff sign in with password then TOTP (`aal2`). Unless a row says otherwise the user is an active `staff` member of business One, which has `idv_max_reliance_days = 730`. Business Two exists with its own staff and customers. "Seeded customer" means a row inserted through SQL with a customer-level `new_capture` ID.

---

## Section A · Automated rows

```
cd app
npx supabase db reset --workdir .. && npm run uat:gold08a      # Playwright, project gold08a (60 tests, rows 8a.2 to 8a.58 and 8a.60)
VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder-anon-key npm test   # Vitest: rows 8a.1 and 8a.59
```
`npm run uat` includes `uat:gold08a` as its last link. The gold edge functions need `GOLD_JOURNEY_ENABLED=true`, which `supabase/config.toml` `[edge_runtime.secrets]` sets for the local stack and CI. The browser build needs `VITE_GOLD_JOURNEY_ENABLED=true`, which `app/playwright.config.js` gives the Vite server it starts (8a.1, flag off, is a Vitest test because that server has the flag on).
Run from this worktree's `app/`: after `supabase start` from another worktree the edge runtime serves that worktree's functions, so `supabase stop && supabase start --workdir ..` first.

☐ CI green on this commit

**How the tests sign in.** The browser session is made through the Auth API (password then TOTP) and written into the page's localStorage; 8a.2 signs in through the real login and MFA screens. Staff, a manager, an admin and business Two's staff are created by `app/e2e/gold08a/support.js`, which also seeds customers and ID captures (with real stored photos where a row looks at them) through SQL.

**Where a row differs from the sheet's first wording** (expectation unchanged): the camera dialog's buttons are "Cancel" and "Take photo" (the sheet said "Close", 8a.38); the three reasons on Update ID read "Renewed: same document, new expiry date", "The customer presented a different document" and "The stored photo is unclear" (8a.39). A third letter cannot be typed in a country box (it stops at 2 characters), so 8a.24 checks `A` and `1A` as refused and `AUS` as capped to `AU`.

**Defects found by UAT (a defect's test stays red until it is fixed)**

| ID | Row | Expected | Actual | Cause and a fix that makes the test pass |
|---|---|---|---|---|
| D1 **fixed in aa01de9** | 8a.53 | After saving a new phone with Enter, "the focus returns to Change" | Focus stays on the page body (nothing focused) | `GoldCustomerPage.jsx` `closePhoneEditor` runs `setTimeout(() => changePhoneRef.current?.focus())` straight after `setIsEditingPhone(false)` inside an async handler. React has not yet re-rendered the "Change" button, so `changePhoneRef.current` is `null`. The Escape path works (a discrete event flushes first). UAT checked that `setTimeout(..., 100)` makes the test pass, then reverted it. A robust fix: focus in a `useEffect` that runs when `isEditingPhone` turns false. Test: `app/e2e/gold08a/07-customer-page.e2e.js` › "8a.53 — after saving a new phone with Enter the focus returns to "Change"" |

Rows 8a.1 to 8a.59 are the implementer's; **8a.60 was added by UAT** from §4.5 (the camera path must always hand on a JPEG of at most 1600 px).

---

## Rows

### Access and shell

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 8a.1 | §2.2 | Build with the flag off (`VITE_GOLD_JOURNEY_ENABLED` unset), signed in. Visit `/gold`, `/gold/customers/new`, `/gold/customers/<id>` | Each redirects to `/` (journey picker). No gold screen renders | `app/src/__tests__/gold08aFlagOff.test.jsx` (6 paths, Vitest) |
| 8a.2 | §2.2 | Signed out, visit `/gold` and `/gold/customers/new` | Redirected to `/login?redirect=…` with the path kept; after sign-in and MFA the staff member lands on the page they asked for | `app/e2e/gold08a/01-access-shell.e2e.js` › 8a.2 |
| 8a.3 | §2.2 | Password-only session (`aal1`) visits `/gold` | Session is ended; staff are sent to login. No gold data is requested | `app/e2e/gold08a/01-access-shell.e2e.js` › 8a.3 |
| 8a.4 | §2.2 | Signed in at `aal2`, flag on. Open the picker, click the "Gold due diligence" card | `/gold` opens "Find customer". The gold header shows the staff name, "Switch journey" and "Sign out" | `app/e2e/gold08a/01-access-shell.e2e.js` › 8a.4 |
| 8a.5 | §2.2 | In the gold header click "Switch journey", then return to Gold and click "Sign out" | "Switch journey" goes to `/`. "Sign out" ends the session and shows the login page. The back button does not show a gold screen | `app/e2e/gold08a/01-access-shell.e2e.js` › 8a.5 |
| 8a.6 | §2.2 | Visit `/gold/nonsense` | Redirected to `/gold` | `app/e2e/gold08a/01-access-shell.e2e.js` › 8a.6 |
| 8a.7 | §5.4 | Tab through each screen at 1280 px wide and at 390 px wide (search, new customer, update ID, edit, customer page) | No horizontal scroll at either width. Every control has a visible label and a visible focus ring. Errors are announced (`role="alert"`), status messages are `role="status"` | `app/e2e/gold08a/01-access-shell.e2e.js` › 8a.7 |

### Find customer

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 8a.8 | §1.5, §5.2 | Open `/gold`. Type 1 character, then 2 | The search box has focus on load. With 1 character nothing is requested and no result list shows. With 2 characters a search runs | `app/e2e/gold08a/02-find.e2e.js` › 8a.8 |
| 8a.9 | §1.5 | Type "jane citizen" quickly, one character at a time | Exactly one `search_customers` request is sent, about 250 ms after the last keystroke, for the full text. The URL never contains the search text | `app/e2e/gold08a/02-find.e2e.js` › 8a.9 |
| 8a.10 | §1.5 | Search by part of the name in any case ("CITIZ", "jane c"), by a middle name, and by an alias | The customer is found each time. A term that matches no name part finds nobody | `app/e2e/gold08a/02-find.e2e.js` › 8a.10 |
| 8a.11 | §1.5 | Search a customer's phone as `0412 345 678`, `+61412345678`, `61412345678`, and `4123`; then search `041` | The first three find the customer. `4123` (4 digits) finds them as a phone part. `041` (3 digits) does not match by phone | `app/e2e/gold08a/02-find.e2e.js` › 8a.11 |
| 8a.12 | §1.5 | Search an ID number as typed, in lower case, with spaces, and with dashes ("ab-12 3456") | The customer is found whichever form is typed | `app/e2e/gold08a/02-find.e2e.js` › 8a.12 |
| 8a.13 | §1.5, §5.2 | Look at a result row | Shows full name, date of birth (en-AU, e.g. 02 Nov 1985), ID type and number, phone, and the ID status badge | `app/e2e/gold08a/02-find.e2e.js` › 8a.13 |
| 8a.14 | §1.5 | Seed customers so that one has exactly the searched phone, and others share the last name. Search the phone digits | The exact phone (or exact ID number) match is listed first; the rest follow by last name, then first name | `app/e2e/gold08a/02-find.e2e.js` › 8a.14 |
| 8a.15 | §1.5 | Seed 25 customers matching one term | At most 20 are listed | `app/e2e/gold08a/02-find.e2e.js` › 8a.15 |
| 8a.16 | §1.5, §6.1 | Search for a name that exists only in business Two, and for a company customer in business One | Neither appears. "No customer matches …" shows | `app/e2e/gold08a/02-find.e2e.js` › 8a.16 |
| 8a.17 | §5.2 | Search something that matches nobody | "No customer matches “…”. Check the spelling or create a new customer." shows with a "New customer" button that opens `/gold/customers/new` | `app/e2e/gold08a/02-find.e2e.js` › 8a.17 |
| 8a.18 | §5.2 | Search for one customer and press Enter; search a term with several results and press Enter; click a result | Enter opens the customer when there is exactly one result and does nothing when there are several. Clicking a result opens `/gold/customers/<id>` | `app/e2e/gold08a/02-find.e2e.js` › 8a.18 |
| 8a.19 | §1.7 C2, §5.2 | Seed customers whose current ID is: valid for 90 days; expires in 12 days; expired yesterday; captured 800 days ago; with no ID on file | Badges read: "ID valid to …" (valid), "ID expires in 12 days" (attention), "ID expired …" (blocking), "Re-verify ID" (attention), "No ID on file" (neutral). Colour differs by meaning | `app/e2e/gold08a/02-find.e2e.js` › 8a.19 |
| 8a.20 | §1.7 C2 | Seed a customer photographed exactly 730 days ago and one 731 days ago; one expired and also 800 days old | 730 days: valid. 731 days: re-verify. Expired and old: shows expired | `app/e2e/gold08a/02-find.e2e.js` › 8a.20 |
| 8a.21 | §5.2 | Make the search request fail (network error), then type again | A visible error says the search failed and to try again; the page does not crash; a later search works | `app/e2e/gold08a/02-find.e2e.js` › 8a.21 |

### New customer

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 8a.22 | §5.2 | Open `/gold/customers/new` (also from the "New customer" button on Find customer) | Form shows first name, middle name (optional), last name, date of birth, phone, residential street, suburb, state, postcode, ID type, ID number, issuing state or authority, ID country, "Does the ID have an expiry date?", front photo, back photo, and the sighted box. Title is "New customer" | `app/e2e/gold08a/03-new-customer.e2e.js` › 8a.22 |
| 8a.23 | §7, §4.3 | Press "Create customer" with nothing entered | Each missing required field has its own message that says what to do; no request is sent; focus moves to the first error | `app/e2e/gold08a/03-new-customer.e2e.js` › 8a.23 |
| 8a.24 | §4.3 | Enter a future date of birth, then 1899-12-31, then a valid one. Enter phone `1234567` then `12345678`. Postcode `123` then `3000`. Country `A`, `AUS`, `au` | Future and pre-1900 dates of birth are refused. 7-digit phone refused, 8 accepted. 3-digit postcode refused. Country must be a 2-letter code (lower case is turned into `AU`) | `app/e2e/gold08a/03-new-customer.e2e.js` › 8a.24 |
| 8a.25 | §5.2 | Choose "Driver licence", then "Passport", then "Other" | Licence: the back photo is required. Passport: the back photo is optional. Other: a description of the document is required | `app/e2e/gold08a/03-new-customer.e2e.js` › 8a.25 |
| 8a.26 | §5.2 | Set "Does the ID have an expiry date?" to Yes, then No; enter an expiry date in the past | Yes shows an expiry date field that is required. No hides it. A past date is refused with "This ID has expired. Ask the customer for a current ID." | `app/e2e/gold08a/03-new-customer.e2e.js` › 8a.26 |
| 8a.27 | §1.7 C3 | Fill everything but leave the sighted box unticked | Refused with a message to confirm the ID was sighted; the box starts unticked | `app/e2e/gold08a/03-new-customer.e2e.js` › 8a.27 |
| 8a.28 | §5.2 | Fill all fields. For the front photo click "Take photo" (camera), for the back click "Upload" a 3000 x 2000 PNG. Tick sighted. Create | Lands on the new customer's page with "Customer created". Details match what was typed. In the database: one customer (source `gold`, individual), one customer-level `new_capture` ID row, two stored photos, and one customer_audit_log row for the creation (source `gold_create`, this staff member) | `app/e2e/gold08a/03-new-customer.e2e.js` › 8a.28 |
| 8a.29 | §4.5 | Inspect the two stored photo objects from 8a.28 | Both are JPEG. The uploaded 3000 x 2000 PNG is stored at 1600 x 1067. The camera frame is at most 1600 px on its long side | `app/e2e/gold08a/03-new-customer.e2e.js` › 8a.29 |
| 8a.30 | §5.2 | Create a customer with the same first name, last name and date of birth as a seeded one | A prompt "This may be an existing customer" lists the match with "Open this customer" and "It's a different person, continue". Nothing is saved until the staff member chooses. "Open" goes to that customer. "Continue" creates a second customer | `app/e2e/gold08a/03-new-customer.e2e.js` › 8a.30 |
| 8a.31 | §1.5 | Create a customer whose phone (8+ digits, any format such as `+61 4…`) equals a seeded customer's, with a different name | The same prompt lists that customer (matched on phone). A phone shorter than 8 digits cannot match (it is refused before this) | `app/e2e/gold08a/03-new-customer.e2e.js` › 8a.31 |
| 8a.32 | §1.6 | Create a customer whose ID type and number are already on file for a seeded customer | A collision prompt names the owner and offers "Open that customer" or "It's a different person". Choosing "different person" saves with reason `different_person`; choosing "open" goes to that customer. The same number with a different type does not trigger it | `app/e2e/gold08a/03-new-customer.e2e.js` › 8a.32 |
| 8a.33 | §4.3 | Make the server refuse the save with `validation_failed` (a field the client check let through) and with `create_failed` | The server's field messages show on those fields; a generic failure shows "Could not save. Try again." The form keeps everything typed. No customer or photo is left behind | `app/e2e/gold08a/03-new-customer.e2e.js` › 8a.33 |
| 8a.34 | §5.2 | Click "Create customer" twice quickly; click Cancel on a filled form | One customer only (the button is disabled while saving). Cancel returns to `/gold` and saves nothing | `app/e2e/gold08a/03-new-customer.e2e.js` › 8a.34 |
| 8a.35 | §5.2 | On the dev server click "Fill with test data" on New customer; check a production build | Dev: every required field and both photos fill and the form saves. The button and its code are absent from `npm run build` output | `app/e2e/gold08a/03-new-customer.e2e.js` › 8a.35 (dev) and `app/e2e/gold08a/09-build.e2e.js` › 8a.35 (production build) |

### Photos and camera

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 8a.36 | §4.5 | Upload a PNG, a WebP and a JPEG each larger than 1600 px | Every file is handed on as `image/jpeg`, at most 1600 px on the long side, aspect ratio kept. A file already smaller than 1600 px is not enlarged | `app/e2e/gold08a/04-photos.e2e.js` › 8a.36 |
| 8a.37 | §4.5 | Upload a file the browser cannot decode (e.g. a HEIC or a text file renamed `.heic`) | The photo is not accepted; a message says the photo could not be read and to take it again or choose a JPEG; the form is not submitted | `app/e2e/gold08a/04-photos.e2e.js` › 8a.37 |
| 8a.38 | §5.4 | Block the camera permission, click "Take photo" | The dialog says the camera is unavailable and to use Upload; Upload still works; Escape and Cancel dismiss the dialog and give the focus back to the button | `app/e2e/gold08a/04-photos.e2e.js` › 8a.38 |
| 8a.60 | §4.5 | *(added by UAT)* The camera gives a frame of 4000 x 3000 (iPads and iPhones can). Click "Take photo" on ID front | The photo is handed on as `image/jpeg` of 1600 x 1200: long side at most 1600, aspect ratio kept | `app/e2e/gold08a/04-photos.e2e.js` › 8a.60 |

### Update ID

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 8a.39 | §5.2 | On a seeded customer's page click "Update ID" | `/gold/customers/<id>/update-id` shows the name, the ID on file with its badge, and a required choice of three reasons ("Renewed: same document, new expiry date", "The customer presented a different document", "The stored photo is unclear"). Saving without a choice is refused | `app/e2e/gold08a/05-update-id.e2e.js` › 8a.39 |
| 8a.40 | §1.6 | Choose Renewed, keep the same number, enter a new expiry, add a new front and back photo, save | Back on the customer page: the new expiry shows, "ID last updated" is today, badge valid. In the database: a new `new_capture` row (`id_changed`) linked to the old one; the old photo objects are deleted and their rows stamped superseded; the customer's current ID is the new capture | `app/e2e/gold08a/05-update-id.e2e.js` › 8a.40 |
| 8a.41 | §1.6 | Choose Photo unclear with the same type and number, new photos, save. Then choose Photo unclear with a number the customer does not have | The first saves as `stored_copy_unclear`, linked, old photos superseded. The second shows that the document is not on file for this customer and to choose "Different document" | `app/e2e/gold08a/05-update-id.e2e.js` › 8a.41 |
| 8a.42 | §1.6 | Choose Different document, enter a new type and number, save | Saves unlinked (`different_document`). The old photos are kept. The new document is now the current ID | `app/e2e/gold08a/05-update-id.e2e.js` › 8a.42 |
| 8a.43 | §1.6 | Choose Different document and enter a number already on file for another customer | Refused with a message naming the owner; nothing saved | `app/e2e/gold08a/05-update-id.e2e.js` › 8a.43 |
| 8a.44 | §1.7 C2 | Open the page of a customer whose ID expired yesterday; then one captured 800 days ago | Expired: a red banner "ID expired on …" with "Update ID now". Old capture: an amber notice that the ID was photographed more than 730 days ago, with "Update ID now". Both buttons open Update ID. After a successful update the banner is gone and the badge is valid | `app/e2e/gold08a/05-update-id.e2e.js` › 8a.44 |
| 8a.45 | §5.2 | Open a customer with no ID on file, click "Add ID" | The Update ID form has no reason choice; saving records the first ID (`different_document`). The page then shows the ID | `app/e2e/gold08a/05-update-id.e2e.js` › 8a.45 |
| 8a.46 | §4.3 | On Update ID: leave the front photo out; use a Driver licence without a back photo; leave the number blank | Each is refused with a message that says what to do. No request is sent | `app/e2e/gold08a/05-update-id.e2e.js` › 8a.46 |

### Edit details

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 8a.47 | §2.3, §5.2 | As a manager (then an admin), click "Edit details" on a customer page | `/gold/customers/<id>/edit` opens prefilled with first, middle, last name, date of birth, gender, phone, email, occupation, residential address, citizenship and tax residency country. There are no ID fields | `app/e2e/gold08a/06-edit.e2e.js` › 8a.47 |
| 8a.48 | §5.2, §4.5 | Change the last name, date of birth and street, save | Customer page shows the new values. One `customer_audit_log` row (source `gold_edit`, this manager) holds old to new for exactly the changed columns. Past TTR party copies are unchanged | `app/e2e/gold08a/06-edit.e2e.js` › 8a.48 |
| 8a.49 | §4.3 | Save with nothing changed; blank the first name; enter a 7-digit phone | "Change at least one field." (no request); first name is required; the phone needs 8 digits. Nothing is saved | `app/e2e/gold08a/06-edit.e2e.js` › 8a.49 |
| 8a.50 | §2.3 | As `staff`: look at a customer page; open `/gold/customers/<id>/edit` directly; send a `gold-update-customer` call with the staff token | No "Edit details" button. The edit URL shows "You are not authorised to view this page." and loads no customer data. The function answers 403 and changes nothing | `app/e2e/gold08a/06-edit.e2e.js` › 8a.50 |

### Customer page

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 8a.51 | §5.2 | Open a seeded customer | Shows full name, date of birth, phone, residential address, ID type, number, issuer, expiry, "Customer since", "ID last updated" (the current capture's date, not the customer's), and who captured it. Dates are en-AU | `app/e2e/gold08a/07-customer-page.e2e.js` › 8a.51 |
| 8a.52 | §6.1, §5.2 | Look at the front and back ID thumbnails; click one; press Escape | The photos load through `get-id-image-urls` (one `access_log` view row per image shown). Click opens a larger view; Escape closes it and returns the focus to the thumbnail. A missing back photo shows "Not on file" | `app/e2e/gold08a/07-customer-page.e2e.js` › 8a.52 |
| 8a.53 | §4.6 | Click "Change" by the phone, enter a valid new number, press Enter | The phone updates in place with "Phone number updated"; `customer_audit_log` has one row (source `phone_change`); the focus returns to "Change". Saving the same number writes nothing | `app/e2e/gold08a/07-customer-page.e2e.js` › 8a.53 (x2: the save, and the focus return) |
| 8a.54 | §4.6 | In the phone editor enter 7 digits, then press Escape | "Phone number looks too short." shows and nothing is saved; Escape closes the editor with the old number | `app/e2e/gold08a/07-customer-page.e2e.js` › 8a.54 |
| 8a.55 | §6.1 | Open `/gold/customers/<id>` for another business's customer, and for an unknown id | "Customer not found." with a link back to Find customer. The same on the update-id and edit pages. No details of the other business are shown | `app/e2e/gold08a/07-customer-page.e2e.js` › 8a.55 |
| 8a.56 | §5.2 | Look at the right-hand side of the customer page of a customer with no ID on file (Phase 8b replaced the placeholder with the purchase form) | The heading "Record purchase" and "Add the customer’s ID before recording a purchase." with no form; nothing can be recorded. "Back to search" returns to `/gold` | `app/e2e/gold08a/07-customer-page.e2e.js` › 8a.56 |

### Privacy and context

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 8a.57 | §2.2 | Use search, create, update ID and the customer page, then inspect `localStorage` and `sessionStorage` | No name, phone, date of birth, ID number or photo is stored in either. Reloading the customer page loads it again from the server | `app/e2e/gold08a/08-privacy.e2e.js` › 8a.57 |
| 8a.58 | §2.2, §2.3 | Sign out; sign in as a different staff member and open `/gold` | Search is empty; no earlier customer, search text or form value is shown. After the idle limit the session ends and the same holds | `app/e2e/gold08a/08-privacy.e2e.js` › 8a.58 |
| 8a.59 | §5.3 | Vitest: `GoldDraftContext` | `useGoldDraft()` throws outside its provider; a draft set for a customer is returned for that customer only; `clearDraft` and `reset()` return the state to `INITIAL_STATE`; unmounting the layout drops the drafts | `app/src/pages/gold/shared/GoldDraftContext.test.jsx` (the implementer's tests, read and broken once by UAT) |

---

## Section B · Manual test for the user (10 minutes or less)

Only what local tests cannot see: which hosted project the preview uses, a real iPad or iPhone camera, and the hosted secrets. Everything else is in Section A.

**Before you start**
- Account: the one **dev admin** account on the dev project `rygjssczdoyvmumxmymc`. Use it for every step.
- Customer: the dummy customer **Lena Hostedsix**, id `174fb856-4049-4c1a-a4c7-5440940ff088`, already on dev with a licence. No new customers are created.
- Phase 8a adds no migration and no edge function. Dev needs the Phase 5 to 7 pieces already deployed (`search_customers`, `customer_current_id`, `gold-create-customer`, `gold-update-customer-id`, `gold-update-customer`, `get-id-image-urls`) and the secret `GOLD_JOURNEY_ENABLED` = `true`. If step 1 shows a missing function, deploy with the pinned CLI:
  ```
  cd app
  npx supabase db push --linked --workdir ..
  npx supabase functions deploy gold-create-customer gold-update-customer-id gold-update-customer get-id-image-urls --project-ref rygjssczdoyvmumxmymc --workdir ..
  ```

### 1. Which Supabase project does the PR #24 preview use? (2 minutes)
1. ☐ Open PR #24 on GitHub. In the checks list click **Vercel – Preview** > **Visit Preview**. Note the address (it ends in `.vercel.app`).
2. ☐ On the preview, sign in with the dev admin account and the 6-digit code.
3. ☐ The "What would you like to do?" page shows a card **Gold due diligence**. (No card means the preview was built without `VITE_GOLD_JOURNEY_ENABLED=true`: stop and tell the implementer.)
4. ☐ Press **F12** > **Network** tab. Click the card, then in **Search** type `Hostedsix`.
5. ☐ A request named `search_customers` appears. Click it. The **Request URL** starts with `https://rygjssczdoyvmumxmymc.supabase.co/rest/v1/rpc/search_customers`.
   - **Yes** (host is `rygjssczdoyvmumxmymc`): use the preview for everything below.
   - **No** (any other host, especially `ykerufaergyqvnaycyce`, the client project): **do not use this preview.** Do the fallback below, and do not set `GOLD_JOURNEY_ENABLED` on the client project.
6. ☐ One row is listed: **Lena Hostedsix**, with a date of birth, her ID type and number, her phone, and an ID badge.

**Fallback: run the app locally against dev (only if step 5 was "No")**
1. In `app/`, create or edit `app/.env.local` (it is not committed) so it holds exactly these three lines. The anon key is the dev project's: Supabase dashboard > project `rygjssczdoyvmumxmymc` > **Project Settings** > **API Keys** > `anon` / publishable key.
   ```
   VITE_SUPABASE_URL=https://rygjssczdoyvmumxmymc.supabase.co
   VITE_SUPABASE_ANON_KEY=<the dev anon key>
   VITE_GOLD_JOURNEY_ENABLED=true
   ```
2. Run `cd app` then `npm run dev`. Open `http://localhost:5173`. Camera access works on `localhost`, but a phone or iPad on your network needs HTTPS, so do the camera step (step 2) on a preview that does point at dev, or from the PC webcam.
3. Repeat steps 1.2 to 1.6 on `http://localhost:5173`.
4. When finished, set `app/.env.local` back to whatever it held before (check which project you meant it to point at).

### 2. Real camera on an iPad or iPhone (4 minutes)
Use Safari on the iPad or iPhone, on the HTTPS preview address from step 1 (not localhost). Sign in with the dev admin account.
1. ☐ Tap **Gold due diligence**, type `Hostedsix` in **Search**, tap the **Lena Hostedsix** row.
2. ☐ The page shows **ID type**, **ID number** and **Expiry**. Write the ID number down.
3. ☐ Tap **Update ID** (or **Update ID now** if a banner is shown).
4. ☐ Under **Why are you updating the ID?** tap **The stored photo is unclear**. The **ID number** box already holds the number you wrote down. Leave it.
5. ☐ Under **ID front** tap **Take photo**. Safari asks to use the camera: tap **Allow**. A live picture shows. Point it at any card or a sheet of paper and tap **Take photo** in the dialog. The dialog closes and **ID front preview** shows the picture, readable.
6. ☐ Under **ID back** tap **Upload**, choose **Photo Library**, and pick a photo that was taken with this device's camera (iPhones and iPads save these as HEIC by default). No red message appears and **ID back preview** shows the picture.
7. ☐ Tick **I have sighted the original ID in person** and tap **Save new ID**. You land on Lena's page and a green **ID updated** message shows. Under **ID front** and **ID back** both thumbnails show. Tap **ID front**: a larger picture opens. Tap **Close**.
8. ☐ Check what was stored: Supabase dashboard (dev) > **Storage** > bucket `compliance-media` > folder `customers/174fb856-4049-4c1a-a4c7-5440940ff088/`. The two newest files both end in `.jpg`. Open one: it is **image/jpeg**. Download both and open **Properties > Details**: width and height are each **1600 pixels or less** (the longer side is 1600 or less), and the file is well under 1 MB.

### 3. Hosted secret and one call as the dev admin (2 minutes, Postman)
Get the token: on the preview, **F12** > **Application** > **Local Storage** > the entry `sb-rygjssczdoyvmumxmymc-auth-token` > copy the value of `access_token` (the long text starting `eyJ`).

Create one Postman request:
- Method **POST**, URL `https://rygjssczdoyvmumxmymc.supabase.co/functions/v1/gold-update-customer`
- **Headers** tab: `apikey` = the dev anon key (same one as the fallback). Do not add a `Content-Type` yourself; the **Body** setting below adds it.
- **Authorization** tab: Type **Bearer Token**, Token = the `access_token` you copied.
- **Body** tab: **raw**, type **JSON**:
  ```
  {"customerId":"174fb856-4049-4c1a-a4c7-5440940ff088","changes":{"occupation":"UAT 8a occupation"}}
  ```
1. ☐ Press **Send**. The status is **200**. (A **403** with `"error":"gold_disabled"` means the dev secret `GOLD_JOURNEY_ENABLED` is not `true`: set it in Supabase dashboard > Edge Functions > Secrets.)
2. ☐ In the preview open Lena's page, tap **Edit details**. **Occupation (optional)** shows `UAT 8a occupation`. (Admins see the **Edit details** button.) Tap **Cancel**.
3. ☐ Press **Send** again with the same body. The status is **200** and nothing changes (the same value writes no new audit row).
4. ☐ If you get `PGRST…` or "Empty or invalid json" the URL went to `/rest/v1`; use `/functions/v1/gold-update-customer`.

### 4. The client project stays closed (1 minute)
1. ☐ Open the production site (the client's live address, built from `main`) and sign in. The "What would you like to do?" page has **no** Gold due diligence card, and typing `/gold` after the address returns you to this page.
2. ☐ Supabase dashboard > project `ykerufaergyqvnaycyce` > **Edge Functions** > **Secrets**: there is no secret named `GOLD_JOURNEY_ENABLED`. (Do not add one.)

### 5. Counter feel (1 minute)
☐ On the preview at the PC's normal browser size, and then with the window dragged narrow (about the width of a phone): Find customer, then the **Lena Hostedsix** page. Nothing needs sideways scrolling, and the ID badge colour matches its meaning (green valid, amber expiring or re-verify, red expired, grey none).

---

## What a failure looks like
- `Customer not found.` on a customer you know exists: you are signed in to a different business, or the preview points at the wrong project (step 1).
- Search never answers and a red message says the search failed: the preview cannot reach `rest/v1/rpc/search_customers`, usually the wrong project or the anon key.
- Postman `unauthorized`: the token expired (they last an hour or less) or was not sent. Copy a fresh `access_token`.
- Postman `invalid_request`: the JSON body is malformed (a missing quote or comma).
- Postman `PGRST…` or "Empty or invalid json": the request went to `/rest/v1`, not `/functions/v1`.
- Postman `403 gold_disabled`: the dev secret `GOLD_JOURNEY_ENABLED` is not `true`.
- Postman `403 forbidden`: the token belongs to a `staff` account, not the admin.
- A HEIC photo is refused with "That photo could not be read": the browser could not convert it. Note the device and iOS version and report it.
- CI `uat` red in **part0** on R11, R18, R24 or R27 and stuck on `/id-verification`: known issue #20 (a double load). Re-run the failed job once before investigating.

☐ Section A green on commit ______ · ☐ Section B · Notes: ______________________________

---

**Progress note (UAT automation).** Batch 1 done: all 60 Playwright tests and the Vitest rows written and green except D1. Batch 2 done: break-and-revert for every row (client, shared rules, database functions and edge functions). Breaks left: none. D1 re-verified after aa01de9: the focus effect was disabled, the focus test failed (`Received: inactive`), reverted, then all 60 `gold08a` tests, Vitest (649), lint and `format:check` passed.
