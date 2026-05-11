
INSERT INTO public.help_articles (
  category_slug, slug, title, excerpt, content, body_html,
  is_published, status, published_at, sort_order, reading_time_minutes,
  seo_title, seo_description, tags, related_article_ids
) VALUES (
  'billing',
  'bring-your-own-ai-key-byok',
  'Bring Your Own AI Key (BYOK)',
  'Connect your own OpenAI, Anthropic, Google AI, or OpenRouter key so AI features run on your account — unlimited usage, your billing, your control.',
  $$Every AI feature in founders.click — content generation, the SEO Coach, page audits, competitor analysis — runs through a unified AI gateway. By default, paid workspaces use the platform key. Free workspaces get 20 starter generations.

If you bring your own API key (BYOK), the gateway uses your provider account instead. Your key is encrypted in Supabase Vault, decrypted only inside the AI proxy edge function at call time, and never logged — only the last four characters are shown in the UI.

## Supported providers
- OpenAI (GPT-5, GPT-5.4, embeddings)
- Anthropic (Claude Sonnet, Claude Haiku)
- Google AI / Gemini
- OpenRouter (any model on the OpenRouter catalog)

## Add a key
1. Go to Settings → AI Providers (`/app/settings/ai`).
2. Pick a provider, paste the key, optionally set the default model.
3. Click Save — your key is sent server-side and stored encrypted in Vault. The plain text is never persisted in the database.
4. Click Test key. We make a tiny validation call (~$0.001 or free) and store the result.

A green "Valid" badge means the key is live and AI features will route through it. A red "Invalid" badge surfaces the real provider error message — no swallowing.

## How fallback works
On every AI call:
1. The proxy looks for a valid BYOK key for the requested provider (or any valid one if unspecified).
2. If found → call runs on your key. No platform credit is consumed.
3. If missing or invalid → call falls back to the platform key and deducts one credit from `platform_credits_remaining`.
4. If you're out of credits and have no BYOK key, the call returns a 402 with a clear message: "Add a key in Settings → AI Providers, or upgrade your plan."

## Spend dashboard
The same page shows current-month totals: number of calls, total tokens, USD cost, split between BYOK and platform usage. The recent activity feed lists the last 25 calls with provider, model, feature, tokens, cost, status, and any provider error.

Costs are estimated from token counts using each provider's published per-token price; treat them as a guide, not an invoice.

## Plan limits
- **Free**: 20 platform generations on signup. Add BYOK at any time for unlimited usage.
- **Paid**: Unlimited platform calls subject to fair-use rate limits, plus unlimited BYOK.

## Security model
- Keys are stored in Supabase Vault, not in `tenant_ai_credentials` itself. The table only stores metadata (provider, last four, status, default models, last test result).
- Decryption happens only inside the `ai-proxy` edge function via a `SECURITY DEFINER` RPC; clients can't read raw keys.
- Workspace owners can save and delete keys. Workspace members can see provider/status/usage but not the key itself.
- Rotating a key replaces the previous Vault row — old material is removed.

## Remove a key
Click the trash icon next to a provider in Settings → AI Providers. We delete the Vault entry and the credential row in one transaction; AI features fall back to the platform key on the next call.$$,
  '<p>Every AI feature in founders.click — content generation, the SEO Coach, page audits, competitor analysis — runs through a unified AI gateway. By default, paid workspaces use the platform key. Free workspaces get 20 starter generations.</p><p>If you bring your own API key (BYOK), the gateway uses your provider account instead. Your key is encrypted in Supabase Vault, decrypted only inside the AI proxy edge function at call time, and never logged — only the last four characters are shown in the UI.</p><h2>Supported providers</h2><ul><li>OpenAI (GPT-5, GPT-5.4, embeddings)</li><li>Anthropic (Claude Sonnet, Claude Haiku)</li><li>Google AI / Gemini</li><li>OpenRouter (any model on the OpenRouter catalog)</li></ul><h2>Add a key</h2><ol><li>Go to <a href="/app/settings/ai">Settings → AI Providers</a>.</li><li>Pick a provider, paste the key, optionally set the default model.</li><li>Click <strong>Save</strong> — your key is sent server-side and stored encrypted in Vault. The plain text is never persisted in the database.</li><li>Click <strong>Test key</strong>. We make a tiny validation call (~$0.001 or free) and store the result.</li></ol><p>A green <em>Valid</em> badge means the key is live and AI features will route through it. A red <em>Invalid</em> badge surfaces the real provider error message — no swallowing.</p><h2>How fallback works</h2><p>On every AI call:</p><ol><li>The proxy looks for a valid BYOK key for the requested provider (or any valid one if unspecified).</li><li>If found → call runs on your key. No platform credit is consumed.</li><li>If missing or invalid → call falls back to the platform key and deducts one credit from your monthly quota.</li><li>If you''re out of credits and have no BYOK key, the call returns a clear error: <em>"Add a key in Settings → AI Providers, or upgrade your plan."</em></li></ol><h2>Spend dashboard</h2><p>The same page shows current-month totals: number of calls, total tokens, USD cost, split between BYOK and platform usage. The recent activity feed lists the last 25 calls with provider, model, feature, tokens, cost, status, and any provider error.</p><p>Costs are estimated from token counts using each provider''s published per-token price; treat them as a guide, not an invoice.</p><h2>Plan limits</h2><ul><li><strong>Free</strong>: 20 platform generations on signup. Add BYOK at any time for unlimited usage.</li><li><strong>Paid</strong>: Unlimited platform calls subject to fair-use rate limits, plus unlimited BYOK.</li></ul><h2>Security model</h2><ul><li>Keys are stored in Supabase Vault, not in <code>tenant_ai_credentials</code> itself. The table only stores metadata (provider, last four, status, default models, last test result).</li><li>Decryption happens only inside the <code>ai-proxy</code> edge function via a <code>SECURITY DEFINER</code> RPC; clients can''t read raw keys.</li><li>Workspace owners can save and delete keys. Workspace members can see provider/status/usage but not the key itself.</li><li>Rotating a key replaces the previous Vault row — old material is removed.</li></ul><h2>Remove a key</h2><p>Click the trash icon next to a provider in Settings → AI Providers. We delete the Vault entry and the credential row in one transaction; AI features fall back to the platform key on the next call.</p>',
  true, 'published', now(), 50, 4,
  'Bring Your Own AI Key (BYOK) — founders.click',
  'Connect your OpenAI, Anthropic, Google AI, or OpenRouter key. Unlimited AI usage on your account, encrypted at rest, decrypted only at call time.',
  ARRAY['ai','byok','settings','billing','providers'],
  ARRAY[]::uuid[]
)
ON CONFLICT (slug) DO UPDATE SET
  title = EXCLUDED.title,
  excerpt = EXCLUDED.excerpt,
  content = EXCLUDED.content,
  body_html = EXCLUDED.body_html,
  category_slug = EXCLUDED.category_slug,
  is_published = EXCLUDED.is_published,
  status = EXCLUDED.status,
  published_at = COALESCE(public.help_articles.published_at, EXCLUDED.published_at),
  reading_time_minutes = EXCLUDED.reading_time_minutes,
  seo_title = EXCLUDED.seo_title,
  seo_description = EXCLUDED.seo_description,
  tags = EXCLUDED.tags,
  updated_at = now();
