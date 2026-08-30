# Founders Edge — automatic domain publishing

The reverse-proxy layer that serves `customer.com/a/*` from Founders while the
rest of the customer's domain keeps hitting their own website. Zero
per-customer configuration: routing is data (`workspace_domains`), read through
`/api/public/domain-config` and cached at the edge.

```
Visitor → customer.com → Founders Edge (this Worker)
                           ├── /a/*  → www.founders.click (x-forwarded-host: customer.com)
                           └── else  → customer's stored origin (full_proxy mode)
```

## Connection modes

| mode             | customer DNS action                                   | Founders controls        |
| ---------------- | ----------------------------------------------------- | ------------------------ |
| `full_proxy`     | point apex/www at the edge (CNAME/flattened → proxy.founders.click) | whole domain; `/a/*` ours, rest proxied back to their origin |
| `subdomain`      | `CNAME seo → proxy.founders.click`                    | `seo.customer.com` (pages under `/a/*` for URL uniformity) |
| `customer_proxy` | none — they route `/a/*` to us in their own CDN/server | only what they forward   |

A CNAME alone cannot create `customer.com/a/` routing — for `/a/` on the root
domain, Founders must sit in the HTTP path (full_proxy). The app's Settings →
Domains flow encodes exactly that distinction.

## One-time Cloudflare account setup (not per customer)

Per Cloudflare's [Workers as your fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)
guide. Two details are easy to get wrong and both matter:

1. Cloudflare zone for `founders.click`, **Cloudflare for SaaS** enabled
   (SSL/TLS → Custom Hostnames).
2. **Fallback origin = an originless record.** Create DNS record
   `proxy` → `AAAA` → `100::` , **proxied** (orange cloud), then set
   `proxy.founders.click` as the Custom Hostnames fallback origin. It is
   originless on purpose: the Worker answers every custom-hostname request, so
   traffic must never fall through to a real server. If the Worker ever stops
   matching, requests fail closed instead of leaking.
3. Deploy the Worker as `founders-edge` (dashboard paste, or `npx wrangler
   deploy` here). **Add no routes by hand** — see below.
4. **Worker routes are created per customer, automatically.** Cloudflare offers
   three options; we use the third:
   - `*/*` — their recommendation, but routes *every* request entering the zone
     (marketing site and app included) through the Worker. Not used.
   - `*/*` plus `Worker: None` bypasses for platform hostnames. Works, but is
     correct only if configured perfectly on a live zone. Not used.
   - **one route per customer hostname (`customer.com/*`)** ← what we do.
     `provisionDomainAtEdge()` creates it alongside the custom hostname.

   A route naming only `proxy.founders.click/*` would not work: the route has
   to name the customer hostname. Capacity is 1,000 routes per zone on Free and
   Paid alike, so this scales to 1,000 connected domains.

   Trade-off, deliberately taken: without the wildcard, a custom hostname
   created *without* its route falls through to the originless fallback origin
   and that customer is hard down rather than degraded — which is why
   provisioning is atomic and rolls back on partial failure.

Note: because a Worker route matches before origin resolution, the
`custom_origin_server` field on individual custom hostnames is bypassed —
per-hostname routing is done inside the Worker from the `Host` header, which is
exactly what `getDomainConfig()` does.

## Per-customer provisioning (automated by the app; API calls only)

1. Customer verifies domain ownership (TXT `_founders-click.{domain}` or
   `/.well-known/founders-click-verify` file) — already automated in-app.
2. App calls Cloudflare API: `POST /zones/{zone}/custom_hostnames` with the
   customer hostname (SSL method `txt` or `http`). Store the returned id in
   `workspace_domains.cloudflare_hostname_id`, status → `ssl_pending`.
3. Customer points DNS at `proxy.founders.click` (CNAME, or flattened at apex).
4. SSL validates automatically; app polls the custom-hostname status, then runs
   the activation tests (below) and flips status → `active`.

## Activation tests (app-driven, no humans)

- `https://customer.com/` still serves their site (full_proxy mode).
- `https://customer.com/a/founders-domain-test` returns the Founders marker
  (proves DNS → edge → origin → tenant resolution).
- No redirect loop (`x-founders-edge` guard returns 508 if one ever forms).

## Ops notes

- Config cache: 60s positive / 10s negative — disconnects and billing
  suspensions propagate within a minute.
- Unknown Host header → 404. The Worker never proxies for a hostname that is
  not verified in `workspace_domains` (host-header security).
- Tenant sitemap lives at `/a/sitemap.xml` on the customer domain (the edge
  only controls `/a/*`; `/sitemap.xml` belongs to the customer's site).

## Deploying

Two independent pipelines. They must stay independent — the app and the Worker
fail in different ways, and a single deploy path would couple a routine app
release to the request path of every connected customer domain.

**The application** (`www.founders.click`) ships through Lovable:

```
push to github.com/derekbowen/kindred-ease-space (main)
  → Lovable pulls on the push webhook
  → deploy (Lovable "Publish", or deploy_project over MCP)
```

The pull is webhook-driven, not polled. Reconnecting the GitHub integration
re-arms the webhook but does **not** backfill commits pushed while it was
disconnected — push something after reconnecting, or the workspace stays behind
main with no error anywhere. Verify a deploy actually carried your code by
hitting a route the release added rather than trusting a green publish.

**The Worker** ships through `.github/workflows/deploy-edge-worker.yml`,
manual dispatch, confirm input `deploy`. It never deploys on merge: this code
sits in front of customers' production domains, so shipping it is a decision.

### Credentials

Three Cloudflare credentials exist and none of them substitute for another:

| name | lives in | scope | used by |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Lovable secrets | custom hostnames, SSL, routes | the app, for customer provisioning |
| `CLOUDFLARE_WORKER_DEPLOY_TOKEN` | GitHub Actions secrets | Workers Scripts:Edit, Workers Routes:Edit | the deploy workflow only |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_ZONE_ID` | GitHub Actions secrets | not secret | the deploy workflow |

GitHub Actions cannot read Lovable secrets. A token set in Lovable is invisible
to CI, and vice versa — the workflow preflights for exactly this because the
failure otherwise surfaces as an opaque wrangler auth error.

The provisioning token deliberately has **no** Workers permission, so it cannot
deploy. Do not broaden it, and do not let application code read the deployment
token. Wrangler reads the credential from the environment variable
`CLOUDFLARE_API_TOKEN`; the workflow maps the deployment token onto that name.
That name collision is wrangler's convention, not shared identity.

### Routes are not deployed

`wrangler.jsonc` declares no routes. The control plane creates and deletes one
route per connected hostname during provisioning, so a deploy from a stale
checkout can never drop a live customer. The workflow counts routes before and
after and fails if the number dropped.
