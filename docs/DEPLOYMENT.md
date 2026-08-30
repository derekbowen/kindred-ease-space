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

Two remain. Only one is in the deployment chain, and it is build-only.

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
It is an ordinary npm package pinned in `bun.lock`; if Lovable vanished
tomorrow, the pinned version keeps building.

*Post-launch:* inline the plugin list and drop the wrapper, verifying the
built output is byte-identical first.

### `ai.gateway.lovable.dev` — runtime, still live

**This one is not build tooling and is not removed by any of the above.**
`LOVABLE_API_KEY` against `https://ai.gateway.lovable.dev` is the default AI
provider for the SEO coach, the page auditor, and the help assistant
(`coach-actions.functions.ts`, `admin-seo-coach.functions.ts`,
`admin-page-auditor.functions.ts`, `supabase/functions/help-assistant-*`).

Removing Lovable from the *deployment* chain does not remove it from the
*product*. There is a BYOK abstraction (`ai-byok.functions.ts`, Settings → API
Keys) so a workspace can supply its own provider key, but the platform default
still routes through Lovable. Treat that as a live vendor dependency on the AI
path and price it accordingly.

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
for k in $(grep -vE '^\s*#|^\s*$' ../../scripts/required-secrets.txt | awk '{print $1}'); do
  bunx wrangler secret put "$k"
done
bunx wrangler secret list  # confirm
```

The authoritative list, with the purpose of each, is
`scripts/required-secrets.txt`. Adding a runtime dependency means adding it
there, or the preflight will not know to check for it.

## Cutting over

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
