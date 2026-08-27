import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import { getActiveTemplateId, slugifyPage } from "@/lib/tenant-page-helpers.server";

/**
 * Confirmed mutation runner for coach insight actions.
 * The UI shows a confirmation dialog, then invokes this fn. We perform the
 * mutation, log success or failure to coach_action_log, and return a
 * user-facing summary.
 */

const ActionInput = z.object({
  workspaceId: workspaceIdSchema,
  briefingId: z.string().uuid().optional(),
  insightIndex: z.number().int().nonnegative().optional(),
  actionType: z.enum(["fix_thin_page", "add_meta", "create_city_page", "add_internal_links"]),
  payload: z.record(z.string(), z.unknown()).default({}),
});

type JsonValue = string | number | boolean | null | { [k: string]: JsonValue } | JsonValue[];
type ActionResult = { ok: true; summary: string; details?: Record<string, JsonValue> };

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-2.5-flash";

// Threads the API key plus a running token tally through every action handler so
// platform-key usage can be metered against workspace credits after the fact.
type AiCtx = { key: string; usage: { prompt: number; completion: number } };

async function callAI(systemPrompt: string, userPrompt: string, ai: AiCtx): Promise<string> {
  const r = await fetch(AI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.key}` },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`AI gateway ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = (await r.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  ai.usage.prompt += j.usage?.prompt_tokens ?? 0;
  ai.usage.completion += j.usage?.completion_tokens ?? 0;
  return j.choices?.[0]?.message?.content?.trim() ?? "";
}

async function fixThinPage(
  workspaceId: string,
  payload: Record<string, unknown>,
  ai: AiCtx,
): Promise<ActionResult> {
  const pageId = String(payload.page_id ?? "");
  if (!pageId) throw new Error("Missing page_id");
  const { data: page, error } = await supabaseAdmin
    .from("tenant_pages")
    .select("id, title, slug, body_markdown, meta_description")
    .eq("id", pageId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!page) throw new Error("Page not found");

  const expanded = await callAI(
    "You expand thin SEO pages. Return Markdown only, 600-1000 words, no frontmatter, use ## and ### headings, end with a CTA paragraph.",
    `Expand this page. Title: "${page.title}". Existing body:\n\n${page.body_markdown ?? page.meta_description ?? ""}`,
    ai,
  );

  const { error: upErr } = await supabaseAdmin
    .from("tenant_pages")
    .update({ body_markdown: expanded })
    .eq("id", pageId)
    .eq("workspace_id", workspaceId);
  if (upErr) throw new Error(upErr.message);

  return {
    ok: true,
    summary: `Expanded "${page.title}" to ${expanded.length} chars`,
    details: { pageId },
  };
}

async function addMeta(
  workspaceId: string,
  payload: Record<string, unknown>,
  ai: AiCtx,
): Promise<ActionResult> {
  const ids: string[] = Array.isArray(payload.page_ids)
    ? (payload.page_ids as string[])
    : payload.page_id
      ? [String(payload.page_id)]
      : [];
  if (ids.length === 0) throw new Error("Missing page_ids");

  const { data: pages, error } = await supabaseAdmin
    .from("tenant_pages")
    .select("id, title, body_markdown, meta_description")
    .in("id", ids)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);

  let updated = 0;
  for (const p of pages ?? []) {
    const out = await callAI(
      'You write SEO meta. Return STRICT JSON: {"seo_title":"...","seo_description":"..."} with seo_title ≤60 chars and seo_description ≤155 chars. No prose.',
      `Page title: "${p.title}". Body excerpt:\n${(p.body_markdown ?? p.meta_description ?? "").slice(0, 1200)}`,
      ai,
    );
    let parsed: { seo_title?: string; seo_description?: string } = {};
    try {
      parsed = JSON.parse(out.replace(/```json|```/g, "").trim());
    } catch {
      /* skip */
    }
    if (!parsed.seo_title || !parsed.seo_description) continue;
    const { error: upErr } = await supabaseAdmin
      .from("tenant_pages")
      .update({
        meta_description: parsed.seo_description.slice(0, 320),
      })
      .eq("id", p.id)
      .eq("workspace_id", workspaceId);
    if (!upErr) updated += 1;
  }
  return {
    ok: true,
    summary: `Updated meta on ${updated} of ${ids.length} pages`,
    details: { updated, requested: ids.length },
  };
}

async function createCityPage(
  workspaceId: string,
  payload: Record<string, unknown>,
  ai: AiCtx,
): Promise<ActionResult> {
  const city = String(payload.city ?? "").trim();
  if (!city) throw new Error("Missing city");
  const state = String(payload.state ?? "").trim();
  const baseSlug = slugifyPage(city);
  if (!baseSlug) throw new Error("Could not derive slug from city");

  const { data: existing } = await supabaseAdmin
    .from("tenant_pages")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("slug", baseSlug)
    .maybeSingle();
  if (existing) throw new Error(`A page with slug "${baseSlug}" already exists`);

  const templateId = await getActiveTemplateId("city_hub");

  // Ground the page in THIS marketplace's real inventory — the vertical, price
  // range, and examples come from the tenant's own listings, never a hardcoded
  // category. Templated same-except-the-city-name pages with invented pricing
  // are exactly what Google's scaled-content-abuse policy demotes.
  const [{ data: ws }, { data: cityListings }] = await Promise.all([
    supabaseAdmin.from("workspaces").select("name").eq("id", workspaceId).maybeSingle(),
    supabaseAdmin
      .from("tenant_listings")
      .select("title, price_amount, price_currency, category")
      .eq("workspace_id", workspaceId)
      .ilike("city", city)
      .eq("state_published", true)
      .limit(100),
  ]);
  const workspaceName = ws?.name ?? "our marketplace";
  const listings = cityListings ?? [];

  const catCounts = new Map<string, number>();
  for (const l of listings) {
    const c = (l.category ?? "").trim().toLowerCase();
    if (c) catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
  }
  const dominantCategory =
    [...catCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const categoryPlural = dominantCategory || "listings";
  const label = categoryPlural.charAt(0).toUpperCase() + categoryPlural.slice(1);
  const title = `${label} in ${city}`;

  const prices = listings
    .map((l) => l.price_amount)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
  const currency = listings.find((l) => l.price_currency)?.price_currency ?? "USD";
  const priceFact = prices.length
    ? `Live price range: ${(prices[0]! / 100).toFixed(0)}–${(prices[prices.length - 1]! / 100).toFixed(0)} ${currency} across ${prices.length} priced listings.`
    : "No price data available — do NOT state or estimate any prices.";
  const sampleTitles = listings
    .slice(0, 5)
    .map((l) => `- ${l.title}`)
    .join("\n");

  const body = await callAI(
    `You write SEO city pages for "${workspaceName}", a marketplace for ${categoryPlural}. Use ONLY the facts provided below — never invent pricing, listing counts, or listings. Return Markdown only, 700-1100 words, ## and ### headings, friendly tone, end with a CTA paragraph inviting readers to browse the live listings shown below the article.`,
    `Write the city page for ${city}${state ? `, ${state}` : ""}.

Facts about our live inventory in ${city} (the only numbers you may use):
- ${listings.length} published listings
- ${priceFact}
${sampleTitles ? `- Example listings:\n${sampleTitles}` : "- No example listings yet."}

Cover: who uses ${categoryPlural} in ${city}, popular local use cases, what to look for when choosing, and a closing CTA. If inventory is small, write genuinely useful local guidance instead of padding or inventing listings.`,
    ai,
  );

  const seoOut = await callAI(
    'Return STRICT JSON: {"seo_title":"...","seo_description":"..."}. seo_title ≤60 chars; seo_description ≤155 chars. No prose.',
    `City page: "${title}". Body excerpt:\n${body.slice(0, 1200)}`,
    ai,
  );
  let seo: { seo_title?: string; seo_description?: string } = {};
  try {
    seo = JSON.parse(seoOut.replace(/```json|```/g, "").trim());
  } catch {
    /* fall back */
  }

  const pageTitle = (seo.seo_title ?? title).slice(0, 200);
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("tenant_pages")
    .insert({
      workspace_id: workspaceId,
      template_id: templateId,
      title: pageTitle,
      slug: baseSlug,
      h1: title,
      meta_description: (seo.seo_description ?? `${label} in ${city} on ${workspaceName}.`).slice(
        0,
        320,
      ),
      body_markdown: body,
      variables: { city, ...(state ? { state } : {}), category_plural: categoryPlural },
      listing_filter: { city, ...(state ? { state } : {}), limit: 24, sort: "newest" },
      // Draft, not published — the confirmation dialog promises a draft, and
      // AI-generated pages deserve a human look before going live.
      status: "draft",
      published_at: null,
    })
    .select("id, slug")
    .single();
  if (insErr) throw new Error(insErr.message);

  return {
    ok: true,
    summary: `Drafted "${title}" — review and publish it from Pages`,
    details: { pageId: inserted.id, slug: inserted.slug },
  };
}

async function addInternalLinks(
  workspaceId: string,
  payload: Record<string, unknown>,
  ai: AiCtx,
): Promise<ActionResult> {
  const pageId = String(payload.page_id ?? "");
  if (!pageId) throw new Error("Missing page_id");

  const { data: page, error } = await supabaseAdmin
    .from("tenant_pages")
    .select("id, title, slug, body_markdown")
    .eq("id", pageId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!page || !page.body_markdown) throw new Error("Page not found or has no body");

  const { data: candidates } = await supabaseAdmin
    .from("tenant_pages")
    .select("title, slug")
    .eq("workspace_id", workspaceId)
    .eq("status", "published")
    .neq("id", pageId)
    .limit(50);

  const targets = (candidates ?? [])
    .filter((c) => c.slug)
    .map((c) => `- /a/${c.slug} — ${c.title}`)
    .join("\n");

  if (!targets) throw new Error("No internal link candidates available");

  const updated = await callAI(
    "You add 3-6 contextual internal links to a markdown page. Use Markdown link syntax [anchor text](/a/slug). Only link to slugs from the provided list. Do NOT change other content. Return the FULL updated markdown only.",
    `Existing page (title: "${page.title}"):\n\n${page.body_markdown}\n\nAvailable internal link targets:\n${targets}`,
    ai,
  );

  // Count newly added internal links
  const before = (page.body_markdown.match(/\]\(\/p\//g) ?? []).length;
  const after = (updated.match(/\]\(\/p\//g) ?? []).length;
  const added = Math.max(0, after - before);
  if (added === 0) throw new Error("Model did not add any new internal links");

  const { error: upErr } = await supabaseAdmin
    .from("tenant_pages")
    .update({ body_markdown: updated })
    .eq("id", pageId)
    .eq("workspace_id", workspaceId);
  if (upErr) throw new Error(upErr.message);

  return {
    ok: true,
    summary: `Added ${added} internal link${added === 1 ? "" : "s"} to "${page.title}"`,
    details: { pageId, added },
  };
}

export const runCoachAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => ActionInput.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertWorkspaceMember(data.workspaceId, userId);

    // BYOK first, platform env-var fallback.
    const { getWorkspaceSecretWithSource } = await import("@/lib/workspace-secrets.server");
    const secret = await getWorkspaceSecretWithSource(
      data.workspaceId,
      "LOVABLE_API_KEY",
      "LOVABLE_API_KEY",
    );
    if (!secret) throw new Error("No AI key configured. Add a BYOK key under Settings → API Keys.");

    const ai: AiCtx = { key: secret.key, usage: { prompt: 0, completion: 0 } };

    // Platform-key usage is metered against workspace credits so an authenticated
    // member can't burn platform AI budget uncapped. Reserve up front (free trial
    // quota, then purchased credits) — throws "Out of AI credits" when empty.
    const { reservePlatformAi, settlePlatformAi } = await import("@/lib/ai-metering.server");
    let billing: import("@/lib/ai-metering.server").PlatformBilling | null = null;
    if (secret.source === "platform") {
      billing = await reservePlatformAi(data.workspaceId);
    }

    let result: ActionResult;
    let errorMessage: string | null = null;
    try {
      switch (data.actionType) {
        case "fix_thin_page":
          result = await fixThinPage(data.workspaceId, data.payload, ai);
          break;
        case "add_meta":
          result = await addMeta(data.workspaceId, data.payload, ai);
          break;
        case "create_city_page":
          result = await createCityPage(data.workspaceId, data.payload, ai);
          break;
        case "add_internal_links":
          result = await addInternalLinks(data.workspaceId, data.payload, ai);
          break;
      }
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
    }

    // Settle metered usage whether or not the action ultimately succeeded — the
    // AI tokens were spent either way.
    // Settle whenever we billed the platform key — even if the gateway omitted a
    // usage object (0 tokens) — so every platform call is logged, matching the
    // seo-coach and page-auditor paths.
    if (billing) {
      try {
        await settlePlatformAi({
          workspaceId: data.workspaceId,
          userId,
          billing,
          model: DEFAULT_MODEL,
          promptTokens: ai.usage.prompt,
          completionTokens: ai.usage.completion,
          feature: "coach_action",
        });
      } catch (e) {
        console.error("[runCoachAction] settle failed", e);
      }
    }

    await supabase.from("coach_action_log").insert({
      workspace_id: data.workspaceId,
      user_id: userId,
      action_type: data.actionType,
      details: {
        status: errorMessage ? "error" : "success",
        briefing_id: data.briefingId ?? null,
        insight_index: data.insightIndex ?? null,
        payload: JSON.parse(JSON.stringify(data.payload)),
        result: errorMessage ? null : (result!.details ?? null),
        summary: errorMessage ?? result!.summary,
      },
    });

    if (errorMessage) throw new Error(errorMessage);
    return result!;
  });
