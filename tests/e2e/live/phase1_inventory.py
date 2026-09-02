"""
Phase 1 — FEATURE INVENTORY (discovery, not testing). Unauthenticated only.

Builds the ADVERTISED-vs-EXPOSED matrix for founders.click from

  * the code: public routes, dashboard routes, nav flags (stub/internalOnly),
    per-page controls, server functions, edge functions, cron jobs, feature
    flags, the plan catalog, the seeded help articles, affiliate code;
  * the live product: the marketing page and help centre (the customer-facing
    promise text is the contract), legal pages, auth pages, robots/sitemaps,
    the public APIs and cron hooks (no secret => must be refused), and an
    unauthenticated probe of every dashboard route (exists + auth-gated?).

Every feature is written through the harness as ONE record (screenshot +
network + console evidence) into
  docs/evidence/live-acceptance-2026-09-02/phase1-inventory/records.json
and the deliverable matrix is rendered to
  docs/evidence/live-acceptance-2026-09-02/phase1-inventory/feature-matrix.md

Status rules for this phase: every row is "Blocked" (= not yet tested,
inventory only) EXCEPT where discovery alone proves "Not implemented" (route is
a scaffold / backend absent) or "Intentionally disabled" (hidden by the
stub/internalOnly flag or an env/enrolment gate).

Nothing here signs in, submits a form, spends AI, or changes production.
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import Session, EVIDENCE, BASE  # noqa: E402

PHASE = "phase1-inventory"
OUT = EVIDENCE / PHASE
OUT.mkdir(parents=True, exist_ok=True)

# --------------------------------------------------------------------------
# Test-phase labels used in the matrix. Phases 2 and 3 are the names already
# used by the acceptance run; the rest are proposals for the orchestrator.
P2, P3, P4, P5, P6, P7, P8, P9, OPS = (
    "P2 account",
    "P3 content",
    "P4 SEO tools",
    "P5 AI generation (metered, spend-capped)",
    "P6 billing (needs Stripe test mode)",
    "P7 affiliates",
    "P8 settings / integrations / domains",
    "P9 public site, help & support",
    "Ops / internal (not customer-testable)",
)

BLOCKED, NOTIMPL, DISABLED = "Blocked", "Not implemented", "Intentionally disabled"

STUB_NOTE = (
    "Route renders <StubToolPage> ('Coming soon — This tool is scaffolded. UI, AI, and "
    "database wiring land in a follow-up pass'); hidden from the sidebar by the stub flag "
    "(app-nav.ts) unless ?showStubs=1; no server function or table behind it."
)

# --------------------------------------------------------------------------
# THE INVENTORY. One dict per customer-facing feature.
#   feature, where, promise, gate, phase, status, actual, route (probed
#   unauthenticated when set), sev (severity for Not implemented rows).
F: list[dict] = []


def add(feature, where, promise, gate, phase, status=BLOCKED, actual="", route=None, sev="-"):
    F.append(dict(feature=feature, where=where, promise=promise, gate=gate, phase=phase,
                  status=status, actual=actual, route=route, sev=sev))


# ---- A. Public site & marketing promises -----------------------------------
add("Marketing landing page", "src/routes/index.tsx (/)",
    "'The all-in-one growth engine. Publish hundreds or thousands of SEO pages for one monthly price — AI generation, hosting, sitemaps and schema included. No agency retainer.' Hero CTA 'Start your free trial'; fine print '14-day free trial · publish up to 25 pages · No card required'.",
    "none (public)", P9, actual="Live text captured in this phase (see live-capture.md).", route="/")
add("Product demo video", "src/routes/index.tsx ProductDemo → public/product-demo.mp4 + poster",
    "'Watch the demo' / 'See the Content Factory in action' (muted inline video with play overlay).",
    "none", P9, actual="Video element + poster present in code; playback not exercised.", route="/")
add("Problem / Fix claims", "src/routes/index.tsx PAINS + FIXES",
    "FIXES: 'One subscription, no retainer, no scope calls.' · 'Pages generated from your real listings — in minutes, not sprints.' · 'A daily briefing telling you the single highest-ROI thing to ship.'",
    "none", P5, actual="Daily briefing depends on coach-briefing-cron (CRON_SECRET) — see Nightly briefing row.", route="/")
add("'Everything included' feature grid (6 tiles)", "src/routes/index.tsx FEATURES",
    "Content Factory · SEO Intelligence (competitor radar, rank tracking, AI page auditor, keyword gaps) · AI Growth Coach · Lead Inbox · Sharetribe Sync · Affiliate Programs — headed 'Everything included / One engine. Every growth surface.'",
    "none", P9,
    actual="Two tiles have no product behind them (Lead Inbox, Competitor radar → stubs) and one is a paid add-on (Affiliate Programs $30/mo) despite 'Everything included'.", route="/")
add("'How it works' steps", "src/routes/index.tsx STEPS",
    "1 Connect your marketplace (Integration API creds; 'we pull your listings, categories and locations automatically') · 2 Generate your pages (Content Factory turns live inventory into indexable pages) · 3 Publish on your domain (connect + verify your domain, track positions, Growth Coach tells you what to ship next).",
    "none", P8, actual="Maps to Sharetribe integration, page builder, domains, rank tracker, coach rows.", route="/")
add("Pricing section (plan catalog)", "src/routes/index.tsx Pricing ← src/lib/plan-catalog.ts (mirror of supabase/functions/_shared/stripe-catalog.ts)",
    "Starter $29/100 pages · Growth $59/500 · Scale $99/1,000 (Most popular) · Pro $199/3,000 · Agency $299/5,000; 'AI generation included', 'Every feature unlocked'; 'Every plan includes: AI page generation, Hosting on your domain, Automatic sitemaps, Schema / structured data, Internal linking, Sharetribe listing sync'; 'Add capacity in blocks of 1,000 from your dashboard'.",
    "none", P6, actual="Catalog drives homepage, billing page and Stripe products; help article 'Understanding page limits' contradicts it (50/500/5,000/Enterprise).", route="/")
add("FAQ promises", "src/routes/index.tsx FAQS (+ FAQPage JSON-LD)",
    "Drafts free & unlimited, only live pages use a slot, unpublish frees it · 'Do I need to be technical? No' · AI included; extra capacity $10 per 1,000 credits · Cancel: pages stay live to period end then unpublished, content retained, same URLs on return · Plan changes: upgrades immediate & prorated, downgrades at period end.",
    "none", P6, actual="Cancellation/proration behaviour needs Stripe test mode; unpublish/draft behaviour testable in P3.", route="/")
add("Site header / footer navigation & locale", "src/components/site/SiteHeader.tsx, SiteFooter.tsx, src/lib/i18n.tsx",
    "Header: Features, Pricing, Help, Sign in, Start free trial. Footer: Features, Pricing, Help, Terms, Privacy, Contact.",
    "none", P9, actual="i18n.tsx defines 6 locales (en/es/fr/de/fi/sv) but no locale switcher is rendered in the header/footer — English only in practice.", route="/")
add("Marketing SEO metadata & JSON-LD", "src/routes/index.tsx head()",
    "Title/description/OG/Twitter tags; SoftwareApplication JSON-LD with AggregateOffer $29–$299; FAQPage JSON-LD; canonical.",
    "none", P9, actual="Captured live in this phase (see live-capture.json → jsonld).", route="/")
add("robots.txt + marketing sitemap + help sitemap", "public/robots.txt, src/routes/sitemap[.]xml.tsx, src/routes/help.sitemap[.]xml.tsx",
    "Crawlable public site; /app, /login, /signup, /reset-password disallowed; sitemaps listed in robots.",
    "none", P9, actual="Fetched live in this phase.", route="/robots.txt")
add("Terms of Service", "src/routes/terms.tsx",
    "Subscriptions auto-renew until cancelled; fees non-refundable; 'cancel your subscription at any time from your account settings or by contacting support'; termination may delete data; contact support@founders.click.",
    "none", P9, actual="In-app cancellation = 'Manage billing' → Stripe customer portal (owner-only); no native cancel control.", route="/terms")
add("Privacy Policy", "src/routes/privacy.tsx",
    "Data retained only as long as needed, then deleted/anonymised; cookie/consent language; rights requests via support@founders.click.",
    "none", P9, actual="No account/workspace deletion UI exists (see Account deletion row); no cookie-consent banner in code.", route="/privacy")

# ---- B. Auth & account -----------------------------------------------------
add("Sign up (email + password)", "src/routes/signup.tsx → supabase.auth.signUp; Terms/Privacy links",
    "'Start your free trial' — name, email, password; 14-day trial, no card.",
    "none", P2, actual="Phase 2 already recorded: reaches 'Check your email' screen (Verified) but NO confirmation email was ever received (Failed).", route="/signup")
add("Email confirmation link (branded auth email)", "src/routes/api/public/hooks/auth-send-email.ts (Supabase send-email hook → EmailIt), src/lib/auth-email-hook.ts",
    "Clicking the emailed link confirms the account and signs the customer in.",
    "SEND_EMAIL_HOOK_SECRET on the Worker; EmailIt API key", P2,
    actual="Phase 2: three sends accepted by Supabase, zero emails delivered after 42 min → confirmation journey unverifiable.")
add("Continue with Google", "src/routes/login.tsx, signup.tsx onGoogle → signInWithOAuth",
    "One-click Google sign-in / sign-up.",
    "Google provider must be enabled in Supabase (code toasts 'Google sign-in is not enabled in Supabase yet' otherwise)", P2,
    actual="Button present on both pages; provider state unknown until clicked.", route="/login")
add("Log in / Sign out", "src/routes/login.tsx; sidebar footer 'Sign out' (app.tsx signOut scope=global → /login)",
    "Sign in with email + password and reach the dashboard; sign out ends the session everywhere.",
    "confirmed account", P2, actual="Blocked in Phase 2 by undelivered confirmation email.", route="/login")
add("Password reset (request + set new password)", "src/routes/reset-password.tsx (resetPasswordForEmail → /reset-password)",
    "'Forgot password' emails a reset link; set a new password; old one refused.",
    "email delivery", P2, actual="Same email-delivery dependency as confirmation.", route="/reset-password")
add("Auth guard on /app/*", "src/routes/_authenticated.tsx beforeLoad (client-side, ssr:false) → redirect /login?next=",
    "Protected pages bounce anonymous visitors to login and return them afterwards.",
    "none", P2, actual="Probed live for every dashboard route in this phase (see per-route rows).", route="/app")
add("Workspace auto-provisioning + welcome email", "src/lib/workspace.functions.ts ensureWorkspace (plan=starter, trialing, 14 days, trial credit grant, owner membership) + welcome email (email.server.ts 'welcome')",
    "No setup wall: first login lands straight in the product; welcome email: 'Sync your listings (we do this automatically every 30 min)'.",
    "email delivery for the welcome mail", P2, actual="Welcome email promises 30-min automatic sync — that job is gated on CRON_SECRET (see cron rows).")
add("Onboarding route", "src/routes/_authenticated/app.onboarding.tsx",
    "Legacy /app/onboarding links forward into the product.",
    "auth", P2, actual="Pure redirect to /app.", route="/app/onboarding")
add("Account profile (name / email / password change in-app)", "src/routes/_authenticated/app.settings.tsx 'Account' card (read-only email, name, role)",
    "Privacy policy lists account information (name, email…) as customer-controlled; README: 'workspace settings'.",
    "auth", P8, status=NOTIMPL, sev="P2",
    actual="Settings shows email/name/role as text only — no control to change name, email or password (password only via the public reset flow). Audit 2026-09-02 P1-18 confirms email change has no UI.",
    route="/app/settings")
add("Account / workspace deletion", "no route, no server function (grep: no delete-account/delete-workspace code)",
    "Privacy: data 'deleted or anonymised' on request; Terms: termination deletes data.",
    "—", P8, status=NOTIMPL, sev="P1",
    actual="No deletion path in UI or API; only route is emailing support@founders.click. Audit P1-18.")
add("Team members / invites / roles (Admin Team)", "src/routes/_authenticated/app.ops.admin-team.tsx (stub: 'Manage workspace members and roles'); roles owner/member exist in DB (workspace_members), OwnerOnlyBanner for members",
    "Help category 'Account & Billing: Plans, page limits, upgrading, team members, invoices, and cancellation'.",
    "stub flag (hidden)", P8, status=NOTIMPL, sev="P2",
    actual="No invite/add-member UI or server fn anywhere; Admin Team page is a 'Coming soon' scaffold. " + STUB_NOTE, route="/app/ops/admin-team")

# ---- C. Dashboard & coach --------------------------------------------------
add("Dashboard home", "src/routes/_authenticated/app.index.tsx (getWorkspaceOverview, getPageEntitlement)",
    "'Welcome back'; trial banner with days left + 'Choose a plan'; KPI cards (AI credits, published pages, synced listings); 'Search performance' card with Import GSC data / View click report / Ask Coach; Setup checklist; today's coach briefing.",
    "auth", P3, actual="'View click report' links to a stub tool (see Click Report row).", route="/app")
add("Setup checklist", "src/components/dashboard/SetupChecklist.tsx",
    "4 steps: Connect Sharetribe · Sync listings · Set marketplace domain · Publish your first page.",
    "auth", P3, actual="Each step links to the relevant page.", route="/app")
add("Daily coach briefing (on-demand)", "src/components/coach/DailyBriefing.tsx → coach.functions generateBriefingNow/getTodayBriefing/dismissInsight; 'Do it' → coach-actions runCoachAction (fix_thin_page, add_meta, create_city_page, add_internal_links)",
    "'A daily briefing that ranks your highest-ROI actions' with one-click 'Do it' fixes (README: coach 'can execute fixes').",
    "auth; AI metered (free trial quota → purchased credits); platform OPENROUTER key or BYOK", P5,
    actual="Manual 'Generate' exists; automatic daily generation relies on the cron below.", route="/app")
add("Nightly coach briefing cron", "supabase/functions/coach-briefing-cron + supabase/migrations/20260825122000_fix_cron_jobs.sql (07:00 UTC, x-cron-secret from Vault)",
    "Briefing waiting every morning without the customer clicking anything.",
    "CRON_SECRET in Vault + on the edge function (audit 2026-09-02: unset → all scheduled jobs off, silently)", OPS,
    actual="Cannot be observed unauthenticated; needs a 24 h window with an account. Treat 'daily' promise as unverified.")
add("Coach chat (tool-using agent)", "src/routes/_authenticated/app.coach.tsx → supabase/functions/coach-chat (streaming; tools: get_workspace_overview, query_pages, query_listings, get_page_seo_audit, suggest_internal_links, check_listing_coverage, get_gsc_data, check_sitemap_health, suggest_content_additions, apply_seo_fix); conversations list/create/rename/delete",
    "README: 'AI Coach: contextual agent that reads your data, suggests actions, can execute fixes'.",
    "auth (workspace member); AI metered; BYOK → platform fallback", P5,
    actual="Conversation CRUD is server functions; each send is an LLM call (spend-capped phase only).", route="/app/coach")
add("Floating coach launcher (⌘J) on every app page", "src/components/coach/CoachLauncher.tsx + CoachPanel.tsx (mounted in app.tsx shell)",
    "Ask the coach from anywhere in the dashboard.",
    "auth; AI metered on send", P5, actual="Opening the panel is free; sending spends.", route="/app")
add("SEO Coach (guided session)", "src/routes/_authenticated/app.seo-coach.tsx → admin-seo-coach.functions seoCoachChat",
    "'Start session' → question-by-question SEO coaching ('Yes / No / your answer…'), Restart.",
    "auth; AI metered", P5, actual="Distinct from Coach chat; same metering.", route="/app/seo-coach")
add("Plan / trial badge in app header", "src/routes/_authenticated/app.tsx header (subscription_status === trialing → 'Trial')",
    "Always see which plan you are on.",
    "auth", P3, actual="Derived from workspaces.plan / subscription_status.", route="/app")

# ---- D. Content / pages ------------------------------------------------------
add("Pages list", "src/routes/_authenticated/app.pages.tsx (listTenantPages, deleteTenantPage)",
    "'Your SEO surface': stats, search, status badges, View live / Preview links, delete, CTAs Bulk import · AI builder · New page · Connect domain; empty state 'No pages yet'.",
    "auth", P3, actual="Until a domain is verified 'View live' opens a noindexed platform preview (/s/{ws}/{slug}).", route="/app/pages")
add("Page editor (new / edit)", "src/routes/_authenticated/app.pages.$id.edit.tsx (+ app.pages.new.tsx redirect; tenant-pages.functions upsertTenantPage/getTenantPage/listPageTemplates)",
    "Help: 'Pages -> New page and pick a template… Review, edit, and click Publish'. Template picker (page_templates, City Hub); tabs Content / SEO / Listings / Preview; fields body (markdown), slug, SEO title, meta description, H1, city/state, category label, max listings; Save draft · Save changes · Publish live · Unpublish.",
    "auth", P3, actual="Publishing goes through the atomic entitlement gate.", route="/app/pages/new")
add("Publish gate (page capacity + contract gate)", "src/lib/entitlements.functions.ts publishPagesAtomically → RPC publish_tenant_pages; tenant-pages.functions contract gate (noindex / duplicate)",
    "FAQ: only live pages consume a slot (trial 25, plans 100–5,000 + add-on); limit message tells the customer to upgrade or unpublish.",
    "auth; plan entitlement", P3, actual="Message text: pageLimitMessage(). Needs 25+ pages to hit the trial ceiling.")
add("Unpublish frees a slot", "app.pages.$id.edit.tsx onSave(opts.unpublish) → status draft",
    "FAQ: 'Unpublish a page any time to free its slot.'",
    "auth", P3, actual="Explicit Unpublish action exists in the editor.")
add("Live preview + SEO/SERP preview in editor", "src/components/pages/PageLivePreview.tsx, PageSeoPreview.tsx",
    "README: 'Page builder with live preview'.",
    "auth", P3, actual="Preview tab on narrow screens, side panel on xl.")
add("Bulk city import (CSV)", "src/routes/_authenticated/app.pages.bulk.tsx → bulkCreatePages",
    "Paste a CSV of cities → preview → 'Create N drafts' or 'Publish N pages'.",
    "auth; publish gate", P3, actual="Single-CSV import — NOT the two-CSV 'matrix builder' the help centre describes.", route="/app/pages/bulk")
add("Quick Page Builder (AI) + city gap detection", "src/routes/_authenticated/app.content.quick-page-builder.tsx → admin-quick-page.functions createQuickPage, page-builder.functions getPageBuilderContext",
    "'Ship SEO pages in 60 seconds' — 'Cities with listings but no page yet' chips (README: 'city gap detection'); page type + brief (city, state, title, meta hint, topic); AI model select (Gemini 3.1 Pro / 3.5 Flash / 3 Flash); generates grounded in real listings and publishes (kept as draft when the limit is hit).",
    "auth; needs BYOK OPENROUTER_API_KEY or platform key ('No AI key configured…' otherwise); AI metered", P5,
    actual="The only whole-page AI generation surface that is implemented.", route="/app/content/quick-page-builder")
add("Generate Content (bulk generation)", "src/routes/_authenticated/app.content.generate.tsx (getGenerateStats reads content_plan/content_pages)",
    "Nav headline item 'Generate Content — Bulk-generate programmatic pages from your content plan'; README: 'Programmatic SEO + content factory (AI pages at ~$0.012/page)'.",
    "auth", P3, status=NOTIMPL, sev="P1",
    actual="Page itself says 'Generation backend pending — The generate-content-batch edge function will be ported in Wave C'; no such edge function exists in supabase/functions. Only stats are shown.",
    route="/app/content/generate")
add("Bulk Page Editor", "src/routes/_authenticated/app.content.bulk-editor.tsx → admin-content-pages.functions listContentPages/updateContentPageBasics",
    "Search pages and toggle sitemap inclusion in bulk.",
    "auth", P3, actual="Operates on the LEGACY content_pages model, not tenant_pages that the editor/publisher use.", route="/app/content/bulk-editor")
add("Data export (CSV)", "src/routes/_authenticated/app.content.data-export.tsx → admin-data-io exportTable (content_plan, content_pages, tenant_pages)",
    "'Download workspace-scoped tables for backup or analysis.'",
    "auth", P3, actual="Three tables only; no listings/keywords/audits export.", route="/app/content/data-export")
add("Data import (CSV, dry-run)", "src/routes/_authenticated/app.content.data-import.tsx → importTable / getImportSchema",
    "'Upload CSVs into your workspace's tables. Dry-run first, then import. Max 25 MB.'",
    "auth", P3, actual="Same three tables.", route="/app/content/data-import")
add("Content Migration", "src/routes/_authenticated/app.content.migration.tsx",
    "'Import legacy URLs into /p/{slug} with redirects.'", "stub flag", P3, status=DISABLED,
    actual=STUB_NOTE, route="/app/content/migration")
add("Blog Admin", "src/routes/_authenticated/app.content.blog.tsx",
    "'Long-form posts surfaced under /p/blog/*.'", "stub flag", P3, status=DISABLED, actual=STUB_NOTE, route="/app/content/blog")
add("Learning Admin", "src/routes/_authenticated/app.content.learning.tsx",
    "'Courses, modules, and certificate completions.'", "stub flag", P3, status=DISABLED, actual=STUB_NOTE, route="/app/content/learning")
add("City Heroes", "src/routes/_authenticated/app.content.city-heroes.tsx",
    "'Manage city hero imagery and copy. Internal staff only.'", "stub + internalOnly", OPS, status=DISABLED, actual=STUB_NOTE, route="/app/content/city-heroes")
add("Public tenant page /a/{slug}", "src/routes/a.$slug.tsx ← public-tenant-page.functions getPublicTenantPage; src/components/templates/CityHub.tsx",
    "Live, indexable landing page on the customer's domain: listing grid from synced Sharetribe listings, related-page internal links, canonical, noindex when thin, BreadcrumbList/ItemList/Product JSON-LD.",
    "page published; domain verified for the customer host (platform host serves noindexed preview)", P3,
    actual="Probed live: /a/<unknown> should 404 (checked in this phase).", route="/a/live-acceptance-probe")
add("Legacy /p/{slug} → 301 /a/{slug}", "src/routes/p.$slug.tsx",
    "Old /p/ links keep working (README still says 'Public tenant pages (/p/slug)').",
    "none", P9, actual="Probed live in this phase.", route="/p/live-acceptance-probe")
add("Platform-hosted preview /s/{ws}/{slug}", "src/routes/s.$ws.$slug.tsx",
    "Preview a page on founders.click before a domain is connected (noindex).",
    "page published", P3, actual="Probed live (unknown → 404).", route="/s/live-acceptance/probe")
add("Automatic sitemaps (tenant)", "src/routes/a.sitemap[.]xml.tsx, sitemap[.]xml.tsx (host-aware), src/routes/api/public/sitemap-by-host.ts, src/lib/sitemap.server.ts",
    "'Automatic sitemaps' in every plan; help: 'Your sitemap lives at https://your-domain.com/sitemap.xml' (code: root-domain mode → /a/sitemap.xml).",
    "verified domain", P8, actual="Help article URL differs from the /a/sitemap.xml the domains page tells root-domain customers to submit.")
add("Schema / structured data", "src/routes/a.$slug.tsx head() + listing structured_data from sharetribe-sync.server.ts; src/lib/json-ld.ts",
    "'Schema / structured data' in every plan.",
    "published page", P3, actual="BreadcrumbList, ItemList, per-listing Product JSON-LD.")
add("Internal linking on published pages", "public-tenant-page.functions fetchRelated (related_pages) + CityHub template",
    "'Internal linking' in every plan.",
    "≥2 published pages", P3, actual="Related published pages rendered as links; separate recommender tool below.")
add("Page templates", "page_templates table (listPageTemplates); src/components/templates/CityHub.tsx",
    "Help: 'Templates are reusable page structures with {{variables}}… Edit one template, regenerate hundreds of pages.'",
    "auth", P3, actual="Only the City Hub template component exists in code; there is no template editing UI and no regenerate-all action.", route="/app/pages/new")
add("404 logging from public pages", "src/lib/admin-404-log.functions.ts logPublic404 (called by a.$slug notFound)",
    "Missing-page hits on your domain show up in 'Missing Pages (404s)'.",
    "published tenant host", P4, actual="Feeds the Missing Pages tool.")

# ---- E. SEO tools --------------------------------------------------------------
add("Rank Tracker", "src/routes/_authenticated/app.seo.rank-tracker.tsx → admin-rank-tracker.functions (add/delete keyword, runSerpCheck)",
    "Landing: 'rank tracking'; add keyword + target path, Check / Check all (20), tracked keywords table.",
    "auth; workspace secret SERPAPI_KEY (Settings → API Keys) — 'Missing SERPAPI_KEY' otherwise", P4,
    actual="Customer-supplied SerpApi key required; nothing platform-provided.", route="/app/seo/rank-tracker")
add("AI Page Auditor", "src/routes/_authenticated/app.seo.page-auditor.tsx → admin-page-auditor.functions auditPage/listRecentAudits",
    "Landing: 'AI page auditor'; audit a URL path, recent audits.",
    "auth; AI metered", P5, actual="LLM call per audit — spend-capped phase only.", route="/app/seo/page-auditor")
add("Keyword Opportunities", "src/routes/_authenticated/app.seo.keyword-opportunities.tsx → findKeywordOpportunities/getKeywordStats",
    "Landing: 'keyword gaps'; filter and search opportunities from imported GSC queries.",
    "auth; needs GSC data imported", P4, actual="Empty until GSC Import has run.", route="/app/seo/keyword-opportunities")
add("Competitor Tracker (scrape)", "src/routes/_authenticated/app.seo.competitor-tracker.tsx → admin-seo-tools scrapeCompetitorUrl (Firecrawl v2)",
    "Add a competitor URL + notes → Scrape; tracked pages; delete.",
    "auth; workspace secret FIRECRAWL_API_KEY ('Settings → API Keys' — the API Keys page only presets OPENROUTER_API_KEY and SERPAPI_KEY; key name must be typed)", P4,
    actual="Customer-supplied Firecrawl key required.", route="/app/seo/competitor-tracker")
add("Internal Link Recommender", "src/routes/_authenticated/app.seo.internal-links.tsx → generateLinkSuggestions/listLinkSuggestions/updateLinkSuggestionStatus",
    "README: 'internal links'; Regenerate suggestions, filter by status, Mark applied / Dismiss.",
    "auth; ≥2 pages", P4, actual="Suggestions are recorded, not auto-applied to page bodies.", route="/app/seo/internal-links")
add("Link Checker", "src/routes/_authenticated/app.seo.link-checker.tsx → admin-link-checker scanInternalLinks",
    "Scan / Re-scan for broken internal links.",
    "auth", P4, actual="", route="/app/seo/link-checker")
add("Missing Pages (404 log) + redirects", "src/routes/_authenticated/app.seo.missing-pages.tsx → list404s/resolve404/redirect404",
    "See 404 hits, mark resolved, or create a redirect to a target path/URL.",
    "auth", P4, actual="Redirect creates a status='redirect' page row honoured by the public route.", route="/app/seo/missing-pages")
add("GSC Import (paste CSV)", "src/routes/_authenticated/app.seo.gsc-import.tsx → importGscQueries",
    "Dashboard: 'Import GSC data'; help 'Welcome': 'Track everything in Google Search Console'.",
    "auth", P4, actual="Manual CSV paste only — there is no Google Search Console OAuth connection.", route="/app/seo/gsc-import")
add("Content Health (thin-page scan)", "src/routes/_authenticated/app.seo.content-health.tsx → admin-content-health scanContentHealth",
    "Scan pages under a minimum body length; affected pages list.",
    "auth; NOT in app-nav.ts (orphan route — reachable by URL / coach only)", P4,
    actual="Route exists but no sidebar entry.", route="/app/seo/content-health")
add("Click Report", "src/routes/_authenticated/app.seo.click-report.tsx → click-report.functions getCityClickReport (reads city_link_clicks)",
    "Dashboard button 'View click report' — clicks by destination city over a window.",
    "stub flag in nav, but linked from the dashboard", P4, status=NOTIMPL, sev="P2",
    actual="app-nav.ts comment: 'reads city_link_clicks, which nothing writes yet — stub until a tracker exists'. Page always empty; still reachable from /app.",
    route="/app/seo/click-report")
add("Canonical Audit", "src/routes/_authenticated/app.seo.canonical-audit.tsx → admin-canonical-audit (platform-admin only)",
    "Audits founders.click's own canonical URLs.",
    "internalOnly; throws Forbidden for customers", OPS, status=DISABLED,
    actual="app-nav.ts: 'platform-admin-only (it audits founders.click itself) and throws Forbidden for customers'.", route="/app/seo/canonical-audit")
add("Competitor Radar", "src/routes/_authenticated/app.seo.competitor-radar.tsx",
    "Landing 'SEO Intelligence: Competitor radar…'; README 'Competitor radar'; stub text 'Watch competitor SERP movement and new pages.'",
    "stub flag", P4, status=NOTIMPL, sev="P1",
    actual="Advertised on the landing page and README but " + STUB_NOTE, route="/app/seo/competitor-radar")
add("Listing Auditor", "src/routes/_authenticated/app.seo.listing-auditor.tsx",
    "'Audit Sharetribe listings for missing fields and weak copy.'", "stub flag", P4, status=DISABLED, actual=STUB_NOTE, route="/app/seo/listing-auditor")
add("SEO Health", "src/routes/_authenticated/app.seo.health.tsx",
    "'Site-wide SEO score and red flags.'", "stub flag", P4, status=DISABLED, actual=STUB_NOTE, route="/app/seo/health")
add("Link Audit Dashboard", "src/routes/_authenticated/app.seo.link-audit.tsx",
    "'Aggregated view of broken-link audits across the site.'", "stub flag", P4, status=DISABLED, actual=STUB_NOTE, route="/app/seo/link-audit")
add("Sitemap & Indexing", "src/routes/_authenticated/app.seo.sitemap.tsx",
    "'Inspect sitemap.xml and submit to Google.' (help 'Publishing pages and getting indexed': 'Publish, ping Google')", "stub flag", P4, status=DISABLED,
    actual="No indexing/ping integration anywhere; " + STUB_NOTE, route="/app/seo/sitemap")
add("Scrape Import", "src/routes/_authenticated/app.seo.scrape-import.tsx",
    "'Import scraped competitor pages and keywords.'", "stub flag", P4, status=DISABLED, actual=STUB_NOTE, route="/app/seo/scrape-import")
add("SEO Opportunities engine", "src/routes/_authenticated/app.opportunities.tsx → opportunities.functions (analyze domain, approve → build page, skip)",
    "Analyse your website and approve AI-found page opportunities ('Build this page').",
    "env OPPORTUNITY_ENGINE_ENABLED=1 AND per-workspace feature_enrollments row (service-role only); not in nav", P5, status=DISABLED,
    actual="UI renders 'This feature isn't enabled for your workspace yet.' unless both gates pass; customers cannot self-enrol.", route="/app/opportunities")
add("Canonical-audit daily cron", "supabase/migrations/20260825122000_fix_cron_jobs.sql → POST /api/public/hooks/canonical-audit (06:00 UTC)",
    "Platform hygiene (not a customer promise).", "CRON_SECRET", OPS, actual="Hook probed without a secret in this phase (must be 401).")

# ---- F. Settings / integrations / domains --------------------------------------
add("Workspace settings", "src/routes/_authenticated/app.settings.tsx → updateWorkspaceProfile, getSettingsContext; SettingsNav (Workspace · Domains · Sharetribe · AI Providers · API Keys)",
    "Edit workspace name + marketplace domain; status cards (Sharetribe / Domains / AI providers / API keys) with 'Configure →'.",
    "auth; owner for writes (OwnerOnlyBanner for members)", P8, actual="", route="/app/settings")
add("Workspace branding (name, colour, logo)", "src/components/WorkspaceBrandingCard.tsx (mounted in app.settings.tsx) → updateWorkspaceBranding",
    "Brand shown in sidebar and on the public affiliate sign-up page.",
    "auth; owner", P8, actual="Used by /apply/{slug} branding.", route="/app/settings")
add("Sharetribe integration (connect / validate / sync now / disconnect)", "src/routes/_authenticated/app.settings.integrations.sharetribe.tsx → sharetribe-sync.functions (connectSharetribe validates creds, runSharetribeSync, disconnectSharetribe, certifyMarketplace); src/lib/sharetribe-sync.server.ts (listings + author + images → tenant_listings; never wipes to zero)",
    "Landing: 'Your listings, synced automatically in the background'; steps: 'We pull your listings, categories and locations automatically'; help: 'Connect… in under 5 minutes', 'Most marketplaces sync in under 2 minutes'.",
    "auth; owner; real Sharetribe Integration API credentials", P8,
    actual="Manual 'Sync now' implemented. Only listings are synced (city/state derived from listing publicData) — no separate categories/locations sync. One integration row per workspace.",
    route="/app/settings/integrations/sharetribe")
add("Scheduled Sharetribe sync (every 30 min)", "pg_cron 'sharetribe-sync-30min' → POST https://www.founders.click/api/public/hooks/sync-sharetribe (Bearer CRON_SECRET) → runSharetribeSyncAll; chains affiliate referral sync",
    "Welcome email: 'we do this automatically every 30 min'; landing: 'synced automatically in the background'.",
    "CRON_SECRET (Vault + Worker env); audit 2026-09-02 found it unset", OPS,
    actual="Hook probed without a secret in this phase: 401 = secret configured; 500 'server misconfigured' = CRON_SECRET missing on the Worker.")
add("Custom domains (connect / verify / activate / delete)", "src/routes/_authenticated/app.settings.domains.tsx → admin-domains.functions (add, verify [DNS TXT or file upload, auto-check], updateDomainConnection, activate → /a/founders-domain-test probe, delete); src/lib/domain-provisioning.server.ts (Cloudflare custom hostname + per-host Worker route, atomic)",
    "'Hosting on your domain' in every plan; step 3 'Connect and verify your own domain'; modes: root domain (full proxy) or 'Subdomain (seo.yourdomain.com) — One CNAME…'; plan domain limit (trial 1, Pro 3, Agency 10).",
    "auth; owner; a real hostname the tester controls; CLOUDFLARE_API_TOKEN/ZONE_ID on the server", P8,
    actual="Needs a customer-controlled DNS zone — Blocked without one.", route="/app/settings/domains")
add("Domain activation probe + public routing APIs", "src/routes/a.founders-domain-test.tsx; src/routes/api/public/domain-config.ts, domain-token.ts, edge-health.ts, page-lookup.ts, sitemap-by-host.ts (rate-limited, 404 for unknown hosts)",
    "Infrastructure behind 'Hosting on your domain' — the edge Worker only serves hosts we manage.",
    "none (public, rate-limited)", P9,
    actual="Probed live in this phase with an unknown hostname (expect 404s).", route="/a/founders-domain-test")
add("AI Providers (BYOK)", "src/routes/_authenticated/app.settings.ai.tsx → ai-byok.functions (providers openai / anthropic / google / openrouter; upsert, test, delete, default model, usage summary)",
    "README: 'OpenRouter / BYOK for AI'; bring your own key so generation bills your provider instead of platform credits.",
    "auth; owner", P8, actual="'Test' calls the provider with the key (cheap, but a real external call).", route="/app/settings/ai")
add("API Keys (workspace secrets)", "src/routes/_authenticated/app.settings.api-keys.tsx → admin-workspace-secrets (Vault-backed; presets OPENROUTER_API_KEY, SERPAPI_KEY)",
    "Store keys used by Quick Page Builder (OPENROUTER_API_KEY), Rank Tracker (SERPAPI_KEY) and Competitor Tracker (FIRECRAWL_API_KEY — not offered as a preset).",
    "auth; owner", P8, actual="Free-text key name + value; last four shown.", route="/app/settings/api-keys")
add("Owner-only gating for invited members", "src/components/settings/OwnerOnlyBanner.tsx; assertWorkspaceOwner on writes; customer-portal owner-only",
    "Members can view but not change billing/settings.",
    "second member (no invite UI exists)", P8, actual="Untestable: no way to add a member through the product.")

# ---- G. Billing -------------------------------------------------------------------
add("Billing page", "src/routes/_authenticated/app.billing.tsx (getPageEntitlement; success/canceled toasts)",
    "Current plan, 'Manage billing', page usage bar, AI generation credits + 'Add N ($)' packs, Plans grid ('Choose X' / 'Current plan' / 'Switch via portal'), page add-on 'Add N pages ($/mo)'.",
    "auth", P6, actual="Display testable; every action leads to Stripe.", route="/app/billing")
add("Free trial (14 days, 25 pages, no card)", "workspace.functions provisionWorkspace (trial_ends_at +14d, trial credit grant); plan-catalog TRIAL_PAGE_LIMIT=25, TRIAL_DOMAIN_LIMIT=1",
    "'14-day free trial · publish up to 25 pages · No card required'.",
    "none", P3, actual="Trial state visible on dashboard banner and billing page.", route="/app/billing")
add("Subscription checkout (Stripe)", "supabase/functions/create-checkout (modes credits / subscription / addon / page_addon; verify_jwt) ← billing page checkout()",
    "Pick a plan → pay → 'your plan will activate in a few seconds'.",
    "auth; owner; STRIPE_SECRET_KEY live only — NO test mode in production (brief: never enter a card)", P6,
    actual="Blocked at the Stripe page by the no-real-money rule.")
add("Manage billing (Stripe customer portal)", "supabase/functions/customer-portal (owner-only; Origin allowlist) ← 'Manage billing'",
    "Terms: 'cancel your subscription at any time from your account settings'; FAQ plan changes; invoices.",
    "auth; owner; existing Stripe customer; portal configuration in Stripe (not in repo)", P6,
    actual="Only path for cancel / invoices / downgrade; no native UI.")
add("AI credit packs", "billing page 'Add N (…)' → create-checkout mode=credits; stripe-catalog CREDIT_PACK 1,000 credits; ai-metering (free quota → credits, no hard cap)",
    "FAQ: 'add extra generation capacity at $10 per 1,000 generation credits'.",
    "Stripe", P6, actual="Price must be confirmed on the live billing page (P6).")
add("Page add-on blocks", "billing page 'Add N pages' (1–10 units) → create-checkout mode=page_addon; PAGE_ADDON $50 / 1,000 pages",
    "Landing: 'Add capacity in blocks of 1,000 from your dashboard.'",
    "Stripe", P6, actual="")
add("Plan change (upgrade / downgrade, proration)", "billing page: 'Switch via portal' once subscribed; create-checkout refuses a second subscription (409 per audit)",
    "FAQ: 'Upgrades take effect immediately with prorated billing. Downgrades apply at the end of your billing period.'",
    "Stripe portal configuration", P6, actual="Audit 2026-09-02 P1-9: no in-app upgrade path; proration/downgrade timing unverified.")
add("Cancellation behaviour", "supabase/functions/stripe-webhook (subscription deleted → page_limit → pages billing_suspended); entitlements suspendedPages",
    "FAQ: pages stay live to the end of the paid period, then are unpublished; content retained; same URLs on return.",
    "Stripe events", P6, actual="Cannot be exercised without test mode; audit notes no refund/dispute handling.")
add("Stripe webhook → entitlements", "supabase/functions/stripe-webhook (signature-verified, idempotent, audited) → workspaces.page_limit_base/addon, subscriptions, credit grants",
    "What you paid for is what you can publish.",
    "STRIPE_WEBHOOK_SECRET", P6, actual="Observable only through a paid checkout.")
add("Add-ons page", "src/routes/_authenticated/app.addons.tsx → addons.functions (ADDON_CATALOG: 'DM Champ — AI Sales Agent' $99/mo managed; 'Affiliate Programs' $30/mo self-serve); checkout mode=addon",
    "Buy add-ons; Affiliate add-on 'Or start a free trial →'.",
    "auth; owner; Stripe", P6,
    actual="App catalog lists 2 SKUs; stripe-catalog.ts defines 4 (adds affiliate-lite $15 / affiliate-pro $45) — drift. DM Champ is 'managed' (records intent only).",
    route="/app/addons")

# ---- H. Affiliates ---------------------------------------------------------------
add("Affiliate dashboard + add-on trial gate", "src/routes/_authenticated/app.affiliates.tsx → getAffiliateDashboard, startAffiliateTrial (14-day, addon_status=trialing)",
    "Landing (Everything included): 'Run referral programs that pay out on real transactions.' Page: 'Turn your members into a sales force… Start a free 14-day trial.'",
    "auth; owner; workspace_affiliate_settings.addon_status active|trialing (assertAddon on all writes)", P7,
    actual="Feature is a paid add-on with a self-serve trial, not part of the plans.", route="/app/affiliates")
add("Affiliate programs (create / edit / delete)", "app.affiliates.programs.tsx + programs.$id.edit.tsx → upsertProgram/deleteProgram (PROGRAM_LIMIT standard=1, pro=3)",
    "Program name, qualification trigger (Transaction / Sign Up), payout type (% of GMV / fixed), payout value.",
    "add-on active/trialing; owner", P7, actual="Standard tier allows 1 program.", route="/app/affiliates/programs")
add("Affiliates directory", "app.affiliates.directory.tsx → listAffiliates/createAffiliate/setAffiliateStatus",
    "Add an affiliate (name, email, program), search, change status.",
    "add-on", P7, actual="", route="/app/affiliates/directory")
add("Payouts", "app.affiliates.payouts.tsx → listPayouts/setPayoutStatus",
    "Add-on bullet: 'Payout lifecycle (pending → ready → paid)'; Approve / Mark paid / Reject.",
    "add-on; referrals recorded", P7, actual="No money movement — status bookkeeping only.", route="/app/affiliates/payouts")
add("Customise + applications review", "app.affiliates.customise.tsx → listApplications/decideApplication; branding link",
    "Branded public sign-up page; approve/decline pending applications.",
    "add-on", P7, actual="", route="/app/affiliates/customise")
add("Affiliate settings + referral sync", "app.affiliates.settings.tsx → updateAffiliateSettings (form slug, marketplace base URL, currency, referrer param) + affiliate-sync runAffiliateSync ('Run sync now')",
    "Add-on bullet: 'Referral tracking via Sharetribe Integration API'.",
    "add-on; Sharetribe connected", P7, actual="Also chained automatically after each listing sync (cron-dependent).", route="/app/affiliates/settings")
add("Public affiliate application page", "src/routes/apply.$slug.tsx → affiliate-public.functions getPublicAffiliateForm / submitAffiliateApplication (60/min/IP)",
    "'Apply to become an affiliate' — branded form, program select, name, email → 'Thanks! Your application has been received.'",
    "add-on active/trialing on the workspace; ≥1 active program", P7,
    actual="Probed live with an unknown slug (expect 'This affiliate program isn't available.'). Max one real submission in P7.", route="/apply/live-acceptance-nope")
add("Referral tracking on real transactions", "src/lib/affiliate-sync.server.ts (reads Sharetribe transactions via the Integration API; auto-enrols on first transaction)",
    "'pay out on real transactions'; 'Auto-enroll affiliates on first transaction'.",
    "add-on; Sharetribe transactions carrying the referrer param", P7, actual="Needs real marketplace transactions — Blocked in an acceptance run.")

# ---- I. Help centre & support --------------------------------------------------------
add("Help centre home", "src/routes/help.index.tsx (getHelpHome): search, categories, popular, recently updated, 'Still need help?'",
    "'How can we help?' — browse by category, popular articles, contact support.",
    "none", P9, actual="Live capture in this phase.", route="/help")
add("Help search (page + quick-search modal)", "src/routes/help.search.tsx (searchHelp, suggestions) + src/components/help/SearchModal.tsx (quickSearchHelp)",
    "Full-text search over published articles with suggestions when nothing matches.",
    "none", P9, actual="Probed live with q=sitemap.", route="/help/search?q=sitemap")
add("Help categories & articles (seeded content)", "src/routes/help.$category.tsx, help.$category.$article.tsx; seed supabase/migrations/20260511071212_*.sql (5 categories, 15 articles)",
    "Getting Started (5) · Sharetribe Integration (4) · Page Builder (3) · SEO & Growth (2) · Account & Billing (1). Several articles describe features that do not exist (see advertised-but-absent).",
    "none", P9, actual="Every live category and article title captured in this phase (help-articles.md).", route="/help/getting-started")
add("Article feedback (helpful / not helpful)", "src/components/help/HelpfulFeedback.tsx → help.functions submitArticleFeedback",
    "Rate an article, optionally say what was missing.",
    "none", P9, actual="One submission maximum in P9.")
add("Help AI assistant widget", "src/components/help/HelpAssistantWidget.tsx → supabase/functions/help-assistant-chat (public, RAG over help_article_embeddings; embeddings built by help-assistant-embed, admin-only)",
    "'Ask about founders.click' floating assistant on every help page ('AI can make mistakes').",
    "none (public; platform-paid AI)", P5, actual="Panel opened (no question sent) in this phase.", route="/help")
add("Contact support form", "src/routes/help.contact.tsx → submitSupportTicket (categories technical / billing / sales / other) → ticket + confirmation email",
    "'Ticket received' and an email confirmation; admins answer from Help Tickets.",
    "none", P9, actual="Phase 2 already submitted one: ticket created (ok:true) but no confirmation email arrived → recorded Failed there. Do not resubmit.", route="/help/contact")
add("In-app link to help / support", "src/routes/_authenticated/app.tsx sidebar (no /help link); README: 'reach out via the in-app help or support channels'",
    "Get help from inside the dashboard.",
    "auth", P3, status=NOTIMPL, sev="P3",
    actual="The dashboard shell has no Help / Contact link; only the floating Coach. Help centre is reachable by URL only.")

# ---- J. Ops / internal & platform plumbing -------------------------------------------
add("Lead Inbox", "src/routes/_authenticated/app.ops.lead-inbox.tsx",
    "Landing (Everything included): 'Capture and triage host/provider leads in one place.' README: 'Lead tools'; meta: 'lead inbox'.",
    "stub flag", P3, status=NOTIMPL, sev="P1",
    actual="Advertised on the landing page, README and meta description, but " + STUB_NOTE + " No lead capture form or table is written anywhere.",
    route="/app/ops/lead-inbox")
add("IG Lead Hunter / Social Lead Hunter", "app.ops.ig-lead-hunter.tsx, app.ops.social-lead-hunter.tsx",
    "'Find Instagram leads… at scale' / 'Cross-platform social scraper'.", "stub + internalOnly", OPS, status=DISABLED, actual=STUB_NOTE, route="/app/ops/ig-lead-hunter")
add("Email Branding", "app.ops.email-branding.tsx", "'Logo, colors, and footer applied to outbound email.'", "stub flag", OPS, status=DISABLED, actual=STUB_NOTE, route="/app/ops/email-branding")
add("Email Verify", "app.ops.email-verify.tsx", "'Verify lead email addresses (deliverable / catch-all / invalid).'", "stub flag", OPS, status=DISABLED, actual=STUB_NOTE, route="/app/ops/email-verify")
add("Site Footer", "app.ops.site-footer.tsx", "'Footer links and copy for your marketplace.'", "stub flag", OPS, status=DISABLED, actual=STUB_NOTE, route="/app/ops/site-footer")
add("Directory Moderation / Listing Claims / Plan Requests", "app.ops.directory-moderation.tsx, listing-claims.tsx, plan-requests.tsx",
    "Internal moderation / claims / manual plan comps.", "stub + internalOnly", OPS, status=DISABLED, actual=STUB_NOTE, route="/app/ops/plan-requests")
add("Help admin (articles, categories, feedback, tickets)", "app.admin.help.*.tsx → help-admin.functions, help-tickets.functions (platform admin role)",
    "Platform staff manage the help centre and answer tickets.", "internalOnly (is_internal workspace + admin role)", OPS, status=DISABLED,
    actual="Hidden from customers by internalOnly; server functions require the admin role.", route="/app/admin/help/articles")
add("Email templates admin", "app.admin.email-templates.tsx → email-templates.functions (edit/preview/reset/send test)",
    "Platform staff edit transactional email copy.", "internalOnly", OPS, status=DISABLED, actual="Same gating as help admin.", route="/app/admin/email-templates")
add("Transactional email delivery (EmailIt)", "src/lib/email.server.ts (welcome, ticket confirmation, help follow-up), auth-send-email hook",
    "Confirmation, reset, welcome and support emails arrive.",
    "EmailIt credentials; hook secret", P2,
    actual="Phase 2 evidence: zero emails delivered across signup, reset and contact-form sends — treat every email-dependent journey as unverified.")
add("Public cron hooks refuse unauthenticated calls", "src/routes/api/public/hooks/sync-sharetribe.ts, canonical-audit.ts, auth-send-email.ts",
    "Nobody can trigger tenant syncs / audits / mail without the shared secret.",
    "CRON_SECRET / hook secret", P9, actual="POSTed with no credentials in this phase; results in extra.")
add("Public endpoint rate limits & host safety", "src/lib/public-rate-limit.ts + per-route in-memory buckets; security-headers.ts",
    "Public APIs answer 404 for hosts we do not manage and 429 under abuse.",
    "none", P9, actual="Spot-checked unknown-host responses in this phase.")

# --------------------------------------------------------------------------
# Promises with nothing (or a stub) behind them — from marketing, help, README,
# legal copy and in-app links. Rendered into the matrix and returned.
ADVERTISED_BUT_ABSENT = [
    "Landing 'Everything included → Lead Inbox: Capture and triage host/provider leads in one place' (also README 'Lead tools', meta description 'lead inbox') → /app/ops/lead-inbox is a hidden StubToolPage 'Coming soon'; no capture form, table or backend.",
    "Landing 'SEO Intelligence: Competitor radar, …' (also README 'Competitor radar') → /app/seo/competitor-radar is a hidden StubToolPage 'Coming soon'.",
    "Landing 'Everything included' / pricing 'Every feature unlocked' / 'Every plan unlocks every feature' → Affiliate Programs is a separate $30/mo add-on (trial only), DM Champ is a $99/mo add-on, and the SEO Opportunities engine is env + enrolment gated.",
    "Nav headline 'Generate Content' (README 'Programmatic SEO + content factory (AI pages at ~$0.012/page)') → page says 'Generation backend pending — generate-content-batch will be ported in Wave C'; no such edge function exists.",
    "Dashboard button 'View click report' → Click Report reads city_link_clicks, which nothing writes (app-nav.ts comment); always empty.",
    "Landing 'Sharetribe Sync: synced automatically in the background' + welcome email 'we do this automatically every 30 min' + FIXES/feature 'A daily briefing…' → both depend on pg_cron jobs gated on CRON_SECRET, which the 2026-09-02 audit found unset (jobs fail silently). Code exists; automation unverified. (Live probe of the hook in this phase indicates whether the Worker has the secret.)",
    "Landing step 1 'We pull your listings, categories and locations automatically' → sync pulls listings (+ author, images); categories/locations are only fields derived from listing publicData, not synced objects.",
    "Landing FAQ 'Can I change plans anytime? Upgrades… prorated. Downgrades… end of period' → no in-app upgrade path (create-checkout refuses a second subscription; 'Switch via portal' depends on Stripe portal config not in repo). Unverifiable without test mode.",
    "Landing FAQ 'What happens if I cancel? … pages return at exactly the same URLs' → webhook suspends pages; return/restore path and refund handling absent (audit P1-3). Unverifiable without test mode.",
    "Help 'Mapping custom fields to page variables → Settings -> Field mapping… drag a Sharetribe field onto a template variable' → no Field mapping settings page exists.",
    "Help 'Handling multiple marketplaces in one workspace (on paid plans connect multiple Sharetribe accounts)' → one integration row per workspace; no multi-marketplace UI.",
    "Help 'Using the matrix builder for bulk page creation — Upload two CSVs…' → no matrix builder; Bulk city import takes one CSV of cities.",
    "Help 'Writing SEO-optimized content with AI assist — Click Generate with AI on any section' → the page editor has no per-section AI; AI writes whole pages only via Quick Page Builder.",
    "Help 'Understanding page limits: Starter 50 · Growth 500 · Scale 5,000 · Enterprise custom' → catalog is Starter 100 · Growth 500 · Scale 1,000 · Pro 3,000 · Agency 5,000; there is no Enterprise plan.",
    "Help 'Troubleshooting failed syncs → Check Settings -> Sync history' → no sync-history view; the integration page shows the last sync only.",
    "Help 'Running your first sync → hit Sync now on the dashboard' → 'Sync now' lives on Settings → Sharetribe; the dashboard only links there.",
    "Help 'Connecting your Sharetribe marketplace → click Test connection' → the button is 'Validate & Connect'.",
    "Help category 'Account & Billing: … team members, invoices, and cancellation' → no team/invite feature (Admin Team is a stub), invoices and cancellation only via the Stripe portal (owner-only, external).",
    "Help 'Publishing pages and getting indexed — Publish, ping Google' and stub 'Sitemap & Indexing: submit to Google' → no indexing/ping integration; sitemap submission is manual in GSC.",
    "Help 'Welcome… Track everything in Google Search Console' → GSC data enters only by pasting a CSV export; no GSC connection.",
    "Help 'Understanding page templates — Edit one template, regenerate hundreds of pages' → no template editor and no regenerate action; one City Hub template.",
    "Help 'Submitting your sitemap: https://your-domain.com/sitemap.xml' → root-domain connections expose the tenant sitemap at /a/sitemap.xml (domains page), not /sitemap.xml.",
    "Terms 'cancel your subscription at any time from your account settings' / Privacy 'data deleted or anonymised' → no native cancel, no account or workspace deletion path (support email only).",
    "Privacy policy cookie/consent language → no consent banner or cookie controls in the code.",
    "README 'reach out via the in-app help' → the dashboard has no Help/Contact link.",
    "README 'Public tenant pages (/p/slug)' → /p/ now 301s to /a/ (canonical); minor.",
    "Login/Signup 'Continue with Google' → code toasts 'Google sign-in is not enabled in Supabase yet' when the provider is off; must be clicked in P2.",
    "Backlink / link-building: no backlink feature is advertised or implemented anywhere (grep: zero hits); 'referral' appears only as the affiliate add-on.",
    "Locale: the help centre header offers six languages (English / Español / Français / Deutsch / Suomi / Svenska) but the marketing site has no switcher and the dashboard/help article copy is English-only.",
    "Help home links 'Welcome to founders.click', 'Connecting your Sharetribe marketplace', 'Publishing pages and getting indexed' and the help sitemap lists all five Getting Started articles → every one of them, and /help/getting-started itself, returns 404 in production.",
    "Help home / sitemap link '/help/billing/bring-your-own-ai-key-byok' → 404 (category 'billing' does not exist).",
    "Help article pages (all categories): the URL answers 200 with the article's <title>, but the visible page is the category listing — the article body never renders (route nesting without <Outlet>). Customers cannot read any help article.",
]

# --------------------------------------------------------------------------
LANDING_JS = r"""
() => {
  const txt = el => (el ? el.innerText.replace(/\s+/g,' ').trim() : '');
  const q = (sel, root=document) => Array.from((root||document).querySelectorAll(sel));
  const out = {};
  const hero = document.querySelector('main section');
  const heroPs = hero ? q('p', hero) : [];
  out.hero = { eyebrow: txt(heroPs[0]), h1: txt(hero && hero.querySelector('h1')), sub: txt(heroPs[1]),
               ctas: q('a', hero).map(a => ({text: txt(a), href: a.getAttribute('href')})), fineprint: txt(heroPs[2]) };
  out.demo = { caption: txt(document.querySelector('#demo figcaption')), video: (document.querySelector('#demo video source')||{}).getAttribute ? document.querySelector('#demo video source').getAttribute('src') : null };
  const secs = q('main section');
  const pf = secs.find(s => txt(s).toLowerCase().includes('the problem'));
  out.problem_fix = pf ? q(':scope > div > div', pf).map(c => ({ label: txt(c.querySelector('p')), h2: txt(c.querySelector('h2')), items: q('li', c).map(txt) })) : [];
  out.features = { eyebrow: txt(document.querySelector('#features p')), h2: txt(document.querySelector('#features-heading')),
                   items: q('#features li').map(li => ({ title: txt(li.querySelector('h3')), desc: txt(li.querySelector('p')) })) };
  const how = document.querySelector('#how-heading'); const howSec = how ? how.closest('section') : null;
  out.how = { h2: txt(how), steps: q('ol li', howSec).map(li => ({ title: txt(li.querySelector('h3')), desc: txt(li.querySelector('p')) })) };
  const pr = document.querySelector('#pricing');
  out.pricing = { h2: txt(document.querySelector('#pricing-heading')), intro: txt(pr && pr.querySelector('#pricing-heading + p')),
    tiers: q('#pricing .grid > div').map(t => { const ps = q('p', t); return { name: txt(t.querySelector('h3')), price: txt(ps[0]), pages: txt(ps[1]), bullets: ps.slice(2).map(txt), cta: txt(t.querySelector('a')), badge: txt(t.querySelector('span.absolute')) }; }),
    included: q('#pricing ul li').map(txt), addon_note: txt(q('#pricing > p').slice(-1)[0]) };
  out.faq = q('#faq h3 button').map((b,i) => ({ q: txt(b), a: txt(document.getElementById('faq-panel-'+i)) }));
  const cta = document.querySelector('#final-cta-heading'); const ctaSec = cta ? cta.closest('section') : null;
  out.final_cta = { h2: txt(cta), p: txt(ctaSec && ctaSec.querySelector('p')), cta: txt(ctaSec && ctaSec.querySelector('a')) };
  out.header_links = q('header a, header button').map(a => ({ text: txt(a), href: a.getAttribute('href') }));
  out.footer_links = q('footer a').map(a => ({ text: txt(a), href: a.getAttribute('href') }));
  out.footer_text = txt(document.querySelector('footer'));
  out.title = document.title;
  out.meta_description = (document.querySelector('meta[name=description]')||{}).content || null;
  out.canonical = (document.querySelector('link[rel=canonical]')||{}).href || null;
  out.jsonld = q('script[type="application/ld+json"]').map(s => s.textContent.slice(0, 600));
  out.lang_switcher = q('select, [aria-label*="anguage"], [aria-label*="ocale"]').length;
  return out;
}
"""

HELP_JS = r"""
() => {
  const txt = el => (el ? el.innerText.replace(/\s+/g,' ').trim() : '');
  const q = (sel, root=document) => Array.from((root||document).querySelectorAll(sel));
  const out = { title: document.title, h1: txt(document.querySelector('h1')),
                search_placeholder: (document.querySelector('input')||{}).placeholder || null };
  out.sections = q('main h2').map(h => { const root = h.closest('section') || h.parentElement;
      return { heading: txt(h), text: txt(root).slice(0, 700),
               links: q('a', root).map(a => ({ text: txt(a).slice(0,160), href: a.getAttribute('href') })) }; });
  out.all_links = q('main a').map(a => ({ text: txt(a).slice(0,120), href: a.getAttribute('href') }));
  out.buttons = q('button').map(b => ({ text: txt(b).slice(0,80), aria: b.getAttribute('aria-label') }));
  out.header_links = q('header a').map(a => ({ text: txt(a), href: a.getAttribute('href') }));
  out.footer_links = q('footer a').map(a => ({ text: txt(a), href: a.getAttribute('href') }));
  out.main_text = txt(document.querySelector('main')).slice(0, 4000);
  return out;
}
"""

CATEGORY_JS = r"""
(cat) => {
  const txt = el => (el ? el.innerText.replace(/\s+/g,' ').trim() : '');
  const links = Array.from(document.querySelectorAll('main a')).filter(a => (a.getAttribute('href')||'').startsWith('/help/' + cat + '/'));
  const seen = new Set(); const out = [];
  for (const a of links) { const h = a.getAttribute('href'); if (seen.has(h)) continue; seen.add(h);
    out.push({ href: h, title: txt(a.querySelector('h3') || a).slice(0,160), excerpt: txt(a.querySelector('p')).slice(0,300) }); }
  return { h1: txt(document.querySelector('h1')), description: txt(document.querySelector('main p')), articles: out };
}
"""

ARTICLE_JS = r"""
() => {
  const txt = el => (el ? el.innerText.replace(/\s+/g,' ').trim() : '');
  const main = document.querySelector('main') || document.body;
  const h1s = Array.from(document.querySelectorAll('h1')).map(txt);
  const body = txt(main);
  return { title: document.title, h1s, h1: h1s[h1s.length - 1] || '', body: body.slice(0, 3000),
           headings: Array.from(main.querySelectorAll('h2,h3')).map(txt).slice(0, 30),
           not_found: /article not found|category not found|page not found/i.test(body),
           has_feedback: /helpful/i.test(body) };
}
"""


def esc(s: str) -> str:
    return str(s).replace("|", "\\|").replace("\n", " ")


async def probe_api(s: Session) -> dict:
    """Unauthenticated probes of the public APIs and cron hooks. No secrets,
    unknown hostnames only — nothing can change state."""
    r = s.context.request
    out = {}

    async def go(name, method, path, **kw):
        try:
            resp = await getattr(r, method)(f"{BASE}{path}", timeout=20000, **kw)
            body = (await resp.text())[:200].replace("\n", " ")
            out[name] = {"status": resp.status, "body": body}
        except Exception as e:  # noqa: BLE001
            out[name] = {"error": str(e)[:200]}

    await go("domain-config unknown host", "get", "/api/public/domain-config?hostname=live-acceptance-probe.example.com")
    await go("domain-token unknown host", "get", "/api/public/domain-token?hostname=live-acceptance-probe.example.com")
    await go("sitemap-by-host unknown host", "get", "/api/public/sitemap-by-host?hostname=live-acceptance-probe.example.com")
    await go("page-lookup unknown host", "post", "/api/public/page-lookup",
             data=json.dumps({"hostname": "live-acceptance-probe.example.com", "slug": "x"}),
             headers={"content-type": "application/json"})
    await go("hook sync-sharetribe (no secret)", "post", "/api/public/hooks/sync-sharetribe",
             data="{}", headers={"content-type": "application/json"})
    await go("hook canonical-audit (no secret)", "post", "/api/public/hooks/canonical-audit",
             data="{}", headers={"content-type": "application/json"})
    await go("hook auth-send-email (no signature)", "post", "/api/public/hooks/auth-send-email",
             data="{}", headers={"content-type": "application/json"})
    return out


async def main():
    live: dict = {}
    shots: dict[str, str] = {}
    route_obs: dict[str, str] = {}

    async with Session(PHASE, label="anonymous visitor (inventory)") as s:
        # ---------------- 1. Marketing page: the contract -------------------
        await s.goto("/", settle_ms=3000)
        # The FAQ is a one-open-at-a-time accordion: open each entry to read it.
        faq_buttons = s.page.locator("#faq h3 button")
        n = await faq_buttons.count()
        for i in range(n):
            try:
                await faq_buttons.nth(i).click(timeout=3000)
                await s.page.wait_for_timeout(150)
                a = await s.page.locator(f"#faq-panel-{i}").inner_text(timeout=2000)
                live.setdefault("faq_expanded", []).append(re.sub(r"\s+", " ", a).strip())
            except Exception:
                live.setdefault("faq_expanded", []).append("(could not expand)")
        landing = await s.page.evaluate(LANDING_JS)
        for i, a in enumerate(live.get("faq_expanded", [])):
            if i < len(landing.get("faq", [])):
                landing["faq"][i]["a"] = a
        live["landing"] = landing
        shots["/"] = await s.shot("marketing-landing-full", full=True)
        (OUT / "marketing-page.txt").write_text(await s.text())
        await s.record(
            feature="LIVE CAPTURE — marketing page promise text",
            promise="The customer-facing promise text on https://www.founders.click/ is the contract for every later phase.",
            actions=["open /", "expand every FAQ entry", "extract hero / problem-fix / features / how-it-works / pricing / FAQ / footer via DOM"],
            expected="Text matches src/routes/index.tsx constants and src/lib/plan-catalog.ts",
            actual=(f"h1={landing['hero']['h1']!r}; sub={landing['hero']['sub'][:120]!r}; fineprint={landing['hero']['fineprint']!r}; "
                    f"features={[f['title'] for f in landing['features']['items']]}; tiers={[(t['name'], t['price'], t['pages']) for t in landing['pricing']['tiers']]}; "
                    f"included={landing['pricing']['included']}; faq={len(landing['faq'])} entries; lang_switcher_controls={landing['lang_switcher']}"),
            status=BLOCKED, screenshot=shots["/"], extra={"landing": landing},
        )

        # ---------------- 2. Help centre ------------------------------------
        await s.goto("/help", settle_ms=3000)
        helphome = await s.page.evaluate(HELP_JS)
        live["help_home"] = helphome
        shots["/help"] = await s.shot("help-home-full", full=True)
        (OUT / "help-home.txt").write_text(helphome.get("main_text", ""))
        # Open the AI assistant panel (no question is sent) to capture its promise copy.
        assistant_copy = ""
        try:
            launcher = s.page.get_by_role("button", name=re.compile("open help assistant", re.I))
            if await launcher.count():
                await launcher.first.click()
                await s.page.wait_for_timeout(800)
                assistant_copy = await s.text("[role=dialog], aside, div:has(> h3:text-is('Ask about founders.click'))")
                if not assistant_copy:
                    assistant_copy = (await s.text())[-600:]
                shots["assistant"] = await s.shot("help-assistant-panel-open")
                closer = s.page.get_by_role("button", name=re.compile("close help assistant|close", re.I))
                if await closer.count():
                    await closer.first.click()
        except Exception as e:  # noqa: BLE001
            assistant_copy = f"(assistant probe failed: {e})"
        live["help_assistant_copy"] = assistant_copy[:800]
        cat_links = sorted({l["href"] for l in helphome["all_links"]
                            if re.fullmatch(r"/help/[a-z0-9-]+", l["href"] or "") and l["href"] not in ("/help/contact", "/help/search")})
        await s.record(
            feature="LIVE CAPTURE — help centre home",
            promise="Help centre promises (categories, popular/recent articles, 'Still need help?', AI assistant) are part of the contract.",
            actions=["open /help", "extract sections/links via DOM", "open the AI assistant panel (nothing sent)", "close it"],
            expected="Categories from the seed migration; assistant present",
            actual=(f"h1={helphome['h1']!r}; sections={[x['heading'] for x in helphome['sections']]}; categories={cat_links}; "
                    f"assistant_launcher={'yes' if any((b.get('aria') or '').lower().startswith('open help assistant') for b in helphome['buttons']) else 'no'}; "
                    f"assistant_copy={assistant_copy[:160]!r}"),
            status=BLOCKED, screenshot=shots["/help"], extra={"help_home": helphome, "assistant_copy": assistant_copy[:800]},
        )

        # ---------------- 3. Every live category + article ------------------
        # Discover categories/articles from THREE sources so nothing the site
        # advertises is skipped: category cards on /help, article links on
        # /help (popular / recent), and the help sitemap.
        sitemap_urls: list[str] = []
        try:
            resp = await s.context.request.get(f"{BASE}/help/sitemap.xml", timeout=20000)
            sm = await resp.text()
            (OUT / "help-sitemap.xml").write_text(sm)
            sitemap_urls = [u.replace(BASE, "") for u in re.findall(r"<loc>([^<]+)</loc>", sm)]
        except Exception as e:  # noqa: BLE001
            live["help_sitemap_error"] = str(e)[:200]
        article_urls = sorted({l["href"] for l in helphome["all_links"] if re.fullmatch(r"/help/[a-z0-9-]+/[a-z0-9-]+", l["href"] or "")}
                              | {u for u in sitemap_urls if re.fullmatch(r"/help/[a-z0-9-]+/[a-z0-9-]+", u)})
        cat_links = sorted(set(cat_links) | {u.rsplit("/", 1)[0] for u in article_urls}
                           | {u for u in sitemap_urls if re.fullmatch(r"/help/[a-z0-9-]+", u) and u not in ("/help/contact", "/help/search")})
        live["help_sitemap_urls"] = sitemap_urls
        articles_md = ["# Help centre — live article inventory (captured unauthenticated)", "",
                       f"Sources: category cards + article links on /help, and /help/sitemap.xml ({len(sitemap_urls)} URLs).", ""]
        all_articles = []
        cat_info: dict[str, dict] = {}
        for cat in cat_links:
            slug = cat.rsplit("/", 1)[-1]
            resp = await s.goto(cat, settle_ms=1800)
            info = await s.page.evaluate(CATEGORY_JS, slug)
            info["http"] = resp.status if resp else None
            info["not_found"] = bool(re.search(r"category not found|page not found", await s.text(), re.I)) or info["http"] == 404
            cat_info[cat] = info
            shots[cat] = await s.shot(f"help-category-{slug}")
            articles_md += [f"## {info['h1'] or slug}  ({cat}) — HTTP {info['http']}{' — CATEGORY NOT FOUND' if info['not_found'] else ''}",
                            f"_{info['description']}_", ""]
            for href in sorted({a["href"] for a in info["articles"]} | {u for u in article_urls if u.startswith(cat + "/")}):
                excerpt = next((a["excerpt"] for a in info["articles"] if a["href"] == href), "")
                aresp = await s.goto(href, settle_ms=1500)
                art = await s.page.evaluate(ARTICLE_JS)
                art_http = aresp.status if aresp else None
                rec = {"category": slug, "href": href, "http": art_http, "not_found": art["not_found"] or art_http == 404,
                       "title": art["h1"] if not art["not_found"] else "(404)", "page_title": art["title"], "h1s": art["h1s"],
                       "excerpt": excerpt, "headings": art["headings"], "body": art["body"], "has_feedback": art["has_feedback"],
                       "in_sitemap": href in sitemap_urls, "linked_from_home": any(l["href"] == href for l in helphome["all_links"])}
                all_articles.append(rec)
                if not rec["not_found"] and "article-full" not in shots:
                    shots["article-full"] = await s.shot(f"help-article-{href.rsplit('/', 1)[-1]}", full=True)
                articles_md += [f"### {rec['title']}  (`{href}`) — HTTP {art_http}{' — NOT FOUND' if rec['not_found'] else ''}",
                                f"- In help sitemap: {rec['in_sitemap']}; linked from /help: {rec['linked_from_home']}",
                                f"- Excerpt: {excerpt}", f"- h1s on page: {art['h1s']}",
                                f"- Headings: {', '.join(art['headings'])}", f"- Body: {art['body'][:1500]}", ""]
            arts = [x for x in all_articles if x["category"] == slug]
            missing = [x["href"] for x in arts if x["not_found"]]
            await s.record(
                feature=f"LIVE CAPTURE — help category '{info['h1'] or slug}'",
                promise=info["description"] or "(category page not served)",
                actions=[f"open {cat}", "open every article linked from it, from /help, or listed in /help/sitemap.xml; capture title/h1/headings/body"],
                expected="Category page + its articles from the seed migration / admin",
                actual=(f"category http={info['http']} not_found={info['not_found']}; {len(arts)} article URLs, {len(missing)} return 404: {missing}; "
                        f"live titles={[x['title'] for x in arts if not x['not_found']]}"),
                status=BLOCKED, screenshot=shots[cat], url=f"{BASE}{cat}", extra={"category": info, "articles": arts},
            )
        (OUT / "help-articles.md").write_text("\n".join(articles_md))
        (OUT / "help-articles.json").write_text(json.dumps(all_articles, indent=2))
        live["help_articles"] = [(a["category"], a["title"], a["href"], a["http"]) for a in all_articles]
        live["help_missing"] = [a["href"] for a in all_articles if a["not_found"]] + [c for c, i in cat_info.items() if i["not_found"]]

        # ---------------- 4. Other public pages -------------------------------
        public_pages = {
            "/help/contact": "contact",
            "/help/search?q=sitemap": "help-search",
            "/terms": "terms",
            "/privacy": "privacy",
            "/login": "login",
            "/signup": "signup",
            "/reset-password": "reset-password",
            "/robots.txt": "robots",
            "/sitemap.xml": "sitemap",
            "/help/sitemap.xml": "help-sitemap",
            "/a/founders-domain-test": "domain-test",
            "/p/live-acceptance-probe": "p-redirect",
            "/a/live-acceptance-probe": "a-404",
            "/s/live-acceptance/probe": "s-404",
            "/apply/live-acceptance-nope": "apply-unknown",
            "/this-route-does-not-exist": "root-404",
        }
        raw_files = {"/robots.txt": "robots.txt", "/sitemap.xml": "sitemap.xml", "/help/sitemap.xml": "help-sitemap.xml"}
        expect = {
            "/help/contact": "Contact form with name/email/category/subject/message (not submitted here)",
            "/help/search?q=sitemap": "Search results page",
            "/terms": "Terms of Service", "/privacy": "Privacy Policy",
            "/login": "Email/password form + Google + reset link", "/signup": "Name/email/password + Google + legal links",
            "/reset-password": "Email form 'Send reset link'",
            "/robots.txt": "Allow /, Disallow /app /login /signup /reset-password, two sitemaps",
            "/sitemap.xml": "Marketing sitemap (/, /help, /privacy, /terms) on the platform host",
            "/help/sitemap.xml": "Every published help category + article",
            "/a/founders-domain-test": "Marker text; tenant 'not-connected' on the platform host",
            "/p/live-acceptance-probe": "301 → /a/live-acceptance-probe → 404",
            "/a/live-acceptance-probe": "404 (unknown page)", "/s/live-acceptance/probe": "404 (unknown workspace/page)",
            "/apply/live-acceptance-nope": "'This affiliate program isn't available.'",
            "/this-route-does-not-exist": "Branded 404 with 'Go home'",
        }
        for path, name in public_pages.items():
            try:
                resp = await s.goto(path, settle_ms=1500)
                status = resp.status if resp else "?"
                body = await s.text()
                extra: dict = {}
                if path in raw_files:
                    rr = await s.context.request.get(f"{BASE}{path}", timeout=20000)
                    raw = await rr.text()
                    (OUT / raw_files[path]).write_text(raw)
                    body = raw[:1200]
                    extra = {"http": rr.status, "raw_first_1200": body, "locs": re.findall(r"<loc>([^<]+)</loc>", raw)[:60]}
                controls = ""
                if path in ("/help/contact", "/login", "/signup", "/reset-password"):
                    labels = await s.page.locator("label").all_inner_texts()
                    buttons = await s.page.locator("button, a[role=button]").all_inner_texts()
                    controls = f" labels={labels} buttons={[b.strip() for b in buttons if b.strip()]}"
                    if path == "/help/contact":
                        try:
                            await s.page.get_by_role("combobox").first.click(timeout=2000)
                            opts = await s.page.get_by_role("option").all_inner_texts()
                            await s.page.keyboard.press("Escape")
                            controls += f" category_options={opts}"
                        except Exception:
                            pass
                shots[path] = await s.shot(f"public-{name}")
                route_obs[path] = f"http={status} final={s.page.url.replace(BASE, '')} text={body[:220]!r}{controls}"
                await s.record(
                    feature=f"LIVE PROBE — {path}",
                    promise="A public URL the site links to or advertises (discovery only, nothing submitted)",
                    actions=[f"open {path}"], expected=expect.get(path, ""), actual=route_obs[path][:900],
                    status=BLOCKED, screenshot=shots[path], url=f"{BASE}{path}", extra=extra,
                )
            except Exception as e:  # noqa: BLE001
                route_obs[path] = f"probe error: {e}"

        # Legal-page promise extraction (sentences around the words that matter).
        for path in ("/terms", "/privacy"):
            await s.goto(path, settle_ms=1200)
            t = await s.text()
            hits = [m.group(0) for m in re.finditer(r"[^.]{0,140}\b(cancel|refund|delete|deletion|cookie|retain|support@founders\.click)\b[^.]{0,140}\.", t, re.I)]
            live[f"legal{path.replace('/', '_')}"] = hits[:14]

        # ---------------- 5. Public API / hook probes -------------------------
        api = await probe_api(s)
        live["api_probes"] = api
        sync_hook = api.get("hook sync-sharetribe (no secret)", {})
        cron_secret_missing = sync_hook.get("status") == 500 and "misconfigured" in sync_hook.get("body", "")
        await s.record(
            feature="LIVE PROBE — public APIs and cron hooks (no credentials, unknown hostname)",
            promise="Public routing APIs answer 404 for hosts we do not manage; cron/auth hooks refuse calls without the shared secret.",
            actions=["GET domain-config / domain-token / sitemap-by-host ?hostname=<unknown>", "POST page-lookup <unknown>",
                     "POST hooks/sync-sharetribe, hooks/canonical-audit, hooks/auth-send-email with no secret/signature"],
            expected="404/404/404/ok:false; 401/401/401",
            actual="; ".join(f"{k}: {v}" for k, v in api.items()),
            status=BLOCKED, screenshot=shots["/"], url=f"{BASE}/api/public/", extra={"api": api, "cron_secret_missing_on_worker": cron_secret_missing},
        )

        # ---------------- 6. Every dashboard route, unauthenticated ----------
        app_routes = sorted({f["route"] for f in F if f["route"] and (f["route"] == "/app" or f["route"].startswith("/app/"))})
        for path in app_routes:
            try:
                await s.goto(path, settle_ms=800)
                try:
                    await s.page.wait_for_url("**/login**", timeout=9000)
                except Exception:
                    pass
                await s.page.wait_for_timeout(400)
                final = s.page.url.replace(BASE, "")
                body = (await s.text())[:160]
                shots[path] = await s.shot(f"app-route{path.replace('/', '-')}")
                if "/login" in final:
                    route_obs[path] = f"route live; anonymous → {final}"
                elif "Page not found" in body or "404" in body[:40]:
                    route_obs[path] = f"NOT FOUND in production build: {final} {body!r}"
                else:
                    route_obs[path] = f"unexpected: {final} {body!r}"
            except Exception as e:  # noqa: BLE001
                route_obs[path] = f"probe error: {e}"

        (OUT / "live-capture.json").write_text(json.dumps({"live": live, "routes": route_obs}, indent=2))
        n_live = sum(1 for p in app_routes if "route live" in route_obs.get(p, ""))
        await s.record(
            feature=f"LIVE PROBE — {len(app_routes)} dashboard routes opened unauthenticated",
            promise="Every /app route in the code exists in the production build and bounces anonymous visitors to /login?next=…",
            actions=[f"open each of {len(app_routes)} /app routes in a fresh anonymous profile"],
            expected="All redirect to /login with next=<route>; none 404",
            actual=f"{n_live}/{len(app_routes)} redirected to /login; others: " + "; ".join(f"{p}: {route_obs[p][:120]}" for p in app_routes if "route live" not in route_obs.get(p, "")),
            status=BLOCKED, screenshot=shots.get("/app", shots["/"]), url=f"{BASE}/app", extra={"routes": {p: route_obs.get(p) for p in app_routes}},
        )

        # ---- runtime-derived rows and status upgrades (discovery evidence) ---
        by_name = {f["feature"]: f for f in F}
        row = by_name["Scheduled Sharetribe sync (every 30 min)"]
        if cron_secret_missing:
            row.update(status=NOTIMPL, sev="P1", actual=row["actual"] + " LIVE: POST /api/public/hooks/sync-sharetribe with no secret → 500 'server misconfigured', which the code returns only when CRON_SECRET is unset on the Worker — the pg_cron job can never authenticate, so the automatic 30-minute sync promised by the welcome email and landing page is operationally absent in production.")
        else:
            row["actual"] += f" LIVE: hook answered {sync_hook} (secret appears configured; schedule itself unobservable here)."
        by_name["Public cron hooks refuse unauthenticated calls"]["actual"] = "; ".join(
            f"{k}: {v}" for k, v in api.items() if k.startswith("hook"))
        by_name["Domain activation probe + public routing APIs"]["actual"] += " LIVE: " + "; ".join(
            f"{k}: {v}" for k, v in api.items() if not k.startswith("hook"))
        by_name["Site header / footer navigation & locale"]["actual"] = (
            f"Marketing header/footer render no locale switcher ({live['landing']['lang_switcher']} controls live); the HELP header does render a 'Language' selector (English / Español / Français / Deutsch / Suomi / Svenska) — see /help/contact probe text. Marketing copy is English-only.")
        live_arts = [a for a in all_articles if not a["not_found"]]
        rendered = [a for a in live_arts if a["page_title"].split(" — ")[0].strip().lower() in [h.lower() for h in a["h1s"]]]
        missing = live.get("help_missing", [])
        by_name["Help categories & articles (seeded content)"]["actual"] += (
            f" LIVE: {len(cat_links)} category URLs, {len(all_articles)} article URLs discovered; {len(missing)} return 404: {missing}; "
            f"{len(rendered)}/{len(live_arts)} live article URLs show the article's own h1.")
        add("Help 'Getting Started' onboarding articles", "help seed 20260511071212: category getting-started (Welcome, Connecting Sharetribe, first sync, first SEO page, publishing & indexing); linked from /help (popular/recent) and listed in /help/sitemap.xml",
            "Help home surfaces 'Welcome to founders.click', 'Connecting your Sharetribe marketplace', 'Publishing pages and getting indexed'; category 'Onboarding, first page, connecting Sharetribe, and your first sync.'",
            "none", P9,
            status=NOTIMPL if "/help/getting-started" in missing else BLOCKED, sev="P2" if "/help/getting-started" in missing else "-",
            actual=("LIVE: /help/getting-started and all five article URLs return HTTP 404 although the help home page links to them and the help sitemap lists them — the onboarding documentation is unreachable." if "/help/getting-started" in missing else "LIVE: category served."))
        add("Help article reading (article body renders)", "src/routes/help.$category.$article.tsx nested under help.$category.tsx (file-route nesting); the category component renders no <Outlet>",
            "Open an article and read it ('Was this helpful?' feedback at the end).",
            "none", P9,
            status=(NOTIMPL if live_arts and not rendered else BLOCKED), sev=("P1" if live_arts and not rendered else "-"),
            actual=(f"LIVE: {len(live_arts)} article URLs answer 200 with the article's <title>, but the visible page is the CATEGORY listing (h1s={live_arts[0]['h1s'] if live_arts else []}); no article body, headings or feedback control render. Cause in code: /help/$category/$article is a child route of /help/$category and the parent component has no <Outlet>, so the child never renders."
                    if live_arts and not rendered else f"LIVE: {len(rendered)}/{len(live_arts)} articles render their own heading."))
        byok = [a for a in all_articles if "bring-your-own-ai-key" in a["href"]]
        if byok:
            add("Help article 'Bring your own AI key (BYOK)' (admin-added, not in seed)", "/help/billing/bring-your-own-ai-key-byok — linked from /help and listed in /help/sitemap.xml; category 'billing' does not exist in the seed",
                "Explain BYOK to customers.", "none", P9,
                status=NOTIMPL if byok[0]["not_found"] else BLOCKED, sev="P3" if byok[0]["not_found"] else "-",
                actual=f"LIVE: http={byok[0]['http']} not_found={byok[0]['not_found']} (category /help/billing http={cat_info.get('/help/billing', {}).get('http')}).")
        s.drain()  # evidence from the probes above already belongs to their own records

        # ---------------- 7. One harness record per inventory feature --------
        for f in F:
            route = f["route"]
            obs = route_obs.get(route, "") if route else ""
            actual = f["actual"]
            if obs:
                actual = f"{actual} [live probe {route}: {obs}]".strip()
            shot = shots.get(route) or (shots["/help"] if route and route.startswith("/help") else shots["/"])
            await s.record(
                feature=f["feature"],
                promise=f["promise"],
                actions=[f"discovery: read {f['where']}"] + ([f"unauthenticated GET {route}"] if route else []),
                expected=f"To be tested in {f['phase']} (gate: {f['gate']})",
                actual=actual or "(inventory only)",
                status=f["status"], severity=f["sev"],
                impact=("" if f["status"] == BLOCKED else
                        ("Advertised/navigable feature with nothing behind it" if f["status"] == NOTIMPL else "Hidden on purpose")),
                screenshot=shot, url=f"{BASE}{route}" if route else BASE,
                extra={"where": f["where"], "gate": f["gate"], "phase": f["phase"]},
            )

        # ---------------- 8. The matrix ---------------------------------------
        counts = {}
        for f in F:
            counts[f["status"]] = counts.get(f["status"], 0) + 1
        md = [
            "# founders.click — Phase 1 feature inventory (advertised vs exposed)",
            "",
            f"Captured unauthenticated against {BASE} on 2026-09-02 by `tests/e2e/live/phase1_inventory.py`. "
            "Records + screenshots: `docs/evidence/live-acceptance-2026-09-02/phase1-inventory/records.json`. "
            "Live text: `marketing-page.txt`, `help-home.txt`, `help-articles.md`, `live-capture.json`.",
            "",
            f"**{len(F)} features** — " + ", ".join(f"{k}: {v}" for k, v in sorted(counts.items())) + ".",
            "",
            "Status legend for this phase: **Blocked** = inventoried, not yet tested (the later phase named in 'Test phase' must test it); "
            "**Not implemented** = advertised or navigable but nothing behind it (proved by discovery); "
            "**Intentionally disabled** = hidden by the `stub`/`internalOnly` nav flag or an env/enrolment gate (proved by discovery).",
            "",
            "## Feature matrix",
            "",
            "| # | Feature | Where | Customer promise | Gate | Test phase | Discovery status |",
            "|---|---|---|---|---|---|---|",
        ]
        for i, f in enumerate(F, 1):
            obs = route_obs.get(f["route"], "") if f["route"] else ""
            status_cell = f["status"] + (f" (sev {f['sev']})" if f["sev"] != "-" else "")
            detail = f["actual"]
            if obs:
                detail += f" — live: {obs[:140]}"
            md.append(f"| {i} | {esc(f['feature'])} | {esc(f['where'])} | {esc(f['promise'])} | {esc(f['gate'])} | {esc(f['phase'])} | **{status_cell}** — {esc(detail)} |")

        md += ["", "## Advertised but absent (promise → what is actually there)", ""]
        md += [f"{i}. {x}" for i, x in enumerate(ADVERTISED_BUT_ABSENT, 1)]

        L = live["landing"]
        md += ["", "## Live marketing-page capture (the contract)", "",
               f"- Title: {L['title']}", f"- Meta description: {L['meta_description']}",
               f"- Hero: **{L['hero']['h1']}** — {L['hero']['sub']} — CTAs {[(c['text'], c['href']) for c in L['hero']['ctas']]} — fine print: {L['hero']['fineprint']}",
               f"- Demo: {L['demo']['caption']} ({L['demo']['video']})"]
        for blk in L["problem_fix"]:
            md.append(f"- {blk['label']}: **{blk['h2']}** — " + " · ".join(blk["items"]))
        md.append(f"- {L['features']['eyebrow']}: **{L['features']['h2']}** — " + " · ".join(f"**{x['title']}**: {x['desc']}" for x in L['features']['items']))
        md.append(f"- How it works: **{L['how']['h2']}** — " + " · ".join(f"{x['title']}: {x['desc']}" for x in L['how']['steps']))
        md.append(f"- Pricing: **{L['pricing']['h2']}** — {L['pricing']['intro']}")
        for t in L["pricing"]["tiers"]:
            md.append(f"  - {t['name']} {t['price']} — {t['pages']} — {' / '.join(t['bullets'])} — CTA '{t['cta']}' {('[' + t['badge'] + ']') if t['badge'] else ''}")
        md.append(f"  - Every plan includes: {' · '.join(L['pricing']['included'])}")
        md.append(f"  - {L['pricing']['addon_note']}")
        md.append("- FAQ:")
        for fq in L["faq"]:
            md.append(f"  - **{fq['q']}** {fq['a']}")
        md.append(f"- Final CTA: **{L['final_cta']['h2']}** — {L['final_cta']['p']} — '{L['final_cta']['cta']}'")
        md.append(f"- Header links: {[(x['text'], x['href']) for x in L['header_links']]}")
        md.append(f"- Footer links: {[(x['text'], x['href']) for x in L['footer_links']]}")
        md.append(f"- Language switcher controls found: {L['lang_switcher']}")

        H = live["help_home"]
        md += ["", "## Live help-centre capture", "", f"- Title: {H['title']} — h1: {H['h1']} — search placeholder: {H['search_placeholder']}"]
        for sec in H["sections"]:
            md.append(f"- **{sec['heading']}**: " + "; ".join(f"{l['text']} → {l['href']}" for l in sec["links"][:12]))
        md.append(f"- AI assistant copy (panel opened, nothing sent): {live['help_assistant_copy'][:400]}")
        md.append(f"- Help sitemap URLs ({len(live.get('help_sitemap_urls', []))}): {live.get('help_sitemap_urls')}")
        md.append(f"- Article URLs probed ({len(live['help_articles'])}): " + "; ".join(f"{h} → HTTP {code} ({t})" for c, t, h, code in live["help_articles"]))
        md.append(f"- Category/article URLs returning 404: {live.get('help_missing')}")
        md.append(f"- Article rendering: {len(rendered)}/{len(live_arts)} live article URLs display the article's own heading (see 'Help article reading' row).")
        md.append("- Full captured bodies: `help-articles.md` / `help-articles.json`.")

        md += ["", "## Legal-page promise sentences", ""]
        for k in ("legal_terms", "legal_privacy"):
            md.append(f"- **{k}**:")
            md += [f"  - {x.strip()}" for x in live.get(k, [])]

        md += ["", "## Public route & API probes (unauthenticated)", "", "| Path | Observation |", "|---|---|"]
        for path, obs in route_obs.items():
            md.append(f"| `{esc(path)}` | {esc(obs)} |")
        for name, r in api.items():
            md.append(f"| API: {esc(name)} | {esc(json.dumps(r))} |")

        md += ["", "## Gates & environment switches found in code", "",
               "- `stub: true` (app-nav.ts) hides 20 scaffold pages from the sidebar; `?showStubs=1` reveals them; each renders `StubToolPage` 'Coming soon'.",
               "- `internalOnly: true` shows only for workspaces with `is_internal` (Canonical Audit, help admin, email templates, several ops stubs).",
               "- `OPPORTUNITY_ENGINE_ENABLED` (env) AND `feature_enrollments` row (service-role only) gate /app/opportunities.",
               "- `CRON_SECRET` (Vault + Worker + edge fn) gates the three pg_cron jobs: coach-briefing-nightly 07:00 UTC, canonical-audit-daily 06:00 UTC, sharetribe-sync-30min.",
               "- Affiliate add-on: `workspace_affiliate_settings.addon_status` active|trialing (self-serve 14-day trial) gates every affiliate write and the public /apply page.",
               "- BYOK keys: `OPENROUTER_API_KEY` (Quick Page Builder; platform fallback), `SERPAPI_KEY` (Rank Tracker), `FIRECRAWL_API_KEY` (Competitor Tracker); AI Providers page holds openai/anthropic/google/openrouter keys for ai-proxy / coach.",
               "- AI metering: free trial quota → purchased credits (`consume_platform_ai_credit`, `deduct_credits`); 'Out of AI credits. Top up in Billing' when empty.",
               "- Page entitlement: `publish_tenant_pages` RPC (trial 25; plans 100/500/1,000/3,000/5,000; +1,000 per $50 add-on); domain limit trial 1 / Pro 3 / Agency 10.",
               "- Stripe: create-checkout, customer-portal (owner-only), stripe-webhook; live keys only — no test mode in production.",
               "- Owner-only writes (`assertWorkspaceOwner`) on settings, secrets, billing, affiliates; but there is no UI to add a second member.",
               "",
               "## Recommended phase order for the remaining rows",
               "",
               "P2 account (unblocked only once email delivery works) → P3 content (pages, publish gate, public /a/ page, sitemap) → P4 SEO tools (empty states + BYOK-key gates) → P5 AI (Quick Page Builder, coach, briefing, SEO coach, page auditor, help assistant — spend-capped) → P6 billing (display only; every action stops at Stripe) → P7 affiliates (self-serve trial; one /apply submission) → P8 settings/integrations/domains (needs Sharetribe creds and a controlled hostname) → P9 public/help/support (feedback once; no second ticket).",
               ]
        (OUT / "feature-matrix.md").write_text("\n".join(md) + "\n")
        print(f"\nmatrix → {OUT / 'feature-matrix.md'}  ({len(F)} rows)")


if __name__ == "__main__":
    asyncio.run(main())
