# UAT: Exports and printing (Gold Phase 9b)

**Purpose:** prove that `gold/09b-exports` lets only managers and admins download purchases (a zip with a CSV and photos) and print a record with ID photos, that every download or print is written to `gold.export_audit_log` before any photo URL is signed, and that a plain print never shows ID photos:
1. On Purchases, a manager or admin sees **Download (n)**; staff do not. It builds a zip in the browser from what `gold-export` returns (CSV rows plus 5-minute signed photo URLs), for at most 200 purchases
2. On a Purchase record, a manager or admin sees **Download record**; staff do not. It asks `gold-export` first, then opens the print dialog with the ID photos shown for that one print
3. A plain Ctrl+P prints the purchase details and goods photos only
4. `gold-export` re-checks the role, the business and the request on the server, whatever the browser sends

| | |
|---|---|
| Environment | Local Supabase stack (`supabase start` from the worktree under test), Vite on 5199, flag on |
| Build/commit | see the sign-off line |
| Run by / date | independent UAT agent (uat-automation), 2026-11-07 |

**Where the rules come from.** Spec §6.2 (Exports and printing), §2.3 ("Downloads and prints"), §4.2 (`gold.export_audit_log`), §4.6 (`recordDownload` → `gold-export`), §5.2 (Purchases and PurchaseRecord rows), §1.7 C1, §6.1, §6.4 and §9 of `docs/gold-due-diligence-spec.md`. The "Spec" column names the clause each row proves.

**`GOLD_JOURNEY_ENABLED`.** Locally it comes from `supabase/config.toml` `[edge_runtime.secrets]`; on dev it is set with `secrets set`; it stays off on the client project `ykerufaergyqvnaycyce`.

**Names used in the rows.**
- **Business One** and **Business Two**: two separate businesses, each with its own staff and purchases.
- **Staff Sam** (role `staff`), **Manager Mel** (role `manager`), **Admin Ada** (role `admin`), all in business One, all with an aal2 session. **Inactive Ian**: a manager in business One whose account is inactive. **Manager Two**: a manager in business Two.
- **Jane Citizen**: driver licence on file with front and back photos. **Joan Smith**: a second person, the joint seller (licence with front and back photos). **Pat**: a third person with a licence on file but no ID photos.
- **P1**: scrap purchase by Jane, invoice `INV-1`, cash $12,000 (reportable), 2 goods photos, linked to a complete TTR with reference `INV-1`.
- **P2**: bullion purchase by Jane and Joan (joint), invoice `INV-2`, 1 goods photo, linked to a draft TTR.
- **P3**: scrap purchase by Pat, no invoice number, no goods photos, no ID photos, no TTR.
- **P-other**: a purchase of business Two.
- **Request** means `POST /functions/v1/gold-export` with `Authorization: Bearer <token>`. `zip` is `{ "kind": "zip", "filters": {...}, "purchaseIds": [...] }`; `record` is `{ "kind": "record", "filters": null, "purchaseIds": [id] }`.

---

## Section A · Automated rows

```
cd app
npx supabase db reset --workdir .. && npm run uat:gold09b      # Playwright, project gold09b (one test per row part, named after the row ID)
cd ../supabase/functions && deno task test                      # Deno: _shared/gold09bUat.test.ts (rows 9b.1, 9b.3, 9b.13, 9b.42)
```
`npm run uat` includes `uat:gold09b` after `uat:gold09a`. The gold edge functions need `GOLD_JOURNEY_ENABLED=true` (set for the local stack and CI in `supabase/config.toml` `[edge_runtime.secrets]`); the browser build needs `VITE_GOLD_JOURNEY_ENABLED=true` (set by `playwright.config.js`). The local edge runtime serves the functions of the worktree where `supabase start` was run: run `npx supabase stop --workdir .. && npx supabase start --workdir ..` from this worktree's `app/` first.

☐ CI green on this commit

**How the tests work.**
- Business One's staff, manager and admin and business Two's staff come from the 8a fixtures; this phase adds Manager Two (`m2`) and Inactive Ian (`i1`) in `app/e2e/gold09b/support.js`. Each file signs in once (password then TOTP) and keeps the tab, as in 8b.
- P1, P2 and P3 are saved through the real `gold-save-purchase` and `gold-start-ttr`; P1's TTR is completed by a database update. The server requires a goods photo, so P3 is saved with one and its `gold.goods_photos` row is then deleted in SQL (triggers off for that delete only). **P3's seller is Pat, who has no ID photos** (the first wording said Jane, whose ID photos would then be in the export, so "no photos at all" could not hold). Pat has the same last name as Jane so a search on it finds P1, P2 and P3.
- The zip is the file Chrome downloads from the real page. The test unzips it (central directory, stored or deflated), reads `purchases.csv` with its BOM and parses it, and compares the photo files byte for byte with the images that were stored.
- Print styles are checked with `page.emulateMedia({ media: 'print' })`. `window.print` is replaced by a recorder (a headless browser opens no dialog), and the test sends the `afterprint` event the browser sends when the dialog closes.
- Signed URLs carry the host `kong:8000` locally; the tests rewrite it to the API URL before fetching.
- Rows that need a failure the stack cannot make (the audit insert failing, the feature flag off, the order of the audit insert and the signing) are Deno tests that drive the real handler with a stubbed network.

**Where a row differs from the sheet's first wording** (the expectation is unchanged):
- 9b.17: P3 has no photos at all because its seller (Pat) has no ID photos; see above.
- 9b.6, 9b.11, 9b.17, 9b.20, 9b.23, 9b.30: one test per part ((a), (b), (c) or one per bad request), so a break fails only the part it concerns.
- 9b.26: "Preparing… x/2" is seen by holding the `gold-export` answer for 2 seconds in the test.
- 9b.33: the manager's role is changed to `staff` in SQL after the page loaded and restored in `finally`.
- 9b.34: the first goods photo request is aborted in the browser.
- 9b.36: `gold-export` is answered by the test with a 403 and then a 500.
- 9b.41: the view rows are matched to the four stored images of Jane's and Joan's licences by id.
- 9b.14: the service role is exercised through PostgREST (`PATCH` and `DELETE` on `export_audit_log` with the local service-role key): `P0001` from the append-only trigger; a manager's `POST` is `42501`.

**Earlier-phase rows changed by this phase** (this branch only; the 8b branch is untouched): 8b.54 expected "no Download button for staff or an admin". Since 9b adds Download for managers and admins (spec §2.3, §5.2) it now expects staff to see none and a manager and an admin to see "Download (n)". 8b.58 is checked as staff and still holds. See `docs/uat-gold-08b-purchase-screens.md`.

| # | What is proved | Covered by |
|---|---|---|
| 9b.1 | With the flag not exactly `true` (unset, empty, `false`, `TRUE`, `1`, `true `, `yes`): 403 `gold_disabled`, nothing read, written or signed | `_shared/gold09bUat.test.ts` |
| 9b.2 | No Authorization header: 401 `unauthorized`; password-only (aal1) token: 403 `mfa_required`; no audit row | `01-access` |
| 9b.3 | Staff Sam: 403 `forbidden` for `zip` and `record`; no audit row; no URL in the answer; the real role check runs before anything is read, written or signed | `01-access`, `_shared/gold09bUat.test.ts` |
| 9b.4 | Inactive Ian: 403 `forbidden`; no audit row | `01-access` |
| 9b.5 | Mel and Ada both get 200 on a zip; each writes its own audit row | `01-access` |
| 9b.6 | Eight bad requests (kind `csv`, no kind, no `purchaseIds`, a string, `[]`, `["nope"]`, `filters` an array, an unreadable body): 400 `bad_request` with the field; no audit row | `01-access` (8 tests) |
| 9b.7 | Exactly 200 distinct ids: 200 and one audit row of 200 ids; 201: 400 `too_many_purchases`, no audit row, nothing signed; duplicates do not count | `06-cap` |
| 9b.8 | `record` with two ids: 400 `bad_request` (`purchaseIds`); with one: 200 `{ ok: true }` and one audit row | `01-access` |
| 9b.9 | `[P1, P-other]` and `[P1, random uuid]`: 404 `purchase_not_found`, identical answers, no audit row, nothing of business Two in the answer | `01-access` |
| 9b.10 | `[P1, P1, P2]`: 2 purchases, audit row holds 2 ids | `01-access` |
| 9b.11 | (a) The audit row's staff and business come from the verified caller, whatever the body claims; kind, ids and time. (b) `filters` holds exactly the seven known keys as sent | `02-audit-and-content` |
| 9b.12 | Ada's `record` for P1: one row, her id, kind `record`, `[P1]` | `02-audit-and-content` |
| 9b.13 | The audit insert fails: 500 `server_error`, no storage call, nothing returned | `_shared/gold09bUat.test.ts` |
| 9b.14 | Service role cannot update or delete an audit row (`P0001`); a manager's session cannot insert one (`42501`); the row is unchanged | `02-audit-and-content` |
| 9b.15 | Mel and Ada read business One's rows; Sam reads none; Manager Two reads none of business One's | `02-audit-and-content` |
| 9b.16 | One entry per purchase with every CSV field; joint fields empty for P1 and P3, filled for P2 | `02-audit-and-content` |
| 9b.17 | (a) Photo entries per purchase (P1 2 goods + Jane front/back; P2 1 goods + both sellers front/back; P3 none, still a row). (b) Every URL is signed and expires within 300 seconds | `02-audit-and-content` |
| 9b.18 | Signed goods and ID URLs return the stored bytes (200, `image/jpeg`); the same path without the token (and via `/public/`) is refused | `02-audit-and-content` |
| 9b.19 | `ttr_status` / `ttr_reference`: P1 complete + `INV-1`; P2 draft + its reference; P3 empty | `02-audit-and-content` |
| 9b.20 | C1: after a renewal (a) the export carries the newer copy's photos; (b) `id_photo_copy_taken` says "newer copy, taken {date}" and `id_document_used` still names the document used | `02-audit-and-content` |
| 9b.21 | C1: a passport is a separate capture: the earlier purchase keeps the licence photos, the later one gets the passport's; both say "original" | `02-audit-and-content` |
| 9b.22 | `zip` and `record` add no `ttr.access_log` rows | `02-audit-and-content` |
| 9b.23 | Sam sees no "Download (n)" and no "Download record"; Mel and Ada see both (six tests: three people on Purchases and on the record) | `03-purchases-download` |
| 9b.24 | "Download (n)" follows the count under the filters; disabled at 0 | `03-purchases-download` |
| 9b.25 | 201 matches: disabled with "Too many purchases to download (201). Narrow the filters to 200 or fewer."; 200: enabled | `06-cap` |
| 9b.26 | "Preparing… x/2", `purchases-<today>.zip`, one zip audit row with the filters (search text included) and exactly P1, P2, "Downloaded 2 purchases" | `03-purchases-download` |
| 9b.27 | The zip: `purchases.csv`, `READ ME.txt`, one folder per purchase with the right photo files (both sellers for P2), the bytes equal to the stored images | `03-purchases-download` |
| 9b.28 | C1 in the zip: the newer copy's images (the same as the record page shows), CSV says "newer copy" | `03-purchases-download` |
| 9b.29 | The 30 columns in order; one row per purchase; `folder` matches the zip folder | `03-purchases-download` |
| 9b.30 | (a) BOM `EF BB BF`; (b) CRLF line ends, every cell quoted; (c) inner quotes doubled, `José O"Brien, Zq…` reads back unchanged | `03-purchases-download` |
| 9b.31 | A cell starting `=`, `+`, `-`, `@`, tab or CR gets a leading `'`; other cells unchanged; (b) the same on the invoice column | `03-purchases-download` |
| 9b.32 | P1 and P3 CSV values; P3's folder `<date>_NO-INVOICE_<id>` holds no images | `03-purchases-download` |
| 9b.33 | Role changed to staff after the page loaded: "You do not have permission to do that.", no file, no audit row | `03-purchases-download` |
| 9b.34 | One photo URL blocked: the zip is still saved with the other photos and every CSV row | `03-purchases-download` |
| 9b.35 | "Download record": `gold-export` starts and finishes before `window.print`; one audit row (kind `record`, `[P2]`); twice writes two | `04-record-print` |
| 9b.36 | 403 / 500 from `gold-export`: no print, the page shows the error, the ID photos stay hidden for print | `04-record-print` |
| 9b.37 | Plain print of P2: details and goods photo shown, no ID photo of either seller | `04-record-print` |
| 9b.38 | After "Download record" the print shows all four ID photos with the details and goods photo | `04-record-print` |
| 9b.39 | After `afterprint`, a plain print hides the ID photos again | `04-record-print` |
| 9b.40 | The record looks the same on screen before and after "Download record" | `04-record-print` |
| 9b.41 | Opening a record writes a `ttr.access_log` view row for each of the four ID images | `04-record-print` |
| 9b.42 | *(added by UAT, §2.3 and §6.2)* The audit insert is made before the first storage (signing) call | `_shared/gold09bUat.test.ts` |
| 9b.43 | *(added by UAT, §6.1)* A manager of business Two cannot export or print business One's purchase (404, no audit row) but can export business Two's own | `01-access` |
| 9b.44 | *(added by UAT, §6.2)* "Download (200)" takes every matching purchase, across pages: 200 CSV rows, 200 folders, an audit row of the same 200 ids | `06-cap` |
| 9b.45 | *(added by UAT, §6.2 print styles)* The gold page header is not printed | `04-record-print` |
| 9b.46 | *(added by UAT, §6.2 print styles)* "Back to Purchases", "Complete", "Download record" and its hint are not printed | `04-record-print` |

---

## Section B · Manual test for the user (about 10 minutes)

Only what the local tests cannot see: deploying to dev, which project the preview uses, a real print preview, a real zip and Excel, and one audit row on the dashboard. Use the **one dev admin account** throughout. Dummy data: the customer **Lena Hostedsix**, `174fb856-4049-4c1a-a4c7-5440940ff088`, with a valid licence. Role refusals (staff, inactive, another business) are the automated rows above; do not test them here.

### 0. Before you start (1 minute)
1. ☐ Open PowerShell in the repo, `cd app`. Run `type ..\supabase\.temp\project-ref`. ☐ It prints exactly `rygjssczdoyvmumxmymc`. If it prints anything else (especially `ykerufaergyqvnaycyce`), stop and run `npx supabase link --project-ref rygjssczdoyvmumxmymc --workdir ..` first.
2. ☐ Dashboard (dev) > **Edge Functions** > **Secrets**: `GOLD_JOURNEY_ENABLED` is `true`. Never set it on the client project.

### 1. Deploy 9b to dev (2 minutes)
1. ☐ `npx supabase db push --linked --workdir ..` lists exactly one migration, `20261111000001_gold_export_id_photos.sql`; answer **Y**. It ends with "Finished supabase db push".
2. ☐ `npx supabase functions deploy gold-export --project-ref rygjssczdoyvmumxmymc --workdir ..` ends with "Deployed Functions on project rygjssczdoyvmumxmymc: gold-export".
3. ☐ Dashboard (dev) > **Edge Functions**: `gold-export` is listed, with **Verify JWT** on.

### 2. Which project the PR #29 preview uses (1 minute)
1. ☐ Open the Vercel preview link on PR #29 (the "Visit Preview" link in the Vercel comment). Press F12 > **Network**, sign in as the dev admin (email, password, then the 6-digit code).
2. ☐ Any request to `https://<something>.supabase.co` has the host `rygjssczdoyvmumxmymc.supabase.co`. If it is any other host, **do not use the preview**: stop it, and use the local app pointed at dev instead. In `app/.env.local` set `VITE_SUPABASE_URL=https://rygjssczdoyvmumxmymc.supabase.co`, `VITE_SUPABASE_ANON_KEY=<the dev anon key>` and `VITE_GOLD_JOURNEY_ENABLED=true`, then run `npm run dev` and open `http://localhost:5173`. Use that address for the rest of this section.
3. ☐ After signing in, tap **Gold due diligence**. The gold header shows "To complete", "Purchases", your name, "Switch journey" and "Sign out".

### 3. The Purchases page and the zip (3 minutes)
1. ☐ Click **Purchases**. Type `Hostedsix` in **Search**. A summary reads "n purchases" (n is 1 or more; if it reads "0 purchases", first do Section B step 3 of `docs/uat-gold-08b-purchase-screens.md` to record a sale for Lena, then come back). Top right, a button reads **Download (n)** with the same n.
2. ☐ Click **Download (n)**. The button reads "Preparing… 0/n" and counts up, then a line under the title reads "Downloaded n purchases". Chrome saves `purchases-<today>.zip` (today as yyyy-mm-dd).
3. ☐ In File Explorer right-click the zip > **Extract All** > **Extract**. The folder holds `purchases.csv`, `READ ME.txt`, and one folder per purchase named `<yyyy-mm-dd>_<invoice or NO-INVOICE>_<id>`. Open `READ ME.txt`: it says "n purchase(s)." and "This download contains identity documents. Store it securely and delete it when no longer needed."
4. ☐ Open a purchase folder. It holds `main-seller-id-front.jpg`, `main-seller-id-back.jpg` and `goods-1.jpg` (and more goods photos if there were more). Double-click each: they open as real pictures, and the ID is Lena's licence.
5. ☐ Double-click `purchases.csv` (it opens in Excel). The first cell reads `purchase_id` and the header row ends with `ttr_status`, `ttr_reference`, `id_document_used`, `id_photo_copy_taken`. The `main_seller_name` cell reads `Lena Hostedsix`. `id_document_used` reads like `main: Driver licence, captured 2026-..-..` and `id_photo_copy_taken` like `main: original, taken 2026-..-..`.
6. ☐ Accents and `=`: close Excel. In the app click **Customers**, search `Hostedsix`, open **Lena Hostedsix**, click **Edit details**, set **Middle name (optional)** to `Zoë`, click **Save changes**. Go back to **Purchases**, search `Hostedsix`, click **Download (n)**, extract and open the new `purchases.csv` in Excel. ☐ `main_seller_name` reads `Lena Zoë Hostedsix` with the ë intact (not `ZoÃ«`). Then repeat once more with **First name** `=1+1` instead (Edit details > First name `=1+1` > Save changes): ☐ the `main_seller_name` cell shows the text `'=1+1 Zoë Hostedsix` (Excel shows the leading `'` as text; it must not show `2` or a formula result). Finally set First name back to `Lena` and clear Middle name, **Save changes**.

### 4. Print preview of a record: Ctrl+P versus Download record (3 minutes)
1. ☐ **Purchases**, search `Hostedsix`, click Lena's newest purchase. The record shows two buttons, **Complete** only if it is incomplete, and **Download record**, with the line "Opens the print dialog with the ID photos. Choose “Save as PDF” to download." Copy the purchase id from the address bar (`/gold/purchases/<id>`). Dashboard (dev) > **Table Editor** > schema **gold** > table **export_audit_log**: note the number of rows shown at the bottom (call it X).
2. ☐ Press **Ctrl+P** (do not click Download record). The preview shows the purchase title, ERP invoice, details, AUSTRAC line and the **goods photos**; it shows **no** ID front or back pictures, no gold header, no "Back to Purchases", no "Download record" button and no hint line. Click **Cancel**.
3. ☐ Dashboard (dev) > **export_audit_log**: still X rows (plain Ctrl+P is not audited).
4. ☐ Click **Download record**. The print dialog opens at once. The preview now **shows the ID front and back pictures** as well as the details and goods photos. Choose **Save as PDF** > **Save**, open the PDF: the ID pictures are in it. (Or click **Cancel**.)
5. ☐ Press **Ctrl+P** again: the ID pictures are **hidden** again.
6. ☐ Dashboard (dev) > **export_audit_log** > refresh: it has X + 1 rows (the one from Download record).

### 5. One audit row on the dashboard (1 minute)
1. ☐ Dashboard (dev) > **Table Editor** > schema **gold** > **export_audit_log**, sort **exported_at** descending. The newest row has: **kind** `record`, **staff_member_id** = the dev admin's id (Authentication > Users shows the same user; staff id equals the user id), **reporting_entity_id** = the dev business, **purchase_ids** = `{<the id you copied in 4.1>}`, **filters** empty (null), **exported_at** a minute or less ago. The rows above it with kind `zip` hold the **filters** `{"q":"Hostedsix"}` and the purchase ids you downloaded.
2. Postman (optional, proves the deploy without the browser): **POST** `https://rygjssczdoyvmumxmymc.supabase.co/functions/v1/gold-export`. Headers: `apikey` = the dev anon key. Authorization tab > Bearer Token = the `access_token` from Local Storage entry `sb-rygjssczdoyvmumxmymc-auth-token` (browser F12 > Application > Local Storage). Body > raw > JSON: `{"kind":"record","filters":null,"purchaseIds":["<the id from 4.1>"]}`. ☐ 200 `{"ok":true}`; ☐ the audit table gains one `record` row. Do not add a Content-Type header by hand beyond the JSON body setting.

---

**What a failure looks like**
- A `PGRST…` code or "Empty or invalid json" in Postman means the request went to `/rest/v1`; use `/functions/v1/gold-export`.
- `bad_request` with a `field` means the JSON body is wrong (`kind` is `zip` or `record`; `purchaseIds` is a non-empty array of uuids; `record` takes exactly one).
- `unauthorized` means the token expired (they last 1 hour on dev) or was not sent; sign in again and copy a new `access_token`. `mfa_required` means a password-only session.
- `forbidden` means the account is `staff` or inactive. `gold_disabled` means `GOLD_JOURNEY_ENABLED` is not exactly `true` on that project.
- "Requested function was not found" means `gold-export` was not deployed to that project.
- The zip downloads but a photo is missing: a signed URL expired (5 minutes) or the object was deleted; the CSV row is still there.
- CI red in `uat` part0 on R11/R18/R24/R27 (stuck on `/id-verification`) is known issue #20; re-run the failed job once.

☐ Section A green on commit ______ · ☐ Section B · Notes:

*Progress note (UAT agent): all 46 rows automated and green locally (gold09b 61 Playwright tests, Deno 11 + the whole suite 387, pgTAP 871, Vitest 833, 8b.54 and 8b.58 re-run). Production breaks and expectation flips were done once each and reverted; no defects.*
