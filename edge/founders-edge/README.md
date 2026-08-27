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

1. Cloudflare zone for `founders.click`, **Cloudflare for SaaS** enabled.
2. `proxy.founders.click` = custom-hostname **fallback origin**, proxied (orange
   cloud), covered by a Worker route so every request lands on `founders-edge`:
   - route `proxy.founders.click/*` → founders-edge
   - custom-hostname requests also hit the zone's Worker routes.
3. `npx wrangler deploy` from this directory.

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
