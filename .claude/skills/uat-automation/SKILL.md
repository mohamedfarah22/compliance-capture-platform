---
name: uat-automation
description: Turn a PR's manual UAT sheet (docs/uat-*.md) into automated tests named after its row IDs, independently of the agent that wrote the code. Use when asked to automate, verify or close off a UAT sheet for a branch. Never changes production code; failing rows are reported as defects.
---

# UAT automation

You automate a UAT sheet that someone else wrote for code someone else wrote. You are the independent check. Your job is to prove each row, not to make rows pass.

## Hard rules

- **Never change production code to make a row pass.** That covers `app/src/**` (except test files), `supabase/migrations/**`, `supabase/functions/**` (except `*.test.ts`) and `supabase/config.toml` (except adding what a test needs locally, and saying so).
- **A failing row is a defect, not a task.**
  - Keep its test, failing. **No `test.fail`, `test.skip`, `fixme` or similar**: CI stays red until the defect is fixed, so nobody can merge past it.
  - Record the row ID, the expected and actual result, and the command plus output as evidence.
  - Carry on with the other rows. Report every defect at the end.
- **Never weaken a row** to fit the code. Don't drop rows. Rewording for precision is fine if the expectation is unchanged. A faster test that proves the same expectation is fine too (e.g. a 1-second signed URL to prove expiry instead of waiting 5 minutes): say so in the sheet and the report.
- **Every test you write or cite must be seen failing once for the right reason** (break and revert, below).
- **No Claude attribution in commits**: no `Co-Authored-By` line or anything like it.

## Inputs

You need:
- the branch
- the UAT sheet path
- the spec sections the phase implements (in `docs/gold-due-diligence-spec.md` or similar). They are the source of truth: you derive cases from them yourself (step 1)
- the PR number

You don't need the implementer's notes; don't ask for them.

**Setup:**
```
git fetch origin && git switch -c uat-<phase> origin/<branch>
cd app && npm ci && npx supabase --version   # must print 2.x (the pinned devDependency), not 3.x
```
When done, push with `git push origin HEAD:<branch>`.

## 1. Derive the cases from the spec, then check the sheet

The spec is the source of truth, not the sheet and not the code.

1. **Read the spec sections in full before you open the sheet.** List the cases they require in your own words, each citing its clause (e.g. `§4.3 bullet 4`). Cover:
   - every refusal (feature flag off, `aal1` / password-only, wrong role, another reporting entity, anon)
   - every validation rule, with its **boundaries** (exactly at a threshold, one under, blank, null, malformed)
   - every rule that is "re-checked on the server", sent with a client value that lies
   - every audit row (who, when, old → new)
   - every happy path
   - atomicity: a failure part-way leaves nothing behind, in rows and in storage
   - anything the spec says must **not** change (immutability, past records untouched)
   - every uniqueness or "only one" rule under **concurrency** (two requests at once)
2. **Then read the sheet** and compare. Each of your cases must map to a sheet row with an **ID**, an **action** and an **expected result**.
3. **Add every missing case as a new row**, marked *(added by UAT)*.
   - Give it the next ID in the sheet's numbering.
   - Cite the spec clause it comes from.
   - Automate it like any other row.
4. **Keep doing this while you automate.** Writing a test often exposes a case the spec implies but nobody listed. Examples: a second role that should also be refused, a field the spec makes immutable, a joint-seller variant of a single-seller rule. Add it as a row then, instead of leaving it for later.
5. **When the spec and the sheet disagree,** the spec wins.
   - Write the row and its test to the spec.
   - Note the disagreement in your report.
   - If the code then fails that row, it's a defect.
   - If the spec itself is ambiguous, don't guess: list it under "spec questions" in your report, with the clause and the two readings.

Report every added row: its ID, the spec clause, and whether it passed.

## 2. Automate each row at the lowest layer that can see it

Prefer **black-box** tests through the public boundary over tests of internals.

| Behaviour | Layer | Where | Run with |
|---|---|---|---|
| UI logic, pure rules | Vitest | `app/src/**/*.test.js(x)` | `cd app && npm test` (env below) |
| Edge function logic, fakes only | Deno | `supabase/functions/**/<name>.test.ts` | `cd supabase/functions && deno task test` |
| RLS, grants, constraints, triggers, RPCs, run as the real roles | pgTAP | `supabase/tests/<phase>_uat.test.sql` | `cd app && npx supabase test db --workdir ..` |
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
- **Feature-flag-off rows go here**: the secret can't be toggled on the running local stack, so drive each function's handler with the flag off. See `supabase/functions/_shared/gold06Flag.test.ts`.

**Playwright:**
- Reuse `app/e2e/support/`:
  - `auth.js`: `signedInContext(browser, 'admin' | 'staff')`, `ACCOUNTS`, `signIn`, `completeMfa`
  - `db.js`: `sql`, `invokeFunction`, `transactionId`, `objectExists`, `putObject`
  - `wizard.js` for TTR pages
- For API rows, take the access token from the signed-in context's storage state and call `${API_URL}/functions/v1/<name>` with `apikey` + `Authorization: Bearer`. Assert status, body and the rows it wrote via `sql`.
- **Make sign-in survive a worker restart.** Playwright restarts the worker after a failure. A setup that enrols MFA must reuse or first delete the test users' factors (`auth.mfa_factors`), or one failure knocks out every test after it.
- **Use only the auth client in e2e support**, never a full `createClient` with realtime: CI's Node 20 has no `WebSocket`, so the first test fails and the rest are skipped.
- Keep files independent rather than `serial`, so a failure doesn't skip its neighbours.
- **Concurrency rows need a deterministic test.** Two calls fired with `Promise.all` only sometimes overlap, so the race test can pass with the guard removed. Hold the lock (or an uncommitted conflicting row) from a second database connection, and assert that the call waits, then is refused once you commit. See 7.58 and 7.59 in `app/e2e/gold07/`. Keep the plain race test too, since it is what proves the defect exists.
- Register a project in `app/playwright.config.js` (`{ name: '<phase>', testDir: './e2e/<phase>' }`).
- Add `"uat:<phase>": "npx supabase db reset && playwright test --project=<phase>"` to `app/package.json` and append it to the `uat` chain, so CI's `uat` job runs it.
- If functions need a secret locally (e.g. `GOLD_JOURNEY_ENABLED=true`), find how the local stack provides it (`supabase/functions/.env`, `config.toml` `[edge_runtime.secrets]`) and state it in the sheet and PR.

**A rule table** (a sheet of situations → answers) gets one test per row, plus a guard test that the sheet's row IDs equal the tests' IDs. See `app/src/lib/goldRules.signoff.test.js`.

**Citing an existing test** for a row, including one the implementer wrote, is allowed only if you:
1. read it,
2. confirm it asserts that row's expectation, not something nearby, and
3. see it fail under a deliberate break.

Otherwise write your own.

## 3. Break and revert, once per behaviour

Every test must be seen failing once, but one break may cover all the rows that prove the same behaviour.

1. Make the smallest production change that should violate the behaviour: flip a comparison, drop a check, grant a role, delete a trigger line.
2. Run its tests and confirm each fails **with a message about that row's behaviour**. A setup error doesn't count.
3. Revert with `git checkout -- <file>`, re-run, and confirm they pass.
4. Before committing, `git diff --stat` must show **no production files**.

**To save time and usage:**
- Put several breaks that don't touch the same behaviour into **one** `db reset` and one run, then check that each target failed for its own reason.
- Never re-run a batch that already gave a clear result.
- After each batch, commit your test changes locally and add one line to a progress note at the bottom of the sheet (batches done, breaks left). A stall or rate limit then loses nothing, and a resume starts where you stopped.

Record each break in your report, one line per behaviour: `6.38, 6.39, 6.111: phone minimum 8 → 7 → all three failed (201 ≠ 400)`.

**Re-verifying a fix** (after the implementer fixes a defect you reported):
1. `git pull --ff-only`, and read the fix.
2. Break the fix once and see the row fail.
3. Revert, then run only your phase project (`npm run uat:<phase>`), plus the Vitest/Deno/pgTAP suite the fix touched. Don't run the full `npm run uat` locally: CI's `uat` job runs the whole chain on your push.
4. Mark the defect fixed (with the commit) in the sheet and the PR body, push, and wait for CI. If `uat` goes red in another phase's project, that is the regression check doing its job: investigate it as in §6.

## 4. The shared local stack

Every worktree shares one local Supabase stack (the same Docker containers and ports) and the Vite port `5199`. Run `db reset`, `test db`, `npm run uat*` and `functions serve` only under the lock, and reset first so the stack has your branch's migrations.

**Use the pinned CLI.** A bare `npx supabase` outside `app/` resolves the latest CLI (3.x), which rejects `[inbucket]` in `config.toml`, so every start and reset fails. Run the CLI from `app/` with `--workdir ..` (it then uses the `supabase` devDependency), or call `npx supabase@2.122.1`.

```
cd app
L="$(cd "$(git rev-parse --git-common-dir)" && pwd)/ccp-local-db.lock"   # shared by every worktree
until mkdir "$L" 2>/dev/null; do sleep 20; done
echo "<your agent id> $(git branch --show-current) $(date -Iseconds)" > "$L/owner"
trap 'rm -rf "$L"' EXIT
npx supabase db reset --workdir .. && npx supabase test db --workdir .. && npm run uat:<phase>
```

Hold the lock for one batch of commands, not between edits. **Only the owner removes the lock.** If you've waited more than 30 minutes, read `$L/owner` and tell your coordinator; don't clear it yourself. A coordinator clears a stale lock only after confirming its owner has stopped *and* no `supabase`, `docker exec` or `playwright` process from that run is still going.

The local edge runtime serves functions from the directory where `supabase start` was run, not from your current worktree. `db reset` only reapplies migrations. When a test calls functions your branch adds or changes, run this from your worktree's `app/`, under the lock:

```
npx supabase stop --workdir .. && npx supabase start --workdir .. && npx supabase db reset --workdir ..
```

Then call your functions.

Vitest needs CI's placeholder env:
`VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder-anon-key npm test`

## 5. Rewrite the sheet

Use the format of `docs/uat-gold-06-customer-writes.md` and `docs/uat-gold-07-purchase-writes.md`.

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

Keep it to **10 minutes or less**. Write it for how the user actually tests:
- **Postman, not curl.** For each request, give:
  - method and full URL
  - Headers: `apikey` = the dev anon key. Authorization tab → Bearer Token = the `access_token` from the `sb-<ref>-auth-token` Local Storage entry.
  - Body:
    - form-data rows (key, Text or File, exact value)
    - or raw JSON
    - say "don't add a Content-Type header" for form-data
- **One admin account.** Dev has a single admin. Use that token throughout, and leave role refusals to the automated rows.
- **Reuse dummy data** that earlier phases left on dev rather than inserting new rows, e.g. customer Lena Hostedsix, `174fb856-4049-4c1a-a4c7-5440940ff088`, with a valid licence.
- **Deploy with the pinned CLI:**
  ```
  cd app
  npx supabase db push --linked --workdir ..
  npx supabase functions deploy <names> --project-ref rygjssczdoyvmumxmymc --workdir ..
  ```
- **Service-role calls on dev** use the `sb_secret_…` key, for both `apikey` and Bearer. The legacy `service_role` JWT is rejected there.
- **Photo uploads** need a real JPEG under the size limit, such as a Windows Camera app photo. iPhone HEIC files are refused.

Spell out every step with exact dummy data (names, DOBs, document numbers, amounts, references), and give each expected result its own ☐. Put "before you start" setup (which project, which preview, which account, which worktree) at the top.

**Footer:**
- "What a failure looks like" notes, useful when CI goes red, including:
  - a `PGRST…` code or "Empty or invalid json" means the request went to `/rest/v1`, not `/functions/v1`
  - `invalid_request` means the form-data or payload JSON is malformed
  - `unauthorized` means the token expired or wasn't sent
- a sign-off line: `☐ Section A green on commit ___ · ☐ Section B · Notes`

**Every row** has either a covering test or a stated reason it can only be checked on the hosted project.

## 6. Finish

1. All green, with the lock held where needed:
   - `deno task test`
   - `npx supabase test db --workdir ..` (from `app/`)
   - `npm test` (placeholder env)
   - `npm run lint`, `npm run format:check`
   - `npm run uat`, which includes your project

   The only exception is the tests of defects you're reporting, which stay red.
2. Commit only tests, test config, test scripts and the sheet. No Claude attribution.
3. If the PR conflicts with `main` (a sibling phase merged first), `git merge origin/main`. Keep both sides in the `uat` chain, `playwright.config.js` and `config.toml`, then re-run the full chain.
4. Push to the phase branch. Add a "UAT automation (independent)" section to the PR body, keeping the existing body:
   ```
   GH_TOKEN=$(gh auth token --user mohamedfarah22) gh pr edit <n> --body-file <file>
   ```
   The default `gh` account can't edit this repo. Cover:
   - rows automated, by layer
   - rows added by UAT
   - the manual section's length
   - defects, if any
5. **CI.** Wait for `gh pr checks <n>`.
   - If `uat` fails in **part0** on R11/R18/R24/R27, stuck on `/id-verification`, that's known issue #20 (a StrictMode double load). Re-run the failed job once (`gh run rerun <id> --failed`) before investigating, and say so in your report.
6. **Report**, concisely:
   - rows automated (count per layer)
   - rows added (ID, spec clause, passed or defect) and any spec questions
   - break-and-revert lines
   - **defects** (row, expected, actual, evidence)
   - files committed
   - the final CI status
