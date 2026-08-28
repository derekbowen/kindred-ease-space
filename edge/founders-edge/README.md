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
3. **Worker routes — order matters.** Add the bypass routes FIRST so the live
   site is never exposed to the Worker, then the wildcard:
   - `www.founders.click/*` → Worker: **None**
   - `founders.click/*` → Worker: **None**
   - `*/*` → Worker: **founders-edge**

   A route on `proxy.founders.click/*` does **not** work: custom-hostname
   traffic arrives as `customer.com`, and only the `*/*` wildcard matches
   traffic entering the zone from customer vanity domains. More specific routes
   win, which is why the bypasses protect the platform's own hostnames. The
   Worker additionally hard-codes a `PLATFORM_HOSTS` passthrough as a backup.
4. Deploy the Worker (dashboard paste, or `npx wrangler deploy` here).

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
