# UAT: Prettier reformat of `app/src` (Gold Phase 0)

**Purpose:** prove the Prettier reformat on `gold/00-format` changed no behaviour. The commit rewrites whitespace, quotes and line breaks in every file under `app/src`, so a slip in JSX text or a template string would show up as a screen that reads or behaves differently.
1. Sign-in and MFA land where they do today
2. One individual TTR still runs end to end, including the camera capture
3. Admin Reports and a batch still open

This sheet does not re-prove TTR report content. [uat-test-matrix.md](uat-test-matrix.md) covers that, and its TTR smoke rows are re-run in row 9.

| | |
|---|---|
| Environment | ________ |
| Build/commit | ________ |
| Run by / date | ________ |

**Setup.**
- A **dev** Supabase project, not the client project and not the one CI deploys `main` to. Before running any `npx supabase db push --linked`, confirm `app/.env.local` and the linked project both point at dev. This phase has no migrations, so no `db push` is needed.
- A **Vercel preview deploy** of `gold/00-format`, with its environment variables pointing at that dev project.
- One **staff** and one **admin** account, both already enrolled in MFA.

**Conventions.**
- `<today>` is today's date.
- Keep DevTools open on the **Console** tab throughout. Any new error fails the row you were on.
- Steps marked ⚠ are where a regression is most likely.

**Timing.** About 10 minutes.

---

## 1 · Sign-in (staff account)

| # | Do this | Expect |
|---|---|---|
| 1 | Sign out completely. Sign in with the staff email and password, then enter the MFA code | ☐ Code entry screen appears after the password ☐ Lands on `/start`, same as before the change |

## 2 · One individual TTR end to end (staff account)

**Start Transaction**
- Scenario: `Sell bullion to customer`
- Transaction reference: `UAT-FMT-001`
- Transaction date and time: `<today>`, current time

| # | Do this | Expect |
|---|---|---|
| 2 | On **Add Customers / Parties**, search for an existing customer by last name | ☐ Results appear |
| 3 | **Create new customer** → Individual: `Fran` `Format`, DOB `03/03/1990`. Fill the remaining screens as normal | ☐ Saves, and every **Continue** works ☐ Labels and helper text read normally, with no missing or doubled spaces |
| 4 ⚠ | On **ID Verification**, choose a sighted document and capture front and back with the **camera** | ☐ Camera preview appears ☐ Both captured images show |
| 5 | Continue to **Recipient / Delivery** and on to **Review & Submit**. Check the reporting entity section | ☐ Every screen loads ☐ Legal name, ABN, AUSTRAC account number and address are shown, not `—` ☐ The banner text reads normally, e.g. `Ready to complete — 1 warning to review` or `2 required fields missing`, with spaces around the number (rewrapped by the reformat) |
| 6 | Complete the transaction | ☐ Completes with no error |
| 6a ⚠ | Start `UAT-FMT-002` for **Fran Format** and go to **ID Verification**. Then **Exit** and confirm | ☐ The prior verification card reads `Transaction: UAT-FMT-001`, with a space after the colon (this line was rewrapped by the reformat) ☐ Exit deletes the draft |

## 3 · Admin Reports (admin account)

| # | Do this | Expect |
|---|---|---|
| 7 | Sign in as admin (both factors). Open **Reports** | ☐ Page loads and lists batches ☐ **New transaction** link is in the header |
| 8 ⚠ | Open a batch | ☐ Summary shows ☐ Transaction list shows ☐ Action buttons (Download XML, Reject, Submit as they apply to its status) are present |

## 4 · Existing smoke rows

| # | Do this | Expect |
|---|---|---|
| 9 | Re-run the TTR smoke rows of [uat-test-matrix.md](uat-test-matrix.md) (the AUSTRAC smoke test, R24–R26) | ☐ All pass as recorded before the change |

**What a failure looks like:**
- Text that reads differently, for example a missing space between words or a button label run together. Prettier moved JSX text across lines and the space was lost or gained.
- A screen that fails to render or logs a Console error. A reformat should never do this, so treat it as a real regression and diff the file against `main`.
- Row 4 shows no camera preview. The camera code was touched by the reformat in a way that changed behaviour.

---

## Sign-off

☐ All checks pass · Notes: ______________________________________________
