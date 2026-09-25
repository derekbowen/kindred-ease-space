# Tests

These are plain assertion scripts, not a test framework. Each file runs top to
bottom, prints PASS/FAIL lines, and exits non-zero on failure. Run them with
`bun`.

```bash
npm test            # every offline suite — no credentials, no network
npm run test:pg         # real-PostgreSQL 16 concurrency proof (AI_PG_URL), see below
npm run test:security   # credentialed regression test, see below
python3 tests/e2e/smoke.py   # browser E2E, see tests/e2e/README.md
```

## Offline suites (`npm test`)

| File | Covers |
|---|---|
| `opportunity-intent.test.ts` | intent-cluster keys, geo/category normalization, duplicate detection |
| `opportunity-gates.test.ts` | opportunity gate precedence and configurable thresholds |
| `site-scan-robots.test.ts` | robots.txt group semantics, sitemap-vs-content URL classification |
| `marketplace-adapter.test.ts` | marketplace route construction, unsupported-filter omission, inventory freshness |
| `ai-spend-sql.test.ts` | the AI spend migration (000800) in PGlite: reserve / mark / settle / release, grants, money on two books, kill switch, ceiling, rate limit, reaper, briefing claim, rollback |
| `ai-provider.test.ts` | the OpenAI provider module against a fake Responses API: every outcome, pinned client, no retries, redaction, the settle mapping |
| `ai-flows.test.ts` | every Worker AI route driven end to end (fake PostgREST + fake OpenAI): order, limits, refusals, settlement |
| `ai-source-guards.test.ts` | strict AI inputs, auth, one client, one spend path, no other provider, legacy endpoints gone |
| `ai-allowance.test.ts` | the one allowance endpoint (getAiAllowance) |
| `ai-customer-messages.test.ts` | every AI customer sentence passes isCustomerSentence |
| `prnm-isolation.test.ts` | the deployed-only PRNM functions stay unreachable; user_roles cannot be self-escalated |
| `coach-briefing.test.ts` | (with the Deno preload) one AI call and one stored briefing per workspace per day under concurrency |

The rest of the chain is listed in `package.json` (`"test"`).

## `test:pg` is separate on purpose

`ai-concurrency.pg.ts` races real connections on a real PostgreSQL 16: 50
simultaneous calls through the real `runMeteredAiCall` against an allowance for
10, one shared request id, a platform ceiling, the kill switch, and the brief's
(a)–(e) at 20 connections. Point it at a throwaway cluster (it creates and drops
its own database):

```
AI_PG_URL=postgres://postgres@127.0.0.1:<port>/postgres bun run test:pg
```

Without `AI_PG_URL` it prints a loud SKIPPED banner and exits 0 — which is why
it is not in `npm test`.

## `test:security` is separate on purpose

`security-entitlement-writes.test.ts` is the permanent regression test for the
2026-08-30 privilege escalation. It authenticates as a real low-privilege user
against a real Supabase project and attempts the exact writes that were
possible. It therefore needs live credentials:

```
SUPABASE_URL  SUPABASE_ANON_KEY  TEST_EMAIL  TEST_PASSWORD
```

It exits 2 when those are missing. That is why it is not in `npm test` — a
missing-credentials skip must never be mistaken for a passing security check.
Run it against staging or production after any migration that touches
`workspaces`, `workspace_members`, or entitlement columns.

## Note for whoever adds a test framework

These files match the `tests/**/*.test.ts` glob that Vitest and Jest collect by
default, but they call `process.exit()` and register no test cases — a runner
will report them as failures even when every assertion passes. Either exclude
`tests/*.test.ts` from the runner's config or port the assertions to it
properly. Don't conclude from a red runner that the logic is broken; run
`npm test` to see the real result.
