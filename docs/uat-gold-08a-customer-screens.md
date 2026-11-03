# UAT: Gold customer screens (Gold Phase 8a)

**Purpose:** prove that `gold/08a-customer-screens` gives staff the customer half of the gold journey in the browser, and that every rule the spec puts on those screens holds:
1. `/gold` replaces the placeholder: find a customer, create one, update their ID, correct their details (managers and admins), see their details and change their phone
2. The screens call the Phase 5 to 7 server pieces (`search_customers`, `gold-create-customer`, `gold-update-customer-id`, `gold-update-customer`, `update_customer_phone`, `customer_current_id`, the duplicate and ID-collision lookups) and show what the server answers, including every refusal
3. ID status (valid, expiring, expired, re-verify, none) is worked out with the shared `goldRules.js` and the business's `idv_max_reliance_days`
4. Photos always leave the browser as a JPEG of 1600 px or less on the long side, from the camera and from Upload
5. The purchase form, joint seller, To complete, Complete purchase, Purchases and Purchase record are **not** here (Phase 8b)

| | |
|---|---|
| Environment | ________ |
| Build/commit | ________ |
| Run by / date | ________ |

**Where the rules come from.** Spec §1.5, §1.6, §1.7 (C2), §2.2, §2.3, §4.6, §5.2 (Search, CustomerForm create / update / edit, CustomerDetail view), §5.3, §5.4 of `docs/gold-due-diligence-spec.md`. The "Spec" column names the clause each row proves.

**Set-up for every row.** The build variable `VITE_GOLD_JOURNEY_ENABLED=true`, and the local functions have `GOLD_JOURNEY_ENABLED=true` (`supabase/config.toml` `[edge_runtime.secrets]`). Staff sign in with password then TOTP (`aal2`). Unless a row says otherwise the user is an active `staff` member of business One, which has `idv_max_reliance_days = 730`. Business Two exists with its own staff and customers. "Seeded customer" means a row inserted through SQL with a customer-level `new_capture` ID.

---

## Rows

### Access and shell

| # | Spec | Action | Expected |
|---|---|---|---|
| 8a.1 | §2.2 | Build with the flag off (`VITE_GOLD_JOURNEY_ENABLED` unset), signed in. Visit `/gold`, `/gold/customers/new`, `/gold/customers/<id>` | Each redirects to `/` (journey picker). No gold screen renders |
| 8a.2 | §2.2 | Signed out, visit `/gold` and `/gold/customers/new` | Redirected to `/login?redirect=…` with the path kept; after sign-in and MFA the staff member lands on the page they asked for |
| 8a.3 | §2.2 | Password-only session (`aal1`) visits `/gold` | Session is ended; staff are sent to login. No gold data is requested |
| 8a.4 | §2.2 | Signed in at `aal2`, flag on. Open the picker, click the "Gold due diligence" card | `/gold` opens "Find customer". The gold header shows the staff name, "Switch journey" and "Sign out" |
| 8a.5 | §2.2 | In the gold header click "Switch journey", then return to Gold and click "Sign out" | "Switch journey" goes to `/`. "Sign out" ends the session and shows the login page. The back button does not show a gold screen |
| 8a.6 | §2.2 | Visit `/gold/nonsense` | Redirected to `/gold` |
| 8a.7 | §5.4 | Tab through each screen at 1280 px wide and at 390 px wide (search, new customer, update ID, edit, customer page) | No horizontal scroll at either width. Every control has a visible label and a visible focus ring. Errors are announced (`role="alert"`), status messages are `role="status"` |

### Find customer

| # | Spec | Action | Expected |
|---|---|---|---|
| 8a.8 | §1.5, §5.2 | Open `/gold`. Type 1 character, then 2 | The search box has focus on load. With 1 character nothing is requested and no result list shows. With 2 characters a search runs |
| 8a.9 | §1.5 | Type "jane citizen" quickly, one character at a time | Exactly one `search_customers` request is sent, about 250 ms after the last keystroke, for the full text. The URL never contains the search text |
| 8a.10 | §1.5 | Search by part of the name in any case ("CITIZ", "jane c"), by a middle name, and by an alias | The customer is found each time. A term that matches no name part finds nobody |
| 8a.11 | §1.5 | Search a customer's phone as `0412 345 678`, `+61412345678`, `61412345678`, and `4123`; then search `041` | The first three find the customer. `4123` (4 digits) finds them as a phone part. `041` (3 digits) does not match by phone |
| 8a.12 | §1.5 | Search an ID number as typed, in lower case, with spaces, and with dashes ("ab-12 3456") | The customer is found whichever form is typed |
| 8a.13 | §1.5, §5.2 | Look at a result row | Shows full name, date of birth (en-AU, e.g. 02 Nov 1985), ID type and number, phone, and the ID status badge |
| 8a.14 | §1.5 | Seed customers so that one has exactly the searched phone, and others share the last name. Search the phone digits | The exact phone (or exact ID number) match is listed first; the rest follow by last name, then first name |
| 8a.15 | §1.5 | Seed 25 customers matching one term | At most 20 are listed |
| 8a.16 | §1.5, §6.1 | Search for a name that exists only in business Two, and for a company customer in business One | Neither appears. "No customer matches …" shows |
| 8a.17 | §5.2 | Search something that matches nobody | "No customer matches “…”. Check the spelling or create a new customer." shows with a "New customer" button that opens `/gold/customers/new` |
| 8a.18 | §5.2 | Search for one customer and press Enter; search a term with several results and press Enter; click a result | Enter opens the customer when there is exactly one result and does nothing when there are several. Clicking a result opens `/gold/customers/<id>` |
| 8a.19 | §1.7 C2, §5.2 | Seed customers whose current ID is: valid for 90 days; expires in 12 days; expired yesterday; captured 800 days ago; with no ID on file | Badges read: "ID valid to …" (valid), "ID expires in 12 days" (attention), "ID expired …" (blocking), "Re-verify ID" (attention), "No ID on file" (neutral). Colour differs by meaning |
| 8a.20 | §1.7 C2 | Seed a customer photographed exactly 730 days ago and one 731 days ago; one expired and also 800 days old | 730 days: valid. 731 days: re-verify. Expired and old: shows expired |
| 8a.21 | §5.2 | Make the search request fail (network error), then type again | A visible error says the search failed and to try again; the page does not crash; a later search works |

### New customer

| # | Spec | Action | Expected |
|---|---|---|---|
| 8a.22 | §5.2 | Open `/gold/customers/new` (also from the "New customer" button on Find customer) | Form shows first name, middle name (optional), last name, date of birth, phone, residential street, suburb, state, postcode, ID type, ID number, issuing state or authority, ID country, "Does the ID have an expiry date?", front photo, back photo, and the sighted box. Title is "New customer" |
| 8a.23 | §7, §4.3 | Press "Create customer" with nothing entered | Each missing required field has its own message that says what to do; no request is sent; focus moves to the first error |
| 8a.24 | §4.3 | Enter a future date of birth, then 1899-12-31, then a valid one. Enter phone `1234567` then `12345678`. Postcode `123` then `3000`. Country `A`, `AUS`, `au` | Future and pre-1900 dates of birth are refused. 7-digit phone refused, 8 accepted. 3-digit postcode refused. Country must be a 2-letter code (lower case is turned into `AU`) |
| 8a.25 | §5.2 | Choose "Driver licence", then "Passport", then "Other" | Licence: the back photo is required. Passport: the back photo is optional. Other: a description of the document is required |
| 8a.26 | §5.2 | Set "Does the ID have an expiry date?" to Yes, then No; enter an expiry date in the past | Yes shows an expiry date field that is required. No hides it. A past date is refused with "This ID has expired. Ask the customer for a current ID." |
| 8a.27 | §1.7 C3 | Fill everything but leave the sighted box unticked | Refused with a message to confirm the ID was sighted; the box starts unticked |
| 8a.28 | §5.2 | Fill all fields. For the front photo click "Take photo" (camera), for the back click "Upload" a 3000 x 2000 PNG. Tick sighted. Create | Lands on the new customer's page with "Customer created". Details match what was typed. In the database: one customer (source `gold`, individual), one customer-level `new_capture` ID row, two stored photos, and no customer_audit_log row (creating writes no audit row) |
| 8a.29 | §4.5 | Inspect the two stored photo objects from 8a.28 | Both are JPEG. The uploaded 3000 x 2000 PNG is stored at 1600 x 1067. The camera frame is at most 1600 px on its long side |
| 8a.30 | §5.2 | Create a customer with the same first name, last name and date of birth as a seeded one | A prompt "This may be an existing customer" lists the match with "Open this customer" and "It's a different person, continue". Nothing is saved until the staff member chooses. "Open" goes to that customer. "Continue" creates a second customer |
| 8a.31 | §1.5 | Create a customer whose phone (8+ digits, any format such as `+61 4…`) equals a seeded customer's, with a different name | The same prompt lists that customer (matched on phone). A phone shorter than 8 digits cannot match (it is refused before this) |
| 8a.32 | §1.6 | Create a customer whose ID type and number are already on file for a seeded customer | A collision prompt names the owner and offers "Open that customer" or "It's a different person". Choosing "different person" saves with reason `different_person`; choosing "open" goes to that customer. The same number with a different type does not trigger it |
| 8a.33 | §4.3 | Make the server refuse the save with `validation_failed` (a field the client check let through) and with `create_failed` | The server's field messages show on those fields; a generic failure shows "Could not save. Try again." The form keeps everything typed. No customer or photo is left behind |
| 8a.34 | §5.2 | Click "Create customer" twice quickly; click Cancel on a filled form | One customer only (the button is disabled while saving). Cancel returns to `/gold` and saves nothing |
| 8a.35 | §5.2 | On the dev server click "Fill with test data" on New customer; check a production build | Dev: every required field and both photos fill and the form saves. The button and its code are absent from `npm run build` output |

### Photos and camera

| # | Spec | Action | Expected |
|---|---|---|---|
| 8a.36 | §4.5 | Upload a PNG, a WebP and a JPEG each larger than 1600 px | Every file is handed on as `image/jpeg`, at most 1600 px on the long side, aspect ratio kept. A file already smaller than 1600 px is not enlarged |
| 8a.37 | §4.5 | Upload a file the browser cannot decode (e.g. a HEIC or a text file renamed `.heic`) | The photo is not accepted; a message says the photo could not be read and to take it again or choose a JPEG; the form is not submitted |
| 8a.38 | §5.4 | Block the camera permission, click "Take photo" | The dialog says the camera is unavailable and to use Upload; Upload still works; Escape and Close dismiss the dialog and give the focus back to the button |

### Update ID

| # | Spec | Action | Expected |
|---|---|---|---|
| 8a.39 | §5.2 | On a seeded customer's page click "Update ID" | `/gold/customers/<id>/update-id` shows the name, the ID on file with its badge, and a required choice: "Renewed", "Different document", "Photo unclear". Saving without a choice is refused |
| 8a.40 | §1.6 | Choose Renewed, keep the same number, enter a new expiry, add a new front and back photo, save | Back on the customer page: the new expiry shows, "ID last updated" is today, badge valid. In the database: a new `new_capture` row (`id_changed`) linked to the old one; the old photo objects are deleted and their rows stamped superseded; the customer's current ID is the new capture |
| 8a.41 | §1.6 | Choose Photo unclear with the same type and number, new photos, save. Then choose Photo unclear with a number the customer does not have | The first saves as `stored_copy_unclear`, linked, old photos superseded. The second shows that the document is not on file for this customer and to choose "Different document" |
| 8a.42 | §1.6 | Choose Different document, enter a new type and number, save | Saves unlinked (`different_document`). The old photos are kept. The new document is now the current ID |
| 8a.43 | §1.6 | Choose Different document and enter a number already on file for another customer | Refused with a message naming the owner; nothing saved |
| 8a.44 | §1.7 C2 | Open the page of a customer whose ID expired yesterday; then one captured 800 days ago | Expired: a red banner "ID expired on …" with "Update ID now". Old capture: an amber notice that the ID was photographed more than 730 days ago, with "Update ID now". Both buttons open Update ID. After a successful update the banner is gone and the badge is valid |
| 8a.45 | §5.2 | Open a customer with no ID on file, click "Add ID" | The Update ID form has no reason choice; saving records the first ID (`different_document`). The page then shows the ID |
| 8a.46 | §4.3 | On Update ID: leave the front photo out; use a Driver licence without a back photo; leave the number blank | Each is refused with a message that says what to do. No request is sent |

### Edit details

| # | Spec | Action | Expected |
|---|---|---|---|
| 8a.47 | §2.3, §5.2 | As a manager (then an admin), click "Edit details" on a customer page | `/gold/customers/<id>/edit` opens prefilled with first, middle, last name, date of birth, gender, phone, email, occupation, residential address, citizenship and tax residency country. There are no ID fields |
| 8a.48 | §5.2, §4.5 | Change the last name, date of birth and street, save | Customer page shows the new values. One `customer_audit_log` row (source `gold_edit`, this manager) holds old to new for exactly the changed columns. Past TTR party copies are unchanged |
| 8a.49 | §4.3 | Save with nothing changed; blank the first name; enter a 7-digit phone | "Change at least one field." (no request); first name is required; the phone needs 8 digits. Nothing is saved |
| 8a.50 | §2.3 | As `staff`: look at a customer page; open `/gold/customers/<id>/edit` directly; send a `gold-update-customer` call with the staff token | No "Edit details" button. The edit URL shows "You are not authorised to view this page." and loads no customer data. The function answers 403 and changes nothing |

### Customer page

| # | Spec | Action | Expected |
|---|---|---|---|
| 8a.51 | §5.2 | Open a seeded customer | Shows full name, date of birth, phone, residential address, ID type, number, issuer, expiry, "Customer since", "ID last updated" (the current capture's date, not the customer's), and who captured it. Dates are en-AU |
| 8a.52 | §6.1, §5.2 | Look at the front and back ID thumbnails; click one; press Escape | The photos load through `get-id-image-urls` (one `access_log` view row per image shown). Click opens a larger view; Escape closes it and returns the focus to the thumbnail. A missing back photo shows "Not on file" |
| 8a.53 | §4.6 | Click "Change" by the phone, enter a valid new number, press Enter | The phone updates in place with "Phone number updated"; `customer_audit_log` has one row (source `phone_change`); the focus returns to "Change". Saving the same number writes nothing |
| 8a.54 | §4.6 | In the phone editor enter 7 digits, then press Escape | "Phone number looks too short." shows and nothing is saved; Escape closes the editor with the old number |
| 8a.55 | §6.1 | Open `/gold/customers/<id>` for another business's customer, and for an unknown id | "Customer not found." with a link back to Find customer. The same on the update-id and edit pages. No details of the other business are shown |
| 8a.56 | §5.2 | Look at the right-hand side of the customer page | A clearly marked placeholder where the purchase form goes (Phase 8b). Nothing can be recorded. "Back to search" returns to `/gold` |

### Privacy and context

| # | Spec | Action | Expected |
|---|---|---|---|
| 8a.57 | §2.2 | Use search, create, update ID and the customer page, then inspect `localStorage` and `sessionStorage` | No name, phone, date of birth, ID number or photo is stored in either. Reloading the customer page loads it again from the server |
| 8a.58 | §2.2, §2.3 | Sign out; sign in as a different staff member and open `/gold` | Search is empty; no earlier customer, search text or form value is shown. After the idle limit the session ends and the same holds |
| 8a.59 | §5.3 | Vitest: `GoldDraftContext` | `useGoldDraft()` throws outside its provider; a draft set for a customer is returned for that customer only; `clearDraft` and `reset()` return the state to `INITIAL_STATE`; unmounting the layout drops the drafts |

---

## Rough manual steps (kept for the user's final pass)

1. **Real camera.** On an iPad or iPhone (Safari) and on a counter PC webcam: New customer, "Take photo" for the front and back of a real or sample ID. The preview is readable, the saved photos open from the customer page, and a photo chosen from the iPad's library (which may be HEIC) is accepted and shows on the customer page.
2. **Which Supabase project the Vercel preview points at.** Open the preview's network tab on a customer search. The request host must be dev `rygjssczdoyvmumxmymc`. If it is not, do not use that preview: run the app locally pointed at dev (`app/.env.local`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_GOLD_JOURNEY_ENABLED=true`) and do the steps there.
3. **Client project stays closed.** On `ykerufaergyqvnaycyce` the `GOLD_JOURNEY_ENABLED` secret is not set, and a production build does not show the Gold card.
4. **Counter feel at 1280 px and 390 px.** Find a customer by name, by phone, by ID number; create one; update an ID; read the badge colours.
