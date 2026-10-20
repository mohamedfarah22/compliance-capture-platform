# UAT run log — self-conducted fast path & item/delivery capture flag

Results for [uat-fast-path-and-capture-flag.md](uat-fast-path-and-capture-flag.md). The sheet itself is left blank so it can be reused.

| | |
|---|---|
| Environment | Supabase `ykerufaergyqvnaycyce` (ap-south-1) |
| Build/commit | **`ffd766b`**. Tested as the uncommitted working tree on top of `d64b43a`; `ffd766b` is that tree plus test-only and doc-only changes (stale test fixes, sheet corrections), so the app and function code are identical. F9 re-test was on the D1 fix included in `ffd766b`. |
| Edge functions | `complete-transaction` **v17**, deployed 2026-10-20 08:46 UTC (see F1) |
| Run by / date | Mohamed Farah / 2026-10-20 |

## Results

| Case | Ref | Result | Notes |
|---|---|---|---|
| F1 | UAT-FP-001 | ✅ Pass (2nd attempt) | 1st attempt failed at **Complete** with *"Recipient/delivery record is required"*. Cause: deployed `complete-transaction` was v2 (2026-07-28), older than the flag change (2026-07-30). Environment issue, not a code defect. Redeployed → v17, retried Complete → succeeded. |
| F2 | — | ✅ Pass | |
| F3 | — | ✅ Pass | Scenario `Sell precious metal to customer`; Back from Review/Submit returned to `/id-verification`. |
| F4 | UAT-FP-001 | ✅ Pass | `recipient_rows` = 0, `bullion_rows` = 0, `status` = `complete`. The server-side check is skipped on v17, not just hidden in the UI. Note: F1's first attempt (on v2) was exactly the 422 this case describes. |
| F5 | UAT-FP-002 | ✅ Pass | |
| F6 | UAT-FP-002 | ✅ Pass | |
| F7 | UAT-FP-002 | ✅ Pass | Completed with a cash amount ≥ `10000` instead of the sheet's `9500` (below threshold — see sheet issues). |
| F8 | UAT-FP-003 | ✅ Pass | |
| F9 ⚠ | UAT-FP-003 | ✅ Pass (re-test) | **1st run failed, defect D1:** on Continue from Party Details (fast path), the wizard dropped back to the first page instead of proceeding toward Review/Submit, abandoning the transaction. **Re-run on a build with the D1 fix:** proceeded to Review/Submit. |
| F10 | UAT-FP-004 / UAT-FP-005 | ✅ Pass | Both parts showed the friendly "already in use" message, with no raw DB error: fast-path insert on Customer Search (004) and normal-path save on Transaction Details (005). Done as two tabs taking turns rather than truly simultaneous requests: both tabs were taken to the step just before the save, then tab B saved first. |

**Part 1 (F1–F4): all pass.** **Part 2 (F5–F10): all pass, with F9 passing on re-test after the D1 fix.**

## Defects

### D1 — Fast path: Continue from Party Details abandons the transaction

- **Case / ref:** F9 / `UAT-FP-003`
- **Steps:** Self-conducted **Yes** → ID Verification → Transaction Details (`10500`) → Party Details → Continue
- **Expected:** Proceeds toward Review/Submit (Conducting Person and the three disabled steps are all skipped)
- **Actual:** Lands back on the first page; no error shown; transaction left mid-flow
- **Root cause:** `PartyDetailsPage.jsx:284` sends the fast path to `/recipient-delivery` without checking `ITEM_AND_DELIVERY_CAPTURE_ENABLED`. With the flag off that route isn't registered (`App.jsx:85`), so the catch-all redirects to `/`. This is the same redirect F2 confirms. `IdVerificationPage.jsx:836/874` already checks the flag; Party Details was missed.
- **Same bug elsewhere (not covered by any F-case):** `ConductingPersonPage.jsx:225` also sends you to `/recipient-delivery` without checking the flag, whenever there's no individual to verify.
- **Fix (2026-10-20, working tree, not yet deployed):** both pages now go to `/review` when the flag is off, the same as ID Verification. Regression tests: `PartyDetailsPage.test.jsx` ("fast path: Continue goes straight to /review…"), and the existing `ConductingPersonPage.test.jsx` company-only test, which asserted the buggy `/recipient-delivery` route and now expects `/review`. Both failed before the fix and pass after.
- **Status:** ✅ Closed. Fix verified by re-running F9 on 2026-10-20. Committed in `ffd766b`.

### Test-suite notes (not UAT defects)

At the time of the D1 fix, 308/311 frontend tests pass. The 3 failures were already there in the uncommitted fast-path work and don't involve the D1 files:
- `TransactionDetailsPage.test.jsx` ×2: the `wizardApi.js` mock is missing the new `describeSaveError` export.
- `CustomerSearchPage.test.jsx` ×1: "navigates to /transaction-details…" doesn't answer the new self-conducted question, which now blocks Continue (F6 behaviour).

**Resolved in `ffd766b`:** the Transaction Details test now uses the real `describeSaveError` (with Supabase mocked), and the Customer Search test answers **No**. Frontend suite 311/311 passes. `complete-transaction` Deno tests 18/18 pass.

## Issues with the test sheet (corrected in `ffd766b`)

- **F1, first checkbox is wrong.** It says no self-conducted question appears, but F5 specifies the question appears for exactly one individual party, which Priya is. It did appear. Answered **No** to take the standard route.
- **F7, cash amount `9500` is below the $10,000 TTR threshold.** A transaction under $10,000 can't be completed: Continue is disabled on Transaction Details (`TransactionDetailsPage.jsx:154`) and `complete-transaction` rejects it (`index.ts:285`). This is correct behaviour; the sheet value is wrong. Use any amount ≥ `10000` instead.
- **Go-live note.** F1's failure is the go-live.md §1.3 risk (stale `complete-transaction`, silent in the UI) happening for real. Confirms `functions list` must be checked after every deploy.

## Sign-off

☑ All Part 1 cases pass · ☑ All Part 2 cases pass, with F9's outcome explicitly recorded (failed, then passed on re-test after the fix) · Defects found: **1 (D1, fixed and verified)**

**Conditions before this run can stand for go-live:**

1. ✅ **Commit**: `ffd766b`.
2. ☐ **Deploy the frontend from `ffd766b`.** A build without the D1 fix still has the F9 defect.
3. ✅ **Fix the 3 stale frontend tests**: done in `ffd766b`.
4. ✅ **Correct the test sheet**: done in `ffd766b`. F1 now expects the question and says to answer **No**; F7 uses `11000`.
