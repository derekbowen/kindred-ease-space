# Deployment

## GitHub Actions is the canonical production path

`.github/workflows/deploy-app.yml` is **authoritative** for founders.click.

**Publishing from Lovable is not a release.** It must not be used to ship
founders.click, and a Lovable publish does not constitute a deployment of
record. This is not a preference — the Lovable relay reported successful
publishes for eleven commits while serving a tree that did not contain them,
and nothing anywhere contradicted it.

| What | Workflow | Trigger |
| --- | --- | --- |
| Application (`founders-click`) | `deploy-app.yml` | push to `main`, or manual |
| Edge proxy (`founders-edge`) | `deploy-edge-worker.yml` | manual only, type `deploy` |

They stay separate, and the edge stays manual until there is production
validation strong enough to trust it unattended. A bad app deploy breaks our
pages while the edge fails open and customers' marketplaces keep serving. A bad
edge deploy sits in the request path of their production domains. One is a
release; the other is a decision.

## Nothing about the stack has to move

- **Supabase is not Lovable's.** Standalone project — Lovable's own API reports
  `database_not_managed`. Data, migrations, RLS and edge functions unaffected.
- **Cloudflare is already ours.** Zone, custom hostnames, edge Worker.
- **The build already targets Cloudflare.** `bun run build` emits
  `.output/server/wrangler.json` and `.wrangler/deploy/config.json`, so
  `wrangler deploy` from the repo root needs no extra configuration.

## Remaining Lovable dependencies, and why

One remains, and it is build-only: an npm package installed from the public
registry like every other dependency.

### The package registry — every dependency from registry.npmjs.org (2026-09-25)

Until 2026-09-25, `bun.lock` resolved 181 of its 804 packages from Lovable's
private npm cache (`europe-west{1,4}-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache`)
— among them `@supabase/supabase-js`, `h3`, `marked`, `nitro`, the rolldown
and oxc native bindings, and the Vite config wrapper below. Their sha512
integrity values protected the content, not the availability: had Lovable
restricted or deleted that registry, `bun install --frozen-lockfile` would
have failed on every CI run, and no release, hotfix or revert-and-redeploy
could have shipped (only `wrangler rollback`, which needs no build, would
still have worked). This document used to claim the pinned version would keep
building if Lovable disappeared; it would not have.

Those entries now resolve from `registry.npmjs.org`, with the same versions
and the same integrity values: all 180 distinct name@version were checked
against the public registry's published sha512 (identical, tarball paths
identical), and a `bun install --frozen-lockfile` from an empty cache, with
every host except registry.npmjs.org unreachable, installs the tree and builds.

Kept that way by `scripts/check-dependency-registry.mjs`, which
`deploy-app.yml` runs before the install and `tests/dependency-registry.test.ts`
runs in `bun run test`: a `bun.lock` entry, `package.json` spec, `.npmrc`,
`bunfig.toml` or workflow setting that points anywhere but registry.npmjs.org
fails the build. When you add or upgrade a dependency, run `bun install` with
no registry override in effect (no `.npmrc`, `bunfig.toml` or
`NPM_CONFIG_REGISTRY` pointing at a mirror): bun writes a mirror's tarball URL
into `bun.lock` for anything it fetched from one — that is how the 181 got
there — and the guard will refuse the commit.

### `@lovable.dev/vite-tanstack-config` — build tooling, retained

A Vite config wrapper bundling the TanStack Start, React, Tailwind,
tsconfig-paths and Cloudflare plugins, plus dev-only tooling.

Audited: **zero runtime footprint.** The built server bundle contains no
reference to the package (`grep -c lovable .output/server/index.mjs` → 0), it
makes no network calls to Lovable at runtime, and its `runtime/fetch-entry.mjs`
is not bundled into the output.

**Retained deliberately.** Replacing it means hand-reassembling the plugin
chain it configures — the file itself warns that adding those plugins manually
produces duplicates that break the app. Doing that during launch recovery would
risk a build regression to remove a dependency that has no production presence.
It is a public npm package (`@lovable.dev/vite-tanstack-config@2.13.1` on
registry.npmjs.org), pinned by version and sha512 in `bun.lock` and installed
from the public registry like everything else — nothing of Lovable's own
infrastructure is in the install path any more. The remaining dependency is on
its publisher: if that version were ever unpublished from npm, a fresh install
would fail until the wrapper is inlined (a deprecation would not stop installs).

*Post-launch:* inline the plugin list and drop the wrapper, verifying the
built output is byte-identical first.

### `ai.gateway.lovable.dev` and OpenRouter — removed from the product (2026-09-25)

Every AI feature founders.click runs — page generation (Quick Page Builder,
Generate Content, the Daily Briefing's city page, the Opportunity Engine), the
Daily Briefing actions, the SEO coach, the page auditor and the daily briefing
itself — now calls OpenAI through the official SDK (`src/lib/ai/openai.server.ts`)
and ONE metered path (`src/lib/ai/spend.server.ts`): an atomic reservation of the
maximum cost before every call, settlement after it (migration
`20260925000800_ai_spend_reservations.sql`). The Lovable AI gateway and
OpenRouter are gone from the code, as are the `ai-proxy` / `coach-chat` /
`help-assistant-chat` / `help-assistant-embed` functions, and the Worker reads
neither `LOVABLE_API_KEY` nor `OPENROUTER_API_KEY`
(`tests/ai-source-guards.test.ts`). Production is a separate matter until the
release is done: those four functions stay deployed and callable until they
are deleted with `supabase functions delete` (each followed by a 404 check),
and the Worker's `OPENROUTER_API_KEY` secret is removed only after the burn-in
— both are steps in `docs/RELEASE_CHECKLIST.md`.

Two deployed-only PRNM functions on the same Supabase project
(`generate-content-batch`, `drive-content-generation`) still use
`OPENROUTER_API_KEY` from Supabase function secrets. They are not part of this
repo and not reachable through founders.click (`tests/prnm-isolation.test.ts`;
operator probe: `scripts/probe-prnm-isolation.ts`). Leave that secret in place.

### AI spend controls (ops)

- **Kill switch** — stops every AI call that would spend the platform key,
  including background jobs and the daily briefing; in-flight calls settle
  normally. Supabase SQL editor, as `postgres`:
  `UPDATE public.ai_platform_settings SET platform_ai_enabled = false, updated_at = now();`
  (`true` to resume). Workspaces on their own key are not affected.
- **Daily ceiling** — `UPDATE public.ai_platform_settings SET daily_budget_micros = 10000000, updated_at = now();`
  ($10.00 per UTC day across all workspaces; the default).
- **Reaper** — pg_cron job `ai-reap-stale-reservations`, every 5 minutes, pure
  SQL: an abandoned hold is released within 15 minutes, an unsettled call
  settled within 35.
- **Page generation pause** — unchanged: `platform_settings.generation_paused`.

## Releasing

The ordered release-day steps — secrets (and how to prove CRON_SECRET is the
same in the Worker, Vault and the briefing function without printing it),
every migration before the Worker deploy, the edge functions with the right
`verify_jwt`, the deploy, smoke checks, the kill-switch drill, the legacy
function deletes and the burn-in cleanup — are in
[`docs/RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md). Follow it in order.

## First-time setup

### 1. GitHub Actions secrets

```
CLOUDFLARE_WORKER_DEPLOY_TOKEN   Account → Workers Scripts:Edit
                                 Zone    → Workers Routes:Edit (founders.click ONLY)
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_ZONE_ID               enables route-isolation + route-preservation checks
```

Minimum scope, founders.click only. The token cannot read Supabase, cannot read
customer data, and cannot create custom hostnames. It is a **different
credential** from the application's `CLOUDFLARE_API_TOKEN` provisioning secret,
which has no Workers permission. Neither may substitute for the other, and
application code must never read the deployment token.

Setting these in Lovable does nothing — GitHub Actions cannot read Lovable Cloud
Secrets. Both workflows preflight for exactly this and say so in the error.

### 2. Worker secrets (once, not per deploy)

Secrets persist across deploys, so CI never handles their values — a workflow
log can then never contain one, and rotating a key does not mean editing a
workflow. CI only *verifies they exist* before deploying, against
`scripts/required-secrets.txt`.

```bash
bun run build              # generates .output/server/wrangler.json
cd .output/server
for k in $(grep -vE '^\s*#|^\s*$|^\[' ../../scripts/required-secrets.txt | awk '{print $1}'); do
  bunx wrangler secret put "$k"
done
bunx wrangler secret list  # confirm
```

The authoritative list, with the purpose of each, is
`scripts/required-secrets.txt`. Adding a runtime dependency means adding it
there, or the preflight will not know to check for it.

One `[required]` name is read only through the BYOK fallback in
`workspace-secrets.server.ts` (`process.env[name]`), so a literal grep for
`process.env.OPENAI_API_KEY` finds nothing and it is easy to leave out:
`OPENAI_API_KEY`, the platform key for every AI feature the Worker runs. The
daily briefing (`coach-briefing-cron`) reads its own `OPENAI_API_KEY` from
Supabase function secrets (`supabase secrets set`), which this Worker preflight
does not cover.

## Cutting over

### Pre-cutover DNS, captured 2026-09-01 — THE ROLLBACK REFERENCE

Before the cutover, founders.click was served by Lovable's hosting through
proxied DNS in our own zone. Not a Worker route, not a custom domain — which is
why every routing check reported "none" while the site was plainly serving.

| Type | Name | Content | Proxy | TTL |
| --- | --- | --- | --- | --- |
| CNAME | `www.founders.click` | `kindred-ease-space.lovable.app` | Proxied | Auto |
| A | `founders.click` (apex) | `185.158.133.1` | Proxied | Auto |

**To roll back the cutover, restore exactly those two rows, including Proxied
status.** While a record is proxied, TTL is forced to Auto and the origin is
masked, so proxy state matters as much as content.

Adding a Worker custom domain REPLACES the matching record, so these values
cannot be read back afterwards. They are recorded here because they are public
DNS, not secrets.

Untouched by the cutover, and listed only so nobody "tidies" them during a
rollback: `notify.www` NS delegation to `ns5/ns6.lovable.cloud`, and the
`_lovable`, `_lovable-email`, `_dmarc` and `emailit._domainkey` TXT records.
Those are separate names from `www` and the apex; replacing a record at `www`
does not affect delegation at `notify.www`.

### Steps

The first deploy is **safe and reversible**: it publishes a Worker named
`founders-click`, and until a route points at it, it serves nothing on the real
domain.

1. **Deploy.** Push to `main`, or dispatch manually.
2. **Verify before sending traffic.** Enable the workers.dev subdomain for
   `founders-click` temporarily and load it. Canonicals are absolute to
   `https://www.founders.click` (`src/lib/canonical.ts`), so the preview cannot
   create duplicate-content URLs. Disable it afterwards.
3. **Cut over.** Point `www.founders.click/*` at the `founders-click` Worker.
   Keep the previous deployment — do not delete it.
4. **Confirm the release is really live:**
   ```bash
   curl -s https://www.founders.click/api/public/edge-health | jq
   # {"sha":"<full commit>","shaShort":"…","builtAt":"…"}
   ```
   The `sha` must equal the commit you deployed. This is the whole point: a
   green deploy log and an existing route both proved nothing.
5. **Watch a customer domain.** `https://<customer>/a/<slug>` must serve, and
   their marketplace root must still reach their own origin.

## Rollback

> **Status: documented, NOT yet exercised against a real prior version.**
> There is currently only one deployment lineage and no CI-published version to
> roll back to. Perform the drill in step 3 below once a second deploy exists,
> and update this line to record the version IDs used.

Cloudflare retains previous Worker versions. Rollback is a routing/version
change only — **no app deploy touches the database**, so nothing needs undoing
on the data side.

```bash
cd .output/server                     # any dir with the generated wrangler.json
export CLOUDFLARE_API_TOKEN=<deploy token>
export CLOUDFLARE_ACCOUNT_ID=<account id>

# 1. List versions, newest first. Note the ID you want.
bunx wrangler versions list --name founders-click

# 2. Roll back. Prompts for confirmation and a reason.
bunx wrangler rollback --name founders-click --version-id <PREVIOUS_VERSION_ID>

# 3. Prove the rollback took effect — do NOT trust the command's own output.
curl -s https://www.founders.click/api/public/edge-health | jq -r .sha
#    must now report the OLDER commit
bun scripts/smoke-production.ts https://www.founders.click
```

Dashboard equivalent: Workers & Pages → `founders-click` → Deployments →
select a prior version → Rollback.

**Re-deploying `main` will undo a rollback.** If you roll back, either revert
the offending commit or the next push republishes the broken build.

## Post-deploy smoke

`scripts/smoke-production.ts` runs automatically after every deploy and can be
run by hand:

```bash
bun scripts/smoke-production.ts https://www.founders.click --sha <commit>
SMOKE_TENANT_PAGE_URL=https://customer.com/a/some-page bun scripts/smoke-production.ts
```

Covers build identity, homepage SSR, auth entry point, static assets, sitemap,
database reachability, telemetry, clean rejection of bad input, and — when
`SMOKE_TENANT_PAGE_URL` is set — a real published page's canonical, structured
data, h1, and absence of `noindex`.

**A SKIP is never a PASS.** Skipped checks are listed separately and never
counted as passing; `--strict` turns them into failures.

## What is deliberately NOT automated

- **Worker routes.** The control plane creates and deletes one route per
  connected customer hostname during provisioning. Neither workflow declares
  routes, and the app workflow asserts on every deploy that `founders-click`
  holds no route outside founders.click, that no wildcard zone route exists,
  and that no hostname is claimed by both Workers. A `*/*` route would swallow
  every request entering the zone — customer domains included.
- **Supabase migrations.** Applied deliberately, with the verification block at
  the foot of each file read before moving on. Coupling a schema change to a
  code deploy removes the ordering control that keeps a bad migration from
  becoming an outage.
- **Edge Worker deploys.** Manual, with a typed confirmation.
