---
name: gold-phase-implementation
description: Build one phase of the gold due-diligence journey (docs/gold-due-diligence-spec.md) on its own branch - code, dev tests, a UAT sheet written from the spec, and a PR. Use when asked to implement or build a gold phase or wave. The UAT sheet is automated afterwards by a separate agent with the uat-automation skill, not by you.
---

# Gold phase implementation

You build one phase of the gold journey: code, your own dev tests, a UAT sheet written from the spec, and a PR. A **separate agent** then automates your UAT sheet with the `uat-automation` skill, and reports any failing row back to you as a defect to fix. Don't automate your own sheet: the split exists so nobody marks their own homework.

## Hard rules

- **The spec is the source of truth** (`docs/gold-due-diligence-spec.md`, the sections your phase implements). Where it's silent, choose, and list the choice in the PR under "Decisions".
- **Never edit a migration that may already be on dev or the client project.** Fixes go in a new migration with the next timestamp.
- **Never edit `_shared/goldAuth.ts` or `_shared/goldRules.js`** without stopping and reporting first. They're shared by the browser, the functions and other phases.
- **Never set `GOLD_JOURNEY_ENABLED` on the client project** (`ykerufaergyqvnaycyce`), not even to test.
- **No Claude attribution in commits**: no `Co-Authored-By` line or anything like it.
- **Don't touch another agent's files.** After the UAT agent starts, `app/e2e/<phase>/**`, `supabase/tests/<phase>_uat.test.sql` and the UAT sheet are its files.

## Inputs

You need:
- the phase number and name
- its spec sections
- the base: `origin/main`, or the top of an unmerged stack
- the migration timestamp prefix for your phase (e.g. `20261108…`). Parallel phases each get their own

**Setup:**
```
git fetch origin && git switch -c gold/0N-<name> origin/main
cd app && npm ci && npx supabase --version   # must print 2.x (the pinned devDependency), not 3.x
```
Read your spec sections in full, and `AGENTS.md`.

## 1. Reuse before you write

- `_shared/goldAuth.ts`: `requireGoldStaff(req, { minRole })`, the **first** thing every gold function does after the CORS preflight. It checks the flag, the JWT, `aal2`, active staff and the role.
- `_shared/goldRules.js`: the rules the browser runs. **Run them again on the server** and never trust a client value for anything the spec says is "re-checked".
- `_shared/goldKeys.ts` and `_shared/supersede.ts`.
- `_shared/goldCustomers.ts` (customer and ID helpers, multipart reading, photo storage) and `_shared/goldPurchaseShared.ts` (purchase and goods-photo helpers).
- The read RPCs from Phases 5 and 6: `linked_parts`, `invoice_purchases`, `customer_ttr_ready`, `customer_current_id`, `find_possible_duplicate_customers`, `get_verification_for_document`.

## 2. How gold functions are built

- **The server sets** `created_by` / `completed_by` / staff IDs, the business and dates, from the verified JWT and the staff row, never from the request.
- **Logs** carry IDs and error codes only, never names, phones, emails, ID numbers or amounts.
- **A multi-row write is atomic.** Use one `SECURITY DEFINER` SQL function per write, granted to `service_role` only, and call it once. Photos are uploaded first (they're hashed). If the SQL call fails, remove them straight away; `reconcile-stored-images` sweeps anything left.
- **`config.toml`:** `[functions.<name>] verify_jwt = true`.
- **A header comment** in each function gives the access rule, the request, every response and error code, what it writes, and the handover `api.js` name (spec §4.6), so the screens phase can wrap it.

**Lessons from earlier phases:**
- **PostgREST maps every `P0*` SQLSTATE except `P0001` to HTTP 500.** A browser-called RPC that needs a 4xx (e.g. "not found") must raise PostgREST's custom error: `RAISE EXCEPTION USING ERRCODE = 'PGRST', MESSAGE = '<json body>', DETAIL = '{"status":404,"headers":{}}'`. Pattern: `supabase/migrations/20261106000003_update_customer_phone_not_found_404.sql`.
- **A "only one" rule checked by read-then-write is racy.** Take `pg_advisory_xact_lock` on the rule's key (e.g. business + normalised invoice number) inside the write function, then re-check against committed data before writing. Pattern: `supabase/migrations/20261107000002_gold_invoice_lock.sql`.
- **`x IN (a, NULL)` is never true, and `NOT (x IN (a, NULL))` is NULL**, so a nullable column in an exclusion list quietly lets rows through. Use `coalesce` or an explicit `IS NULL` branch.

## 3. Your own dev tests

Write the normal tests for your code:
- Deno tests next to each function (fake clients, no network)
- pgTAP for each SQL function, grant and trigger (`supabase/tests/NN_gold_<name>.test.sql`)
- Vitest for any browser code

**Don't** name tests after UAT row IDs, add a Playwright UAT project, or add "Covered by" mappings. The UAT agent does that.

## 4. The UAT sheet

Write `docs/uat-gold-0N-<name>.md` **from the spec, before you run your own code against it**. Don't edit it afterwards to match what your code does: if you find the spec and your code disagree, fix the code or report a spec question.

- **Numbered rows** (`8.1`, `8.2`, …), each with the spec clause it proves, the action and the expected result.
- **Aim for 60 rows or fewer.** One row per behaviour, not one per input: a phone rule is one row covering 7 digits refused, 8 accepted, blank and malformed, not four rows. The UAT agent adds the cases you missed.
- Cover:
  - every refusal (flag off, `aal1`, wrong role, inactive, another business, anon)
  - every rule with its boundaries
  - every server re-check, with a lying client
  - every audit row
  - the happy paths
  - atomicity in rows and storage
  - immutability
  - concurrency for any "only one" rule
- Write the rows as manual steps for now. The UAT agent rewrites the sheet into Section A (automated) and Section B (a 10-minute manual test for the user, in Postman, with a single dev admin account).

## 5. The shared local stack

Every worktree shares one local Supabase stack and the Vite port `5199`. Follow `uat-automation` §4 exactly:
- the lock at `$(git rev-parse --git-common-dir)/ccp-local-db.lock`, with an `owner` file
- the pinned CLI, run from `app/` with `--workdir ..`
- `stop`/`start`/`db reset` from your worktree before calling functions you changed

Run `db reset` first in every batch, so the stack has your migrations.

## 6. Parallel phases

When another phase is being built at the same time:
- Use only your migration prefix.
- Add only your own blocks to `config.toml`, `app/package.json` and `app/playwright.config.js`.
- Own only your helpers. Phases split the `_shared/` files by area (e.g. one owns customer and ID helpers, the other goods photos and `reconcile-stored-images`).
- If the other phase merges first, `git merge origin/main` before your final push.
  - Keep both sides: both projects in the `uat` chain and in `playwright.config.js`, and both phases' `[functions.*]` blocks in `config.toml`.
  - Keep a **single** `[edge_runtime.secrets]` block.
  - Then re-run the full chain.

## 7. Done means

1. Green, with the shared runs under the lock:
   - `cd supabase/functions && deno task test`
   - `cd app && npx supabase db reset --workdir .. && npx supabase test db --workdir ..`
   - `npm test` (placeholder env: `VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder-anon-key`)
   - `npm run lint`, `npm run format:check`
   - `npm run uat`
2. Commits with no Claude attribution.
3. Pushed, with a PR to `main` titled `Gold Phase N: <name>` in the style of #22 and #23:
   - what it adds
   - "Decisions" (where the spec was silent)
   - "Not in this PR"
   - the UAT sheet
   - how to deploy to dev, with the pinned CLI and `--project-ref rygjssczdoyvmumxmymc`
   - how `GOLD_JOURNEY_ENABLED` is set locally (`config.toml` `[edge_runtime.secrets]`) and on dev (`secrets set`), and that it stays off on the client project

   Open it with `GH_TOKEN=$(gh auth token --user mohamedfarah22) gh pr create … --body-file <file>`. The default `gh` account can't open PRs here.
4. **Report, concisely:**
   - the PR URL
   - the files
   - test counts
   - decisions
   - anything deferred

## 8. When the UAT agent reports a defect

You get a row ID, expected and actual results, and evidence.
1. `git pull --ff-only` (the UAT agent pushes to your branch).
2. Fix it in production code, using a new migration for SQL.
3. Update your own dev tests if they asserted the old behaviour.
4. Don't edit the UAT agent's tests or sheet. Run its project (`npm run uat:<phase>`) to see the row pass, then the full chain.
5. Push and report the fix and its commit. The UAT agent re-verifies it independently.

## For the coordinator

- Run one implementing agent per phase, in its own worktree: Sonnet 5.5, effort high.
- When it finishes, start a **fresh** agent with the `uat-automation` skill. It gets the branch, the sheet path, the spec sections and the PR number, nothing from the implementer's report.
- Run **UAT agents one at a time**. They queue on the one local stack, so two at once doesn't save time.
- Route each defect back to the implementer, then have the UAT agent re-verify.
- Never clear the stack lock while an agent might still be running (see `uat-automation` §4).
