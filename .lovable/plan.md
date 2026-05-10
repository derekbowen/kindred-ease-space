## Audit findings

**The good:** Your Supabase already has the SaaS skeleton + every feature table founders.click needs.
- `workspaces` (plan, subscription_status, trial_ends_at, stripe_customer_id, stripe_subscription_id, marketplace_domain, domain_verified_at, owner_user_id)
- `workspace_members` + helpers `is_workspace_member`, `is_workspace_owner`, `workspace_for_host`
- `customer_subscriptions` (workspace_id-scoped, status enum, period tracking)
- `user_roles` + `has_role` (app-wide admin separate from tenant ownership)
- All feature tables exist: `content_plan`, `content_pages`, `competitor_sites/urls/pages`, `gsc_query_data`, `serp_rankings`, `tracked_keywords`, `page_audits`, `internal_link_suggestions`, `provider_leads`, `email_branding`, `site_footer_settings`, `blog_posts`, `courses`, `course_*`, `mb_*`, `enriched_contacts`, `provider_claims`, `provider_plan_requests`, etc.

**The critical gap:** Of ~60 tables, only **3** carry `workspace_id` (`content_pages`, `customer_subscriptions`, `workspace_members`). Everything else is gated by a single `has_role('admin')` policy — meaning today every paying customer would see every other customer's data. This is the #1 ship-blocker.

**Other gaps:**
- This project has zero app routes (only the placeholder `/`). No login, no dashboard, no signup.
- No Stripe webhook → `customer_subscriptions` / `workspaces.subscription_status` plumbing.
- No domain verification flow for `marketplace_domain`.
- `email_branding` / `site_footer_settings` are global single-row tables — needs per-workspace.
- No marketing site for founders.click yet.

## Recommended scope (this project) & domain

Build the SaaS app **here** at `/app/*` (signup, dashboard, every founders.click feature) and the marketing site at `/marketing/*` or under a separate domain. Two clean options:

1. **Single project (recommended):** keep poolrentalnearme.com proxy untouched, add `/app` (admin) + `/marketing` (founders.click landing) routes. Point `founders.click` DNS at the same fresh-web Lovable host with a second nginx server block. One codebase, one Supabase, easiest to ship.
2. **Split:** spin up a second Lovable project for marketing only. Adds ops cost, no real benefit at this stage.

Going with option 1 below.

## Plan — phased

```text
Phase 1: Multi-tenant data isolation (CRITICAL, blocks everything)
Phase 2: Auth + workspace onboarding
Phase 3: Stripe billing (built-in Stripe payments)
Phase 4: Admin dashboard shell + first 2 features ported
Phase 5: Marketing site (the 7 slides → /marketing)
Phase 6: Remaining features ported into the shell
```

### Phase 1 — Tenancy retrofit (1 migration, 1 PR)
Add `workspace_id uuid` (nullable for backfill, then NOT NULL) to every operational table:
`content_plan, competitor_sites, competitor_urls, competitor_pages, competitor_host_matches, gsc_query_data, serp_rankings, tracked_keywords, page_audits, internal_link_suggestions, provider_leads, provider_claims, provider_plan_requests, host_match_false_positives, enriched_contacts, enrichment_spend_log, email_branding, email_send_log, email_send_state, site_footer_settings, blog_posts, host_tools, help_articles, help_categories, content_404_log, seo_overrides, seo_fix_jobs, site_issues, listing_sync_log, page_quality, template_quality_breakdown, feature_requests, host_profiles, courses, course_*, mb_threads, mb_replies, mb_likes, suppressed_emails, synced_listings, customer_subscriptions (already has)`.

Backfill all existing rows to a single "internal" workspace (your fresh-web one, mark `is_internal=true`). Replace every `has_role('admin')` ALL-policy with **two** policies per table: (a) workspace members read/write their workspace's rows, (b) `has_role('admin')` super-admin escape hatch.

Keep public-read policies (cities, amenities, blog_posts, etc.) as-is for the marketing/SEO surface.

### Phase 2 — Auth + onboarding
- `/login`, `/signup` (email + Google), reset password page.
- `_authenticated/` route group guarded via `beforeLoad` + Supabase session check.
- First-run onboarding: name workspace → enter Sharetribe `marketplace_domain` → DNS TXT verification edge function → set `domain_verified_at`.
- Trial timer starts on workspace creation (`trial_ends_at = now() + 14 days`, `plan='trial'`).

### Phase 3 — Billing (Stripe via Lovable's built-in Stripe payments)
- Run `recommend_payment_provider`, then enable Stripe. Create 3 plans (Starter / Pro / Scale) once enabled.
- Checkout session per workspace; portal link in settings.
- `/api/public/webhooks/stripe` server route → verify signature → upsert `customer_subscriptions` → mirror `plan` / `subscription_status` / `current_period_end` onto `workspaces`.
- Plan-gating helper `requirePlan(workspaceId, ['pro','scale'])` for premium features (Competitor Radar, IG Lead Hunter, etc.).

### Phase 4 — Admin dashboard shell (`/app`)
- Shadcn sidebar layout: Dashboard, Content, SEO, Users & Ops, Settings.
- Workspace switcher (for users with multiple memberships).
- Implement Dashboard tab + Content (Quick Page Builder + Bulk Page Editor) first as proof-of-concept end-to-end on the new tenancy model.

### Phase 5 — Marketing site (`/marketing` or founders.click root)
- Routes: `/marketing`, `/marketing/dashboard`, `/marketing/content`, `/marketing/seo`, `/marketing/users-ops`, `/marketing/pricing`.
- Convert the 7 slides to dark-aesthetic SSR pages with per-route `head()` metadata.
- CTA → `/signup?plan=...`.
- Gate behind a separate nginx server block on founders.click pointed at the same fresh-web origin (no Lovable changes needed beyond routing).

### Phase 6 — Remaining features
Port each remaining tab one-by-one against the now-isolated schema: SEO suite (Competitor Radar, Rank Tracker, Page Auditor, Link Auditor, Keyword Opportunities, Internal Link Recommender, Sitemap/404), Users & Ops (Lead Inbox, Email Verify, IG Lead Hunter, Directory Moderation, Email Branding per workspace, Site Footer Editor, Admin Team, Listing Claims & Plans), Content Factory cron, SEO Coach AI chat, Blog Admin & Learning.

## Technical specifics

- All workspace queries go through `createServerFn` with `requireSupabaseAuth` middleware so RLS does the isolation work — no admin client in feature code.
- `supabaseAdmin` only in: Stripe webhook, DNS verifier, cron jobs (Content Factory, Competitor Radar daily scrape, Link Auditor, GSC pull), and the Sharetribe sitemap scrapers.
- New SECURITY DEFINER helper `current_workspace_id(request_host text)` for SSR resolution by `marketplace_domain`.
- Migrations split per phase to keep PRs reviewable.
- Existing fresh-web `/p/*` and `/`/sitemap.xml routes untouched.

## What I need from you to start

1. Confirm option 1 (single project, `/app` + founders.click DNS routed here) — or pick option 2.
2. Confirm I should use Lovable's built-in Stripe payments (recommended, no account setup).
3. Pricing: rough $/mo for Starter / Pro / Scale and what each tier unlocks (or say "pick reasonable defaults and I'll edit").

Once those are answered I'll start with the Phase 1 tenancy migration, since nothing else is safe to expose to real customers without it.