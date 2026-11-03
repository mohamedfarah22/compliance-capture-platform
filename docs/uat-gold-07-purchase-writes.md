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

**Timing.** About 10 minutes for Section B. Section A is automated (about 3 minutes of tests, plus the stack restart).

**Where the rules come from.** Spec §1.7 (C1 to C3), §3.3, §3.3a, §3.4, §3.5, §4.2 to §4.6, §5.1 and §6.1 of `docs/gold-due-diligence-spec.md`. The "Spec" column names the clause each row proves. Where the spec fixes a behaviour but not a response code, the code is the one documented in the header comment of the function.

**`GOLD_JOURNEY_ENABLED` locally and in CI.** `supabase/config.toml` carries `[edge_runtime.secrets] GOLD_JOURNEY_ENABLED = "true"`, which the local CLI hands to the local functions. It never reaches a hosted project. After changing it, run `npx supabase stop && npx supabase start`.

---

## A · Automated rows

Every row below is proved by an automated test, written independently of the code from the spec. The Playwright tests call the real functions with real `aal2` sessions (staff are created through the Auth admin API and enrolled in TOTP), seed their own businesses and customers, and read the results back with SQL.

The local edge runtime serves functions from the directory where `npx supabase start` was run, so start the stack from this branch's directory:

```
npx supabase stop && npx supabase start && npx supabase db reset
npx supabase test db                                     # pgTAP: expect Result: PASS (includes gold07_uat.test.sql)
cd supabase/functions && deno task test                  # expect 0 failed (includes _shared/gold07_uat.test.ts)
cd app && npm run uat:gold07                             # Playwright project gold07 (also part of `npm run uat`)
```

☐ CI green on this commit (jobs `uat`, `functions`, `frontend`, pgTAP)

Test files: **E1** `app/e2e/gold07/01-refusals-and-save.e2e.js` · **E2** `02-cash-id-ttr-case.e2e.js` · **E3** `03-invoices-linking-lies.e2e.js` · **E4** `04-atomicity-and-complete.e2e.js` · **E5** `05-urls-audit-reconcile-logs.e2e.js` (all in `app/e2e/gold07/`; shared helpers in `support.js`) · **P** `supabase/tests/gold07_uat.test.sql` · **D** `supabase/functions/_shared/gold07_uat.test.ts`. Every test name starts with its row ID. Rows marked *(added by UAT)* were missing from the first version of this sheet and come from the spec clause shown.

### A · Refusals (all three functions)

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 7.1 ⚠ | §2.2 | With `GOLD_JOURNEY_ENABLED` unset, empty, `false`, `TRUE`, `1` or `true `, each function answers **403 `gold_disabled`** before looking at the token and makes no network call. (With it on, the local stack answers an anon call 401: every E-file test depends on that.) | D `7.1 ⚠` (real handlers, real access check) |
| 7.2 ⚠ | §6.1 | No token, and the anon key as a token: **401** on every function; nothing written | E1 `7.2 ⚠` |
| 7.3 ⚠ | §6.1 | A password-only (`aal1`) session: **403 `mfa_required`** on every function; nothing written | E1 `7.3 ⚠` |
| 7.4 | §6.1 | A deactivated staff member (with MFA): **403 `forbidden`** on every function | E1 `7.4` |
| 7.5 ⚠ | §6.1, §4.3 | Staff of another business saving for this business's customer gets the same **404 `customer_not_found`** as for an unknown id | E1 `7.5 ⚠` |
| 7.6 ⚠ | §6.1, §4.3 | Staff of another business cannot complete or get URLs for this business's purchase: **404 `purchase_not_found`**, purchase unchanged | E1 `7.6 ⚠` |
| 7.7 | §6.1, §4.3 | Staff of One saving for a customer of Two: **404**, nothing written | E1 `7.7` |
| 7.8 | §4.5 | A plain `staff` role can save, complete and get URLs | E1 `7.8` |

### B · Saving a purchase, and the photo rule

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 7.10 ⚠ | §4.2, §4.3, §4.5 | A non-reportable scrap sale: 201 `{purchaseId, ttr: null, warnings: {}}`; type, band, flag, no amount, no invoice, sighted, phone, recorded-by, business, ID used, Melbourne sale date, not completed | E1 `7.10 ⚠` |
| 7.11 ⚠ | §4.2 (`goods_photos`) | Three photos: rows with sort order 0..2, paths `{id}/goods-n.jpg`, `image/jpeg`, `gold-goods`, byte sizes, **SHA-256 of the bytes**, captured-by, business, and the objects exist | E1 `7.11 ⚠` |
| 7.12 ⚠ | §4.3 | No photo: **422** `errors.photos`; nothing written | E1 `7.12 ⚠` |
| 7.13 | §4.5 | PNG, a text file with a `.jpg` name and JPEG type, a photo over 5 MiB, 11 photos: **415, 415, 413, 400**; nothing stored | E1 `7.13` |
| 7.14 ⚠ | §1.7 C3 | Sighted box missing, `false` or `yes`: **422** `errors.idSighted` (single and joint wording) | E1 `7.14 ⚠` |
| 7.15 | §4.3 | Phone required; 7 digits too short; `04 1234 5678` accepted | E1 `7.15` |
| 7.16 | §5.1 | `ten grand` as a cash amount: **422** `errors.cashAmount` | E1 `7.16` |
| 7.17 | §4.3 | Bad purchase type, bad customer id, missing scrap cash answer: **400** naming the field | E1 `7.17` |
| 7.18 | §4.3 `cash_amount >= 0` *(added by UAT)* | `-500` refused; `0` accepted and stored as 0 | E1 `7.18` |
| 7.19 | §4.3 phone 8+ digits *(added by UAT)* | Exactly 8 digits accepted; 7 digits and no digits refused | E1 `7.19` |
| 7.84 | §4.5 *(added by UAT)* | 10 photos and one of exactly 5 MiB accepted; 5 MiB + 1 byte is 413 | E1 `7.84` |
| 7.85 | §4.3 *(added by UAT)* | An empty file does not count as a photo | E1 `7.85` |

### C · Cash thresholds (computed on the server)

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 7.20 ⚠ | §3.3, §5.1 | Scrap, Yes, $9,999.99: not reportable | E2 `7.20 ⚠` |
| 7.21 ⚠ | §3.3, §5.1 | Scrap, Yes, exactly $10,000: reportable, case A for a ready customer | E2 `7.21 ⚠` |
| 7.22 | §5.1 | Scrap, Yes, no amount: reportable, case B for a gold-only customer | E2 `7.22` |
| 7.23 | §5.1 | Scrap, Yes, $8,000: the amount decides, not reportable | E2 `7.23` |
| 7.24 | §5.1 | Scrap by bank transfer with a stray amount: amount ignored | E2 `7.24` |
| 7.25 | §5.1 | Bullion under $5,000 saves | E2 `7.25` |
| 7.26 ⚠ | §1.7 C2 | Bullion $5,000 to $9,999: saves with a current ID, **blocked** with an expired one | E2 `7.26 ⚠` |
| 7.27 | §5.1 | Bullion $10,000+ reportable (case B); Yes with $7,000 is $5,000 to $9,999, not reportable | E2 `7.27` |
| 7.28 | §1.7 C2 *(added by UAT)* | Bullion boundaries: $4,999.99 needs no current ID, $5,000 does, $9,999.99 not reportable, $10,000 reportable | E2 `7.28` |

### D · ID rules (C2) and the ID used

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 7.30 ⚠ | §1.7 C2 | Reportable with an expired ID: **422** `blocked: [{customerId, role: main, status: expired}]` | E2 `7.30 ⚠` |
| 7.31 ⚠ | §1.7 C2 | Reportable with an ID photographed 800 days ago (window 730): blocked `reverify` | E2 `7.31 ⚠` |
| 7.32 ⚠ | §1.7 C2 | The window is the business setting: 5 days blocks, 730 saves | E2 `7.32 ⚠` |
| 7.33 ⚠ | §1.7 C2, §4.2 | Where no current ID is needed the sale saves and the expired / outside-window flags are recorded | E2 `7.33 ⚠` |
| 7.34 | §1.7 C2 | Joint seller's expired ID blocks, for the joint seller only | E2 `7.34` |
| 7.35 | §2 "no ID, no transaction" | A seller with no ID: **422 `no_id_on_file`** `role: main` | E2 `7.35` |
| 7.36 | §1.6, §4.2 | The newest ID capture is the ID used; an earlier purchase keeps its own | E2 `7.36` |
| 7.37 | §1.7 C2 *(added by UAT)* | Boundaries: an ID expiring today and one photographed exactly 730 days ago are current; expired yesterday and 731 days are not | E2 `7.37` |
| 7.38 | §2 *(added by UAT)* | A joint seller with no ID: **422 `no_id_on_file`** `role: joint` | E2 `7.38` |
| 7.39 | §1.7 C2 *(added by UAT)* | A reportable joint sale with an out-of-window joint ID: blocked `reverify`, joint role | E2 `7.39` |

### E · TTR case and counter answers (§3.3, §3.3a)

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 7.40 ⚠ | §3.3 case A | Ready customer, reportable, both answers Yes, no invoice: 201 `ttr: "A"`, answers stored, **no TTR started** | E2 `7.40 ⚠` |
| 7.41 ⚠ | §3.3 case B | Details missing: invoice required with the spec's message; with an invoice it saves trimmed, `ttr: "B"`, no answers stored | E2 `7.41 ⚠` |
| 7.42 | §3.3a | Any No answer is case B; answers stored as given | E2 `7.42` |
| 7.43 | §3.3a | Both answers are required when asked | E2 `7.43` |
| 7.44 ⚠ | §3.3a, §4.3 | On a non-reportable sale the answers are not stored | E2 `7.44 ⚠` |
| 7.45 ⚠ | §3.3 | A reportable joint sale is always case B and stores no answers | E2 `7.45 ⚠` |
| 7.46 | §4.2, §4.3 | Joint seller equal to main seller: **422** `errors.joint` | E2 `7.46` |
| 7.47 | §4.3 | Non-reportable joint sale stores both IDs used | E2 `7.47` |

### F · Invoice rules (§3.3, §3.5)

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 7.50 ⚠ | §3.3 | A reportable purchase on another customer's invoice is refused; case and spaces do not hide it | E3 `7.50 ⚠` |
| 7.51 | §3.3 | A non-reportable purchase on a used invoice saves with `warnings.duplicateInvoice` | E3 `7.51` |
| 7.52 | §3.3 | A same-day linked part is not a duplicate | E3 `7.60 ⚠` (part 2 reuses part 1's invoice, reportable by total, and saves) |
| 7.53 ⚠ | §3.3, §4.2 | A part from another day is not a linked part: a duplicate | E3 `7.53 ⚠` |
| 7.54 ⚠ | §3.5 | A new scrap part on an invoice whose scrap TTR is complete is refused with the spec's message; a bullion part is not | E3 `7.54 ⚠` |
| 7.55 | §3.5 | A draft TTR does not block | E3 `7.55` |
| 7.56 | §3.5 *(added by UAT)* | The completed-TTR block finds the invoice whatever its case or spacing | E3 `7.56` |
| 7.57 | §4.3 *(added by UAT)* | Two simultaneous reportable saves on one invoice cannot both succeed: exactly one 201 and one 422 `errors.erp_invoice_no`, four times over. Found as defect D1; fixed in 0105b69 (advisory lock and re-check in the write functions) | E3 `7.57` |
| 7.58 | §4.3, §3.3 *(added by UAT)* | The invoice lock itself: with another connection holding the lock and an uncommitted conflicting purchase, a save waits (it does not finish within 4 seconds); after the commit it is refused with `errors.erp_invoice_no` and its uploaded photo is removed | E3 `7.58` |
| 7.59 | §4.3, §3.3 *(added by UAT)* | The same for a completion: it waits for the lock, then is refused; the purchase gets no invoice | E3 `7.59` |

### G · Linked parts and totals (§3.4, §4.2)

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 7.60 ⚠ | §3.4, §4.2, §4.5 | Part amount and earlier part's amount required; the fill is written in the same save; the total makes the sale reportable; the fill is audited (source, who, old → new) | E3 `7.60 ⚠` |
| 7.61 | §3.4 | The total decides ($2,000 + $3,000 not reportable); an earlier amount already saved is untouched | E3 `7.61` |
| 7.62 ⚠ | §3.4 | Mixed scrap + bullion, $6,000 + $6,000: reportable, each part keeps its own amount | E3 `7.62 ⚠` |
| 7.63 | §4.2 | A later part adds to the total; earlier snapshots are never rewritten | E3 `7.63` |
| 7.64 ⚠ | §4.3 | The total uses saved amounts; an earlier amount is never overwritten; a part that is not linked cannot be filled | E3 `7.64 ⚠` |
| 7.65 | §3.4 | A different customer on the same invoice is not a linked part | E3 `7.65` |
| 7.66 | §3.4 | A joint seller's earlier part is linked | E3 `7.66` |
| 7.67 | §4.5 *(added by UAT)* | Two saves filling the same earlier part: one wins, the other is **409 `linked_part_changed`** and leaves no row, photo, object or audit row | E3 `7.67` |

### H · Values a client sends that lie

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 7.70 ⚠ | §4.3 | Every server-computed value forged (band, flag, date, creator, ID flags, ID used, total, business, id, answers, completed_*) is ignored | E3 `7.70 ⚠` |
| 7.71 ⚠ | §4.2 | `sale_date` is the Melbourne calendar date, set by the server. The zone itself is proved at 14:30 UTC (already tomorrow in Melbourne) | E3 `7.71 ⚠` (today's date); `supabase/functions/gold-save-purchase/index.test.ts` "saves a non-reportable scrap purchase" (read, asserts 2026-11-07 at 2026-11-06T14:30Z; fails under a UTC date) |
| 7.72 | §4.3 | "Not cash" with a forged amount cannot make a sale reportable | E3 `7.72` |
| 7.73 | §4.3 *(added by UAT)* | A part amount sent with no linked part is ignored | E3 `7.73` |

### I · Atomicity: rows and storage (§4.5)

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 7.80 ⚠ | §4.5 | The database refuses the photo rows: **500 `save_failed`**; no purchase, photo, object, audit row, no fill; the same call then succeeds | E4 `7.80 ⚠` |
| 7.81 ⚠ | §4.5 | Storage refuses the second photo: **500 `storage_failed`**; the first object is removed again | E4 `7.81 ⚠` |
| 7.82 | §4.4, §4.5 | An object left behind is swept | E5 `7.130` to `7.132` |
| 7.83 | §4.5 | After every row above, every `gold-goods` object has a `goods_photos` row | E4 `7.83` |

### J · Completing a purchase

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 7.90 ⚠ | §4.3, §4.5 | The invoice is added trimmed; `completed_at` / `completed_by` in the same update; one audit row with exactly those three keys | E4 `7.90 ⚠` |
| 7.91 | §4.3 | Blank, spaces or missing invoice: **422** `errors.erp_invoice_no` | E4 `7.91` |
| 7.92 ⚠ | §4.3 | An invoice already set (at completion or at the counter) is never changed: **409 `already_has_invoice`** | E4 `7.92 ⚠` |
| 7.93 ⚠ | §3.3 case A | Case A completes with `ttr: "A"`, `completed_*`, no TTR started | E4 `7.93 ⚠` |
| 7.94 | §3.3 | A reportable purchase cannot take a used invoice; a non-reportable one gets a warning | E4 `7.94` |
| 7.95 ⚠ | §3.5 | Adding an invoice whose TTR (of this type) is complete is refused | E4 `7.95 ⚠` |
| 7.96 ⚠ | §5.1, §1.7 C2 | Saved with an expired ID, reportable at completion: **422** `blocked: true` | E4 `7.96 ⚠` |
| 7.97 | §4.2, §4.5 | Amounts on completion: both required; all or nothing; each change audited | E4 `7.97` |
| 7.98 | §3.3 | Becoming reportable at completion (no counter answers): `ttr: "B"` | E4 `7.98` |
| 7.99 ⚠ | §4.3 | Only the invoice changes: forged band, answers, `completed_*`, type and flags are ignored | E4 `7.99 ⚠` |
| 7.100 | §6.1 | Unknown purchase 404; malformed id or body 400 | E4 `7.100` |
| 7.101 | §3.3, §3.5 *(added by UAT)* | A case A purchase needs an invoice to complete; a used invoice is found whatever its case | E4 `7.101` |
| 7.102 | §3.5 *(added by UAT)* | A bullion purchase can take an invoice whose scrap TTR is complete | E4 `7.102` |
| 7.103 | §4.3 *(added by UAT)* | Two completions racing on one purchase: one 200, one 409, one audit row | E4 `7.103` |

### K · Signed photo URLs

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 7.110 ⚠ | §4.5, §6.1 | Three photos in order; each URL returns the exact file (hash equals the row's) | E5 `7.110 ⚠` |
| 7.111 ⚠ | §6.1 | URL lifetime is 300 seconds or less; an expired signed URL stops working (shown with a 1-second one) | E5 `7.111 ⚠` |
| 7.112 ⚠ | §6.1 | Another business's purchase and an unknown one are the same 404, no `urls`; a malformed id is 400 | E5 `7.112 ⚠` |
| 7.113 | §6.1 | Private bucket: no public URL, no direct read or listing as staff | E5 `7.113` |
| 7.114 | §4.5 | No photos: `{"urls":[]}` | E5 `7.114` |
| 7.116 | §6.1 *(added by UAT)* | URLs are for the purchase asked about, not another purchase of the business | E5 `7.116` |

### L · Immutability, audit and the browser's access

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 7.120 ⚠ | §4.3 | After capture, as the service role, each of customer, joint customer, type, both ID references, sighted, both ID flags, both counter answers, sale date, creator, created_at and business is refused (`23001`); the row is unchanged | P `7.120 ⚠` (14 statements) |
| 7.121 ⚠ | §4.3 | An invoice already set cannot be changed or removed; `completed_*` only comes with the update that adds the invoice, and cannot then change or be cleared; the allowed changes work | P `7.121` |
| 7.122 | §4.2 | `goods_photos` is append-only (update, delete as service role and owner); a purchase with photos cannot be deleted | P `7.122` |
| 7.123 ⚠ | §4.2 | `purchase_audit_log` is append-only | P `7.123 ⚠` |
| 7.124 ⚠ | §4.2 | A plain save writes no audit row; fills and completions do, with the session's staff member, time, old → new, and no `updated_at` / `erp_invoice_norm` keys | E5 `7.124 ⚠` |
| 7.125 ⚠ | §4.5, §6.1 | With a browser session: reads work; valid insert, update, delete, photo insert and both write functions do nothing. Also in the database as `authenticated` and `anon` | E5 `7.125 ⚠`, P `7.125` |
| 7.126 | §4.5 | `anon f`, `authenticated f`, `service_role t` on both write functions, and a call as staff is permission denied | P `7.126` |
| 7.127 | §4.2, §4.3 *(added by UAT)* | The database's own checks: joint equals main, joint without joint ID, negative cash, 0 accepted, sighted false, 7-digit phone, 8 digits among punctuation, blank invoice, generated `erp_invoice_norm` | P `7.127` |
| 7.128 | §6.1 *(added by UAT)* | `gold.save_purchase` itself refuses another business's staff, a deactivated staff member, another business's customer, another customer's ID, and no photos, and leaves nothing | P `7.128` |
| 7.129 ⚠ | §4.5 *(added by UAT)* | A bad fill fails the whole call (`40001`): no purchase, no photo, the earlier fill rolled back, a saved amount never overwritten | P `7.129 ⚠` |

### M · `reconcile-stored-images`: orphaned goods photos (§4.4)

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 7.130 ⚠ | §4.4 | Dry run by default; a `goldGoods` section; a brand-new object (a save in flight) is not an orphan | E5 `7.130 ⚠` |
| 7.131 ⚠ | §4.4 | An orphan over an hour old is reported (and is the only one) and left in place | E5 `7.131 ⚠` |
| 7.132 ⚠ | §4.4 | `apply` removes only the orphan; objects with a row, the rows, and `compliance-media` are untouched | E5 `7.132 ⚠` |
| 7.133 ⚠ | §4.4 | A photo row with no object is reported (`missingObjects.photoIds`), never deleted | E5 `7.133 ⚠` |
| 7.134 ⚠ | §4.4 | With storage down the sweep fails and removes nothing; it works again after | E5 `7.134 ⚠` |
| 7.135 | §4.4 | A staff session cannot run it: 401 | E5 `7.135` |
| 7.136 | §4.4 | The existing ID-image sections are still reported | E5 `7.136` |
| 7.137 | §4.4 *(added by UAT)* | `apply` with nothing wrong deletes no goods row and no object | E5 `7.137` |

### N · Logs (§6.1)

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 7.140 ⚠ | §6.1 | A failed save logs its purchase id and an error code, and none of the customer's name, phone, invoice or amount | E5 `7.140 ⚠` |
| 7.141 | §6.1 | Successful calls write nothing to the log (the runtime's own "serving the request" lines are not the function's) | E5 `7.141` |

### O · TTR is unaffected

| # | Spec | What is proved | Covered by |
|---|---|---|---|
| 7.150 ⚠ | §8 | `npm run uat` (Part 0, Phase 4, Part 1, then gold07) passes | CI job `uat` |
| 7.151 | §9 | All pgTAP files pass; `deno task test` reports 0 failed | CI (`supabase test db` in `uat:part0`, and the `functions` job) |

### Hosted only

| # | Spec | Why it cannot be checked locally | Covered by |
|---|---|---|---|
| 7.160 ⚠ | §2.2 | The client project's secrets and deployed functions | Section B, step B6 |

---

## B · Manual test for the user (about 10 minutes, dev project only)

The local stack cannot see the hosted project's settings, deploys or a real camera JPEG. Everything else is Section A.

**Before you start**
- Use the **dev** project. Confirm `supabase/.temp/project-ref` and `app/.env.local` both name dev. `gold` must already be in the project's Exposed schemas (Phase 5, check H1).
- A real JPEG from a phone or camera, under 5 MiB. Call it `goods.jpg`.
- A dev staff login with MFA, signed in to the dev app. In the browser console run `JSON.parse(localStorage[Object.keys(localStorage).find(k => k.endsWith('-auth-token'))]).access_token` and keep the token as `$TOKEN` (it lasts 5 minutes: rerun when you get 401).
- In the dev SQL editor, make one dummy customer with an ID (skip if Phase 6 left you one with a valid ID and write its id down):
  ```sql
  insert into public.customers (id, reporting_entity_id, customer_type, source, first_name, last_name, date_of_birth, phone, res_street, res_suburb, res_state, res_postcode, res_country)
  select 'c7000000-0000-4000-8000-000000000007', reporting_entity_id, 'individual', 'gold', 'Hosted', 'Seven', '1990-07-07', '0412 345 678', '7 Test St', 'Coburg', 'VIC', '3058', 'AU'
  from public.staff_members limit 1;
  insert into ttr.stored_images (id, customer_id, object_path, content_hash_sha256, captured_by_staff_id)
  select 'b7000000-0000-4000-8000-000000000007', 'c7000000-0000-4000-8000-000000000007', 'customers/c7000000-0000-4000-8000-000000000007/f7000000-0000-4000-8000-000000000007/front-uat.jpg', 'uat-hash-7', id from public.staff_members limit 1;
  insert into ttr.id_verifications (id, customer_id, verification_method, document_type, document_number, issuer, id_country_code, has_expiry, expiry_date, verification_description, is_complete, front_image_id)
  values ('f7000000-0000-4000-8000-000000000007', 'c7000000-0000-4000-8000-000000000007', 'Sighted original document', 'Driver licence', 'UAT-LIC-7', 'VIC', 'AU', true, '2031-01-01', 'Sighted in person', true, 'b7000000-0000-4000-8000-000000000007');
  ```

| # | Do this | Expect |
|---|---|---|
| B1 | `npx supabase db push --linked`, then `npx supabase functions deploy gold-save-purchase gold-complete-purchase get-gold-photo-urls reconcile-stored-images`, then `npx supabase secrets set GOLD_JOURNEY_ENABLED=true` | ☐ No errors ☐ `npx supabase functions list` shows the four functions ☐ `npx supabase secrets list` shows `GOLD_JOURNEY_ENABLED` |
| B2 | Save: `curl -s -w "\nHTTP %{http_code}\n" -X POST https://<dev ref>.supabase.co/functions/v1/gold-save-purchase -H "apikey: <dev anon key>" -H "Authorization: Bearer $TOKEN" -F customerId=c7000000-0000-4000-8000-000000000007 -F purchaseType=scrap -F cash10k=false -F "phone=0412 345 678" -F idSighted=true -F "photos=@goods.jpg;type=image/jpeg"` | ☐ **201** with a `purchaseId` (note it) and `"ttr":null` ☐ SQL editor: `select * from gold.goods_photos where purchase_id = '<id>'` has one row, `byte_size` equal to the file's size ☐ Storage → `gold-goods` holds `<id>/goods-1.jpg` |
| B3 | Photo URL: `curl -s -X POST https://<dev ref>.supabase.co/functions/v1/get-gold-photo-urls -H "apikey: <dev anon key>" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"purchaseId":"<id>"}'`. Open the returned `url` in a browser | ☐ Your photo shows ☐ The URL host is `<dev ref>.supabase.co` (not `kong`) |
| B4 | Complete: `curl -s -w "\nHTTP %{http_code}\n" -X POST https://<dev ref>.supabase.co/functions/v1/gold-complete-purchase -H "apikey: <dev anon key>" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"purchaseId":"<id>","erpInvoiceNo":"UAT-DEV-0701"}'` | ☐ **200** `{"purchaseId":"<id>","ttr":null,"warnings":{}}` ☐ SQL: `select erp_invoice_no, completed_at, completed_by_staff_id from gold.purchases where id = '<id>'` shows `UAT-DEV-0701` and both `completed_*` set |
| B5 | Reconcile dry run: `curl -s -X POST https://<dev ref>.supabase.co/functions/v1/reconcile-stored-images -H "apikey: <dev service role key>" -H "Authorization: Bearer <dev service role key>" -d '{}'` (do **not** pass `apply`) | ☐ 200, `"mode":"dry-run"` ☐ `goldGoods.orphanObjects.count` is 0 and `goldGoods.missingObjects.count` is 0 for the photo you saved |
| B6 | **After merge only**, on the **client** project: `npx supabase secrets list --project-ref <client ref>` and one call to each of the three functions with any staff token: `curl -s -w "\nHTTP %{http_code}\n" -X POST https://<client ref>.supabase.co/functions/v1/gold-save-purchase -H "apikey: <client anon key>" -H "Authorization: Bearer <staff token>"` (and `gold-complete-purchase`, `get-gold-photo-urls`) | ☐ No `GOLD_JOURNEY_ENABLED` in the list ☐ Each returns **403** `{"error":"gold_disabled"}` ☐ `reconcile-stored-images` still runs for ID images as before |

**What a failure looks like:**
- **Every Playwright call returns `Function not found`.** The local stack was started from another directory. Run `npx supabase stop && npx supabase start && npx supabase db reset` from this branch.
- **Every call returns `gold_disabled`.** The `GOLD_JOURNEY_ENABLED` secret is missing: see the top of this sheet (local) or B1 (dev).
- **`save_failed` on a plain save.** The migration did not apply (`select proname from pg_proc where proname = 'save_purchase'`), or `gold` is not exposed through the API (hosted: Project Settings → Data API → Exposed schemas).
- **7.57 returns two 201s.** The invoice lock in migration `20261107000002_gold_invoice_lock.sql` is missing or not applied: run `npx supabase db reset`.
- **7.134 hangs or fails after storage restarts.** The Storage container needs a few seconds to accept requests; the test retries for 90 seconds. Check `docker ps` for `supabase_storage_compliance-capture-platform`.
- **A signed URL does not open locally.** Replace `http://kong:8000` with `http://127.0.0.1:54321`.

---

## Sign-off

☐ Section A green on commit ________ · ☐ Section B (B1 to B5) · ☐ B6 after merge · Notes: ______________________________________________
