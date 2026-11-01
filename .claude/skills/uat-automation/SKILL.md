---
name: uat-automation
description: Turn a PR's manual UAT sheet (docs/uat-*.md) into automated tests named after its row IDs, independently of the agent that wrote the code. Use when asked to automate, verify or close off a UAT sheet for a branch. Never changes production code; failing rows are reported as defects.
---

# UAT automation

You automate a UAT sheet that someone else wrote for code someone else wrote. You are the independent check. Your job is to prove each row, not to make rows pass.

## Hard rules

- **Never change production code to make a row pass.** That covers `app/src/**` (except test files), `supabase/migrations/**`, `supabase/functions/**` (except `*.test.ts`) and `supabase/config.toml` (except adding what a test needs locally, and saying so).
- **A failing row is a defect, not a task.**
  - Keep its test.
  - Record the row ID, the expected and actual result, and the command plus output as evidence.
  - Carry on with the other rows. Report every defect at the end.
- **Never weaken a row** to fit the code. Don't drop rows. Rewording for precision is fine if the expectation is unchanged.
- **Every test you write or cite must be seen failing once for the right reason** (break and revert, below).

## Inputs

You need:
- the branch
- the UAT sheet path
- the spec sections the phase implements (in `docs/gold-due-diligence-spec.md` or similar)
- the PR number

You don't need the implementer's notes; don't ask for them.

**Setup:**
```
git fetch origin && git switch -c uat-<phase> origin/<branch>
cd app && npm ci
```
When done, push with `git push origin HEAD:<branch>`.

## 1. Check the sheet against the spec

Read the spec sections, then the sheet. Every behaviour in scope needs a row with an **ID**, an **action** and an **expected result**:
- every refusal (feature flag off, `aal1` / password-only, wrong role, another reporting entity, anon)
- every validation rule
- every audit row
- every happy path
- atomicity: a failure part-way leaves nothing behind

Add any missing row, marked *(added by UAT)*, and list the additions in your report.

## 2. Automate each row at the lowest layer that can see it

Prefer **black-box** tests through the public boundary over tests of internals.

| Behaviour | Layer | Where | Run with |
|---|---|---|---|
| UI logic, pure rules | Vitest | `app/src/**/*.test.js(x)` | `cd app && npm test` (env below) |
| Edge function logic, fakes only | Deno | `supabase/functions/**/<name>.test.ts` | `cd supabase/functions && deno task test` |
| RLS, grants, constraints, triggers, RPCs, run as the real roles | pgTAP | `supabase/tests/<phase>_uat.test.sql` | `npx supabase test db` |
| Edge functions end to end: real JWT/MFA, storage, DB writes | Playwright API | `app/e2e/<phase>/*.e2e.js` | `npm run uat:<phase>` |
| Flows across pages | Playwright | `app/e2e/<phase>/*.e2e.js` | `npm run uat:<phase>` |

**Naming.** Put the row ID first in every test name, e.g. `6.4 ⚠ — a staff member cannot edit customer details (403 forbidden)`.

**pgTAP:**
- Follow `supabase/tests/05_gold_rls.test.sql`: `begin; select plan(n); … select * from finish(); rollback;`.
- Act as a role with its helpers (`set local role authenticated`, `request.jwt.claims` with `aal`).
- Assert SQLSTATEs (`42501`, `23001`, `23514`) rather than message text unless the message is the row's point.

**Deno:**
- Follow `supabase/functions/_shared/goldAuth.test.ts` and `complete-transaction/index.test.ts`.
- Fake clients, no network.

**Playwright:**
- Reuse `app/e2e/support/`:
  - `auth.js`: `signedInContext(browser, 'admin' | 'staff')`, `ACCOUNTS`, `signIn`, `completeMfa`
  - `db.js`: `sql`, `invokeFunction`, `transactionId`, `objectExists`, `putObject`
  - `wizard.js` for TTR pages
- For API rows, take the access token from the signed-in context's storage state and call `${API_URL}/functions/v1/<name>` with `apikey` + `Authorization: Bearer`. Assert status, body and the rows it wrote via `sql`.
- Register a project in `app/playwright.config.js` (`{ name: '<phase>', testDir: './e2e/<phase>' }`).
- Add `"uat:<phase>": "npx supabase db reset && playwright test --project=<phase>"` to `app/package.json` and append it to the `uat` chain, so CI's `uat` job runs it.
- If functions need a secret locally (e.g. `GOLD_JOURNEY_ENABLED=true`), find how the local stack provides it (`supabase/functions/.env`, `config.toml` `[edge_runtime.secrets]`) and state it in the sheet and PR.

**A rule table** (a sheet of situations → answers) gets one test per row, plus a guard test that the sheet's row IDs equal the tests' IDs. See `app/src/lib/goldRules.signoff.test.js`.

**Citing an existing test** for a row, including one the implementer wrote, is allowed only if you:
1. read it,
2. confirm it asserts that row's expectation, not something nearby, and
3. see it fail under a deliberate break.

Otherwise write your own.

## 3. Break and revert, for every test you write or cite

1. Make the smallest production change that should violate the row: flip a comparison, drop a check, grant a role, delete a trigger line.
2. Run the test and confirm it fails **with a message about that row's behaviour**. A setup error doesn't count.
3. Revert with `git checkout -- <file>`, re-run, and confirm it passes.
4. Before committing, `git diff --stat` must show **no production files**.

Record each break in your report, one line per row: `6.4: removed minRole manager → test failed with 200 ≠ 403`.

## 4. The shared local stack

Every worktree shares one local Supabase stack (the same Docker containers and ports) and the Vite port `5199`. Run `db reset`, `test db`, `npm run uat*` and `functions serve` only under the lock, and reset first so the stack has your branch's migrations:

```
L="C:/Users/MOHAME~1/AppData/Local/Temp/claude/c--Personal-Projects-compliance-capture-platform/208c00bf-83c3-4a6c-8bab-1e65879562e4/scratchpad/ccp-local-db.lock"
until mkdir "$L" 2>/dev/null; do sleep 20; done; trap 'rmdir "$L"' EXIT
npx supabase db reset && npx supabase test db && (cd app && npm run uat:<phase>)
```

Hold the lock for one batch of commands, not between edits.

Vitest needs CI's placeholder env:
`VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder-anon-key npm test`

## 5. Rewrite the sheet

Use the format of `docs/uat-gold-05-schema.md` and `docs/uat-gold-03-picker-idle.md`.

**Header:** purpose, the environment/commit/run-by table, timing.

**Section A · Automated rows:**
- the commands to run
- ☐ CI green on this commit
- a table of `#`, what is proved and **Covered by** (file + test name)

**Section B · Manual test for the user.** Only what local tests can't see:
- hosted settings
- deploying to dev
- secrets
- the Vercel preview
- a real camera or device

Keep it to **10 minutes or less**. Spell out every step with exact dummy data (names, DOBs, document numbers, amounts, references), and give each expected result its own ☐. Put "before you start" setup (which project, which preview, which account) at the top.

**Footer:**
- "What a failure looks like" notes, useful when CI goes red
- a sign-off line: `☐ Section A green on commit ___ · ☐ Section B · Notes`

**Every row** has either a covering test or a stated reason it can only be checked on the hosted project.

## 6. Finish

1. All green, with the lock held where needed:
   - `deno task test`
   - `npx supabase test db`
   - `npm test` (placeholder env)
   - `npm run lint`, `npm run format:check`
   - `npm run uat`, which includes your project
2. Commit only tests, test config, test scripts and the sheet. End each message with the attribution line you were given.
3. Push to the phase branch. Add a "UAT" section to the PR body (`gh pr edit <n> --body-file …`, keeping the existing body) covering:
   - rows automated, by layer
   - rows added by UAT
   - the manual section's length
   - defects, if any
4. **Report:**
   - rows automated (count per layer)
   - rows added
   - break-and-revert lines
   - **defects** (row, expected, actual, evidence)
   - files committed
   - the final CI status
