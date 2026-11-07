# UAT: Exports and printing (Gold Phase 9b)

**Purpose:** prove that `gold/09b-exports` lets only managers and admins download purchases (a zip with a CSV and photos) and print a record with ID photos, that every download or print is written to `gold.export_audit_log` before any photo URL is signed, and that a plain print never shows ID photos.

| | |
|---|---|
| Environment | Local stack |
| Build/commit | ________ |
| Run by / date | ________ |

**Where the rules come from.** Spec §6.2 (Exports and printing), §2.3 ("Downloads and prints"), §4.2 (`gold.export_audit_log`), §4.6 (`recordDownload` → `gold-export`), §5.2 (Purchases and PurchaseRecord rows), §1.7 C1, §6.1, §6.4 and §9 of `docs/gold-due-diligence-spec.md`. The "Spec" column names the clause each row proves.

**`GOLD_JOURNEY_ENABLED`.** Locally it comes from `supabase/config.toml` `[edge_runtime.secrets]`; on dev it is set with `secrets set`; it stays off on the client project `ykerufaergyqvnaycyce`.

**Names used in the rows.**
- **Business One** and **Business Two**: two separate businesses, each with its own staff and purchases.
- **Staff Sam** (role `staff`), **Manager Mel** (role `manager`), **Admin Ada** (role `admin`), all in business One, all with an aal2 session. **Inactive Ian**: a manager in business One whose account is inactive.
- **Jane Citizen**: driver licence on file. **Joan Smith**: a second person, the joint seller.
- **P1**: scrap purchase by Jane, invoice `INV-1`, cash $12,000 (reportable), 2 goods photos, linked to a complete TTR with reference `INV-1`.
- **P2**: bullion purchase by Jane and Joan (joint), invoice `INV-2`, 1 goods photo, linked to a draft TTR.
- **P3**: scrap purchase by Jane, no invoice number, no goods photos, no TTR.
- **P-other**: a purchase of business Two.
- **Request** means `POST /functions/v1/gold-export` with `Authorization: Bearer <token>`. `zip` is `{ "kind": "zip", "filters": {...}, "purchaseIds": [...] }`; `record` is `{ "kind": "record", "filters": null, "purchaseIds": [id] }`.

## Section 1 · Access (`gold-export`)

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 9b.1 | §9, §6.1 | With `GOLD_JOURNEY_ENABLED` off, send a valid `zip` request as Manager Mel. | 403 `gold_disabled`. No audit row, nothing signed. | |
| 9b.2 | §6.1, §9 | Send a valid `zip` request (a) with no Authorization header, (b) with a password-only (aal1) token. | (a) 401 `unauthorized`. (b) 403 `mfa_required`. No audit row either time. | |
| 9b.3 | §2.3, §9 | As Staff Sam, send a valid `zip` request, then a valid `record` request. | Both 403 `forbidden`. No audit row. No storage call is made (no URL is returned). | |
| 9b.4 | §2.3, §6.1 | As Inactive Ian, send a valid `zip` request. | 403 `forbidden`. No audit row. | |
| 9b.5 | §2.3 | As Manager Mel, then as Admin Ada, send `zip` for [P1, P2, P3]. | Both 200. Admin passes the manager check. Each writes its own audit row. | |
| 9b.6 | §6.2 | Send these as Mel, one at a time: kind `"csv"`; no `kind`; no `purchaseIds`; `purchaseIds` a string; `purchaseIds` `[]`; `purchaseIds` `["nope"]`; `filters` an array; an unreadable body. | Each is 400 `bad_request` with the `field` that is wrong. No audit row, nothing signed. | |
| 9b.7 | §6.2 | As Mel, send `zip` with exactly 200 distinct purchase IDs of business One, then with 201. | 200 IDs: 200 OK, one audit row holding 200 IDs. 201 IDs: 400 `too_many_purchases`, no audit row, nothing signed. | |
| 9b.8 | §6.2 | As Mel, send `record` with two purchase IDs, then with one. | Two: 400 `bad_request` (`purchaseIds`), no audit row. One: 200, one audit row. | |
| 9b.9 | §6.1, §9 | As Mel, send `zip` for [P1, P-other], then for [P1, a random UUID that is no purchase]. | Both 404 `purchase_not_found`. No audit row, nothing signed, nothing from business Two in any response. The two answers are the same. | |
| 9b.10 | §6.2 | As Mel, send `zip` for [P1, P1, P2]. | 200. The response has 2 purchases. The audit row holds 2 IDs. | |

## Section 2 · Audit row (`gold.export_audit_log`)

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 9b.11 | §4.2, §6.2 | As Mel, send `zip` for [P1, P2] with filters `{ "q": "Jane", "status": "austrac", "type": "scrap", "cash": "yes", "from": "2026-11-01", "to": "2026-11-07", "recordedBy": "<Sam's id>" }` and extra fields `staffId` (Ada's id), `reportingEntityId` (business Two) and `unknown: 1`. | One new row: `staff_member_id` is Mel's, `reporting_entity_id` is business One's, kind `zip`, `purchase_ids` [P1, P2], `filters` holds exactly the seven known keys with the values sent, `exported_at` within a minute of now. Nothing from `staffId`, `reportingEntityId` or `unknown`. | |
| 9b.12 | §4.2, §6.2 | As Ada, send `record` for [P1]. | One new row: Ada's staff ID, kind `record`, `purchase_ids` [P1]. | |
| 9b.13 | §6.2, §6.4 | Make the audit insert fail (for the test only), then send a valid `zip` request. | 500 `server_error`. No photo URL is signed (no storage call). Nothing is returned. | |
| 9b.14 | §4.2, §6.4 | With the service role, try to update and then delete an audit row. As Mel's session, try to insert one. | Update and delete are refused by the append-only trigger. The insert is refused (no privilege). The row is unchanged. | |
| 9b.15 | §4.2, §2.3 | Read `gold.export_audit_log` as Mel, as Ada, as Staff Sam, and as a manager of business Two. | Mel and Ada see business One's rows. Sam sees none. Business Two's manager sees none of business One's. | |

## Section 3 · Response content

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 9b.16 | §6.2 | As Mel, send `zip` for [P1, P2, P3]. | One entry per purchase. Each has the CSV fields: purchase ID, recorded and completed times and staff names, invoice, type, cash band, cash flag and amount, seller names and phones, ID type, number and expiry, phone at purchase, `id_sighted`, `id_expired_at_time`, goods photo count, `ttr_status`, `ttr_reference`, `id_document_used`, `id_photo_copy_taken`. Joint fields are empty for P1 and P3 and filled for P2. | |
| 9b.17 | §6.2 | In the response for [P1, P2, P3], read each photo entry. | P1: 2 goods photos + Jane's ID front and back. P2: 1 goods photo + front and back for Jane and for Joan. P3: no photos at all, and still a row. Each URL is a signed storage URL whose token expires within 300 seconds of now. | |
| 9b.18 | §6.2, §6.1 | Fetch one goods photo URL and one ID photo URL from the response. Fetch the same storage path without the token. | The signed URLs return the image (200). The unsigned fetch is refused. | |
| 9b.19 | §6.2 | Read `ttr_status` and `ttr_reference` for P1, P2 and P3. | P1: `complete`, `INV-1`. P2: `draft` and its reference. P3: both empty. | |
| 9b.20 | §1.7 C1, §6.2 | Jane's licence was used for P1. Update Jane's ID with reason "renewed" (same document, new photos), so P1's original photos are replaced. Send `zip` for [P1]. | The ID front and back URLs are the **newer** copy's images (the current ones). `id_photo_copy_taken` says it is a newer copy and gives the date it was taken. `id_document_used` still names the document P1 used. | |
| 9b.21 | §1.7 C1 | Jane then records a **different document** (a passport). Send `zip` for [P1, P4], where P4 was bought with the passport. | P1's ID photos are still the licence's copy (the passport is a separate document). P4's are the passport's. Each `id_photo_copy_taken` says "original". | |
| 9b.22 | §6.2, §6.4 | Send any successful `zip` and `record` request, then read `ttr.access_log`. | No `ttr.access_log` rows are added by `gold-export`. The export audit row is its record (Decision 2). | |

## Section 4 · Download (n) on Purchases

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 9b.23 | §2.3, §5.2 | Sign in as Staff Sam and open Purchases, then a purchase record. Repeat as Mel and as Ada. | Sam sees **no** "Download (n)" and **no** "Download record". Mel and Ada see both. | |
| 9b.24 | §6.2 | As Mel, open Purchases with no filters, then pick Status "AUSTRAC", then type a search that matches nothing. | The button reads "Download (n)" where n is the "n purchases" count under the filters, updating as the filters change. With 0 results the button is disabled. | |
| 9b.25 | §6.2 | As Mel, filter so the list has 201 purchases. Then narrow to 200. | At 201 the button is disabled and the page says "Too many purchases to download (201). Narrow the filters to 200 or fewer." At 200 it is enabled. | |
| 9b.26 | §6.2 | As Mel, filter to P1 and P2 and press **Download (2)**. | The button shows "Preparing… x/2" while it works. A file `purchases-<today>.zip` is saved. One audit row is written with kind `zip`, the current filters (search text included) and exactly P1 and P2. A short message says "Downloaded 2 purchases". | |
| 9b.27 | §6.2 | Open the saved zip. | It holds `purchases.csv`, `READ ME.txt` (the date, the count, and a warning that the download contains identity documents), and one folder per purchase named `<yyyy-mm-dd>_<invoice or NO-INVOICE>_<purchase id>`. P1's folder has `main-seller-id-front`, `main-seller-id-back`, `goods-1` and `goods-2`; P2's also has `joint-seller-id-front` and `joint-seller-id-back`. | |
| 9b.28 | §6.2, §1.7 C1 | After 9b.20, download P1 as Mel and open the zip. | P1's ID images are the newer copy's (compare with the image shown on the record page). The CSV `id_photo_copy_taken` for P1 says it is a newer copy and gives the date. | |
| 9b.29 | §6.2 | Open `purchases.csv`. | The columns, in order: `purchase_id, recorded_at, recorded_by, status, completed_at, completed_by, erp_invoice_no, purchase_type, cash_paid, austrac_reportable, cash_amount_aud, main_seller_name, main_seller_phone, main_id_type, main_id_number, main_id_expiry, joint_seller_name, joint_seller_phone, joint_id_type, joint_id_number, joint_id_expiry, phone_at_purchase, id_sighted, id_expired_at_time, goods_photo_count, folder, ttr_status, ttr_reference, id_document_used, id_photo_copy_taken`. One row per purchase. `folder` matches the zip folder. | |
| 9b.30 | §6.2 | Check the first bytes and the layout of `purchases.csv`. | It starts with the UTF-8 byte order mark (EF BB BF), lines end CRLF, every cell is in double quotes, and a double quote inside a cell is doubled. A name with a comma, a quote or an accent (for example `O"Brien, José`) reads back unchanged. | |
| 9b.31 | §6.2 | Give a seller the name `=HYPERLINK("http://x")` (and another `+1`, `-1`, `@SUM(1)`), record purchases for them, and download. | Each cell that begins with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a leading `'` inside the quotes. A cell that begins with anything else is unchanged. | |
| 9b.32 | §6.2 | Download P1 and P3. | P1: status Completed, `austrac_reportable` Yes, `ttr_status` complete, `ttr_reference` INV-1. P3: status Incomplete, `austrac_reportable` No, `ttr_status` and `ttr_reference` empty, `goods_photo_count` 0, and a folder `<date>_NO-INVOICE_<id>` with no images. | |
| 9b.33 | §2.3, §6.2 | Download while the server refuses (the manager's role is changed to `staff` after the page loaded, then press **Download**). | The page shows "You do not have permission to do that." No file is saved. No audit row. | |
| 9b.34 | §6.2 | Download while one photo URL cannot be fetched (for example one signed URL is blocked). | The zip is still saved with the other photos; the CSV row is still there. No error page. | |

## Section 5 · Download record and printing

| # | Spec | Action | Expected | Covered by |
|---|---|---|---|---|
| 9b.35 | §6.2, §2.3 | As Mel, open P2's record and press **Download record**. | `gold-export` is called with kind `record` and [P2] **before** the print dialog opens. One audit row is written. Pressing it twice writes two rows. | |
| 9b.36 | §6.2, §9 | Make `gold-export` refuse or fail, then press **Download record**. | The print dialog does not open. The page shows the error ("You do not have permission to do that." for a 403, or "Could not prepare the download. Try again." otherwise). ID photos stay hidden for print. | |
| 9b.37 | §6.2 | As Mel, open P2's record and print with Ctrl+P (or emulate print media) **without** pressing Download record. | The print shows the purchase details and goods photos. The ID front and back photos of **both** sellers are not shown. The ID details text (type, number, expiry) is. The page header, "Back to Purchases", **Complete** and the Download button are not shown. | |
| 9b.38 | §6.2 | Press **Download record** and let the print dialog open (emulate print media at that moment). | The ID front and back photos of both sellers are shown in that print, along with the details and goods photos. | |
| 9b.39 | §6.2 | Close the print dialog (the `afterprint` event), then print again with Ctrl+P. | The ID photos are hidden again. They are shown only for the print that **Download record** opened. | |
| 9b.40 | §6.2 | On screen, with no print, open P2's record before and after pressing **Download record**. | The page looks the same on screen both times. | |
| 9b.41 | §6.2 | As Mel, open a record and look at `ttr.access_log`. | Each ID image shown on screen has a `view` row, as before this phase (ID images are still only served by `get-id-image-urls`). | |
