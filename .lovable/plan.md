## Goal

Stop wrong-host URLs from shipping. Every canonical, `og:url`, sitemap entry, and internal link must resolve to `https://www.founders.click/...` (never the apex `founders.click`, never any `*.lovable.app` host).

Today's state (from a quick scan):
- `src/routes/index.tsx` emits `rel="canonical"` and `og:url` pointing at the apex `https://founders.click/`.
- `src/routes/sitemap[.]xml.tsx` builds URLs from `const SITE = "https://founders.click"`.
- `src/routes/__root.tsx` `og:image` / `twitter:image` point at an `id-preview-…lovable.app` R2 thumbnail.
- There is no central canonical helper in this repo yet.

The audit needs to catch all three: source code (lint), generated HTML (crawl), and runtime requests (smoke).

## What we'll build

### 1. Canonical helper (single source of truth)

`src/lib/canonical.ts`
- `CANONICAL_ORIGIN = "https://www.founders.click"`
- `canonicalUrl(path: string)` — joins origin + normalized path
- `isCanonicalUrl(url: string)` — boolean for the audit

Replace the hard-coded apex strings in `index.tsx` and `sitemap[.]xml.tsx` with this helper. Also fix the `og:image` host on `__root.tsx` (move the asset under `www.founders.click` or accept it as an allow-listed CDN — see Open Question 1).

### 2. Static audit (the lint)

`scripts/audit-canonical-urls.ts` runnable via `bun run audit:urls`.

It walks `src/routes/**/*.{ts,tsx}` and `src/**/*.functions.ts` and flags:
- Any string literal matching `https?://founders\.click` (apex, missing `www`)
- Any string literal matching `https?://[^"']*lovable\.app` outside an allow-list
- Any `rel="canonical"` / `og:url` / `twitter:url` value that isn't built from `canonicalUrl(...)`
- `<Link to="https://...">` absolute internal links (should be relative `to="/path"`)

Allow-list lives at the top of the script (e.g. Supabase URLs, the R2 og:image bucket if we keep it, any developer comments). Output is grouped by file with line numbers; non-zero exit on any violation. Wired into `package.json` so it can run locally and in CI.

### 3. Live crawl audit (the runtime check)

A new admin page at `/app/seo/canonical-audit` plus a server function `auditCanonicalUrls` in `src/lib/admin-canonical-audit.functions.ts`.

For each URL in a seed list (homepage + every route from the sitemap, capped at e.g. 200 per run):
- `fetch` the URL on `https://www.founders.click`
- Parse the returned HTML and extract: `<link rel="canonical">`, `og:url`, `twitter:url`, every `<a href="...">`, every `<link rel="alternate">`
- For each extracted URL, classify:
  - ✅ Relative or starts with `https://www.founders.click`
  - ⚠️ Apex `https://founders.click` (should redirect, but we don't want it baked into HTML)
  - ❌ Any `lovable.app` host
  - ➖ External (other domain) — reported but not a failure
- Also `HEAD` the page itself on `https://founders.click/...` and confirm it returns a 301 to `www`.

Results stored in a new table `canonical_audit_runs` (run_id, url, issues jsonb, checked_at) so the admin UI can show history and a delta vs the last run. RLS: admin role only.

The page renders: last-run summary (pass/warn/fail counts), failing URLs grouped by issue type, and a "Run audit now" button that triggers the server fn.

### 4. Scheduled run

A `pg_cron` job hits a public route `/api/public/hooks/canonical-audit` once a day. The handler verifies the Supabase anon key in the `apikey` header, then invokes the same audit logic and writes a row. If any ❌ failures appear, it logs to `console.error` (which Lovable surfaces) and inserts an alert row in `admin_alerts` (existing table if present; otherwise a tiny new one). No email yet — that's a follow-up.

### 5. Fix the existing violations the audit will catch

In the same change set:
- Rewrite `index.tsx` head to use `canonicalUrl("/")`
- Rewrite `sitemap[.]xml.tsx` to use `CANONICAL_ORIGIN`
- Decide on `__root.tsx` og:image (see Open Question 1)
- Run `bun run audit:urls` to confirm zero violations

## File map

```text
src/lib/canonical.ts                          (new)
src/lib/admin-canonical-audit.functions.ts    (new — server fn)
src/lib/admin-canonical-audit.server.ts       (new — fetch + parse helpers)
src/routes/_authenticated/app.seo.canonical-audit.tsx   (new — admin UI)
src/routes/api/public/hooks/canonical-audit.ts          (new — cron endpoint)
scripts/audit-canonical-urls.ts               (new — static lint)
src/routes/index.tsx                          (edit — use helper)
src/routes/sitemap[.]xml.tsx                  (edit — use helper)
src/routes/__root.tsx                         (edit — og:image host)
package.json                                  (edit — "audit:urls" script)
supabase migration                            (new table + RLS)
pg_cron job                                   (insert via supabase tool, not migration)
```

## Open questions

1. The current `og:image` is hosted on `pub-…r2.dev`. Two options: (a) re-upload the share image to `www.founders.click/og/home.png` and serve it from our own host, or (b) keep the R2 URL and add it to the audit allow-list. (a) is the cleaner long-term answer. Which do you want?
2. Crawl scope: cap at 200 URLs per run, or crawl the entire sitemap (currently small but will grow)?
3. Cron cadence: daily at 06:00 UTC, or hourly during the first week so we catch regressions fast?

Tell me your answers (or "you pick") and I'll implement.