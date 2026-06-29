# founders.click

AI-powered growth engine for Sharetribe marketplace founders.

Replace your agency. Move at AI speed.

- Programmatic SEO + content factory (AI pages at ~$0.012/page)
- Competitor radar, rank tracking, page auditing, internal links
- AI Coach: contextual agent that reads your data, suggests actions, can execute fixes
- Page builder with live preview and city gap detection
- Lead tools, affiliates, billing, workspace settings
- Public tenant pages (/p/slug), help center, sitemaps

## Live

- Public site: https://founders.click
- Help center: https://founders.click/help
- App: https://founders.click/app (sign up)

## Tech

- TanStack Start (React 19 + Router + Server) + Vite + Tailwind + Radix
- Supabase (Postgres, Auth, RLS, Edge Functions)
- Cloudflare (Workers/Pages via wrangler + @cloudflare/vite-plugin)
- Stripe for billing + addons
- OpenRouter / BYOK for AI

## Local development

```bash
# 1. Clone
git clone https://github.com/derekbowen/kindred-ease-space.git
cd kindred-ease-space

# 2. Install
npm install   # or bun install

# 3. Env
cp .env.example .env
# Fill in your Supabase project (public + service role keys), etc.

# 4. Run
npm run dev
```

The app uses Vite dev server + Supabase (remote or local via supabase CLI).

### Required env vars (see .env.example)

- Supabase connection (client + server)
- OPENROUTER_API_KEY (or configure BYOK per workspace)
- Stripe keys + webhook secret (for billing flows)
- CRON_SECRET (for scheduled edge functions like briefings)

Many features gracefully degrade without keys.

## Scripts

- `npm run dev` — Vite dev server
- `npm run build` — Production build (for Cloudflare)
- `npm run preview` — Preview built output
- `npm run lint`
- `npm run format`
- `npm run audit:urls` — Canonical URL checker (requires Bun)

## Deployment

Configured for Cloudflare (wrangler.jsonc + Cloudflare Vite plugin).

Typical flow (Lovable or manual):

1. `npm run build`
2. `npx wrangler deploy` (or platform deploy)

Update `wrangler.jsonc` "name" and any routes/domains as needed.

Secrets are managed in the platform (Supabase Edge Function env, Cloudflare, etc.).

## Testing

E2E smoke test (Python + Playwright):

```bash
python3 tests/e2e/smoke.py https://your-preview-url
```

See `tests/e2e/README.md`.

CI runs smoke on pushes to main for key paths + scheduled.

## Project notes

- Many "stub" admin/ops tools exist in the nav for future work but are hidden from the public sidebar by default (use `?showStubs=1` to reveal during development).
- Internal-only tools are marked with an "internal" badge.
- Workspace auto-provisions on first login.
- AI usage is metered via platform credits or tenant BYOK keys.

## Contributing / internal

This repo is the full source for the public product.

For questions, reach out via the in-app help or support channels.

---

Built with ❤️ for Sharetribe founders who want to grow without an agency.
