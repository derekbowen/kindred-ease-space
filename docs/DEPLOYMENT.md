# Deployment

## The short version

founders.click runs on **Cloudflare Workers**. It always did — Lovable was the
thing that ran `wrangler deploy` on our behalf, not the host. When its GitHub
sync stalled, commits stopped reaching production with no error surfaced
anywhere, and there was no second way to ship.

There are now two workflows in this repository, and neither depends on a third
party being healthy:

| What | Workflow | Trigger |
| --- | --- | --- |
| The application (`founders-click`) | `.github/workflows/deploy-app.yml` | push to `main`, or manual |
| The edge proxy (`founders-edge`) | `.github/workflows/deploy-edge-worker.yml` | manual only, type `deploy` |

The split in trigger is deliberate. A bad app deploy breaks founders.click and
customers' `/a/*` SEO pages — bad, but the edge fails open so their actual
marketplace keeps serving. A bad **edge** deploy sits in the request path of
their production domains. One is a release; the other is a decision.

## Nothing about the stack has to move

- **Supabase is not Lovable's.** It is a standalone project — Lovable's own API
  reports `database_not_managed` for it. Data, migrations, RLS and edge
  functions are unaffected by any of this.
- **Cloudflare is already ours.** The zone, the custom hostnames and the edge
  Worker all live in our own account.
- **The build already targets Cloudflare.** `npm run build` emits
  `.output/server/wrangler.json` (worker `founders-click`, `nodejs_compat`,
  assets binding) plus `.wrangler/deploy/config.json`, so `wrangler deploy`
  from the repo root needs no extra configuration.

The only remaining coupling is one build-config package,
`@lovable.dev/vite-tanstack-config`, which wraps the TanStack Start, React,
Tailwind and Cloudflare Vite plugins. It is a normal npm dependency and does
not phone home at runtime. Replacing it is optional cleanup, not a blocker.

## First-time setup

### 1. GitHub Actions secrets

```
CLOUDFLARE_WORKER_DEPLOY_TOKEN   Account → Workers Scripts:Edit
                                 Zone    → Workers Routes:Edit (founders.click)
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_ZONE_ID               (optional; enables the edge workflow's
                                  route-preservation check)
```

Setting these in Lovable does nothing — GitHub Actions cannot read Lovable
Cloud Secrets. Both workflows preflight for exactly this and say so.

### 2. Worker secrets (once, not per deploy)

Worker secrets persist across deploys, which is why the workflow never touches
them: a CI log can then never contain one, and rotating a key does not mean
editing a workflow file.

```bash
cd .output/server        # after npm run build, so wrangler.json exists
for k in SUPABASE_URL SUPABASE_PUBLISHABLE_KEY SUPABASE_SERVICE_ROLE_KEY \
         SERVICE_ROLE_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ZONE_ID \
         CLOUDFLARE_EDGE_WORKER EMAILIT_API_KEY FROM_EMAIL \
         SUPPORT_INBOX_EMAIL PUBLIC_APP_URL CRON_SECRET \
         PLATFORM_AI_MODEL AI_CREDIT_VALUE_MICROS AI_CREDIT_MARKUP \
         OPPORTUNITY_ENGINE_ENABLED; do
  npx wrangler secret put "$k"
done
```

`CLOUDFLARE_API_TOKEN` here is the **provisioning** token (custom hostnames,
SSL, routes). It is a different credential from
`CLOUDFLARE_WORKER_DEPLOY_TOKEN` and must stay that way: the provisioning token
has no Workers permission and cannot deploy, and application code must never
read the deployment token. See `edge/founders-edge/README.md`.

## Cutting over from the Lovable-run deploy

The first deploy is **safe and reversible**: it publishes a Worker named
`founders-click`, and until a route points at it, it serves nothing on the real
domain. So deploy first, verify, then switch.

1. **Deploy.** Push to `main`, or run the workflow manually. It typechecks,
   runs the tests, builds, and deploys.
2. **Verify the new Worker before sending traffic to it.** In the Cloudflare
   dashboard, enable the workers.dev subdomain for `founders-click` temporarily
   and load it. Canonicals are absolute to `https://www.founders.click`
   (`src/lib/canonical.ts`), so the preview cannot create duplicate-content
   URLs. Turn it back off afterwards.
3. **Cut over.** Point the `www.founders.click/*` route at the `founders-click`
   Worker. Keep the old deployment in place — do not delete it.
4. **Confirm the release is really live.** `POST /api/public/edge-health` must
   return 202, not 404. A 404 means the route is still serving the old build.
   Checking a route the release *added* is the only reliable test; a green
   deploy log is what was trustworthy right up until it wasn't.
5. **Watch a customer domain.** `https://<customer>/a/<slug>` must still serve,
   and their marketplace root must still reach their own origin.

### Rolling back

Cloudflare keeps previous Worker versions. Roll back in the dashboard
(Workers → founders-click → Deployments), or point the route back at the prior
deployment. Nothing in the database changes on an app deploy, so a rollback is
a routing change and not a data operation.

## What is deliberately NOT automated

- **Worker routes.** The control plane creates and deletes one route per
  connected customer hostname during domain provisioning. Neither workflow
  declares routes, so a deploy from a stale checkout can never drop a live
  customer. The edge workflow counts routes before and after and fails if the
  number dropped.
- **Supabase migrations.** Applied deliberately, reviewed, with the
  verification block at the bottom of each file read before moving on. A schema
  change that lands automatically at the same moment as the code that needs it
  removes the ordering control that keeps a bad migration from becoming an
  outage.
- **Edge Worker deploys.** Manual, with a typed confirmation.
