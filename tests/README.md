# Tests

These are plain assertion scripts, not a test framework. Each file runs top to
bottom, prints PASS/FAIL lines, and exits non-zero on failure. Run them with
`bun`.

```bash
npm test            # the four offline suites — no credentials, no network
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
