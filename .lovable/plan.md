# Tenant Onboarding & Setup System

Build a complete onboarding system so new tenants can get to first value without you in the loop. Three surfaces, one source of truth.

## Decisions baked in

1. **Cron is platform-managed.** One master `pg_cron` job loops every `tenant_integrations` row with `status='connected'` and calls the existing sync hook. Tenants never see SQL. The "Schedule cron" step is removed from the wizard entirely. The existing `/api/public/hooks/sync-sharetribe` already supports this — we just schedule it once, server-side.
2. **Soft-blocking, not hard walls.** Steps 1–2 (Connect + Sync) gate the Pages builder with an inline nag. Everything else is encouraged but skippable. Dismiss hides the dashboard widget for 7 days.
3. **State derived from real data**, not user-clicked checkboxes. Triggers update `workspace_onboarding` flags from `tenant_integrations` and `tenant_pages` events.
4. **Email sequence**: scaffolded with Lovable Emails (built-in, queue-based). Will require setting up an email domain — I'll prompt for that when we get there. If you'd rather skip emails for v1, say so and I'll cut that section.

## Scope

### 1. Database (one migration)

- `workspace_onboarding` — one row per workspace, tracks 5 step booleans + timestamps + `current_step`, `onboarding_completed`, `onboarding_dismissed_until`. Auto-created via trigger on `workspaces` insert. Backfill rows for existing workspaces.
- `onboarding_events` — append-only event log (`workspace_id`, `step_name`, `event_type`, `metadata`) for funnel analytics.
- Triggers (all `SECURITY DEFINER`):
  - `tenant_integrations` insert/update with `status='connected'` → set `step_sharetribe_connected`
  - `tenant_integrations` update where `last_sync_status='success'` → set `step_first_sync_completed`
  - `tenant_pages` insert → set `step_first_page_created`
  - `tenant_pages` update to `status='published'` → set `step_first_page_published`
  - When all required steps true → set `onboarding_completed=true`
- RLS: workspace members can read their own row, system updates via triggers. `onboarding_events` insert open to authenticated for own workspace; read restricted to workspace members + admins.

### 2. Onboarding wizard — `/app/onboarding`

Full-page route (not modal). Left rail vertical stepper, main content per step, top progress bar, "Skip for now" link.

- **Step 1 — Connect Sharetribe**: embeds the existing connect form from `/app/settings/integrations/sharetribe`. "Where do I find these?" expandable section linking to the Help article. Auto-advances on success.
- **Step 2 — Run first sync**: big "Run Sync" button calling existing `runSharetribeSync` server fn. Polls integration row, shows live "X listings synced". Success card with stats.
- **Step 3 — Create your first page**: simplified form (template = City Hub locked, city autocomplete from synced `tenant_listings.city`, state). "Generate" calls a new server fn that creates a draft page with sensible defaults. Preview pane.
- **Step 4 — Publish & verify**: shows draft preview, "Publish" button, opens live URL in new tab, "I can see my page" confirmation.
- **Step 5 — Connect GSC** *(optional)*: stub — shows "Coming soon" with a "Skip" button that marks step complete. (Real GSC OAuth is a separate build; let me know if you want it now.)
- **Completion screen**: subtle confetti, 3 next-step cards (matrix tool, AI coach, pSEO playbook), "Go to dashboard" CTA.

Wizard is resumable — `current_step` lookup on entry routes you to the right step.

### 3. Dashboard checklist widget

`<OnboardingChecklist />` rendered on `/app` dashboard when `onboarding_completed = false` AND `onboarding_dismissed_until < now()`.

- Header + dismiss X (sets `onboarding_dismissed_until = now() + 7 days`)
- Progress bar "X of 5 complete"
- Each step row: icon, label, "Start" button deep-linking to wizard at that step
- Footer link to `/help/getting-started`

### 4. Soft-block on Pages

`/app/pages` and `/app/pages/new` show a banner if Sharetribe not connected or first sync not run, with a "Finish setup" CTA to the wizard. Page builder still loads (not hard blocked) but the banner makes the prerequisite obvious.

### 5. Platform-managed cron

- Replace the per-tenant SQL approach. Schedule **one** `pg_cron` job (`sync-all-tenants-30min`) that POSTs to `/api/public/hooks/sync-sharetribe` with empty body. The existing handler already iterates all connected workspaces via `runSharetribeSyncAll()`.
- Run via the migration (uses `pg_cron` + `pg_net`, both already enabled per existing migrations).
- Idempotent: unschedule existing job by name before re-creating.

### 6. Help Center articles (6 articles)

If a Help Center route doesn't exist yet, scaffold a minimal one at `/help/$slug` with markdown bodies stored in a `help_articles` table (slug, title, category, body_md, published). Seed 6 articles in "Getting Started":

1. Welcome to founders.click
2. Connecting your Sharetribe marketplace
3. Your first listing sync
4. Building your first page
5. Publishing and indexing your pages
6. Connecting Google Search Console *(stub article)*

Each: 400–800 words placeholder copy, screenshot placeholders, "Was this helpful?" feedback writes to `help_feedback` table.

### 7. Email sequence

Scaffold Lovable Emails infrastructure (requires email domain). 6 templates triggered from a server-side scheduler that reads `workspace_onboarding` + `workspaces.created_at`:

- Hour 0: Welcome
- Hour 24: If !sharetribe_connected → "Stuck?"
- Hour 48: If !first_sync → "Listings waiting"
- Day 5: If !first_page_published → "Build your first page"
- Day 7: If completed → "What's next"
- Day 14: Founder check-in (calendar link placeholder)

Suppression: skip if `onboarding_completed=true` (except day-7 success email) or `onboarding_dismissed_until > now()`.

A second `pg_cron` job (`onboarding-emails-hourly`) calls a new `/api/public/hooks/onboarding-emails` route that selects eligible workspaces and enqueues emails.

### 8. Admin funnel analytics

`/app/admin/onboarding` (admin-gated): funnel chart (signups → connected → synced → page created → published → GSC), drop-off %, avg time per step, error frequency. Pulls from `onboarding_events` + `workspace_onboarding`.

## Files

**New:**
- `supabase/migrations/<ts>_onboarding.sql` — tables, triggers, backfill, cron schedules
- `src/lib/onboarding.functions.ts` + `.server.ts` — get/update progress, log events, generate first page
- `src/lib/onboarding-emails.server.ts` — eligibility query + enqueue
- `src/lib/help-articles.functions.ts` + `.server.ts`
- `src/routes/_authenticated/app.onboarding.tsx` (replaces existing thin onboarding page; existing workspace-creation logic preserved as Step 0 if no workspace yet)
- `src/components/onboarding/{StepRail,Step1Sharetribe,Step2Sync,Step3FirstPage,Step4Publish,Step5GSC,CompletionScreen}.tsx`
- `src/components/onboarding/OnboardingChecklist.tsx`
- `src/components/onboarding/SetupBanner.tsx` (soft-block on Pages)
- `src/routes/help/index.tsx`, `src/routes/help/$slug.tsx`
- `src/routes/_authenticated/app.admin.onboarding.tsx`
- `src/routes/api/public/hooks/onboarding-emails.ts`
- `supabase/functions/_shared/email-templates/onboarding-*.tsx` (6 templates) — only if you confirm email setup

**Edited:**
- `src/routes/_authenticated/app.index.tsx` — mount `<OnboardingChecklist />`
- `src/routes/_authenticated/app.pages.tsx` + `.new.tsx` — mount `<SetupBanner />`
- `src/lib/app-nav.ts` — add Help + Admin Onboarding links
- `src/integrations/supabase/types.ts` — auto-regen after migration

## Open question before I start

**Email setup** — I can scaffold the 6 emails using Lovable Emails (queue-based, retry-safe), but it requires setting up a sender domain. Three options:

- **A)** Build everything including email sequence (I'll trigger the email-domain setup dialog when we get there).
- **B)** Build everything except email sequence — ship in-app onboarding now, add emails later.
- **C)** Use Resend instead (you already have a connection? — I'll need to check).

Reply "A", "B", or "C" and I'll execute.