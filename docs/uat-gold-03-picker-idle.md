# UAT: Journey picker, `/start` and 10-minute idle sign-out (Gold Phase 3)

**Purpose:** prove the changes on `gold/03-picker-idle` work and that TTR still runs as before:
1. After sign-in and MFA, staff land on a journey picker at `/`. TTR starts at `/start`.
2. The Gold card and `/gold` only exist while `VITE_GOLD_JOURNEY_ENABLED` is on
3. The Reports card shows for admins only
4. Staff are signed out after 10 minutes without activity, across all tabs, and an unfinished TTR is cleared from the browser (but not lost: the draft can be reopened by reference)
5. The login redirect rules from the security hardening work still hold

This sheet does not re-prove TTR report content. [uat-test-matrix.md](uat-test-matrix.md) covers that, and its TTR rows are re-run in row 3.9.

| | |
|---|---|
| Environment | ________ |
| Build/commit | ________ |
| Run by / date | ________ |

**Setup.**
- A **dev** Supabase project, not the client project and not the one CI deploys `main` to. This phase has no migrations, so no `db push` is needed.
- A **Vercel preview deploy** of `gold/03-picker-idle`, with its environment variables pointing at that dev project and `VITE_GOLD_JOURNEY_ENABLED=true` set for **Preview only** (Vercel → Project Settings → Environment Variables). Redeploy after setting it, because Vite reads it at build time.
- For row 3.4 only: a **second build with the flag off**, either a Vercel preview with `VITE_GOLD_JOURNEY_ENABLED` unset or `false`, or Production once it has this branch. Do not turn the flag on in Production.
- One **staff** and one **admin** account, both already enrolled in MFA.
- A stopwatch. Rows 3.5 and 3.7 need real waiting time.

**Conventions.**
- `<today>` is today's date.
- Keep DevTools open on the **Console** tab throughout. Any new error fails the row you were on.
- Steps marked ⚠ are where a regression is most likely.

**Timing.** About 45 minutes, most of it waiting in rows 3.5 and 3.7. Start 3.5 first and do 3.7 in the second window while you wait.

---

## Journey picker and routing

| # | Do this | Expect |
|---|---|---|
| 3.1 | On the flag-on preview, sign out completely. Sign in as **staff**, enter the MFA code | ☐ Lands on `/`, the journey picker ☐ A **Threshold transaction report (TTR)** card ☐ A **Gold due diligence** card ☐ No **Reports** card |
| 3.2 ⚠ | Click the TTR card. Complete a TTR end to end (scenario `Sell bullion to customer`, reference `UAT-PICK-001`, one individual customer, ID with the camera). On **Transaction Complete**, click **Start New Transaction** | ☐ The TTR card opens `/start` ☐ The transaction completes ☐ **Start New Transaction** goes to `/start`, **not** the picker. Also check the other ways back to the start: **Exit** on any wizard screen and then **Cancel** on `/start` stay on `/start` |
| 3.3 | Sign out. Sign in as **admin**, enter the MFA code | ☐ Lands on `/` ☐ A **Reports** card, plus the TTR and Gold cards ☐ The Reports card opens the Reports page ☐ On Reports, the header **New transaction** link goes to `/start` |
| 3.4 | On the **flag-off build**, sign in and look at `/`. Then type `/gold` and `/gold/customers/new` into the address bar | ☐ No Gold card ☐ Both addresses end up on `/` (the picker) |

## Idle sign-out

| # | Do this | Expect |
|---|---|---|
| 3.5 ⚠ | Sign in as staff. Click TTR. On `/start` enter scenario `Sell bullion to customer` and reference `UAT-IDLE-001`, continue to **Add Customers / Parties** and create customer `Ida` `Idle`, DOB `04/04/1990`, and save. Then **leave the tab alone for 10 minutes**: no clicks, keys or touches, and no other tab of this app doing anything either. Watch the screen | ☐ Between 10:00 and about 10:30 after your last action the app goes to the sign-in page ☐ It says **"You were signed out after 10 minutes without activity."** ☐ DevTools → Application → Session Storage has no `ttr.*` entries (no `ttr.customers`, `ttr.transaction`, `ttr.transactionId`) ☐ Using Back does not show Ida's details |
| 3.6 ⚠ | Sign back in (both factors) and click the TTR card. On `/start` choose the scenario and type `UAT-IDLE-001` in **Transaction reference**, then tab out of the field | ☐ "Existing draft found — fields pre-filled." ☐ **Start Transaction** resumes at **Add Customers / Parties** with `Ida Idle` listed ☐ The draft still lives on the server, so the idle sign-out lost nothing |
| 3.7 | Sign in. Open the app in **two tabs**. Work in tab A for 12 minutes (click or type at least once every 5 minutes, e.g. move through the wizard screens) and leave tab B untouched on a protected page | ☐ Tab B is **not** signed out ☐ Tab A is not signed out ☐ Then stop touching **both** tabs for 10 minutes: both go to the sign-in page, and the message shows in the tab you are looking at |

## Redirects and regression

| # | Do this | Expect |
|---|---|---|
| 3.8 ⚠ | As admin, copy a batch review link (from the approval email or the Reports page): `/review-batch/<id>?token=…`. Sign out, open that link, sign in, enter the code. Then also open `/login?redirect=//example.com` signed out, sign in, enter the code | ☐ The link lands on **that batch's review page** with **Submit** and **Reject** available (security sheet C7) ☐ The `//example.com` address lands on `/`, the picker, and never leaves the app (security sheet A3) |
| 3.9 | Re-run the TTR rows of [uat-test-matrix.md](uat-test-matrix.md) (the AUSTRAC smoke test, R24–R26, and the sign-in rows) | ☐ All pass as recorded before the change |

**What a failure looks like:**
- 3.2 lands on the picker after **Start New Transaction**. A link in the TTR flow still points at `/` instead of `/start`.
- 3.4 shows a Gold card, or `/gold` shows "coming soon": the flag was on in that build. Check the Vercel variable scope and redeploy.
- 3.5 never signs out, or signs out well before 10 minutes. Check that no other tab of the app was open and active, and that the clock was not paused by the machine sleeping (a woken laptop signs out at once, which is correct).
- 3.5 signs out but no message shows. Note whether the sign-in page was reached through a refresh: the message lives in memory only.
- 3.7 signs the active tab out partway through. The Supabase session inactivity limit (`[auth.sessions] inactivity_timeout = "10m"` in `supabase/config.toml`, and the same setting on the hosted project) can end sessions that make no refresh request for 10 minutes, even while the person is busy. Compare the time of sign-out with the time the session was started or last refreshed, and tell the developer before merge.
- 3.6 shows no draft. The draft row was deleted: check `cleanup-stale-drafts` has not been run, and that the same account's reporting entity is being used.

---

## Sign-off

☐ All checks pass · Notes: ______________________________________________
