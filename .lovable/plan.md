# AI Coach for founders.click

A contextual, tool-using agent embedded in the app. Not a chatbot — it reads workspace data, calls tools, and returns specific actionable recommendations. Uses each tenant's BYOK keys via the existing `ai-proxy` edge function.

## Scope

Three surfaces:
1. **Persistent chat panel** — slide-out, ⌘J shortcut, available on every `/app/*` route
2. **Daily briefing card** — top of `/app/dashboard`, regenerated nightly via cron
3. **Inline coaching** — context-aware side panel on page builder, listing sync, SEO settings

## Database (one migration)

- `coach_conversations` — workspace_id, user_id, title, context_type, context_ref_id
- `coach_messages` — conversation_id, role, content, tool_calls jsonb, tokens_used
- `coach_daily_briefings` — workspace_id, briefing_date (unique), insights jsonb, viewed_at
- `coach_action_log` — workspace_id, user_id, action_type, details jsonb
- `coach_system_prompts` — version-controlled system prompt rows so we can iterate without redeploy
- `coach_user_preferences` — per-user mode (aggressive/steady), preferred response length, model preference
- RLS: workspace members can read/write their workspace rows only; user prefs scoped to `auth.uid()`

## Edge functions

### `coach-chat` (streaming SSE)
- Auth: workspace member check
- Loads conversation history (last 20 messages) + workspace summary + active system prompt version
- Resolves tenant BYOK via `tenant_get_ai_credential` (provider/model from `coach_user_preferences`, fallback OpenAI)
- Tool-use loop, max 8 iterations: send → if `tool_use` blocks, execute → append results → repeat
- Streams final assistant text via SSE
- Persists every message (user, assistant, tool result) with `tokens_used`
- Returns rolling cost estimate to client
- Anthropic prompt caching headers on system + workspace context blocks

### `coach-tools` (internal RPC, called only from `coach-chat`)
Single function exposing all tools — keeps deploy simple. Tools:
- `query_pages(filters)` — over `tenant_pages`
- `query_listings(filters)` — over `tenant_listings`
- `get_page_seo_audit(page_id)` — word count, title/meta length, H1, internal links, schema check
- `get_gsc_data(page_url?, days)` — pulls existing GSC data if connected, else returns `not_connected`
- `suggest_content_additions(page_id)` — diff vs top 3 SERP results for primary keyword
- `suggest_internal_links(page_id)` — related workspace pages that should link in
- `generate_page_content(page_id, section, brief)` — uses BYOK to draft markdown
- `check_listing_coverage()` — listings with no page, pages with no matching listings
- `check_sitemap_health()` — validates sitemap, finds 404s and orphans
- `run_competitor_analysis(query, location)` — top-3 SERP scrape via existing fetch infra
- `apply_seo_fix(page_id, fix_type, payload)` — gated; requires `confirmed: true` flag set by client

All tool inputs validated with Zod. Workspace isolation enforced inside every tool implementation in addition to RLS.

### `coach-briefing-cron` (called by pg_cron daily at 06:00 UTC)
- For each active workspace: run analysis tools, score by `impressions × position_improvement_potential`
- Send top 10 candidates to LLM, ask for top 3 with priority + action_type + action_payload
- Upsert into `coach_daily_briefings` keyed by `(workspace_id, briefing_date)`

### Pg_cron
- Schedule via `net.http_post` to `coach-briefing-cron` daily, using anon key in `apikey` header

## Frontend

- `src/lib/coach.functions.ts` — server fns: `listConversations`, `createConversation`, `getMessages`, `getTodayBriefing`, `dismissInsight`, `logCoachAction`, `setCoachPreferences`
- `src/components/coach/CoachPanel.tsx` — slide-out using existing Sheet primitive; conversation list, streaming message renderer (react-markdown), tool-call collapsibles, action buttons, suggested prompts, cost footer
- `src/components/coach/CoachLauncher.tsx` — floating button + ⌘J binding, mounted in `_authenticated` layout
- `src/components/coach/DailyBriefing.tsx` — three insight cards on dashboard with "Take action" / "Dismiss"
- `src/components/coach/InlineCoach.tsx` — collapsible right panel; consumes `context` prop; mounted on page builder, listing sync, SEO settings routes
- Streaming via `fetch` to `/functions/v1/coach-chat`, SSE parser per AI gateway pattern
- Suggested prompts library (15 starter prompts) in `src/lib/coach-prompts.ts`

## Constraints honored

- All LLM calls use tenant BYOK; if missing, panel shows upgrade CTA pointing to `/app/settings/ai`
- Destructive tools (`apply_seo_fix`, `generate_page_content` write-back) require client to pass `confirmed: true` after a Confirm click
- Context window trimmed to last 20 messages + system + workspace summary
- Streaming SSE; no spinners on assistant text
- Workspace isolation: RLS + tool-level checks
- No autonomous mutations — every write is button-triggered

## Out of scope for this build

- Public `/audit` lead magnet (separate workstream)
- Cross-workspace user memory (will scaffold `coach_user_preferences` but not auto-summarize)
- Conversation summarization rollup at 50 messages (will leave a TODO; trim-only for now)
- Coach analytics dashboard for admins

## Build order

1. Migration (tables + RLS + `coach_system_prompts` seed row)
2. `coach-chat` edge function with full tool layer + Zod schemas + streaming
3. `coach-briefing-cron` + pg_cron schedule
4. `coach.functions.ts` server functions
5. `CoachPanel` + `CoachLauncher` mounted in `_authenticated` layout
6. `DailyBriefing` on dashboard
7. `InlineCoach` wired into page builder route (other surfaces follow same pattern)
8. Suggested prompts + cost footer + ⌘J shortcut
