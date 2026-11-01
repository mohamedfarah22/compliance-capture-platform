# UAT: Journey picker, `/start` and 10-minute idle sign-out (Gold Phase 3)

**Purpose:** prove the changes on `gold/03-picker-idle` work and that TTR still runs as before:
1. After sign-in and MFA, staff land on a journey picker at `/`. TTR starts at `/start`.
2. The Gold card and `/gold` only exist while `VITE_GOLD_JOURNEY_ENABLED` is on
3. The Reports card shows for admins only
4. Staff are signed out after 10 minutes without activity, across all tabs, and an unfinished TTR is cleared from the browser (but not lost: the draft can be reopened by reference)
5. The login redirect rules from the security hardening work still hold

This sheet does not re-prove TTR report content. [uat-test-matrix.md](uat-test-matrix.md) covers that.

| | |
|---|---|
| Environment | ________ |
| Build/commit | ________ |
| Run by / date | ________ |

**Timing.** About 10 minutes. Nothing needs a stopwatch: the 10-minute timer is tested with a fake clock.

---

## A · Automated rows

The `frontend` CI job runs these on every push (`cd app && npm test`).

☐ The `frontend` job is green on this commit

| # | What is proved | Covered by |
|---|---|---|
| 3.1 | After both factors a signed-in visitor lands on the journey picker at `/`; staff see the TTR and Gold cards and no Reports card | `app/src/pages/login/LoginPage.test.jsx` ("sends an already fully-authenticated visitor straight through"), `app/src/__tests__/journeyRouting.test.jsx` ("shows the journey picker at /", "is hidden from staff", "shows the Gold card … while the flag is on") |
| 3.2 ⚠ | The TTR card opens `/start`; **Start New Transaction** goes to `/start`, not the picker; **Exit** goes to `/start` | `journeyRouting.test.jsx` ("opens the transaction start screen from the TTR card"), `TransactionCompletePage.test.jsx` ("starts the next transaction at /start, not the journey picker"), the Exit test in `RecipientDeliveryPage.test.jsx`, `BullionDetailsPage.test.jsx` and `PreciousMetalDetailsPage.test.jsx` |
| 3.3 | Admins see the Reports card; on Reports the header **New transaction** link goes to `/start` | `journeyRouting.test.jsx` ("is shown to admins"), `WizardFrame.test.jsx` ("shows a New transaction link to /start instead of Reports on /reports") |
| 3.4 | With the flag off: no Gold card, and `/gold` and `/gold/customers/new` go back to `/` | `journeyRouting.test.jsx` ("hides the Gold card and sends /gold back to the picker while the flag is off") |
| 3.5 ⚠ | Still signed in at 9:59 of inactivity, signed out at 10:00; the unfinished transaction is removed from session storage; the sign-in page says **"You were signed out after 10 minutes without activity."** | `app/src/context/AuthContext.idle.test.jsx` ("keeps the session at 9:59 … and ends it at 10:00", "clears an unfinished transaction from the browser"), `LoginPage.test.jsx` ("tells the user why they were signed out after sitting idle") |
| 3.6 ⚠ | The idle sign-out deletes nothing on the server: it calls the same `signOut()` as the Sign out button, which only clears the browser and ends the session | `AuthContext.idle.test.jsx` (the Supabase mock has only `auth`, so any server call would fail the test). Resuming the draft is checked on the preview in P3 below |
| 3.7 | Activity in another tab keeps every tab signed in; a click, key press or touch restarts the 10 minutes; a hidden tab that comes back after 11 minutes signs out at once | `AuthContext.idle.test.jsx` ("counts activity in another tab", "starts the 10 minutes again", "signs out at once when a hidden tab comes back after 11 minutes") |
| 3.8 ⚠ | A review link with its token survives sign-in; `//example.com`, `https://…` and `/\…` land on `/` and never leave the app | `app/src/lib/safeRedirect.test.js`, `LoginPage.test.jsx` ("carries the originally requested page through the second factor", "drops a requested page outside the app") |
| 3.9 | Existing TTR behaviour | the rest of `npm test` and the `functions` CI job. Until the Playwright `uat` job runs on these PRs, also run the sign-in rows and the AUSTRAC smoke rows R24–R26 of [uat-test-matrix.md](uat-test-matrix.md) |

## B · On the preview deploy

What the local tests can't see: the build's environment variables, the hosted project's session settings, and the real camera.

**Setup.**
- A **Vercel preview deploy** of `gold/03-picker-idle`, pointing at the **dev** Supabase project, with `VITE_GOLD_JOURNEY_ENABLED=true` set for **Preview only**. Redeploy after setting it, because Vite reads it at build time.
- One **staff** account, enrolled in MFA.
- DevTools open on the **Console** tab. Any new error fails the row you were on.

| # | Do this | Expect |
|---|---|---|
| P1 | Vercel → Project Settings → Environment Variables. Then the dev Supabase project → Authentication → Sessions | ☐ `VITE_GOLD_JOURNEY_ENABLED` is set for **Preview** only, not Production ☐ Access token (JWT) expiry is **300 seconds** ☐ Session inactivity timeout is **10 minutes** (if your plan doesn't offer it, note that here) |
| P2 ⚠ | Sign in as **staff**, enter the code. Click the TTR card and complete a TTR end to end (scenario `Sell bullion to customer`, reference `UAT-PICK-001`, one individual customer, ID with the camera). Click **Start New Transaction** | ☐ Lands on `/`, with TTR and Gold cards and no Reports card ☐ The camera works and the transaction completes ☐ **Start New Transaction** goes to `/start` |
| P3 ⚠ | On `/start` enter scenario `Sell bullion to customer` and reference `UAT-IDLE-001`, continue, and create customer `Ida` `Idle`, DOB `04/04/1990`. Click **Sign out**. Sign back in, click the TTR card, choose the scenario, type `UAT-IDLE-001` and tab out | ☐ After signing out, DevTools → Application → Session Storage has no `ttr.*` entries ☐ "Existing draft found — fields pre-filled." ☐ **Start Transaction** resumes at **Add Customers / Parties** with `Ida Idle` listed |
| P4 | After merge, open Production's `/` | ☐ No Gold card |

**What a failure looks like:**
- **A test in section A fails.** The test name says which behaviour broke. For 3.2, a link in the TTR flow points at `/` instead of `/start`.
- **P2 shows no Gold card, or P4 shows one.** The flag's Vercel scope is wrong. Fix the scope and redeploy.
- **P3 shows no draft.** The draft row was deleted: check `cleanup-stale-drafts` has not been run, and that the same account's reporting entity is being used.
- **Staff are signed out partway through active work on the preview.** Check P1: with a JWT expiry longer than 300 seconds the tab doesn't refresh often enough, and the 10-minute session inactivity limit ends the session.

---

## Sign-off

☐ Section A green on commit ________ · ☐ P1–P3 · ☐ P4 after merge · Notes: ______________________________________________
