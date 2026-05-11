# founders.click — Sharetribe Integration + Page Builder (v1)

Scope from your spec, scoped down to a shippable v1: Sharetribe connect → encrypted creds → cron sync → page builder (City Hub template) → SSR public renderer at `/p/:slug`. All other templates are seeded as placeholders only.

---

## 1. Database (one migration)

New tables (all RLS-on, workspace-scoped via `is_workspace_member`):

- **`tenant_integrations`** — per-workspace Sharetribe creds. `client_secret` stored via Supabase Vault (`vault.secrets`), table holds only `client_secret_vault_id`. Unique `(workspace_id, provider)`.
- **`tenant_listings`** — synced listings. Indexes on `(workspace_id, city)`, `(workspace_id, category)`, `(workspace_id, state_published)`. Unique `(workspace_id, sharetribe_listing_id)`.
- **`page_templates`** — system-owned (no tenant write). Seed: `city_hub`, `category_page`, `neighborhood`, `comparison`, `resource_article`. Only `city_hub` has a real `config_schema`; others are stubs flagged `is_active=false`.
- **`tenant_pages`** — tenant-built pages. Unique `(workspace_id, slug)` so two tenants can both own `/p/austin`. Indexes on `(workspace_id, status)` and `slug`.

Plus two SECURITY DEFINER helpers:
- `tenant_set_integration_secret(_workspace_id, _client_secret)` → writes to vault, returns `vault_id`. Keeps service-role usage off the client.
- `tenant_get_integration_secret(_workspace_id)` → returns decrypted secret, callable only by service role (used by sync function).

RLS: tenant tables all gated by `is_workspace_member(workspace_id, auth.uid())`. `page_templates` is world-readable, no writes. `tenant_listings` is also world-readable when `state_published=true` so the public `/p/:slug` renderer can read with anon key (still scoped by workspace_id in queries).

## 2. Sharetribe sync (server function, not Supabase Edge Function)

Per workspace knowledge + project conventions, server-side jobs in this stack should be **TanStack server functions / server routes**, not Supabase Edge Functions. Two pieces:

- `src/lib/sharetribe-sync.functions.ts` — `runSharetribeSync({ workspace_id })` server fn, `requireSupabaseAuth` + workspace-membership check. Calls into a server-only helper.
- `src/routes/api/public/hooks/sync-sharetribe.ts` — public hook for `pg_cron`. Body `{ workspace_id }`, header `apikey: <anon>`. For "sync all", iterates connected workspaces.

Sync helper (`src/lib/sharetribe-sync.server.ts`, service-role):
1. Fetch `tenant_integrations` row, decrypt secret via `tenant_get_integration_secret`.
2. POST `https://flex-integ-api.sharetribe.com/v1/auth/token` with `grant_type=client_credentials&scope=integ` → `access_token`.
3. Page through `/v1/integration_api/listings/query?per_page=100&page=N&include=author,images` until `meta.totalPages` reached.
4. Map → upsert into `tenant_listings` by `(workspace_id, sharetribe_listing_id)`. Build JSON-LD `Product` and store in `structured_data`.
5. Delete rows whose `sharetribe_listing_id` is no longer present (set captured during paging).
6. Update `tenant_integrations.last_sync_at / status / listings_count / last_sync_error`.
7. Retry 3× with exponential backoff (1s/3s/9s) on 429/5xx. Auth failure → `status='error'`.

`pg_cron`: every 30 min, calls the public hook with `{}` → hook fans out to all `connected` integrations.

## 3. Connect UI — `/app/settings/integrations/sharetribe`

Form: marketplace URL, marketplace ID, client ID, client secret. On submit, server fn:
1. Validates creds by calling `/v1/integration_api/marketplace/show`.
2. On success, writes secret to vault via `tenant_set_integration_secret`, upserts `tenant_integrations` row with `status='connected'`.
3. Returns sanitized row (never the secret) for the UI.

Connected state shows: marketplace URL, last sync timestamp/status, listings count, "Sync now" button (calls `runSharetribeSync`), "Disconnect" button.

## 4. Page builder — `/app/pages`

- **List view**: table of `tenant_pages` (title, template, slug, status, published_at, actions).
- **Create flow** (single multi-step page, not separate routes):
  1. Pick template (cards from `page_templates` where `is_active`). v1 = only City Hub.
  2. Configure form, dynamically rendered from `template.config_schema`: slug, SEO title, meta description, H1, variable inputs (city, state, category_plural), listing filter (city/state/limit/sort), markdown body. AI-assist button is a stub button that opens a tooltip "coming soon" — out of v1 to keep this shippable.
  3. Preview iframe → `/preview/:page_id` (auth-gated route that renders draft content as the published renderer would).
  4. Publish → sets `status='published'`, `published_at=now()`.
- **Bulk matrix**: CSV upload (`slug,city,state,category_plural,...`), pick template, server fn loops and upserts `tenant_pages`. Progress shown via simple count + toast (no streaming).

## 5. Public SSR renderer — `/p/$slug`

`src/routes/p.$slug.tsx`:
- `loader` calls a server fn `getPublicPage({ slug, host })`.
- Server fn resolves workspace from host using existing `workspace_for_host(host)` helper, then fetches `tenant_pages` by `(workspace_id, slug, status='published')`.
- Runs listing query against `tenant_listings` with `page.listing_filter` (city/state/category/limit/sort). All in one round-trip.
- Returns `{ page, listings, workspace }`.
- Component renders the City Hub template as pure server HTML: hero (city + count), intro markdown, 24-card grid, body markdown, FAQ accordion (CSS-only `<details>`), related pages.
- Each card: `<article itemscope itemtype="https://schema.org/Product">`, image with `loading="lazy"`, links to `listing.marketplace_url` with `rel="noopener nofollow"`.
- `head()` emits canonical, OG, Twitter, and a `<script type="application/ld+json">` per listing from `structured_data`. Title/description from `page.title` / `page.meta_description`.
- `errorComponent` + `notFoundComponent` per route conventions.

## 6. City Hub template

Hard-coded React component `src/components/templates/CityHub.tsx`. `page_templates.config_schema` for `city_hub` matches your spec exactly. Renderer dispatches on `template.slug`.

---

## Technical notes / deviations

- **Edge Functions vs server functions**: The spec says "Supabase Edge Function". Workspace and stack rules say *use TanStack server functions / server routes for app logic, not Edge Functions*. I'll implement as a server route under `/api/public/hooks/sync-sharetribe`, called by `pg_cron` via `pg_net`, and a `createServerFn` for the in-app "Sync now" button. Functionally equivalent, follows project conventions.
- **Vault**: assumes `vault` extension is enabled (it is in standard Supabase projects). If `vault.create_secret` isn't available in this project I'll fall back to encrypting with `pgsodium` + a `SHARETRIBE_ENCRYPTION_KEY` runtime secret. Migration will branch.
- **Subdomain → workspace resolution**: relies on existing `workspace_for_host(host)` DB function (already in your schema). Public renderer pulls the host from the request, not `window.location`.
- **Unscoped routes**: nothing new under disallowed prefixes (you're not in the pool-rental project here, so the workspace-knowledge legacy-route rules don't apply — those are for fresh-web).
- **AI body assist**, **structured-data validation page**, **detailed sync logs UI**, **partial-failure resume**, and **per-template builders beyond City Hub** are explicitly *out of v1*. I'll stub the AI button and leave a `// TODO v2` marker for the rest.

---

## File list (rough)

```
supabase/migrations/<ts>_sharetribe_pages.sql
src/integrations/supabase/types.ts                  (regen)
src/lib/sharetribe-sync.functions.ts
src/lib/sharetribe-sync.server.ts
src/lib/tenant-pages.functions.ts
src/lib/tenant-pages.server.ts
src/routes/api/public/hooks/sync-sharetribe.ts
src/routes/_authenticated/app.settings.integrations.sharetribe.tsx
src/routes/_authenticated/app.pages.tsx              (list)
src/routes/_authenticated/app.pages.new.tsx          (create wizard)
src/routes/_authenticated/app.pages.$id.edit.tsx
src/routes/_authenticated/app.pages.bulk.tsx        (CSV matrix)
src/routes/_authenticated/preview.$pageId.tsx
src/routes/p.$slug.tsx                              (public SSR)
src/components/templates/CityHub.tsx
src/components/page-builder/{TemplatePicker,ConfigForm,ListingFilterEditor,MarkdownEditor}.tsx
src/lib/app-nav.ts                                  (add Pages + Integrations entries)
```

Plus a separate `pg_cron` insert (via DB insert tool, not migration) once the hook is live.

---

## Open question

Spec says listing-card links go to `listing.marketplace_url` (the tenant's Sharetribe URL). Confirm: should those links be **`rel="noopener nofollow"`** (treat as outbound user content, preserves SEO juice for `/p/:slug`) or **`rel="noopener"` only** (pass link equity to the tenant's marketplace)? I'll default to `noopener nofollow` unless you say otherwise.

Approve and I'll build it.