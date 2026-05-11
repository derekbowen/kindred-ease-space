
# Help Center Build Plan

Full scope from the prompt, sequenced across 4 turns so each turn ships something working and reviewable. Accent color reuses existing brand tokens from `src/styles.css` (no new palette).

## Turn 1 — Foundation + Public Site (SSR)

**Database** (single migration)
- `help_categories`, `help_articles` (with `tsvector` + GIN index + trigger), `help_article_feedback`, `help_search_queries`, `support_tickets`
- RLS: published categories/articles readable by anon; feedback/queries/tickets insert-only by anon; admin-only writes via `has_role(_, 'admin')`
- Seed: 5 categories + 15 placeholder articles (markdown bodies)

**Public routes** (all SSR via loaders + server fns using `supabaseAdmin` server-side)
- `/help` — hero, search input, 5 category cards, popular + recent sections
- `/help/$category` — breadcrumb, article list, sidebar of other categories
- `/help/$category/$article` — TOC, markdown body, feedback widget, related articles
- `/help/search?q=` — Postgres `websearch_to_tsquery` + `ts_rank`, filters
- `/help/contact` — form → `support_tickets` insert (email send wired in turn 3)
- `/help/sitemap.xml` — server route, absolute URLs

**Components**
- `Breadcrumb`, `CategoryCard`, `ArticleCard`, `TableOfContents`, `HelpfulFeedback`, `Callout`, `CodeBlock` (Shiki), `MarkdownRenderer` (remark/rehype + custom `:::info` callouts), `ContactForm`

**SEO**
- Per-route `head()` with title/description/og/canonical
- Article JSON-LD (`Article` + `BreadcrumbList`)

## Turn 2 — Admin CRUD

- `/app/admin/help/articles` — list with filters, markdown editor with live preview, autosave draft (30s), publish toggle, body_html pre-render on save
- `/app/admin/help/categories` — CRUD + drag-to-reorder
- Admin gating via existing `user_roles` + `has_role(uid, 'admin')`
- Server functions for all writes (`*.functions.ts` calling `supabaseAdmin` only after admin check)

## Turn 3 — Search Modal + Contact Email + Feedback Dashboard

- `SearchModal` (cmd+K) — debounced 150ms, keyboard nav, recent searches in localStorage
- Contact form → `support_tickets` insert + EmailIt notification to support@founders.click (reuse existing `email.server.ts`)
- `/app/admin/help/feedback` — recent thumbs-down, lowest helpful-ratio articles, zero-result query log
- `/app/admin/help/tickets` — inbox, view, status/priority/assignment, reply via email

## Turn 4 — Polish + Automation

- Dynamic OG images per article (server route rendering SVG → PNG, no external deps)
- AI draft generator in admin (Lovable AI Gateway, google/gemini-2.5-flash)
- Weekly zero-result query digest (pg_cron → server route → email)
- Dark mode toggle (if not already present) + accessibility pass (focus rings, ARIA, contrast)
- Lighthouse audit + lazy-loading sweep

## Technical notes

- All article data access goes through `supabaseAdmin` in `*.server.ts` / server functions — never from browser
- Markdown rendered to HTML at save time, stored in `body_html`; runtime just sanitizes + injects TOC anchors
- Search uses `websearch_to_tsquery('english', q)` ranked by `ts_rank(search_vector, query)`
- Sitemap built from `published_at IS NOT NULL`, absolute URL via request host
- No new npm deps beyond: `react-markdown`, `remark-gfm`, `rehype-slug`, `rehype-autolink-headings`, `shiki`, `dompurify`

## Out of scope (explicit)

- Subdomain `help.founders.click` — using `/help` subpath
- Algolia / MeiliSearch — Postgres FTS only
- pgvector related-articles automation (deferred; manual `related_article_ids` for now)
- Tenant-branded help centers (the "unconventional play")

---

Approve to start Turn 1 (migration + 5 categories + 15 seed articles + full public site + SEO).
