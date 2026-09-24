import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import {
  CustomerFacingError,
  GENERATION_UNAVAILABLE_MESSAGE,
  buildCityBrief,
  customerMessage,
  deterministicRequestId,
  findExistingCityPage,
} from "@/lib/generation.server";
import { QuickPageInputSchema, runQuickPage } from "@/lib/admin-quick-page.functions";

/**
 * Confirmed mutation runner for coach insight actions.
 * The UI shows a confirmation dialog, then invokes this fn. We perform the
 * mutation, log success or failure to coach_action_log, and return a
 * user-facing summary.
 *
 * create_city_page is a page GENERATION and runs through the shared
 * generation core (runQuickPage): the pause switch, the daily-cap
 * reservation, who pays (BYOK / beta grant / platform funds), settlement
 * after the draft exists, and an idempotent request id all apply to it
 * exactly as they do to the Quick Page Builder. The Lovable gateway path
 * below serves only the three page-editing actions.
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

/**
 * Draft a city page through the shared generation core. No gateway call, no
 * key resolution and no metering happen here: runQuickPage decides who pays
 * and settles after the draft exists, under the platform pause switch and the
 * daily-cap reservation. Grounding in the tenant's live inventory (the ONLY
 * numbers the model may use) is the core's own rule.
 */
async function createCityPage(
  workspaceId: string,
  userId: string,
  payload: Record<string, unknown>,
  origin: { briefingId?: string; insightIndex?: number },
): Promise<ActionResult> {
  const city = String(payload.city ?? "")
    .trim()
    .slice(0, 120);
  if (!city) throw new CustomerFacingError("Missing city");
  const state = String(payload.state ?? "")
    .trim()
    .slice(0, 80);

  // A page that already covers this city is never duplicated — the same
  // predicate the batch generator and the Page Builder use (pageCoversCity),
  // instead of a slug lookup that a suffixed slug would slip past.
  const existing = await findExistingCityPage(workspaceId, city, state || null);
  if (existing) {
    throw new CustomerFacingError(
      `A page for ${city} already exists (/a/${existing.slug}). Review it from Pages.`,
    );
  }

  // The vertical comes from the tenant's own listings in that city, never a
  // hardcoded category — templated same-except-the-city-name pages are what
  // Google's scaled-content-abuse policy demotes.
  const { data: cityListings } = await supabaseAdmin
    .from("tenant_listings")
    .select("category")
    .eq("workspace_id", workspaceId)
    .ilike("city", city)
    .eq("state_published", true)
    .limit(100);
  const catCounts = new Map<string, number>();
  for (const l of cityListings ?? []) {
    const c = (l.category ?? "").trim().toLowerCase();
    if (c) catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
  }
  const dominantCategory =
    [...catCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const categoryPlural = dominantCategory || "listings";
  const brief = buildCityBrief({ city, state: state || null, categoryPlural });

  // Idempotent by insight: the same briefing + insight always maps to the
  // same request id, so a double-click (or a retry after a lost response)
  // replays the page that exists instead of drafting a second one. Only an
  // action with no briefing behind it gets a fresh id.
  const generationRequestId = origin.briefingId
    ? await deterministicRequestId(`coach:${origin.briefingId}:${origin.insightIndex ?? 0}`)
    : crypto.randomUUID();

  const res = await runQuickPage(
    QuickPageInputSchema.parse({
      workspaceId,
      title: brief.title.slice(0, 140),
      description: brief.description,
      topic: brief.topic,
      city,
      state: state || undefined,
      categoryPlural,
      // Draft, not published — the confirmation dialog promises a draft, and
      // AI-generated pages deserve a human look before going live.
      autoPublish: false,
      generationRequestId,
    }),
    userId,
  );

  return {
    ok: true,
    summary: res.replayed
      ? `"${res.page.title}" was already drafted — review and publish it from Pages`
      : `Drafted "${res.page.title}" — review and publish it from Pages`,
    details: {
      pageId: res.page.id,
      slug: res.page.slug,
      replayed: res.replayed,
      creditsCharged: res.creditsCharged,
      billing: res.billing,
    },
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

  // Count newly added internal links. Pages live at /a/{slug} — the prompt
  // asks for /a/ links, so /a/ is what is counted (a /p/ count was always 0).
  const before = (page.body_markdown.match(/\]\(\/a\//g) ?? []).length;
  const after = (updated.match(/\]\(\/a\//g) ?? []).length;
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

    const logAction = async (errorMessage: string | null, result: ActionResult | null) => {
      await supabase.from("coach_action_log").insert({
        workspace_id: data.workspaceId,
        user_id: userId,
        action_type: data.actionType,
        details: {
          status: errorMessage ? "error" : "success",
          briefing_id: data.briefingId ?? null,
          insight_index: data.insightIndex ?? null,
          payload: JSON.parse(JSON.stringify(data.payload)),
          result: errorMessage ? null : (result?.details ?? null),
          summary: errorMessage ?? result?.summary ?? null,
        },
      });
    };

    // Page generation goes through the core, not the gateway: no key is
    // resolved and nothing is reserved or settled here — runQuickPage does
    // both, after the draft exists. What is logged and thrown is the
    // customer-facing message only; database text is withheld.
    if (data.actionType === "create_city_page") {
      let result: ActionResult | null = null;
      let errorMessage: string | null = null;
      try {
        result = await createCityPage(data.workspaceId, userId, data.payload, {
          briefingId: data.briefingId,
          insightIndex: data.insightIndex,
        });
      } catch (e) {
        errorMessage = customerMessage(e, GENERATION_UNAVAILABLE_MESSAGE);
      }
      await logAction(errorMessage, result);
      if (errorMessage || !result) throw new Error(errorMessage ?? GENERATION_UNAVAILABLE_MESSAGE);
      return result;
    }

    // BYOK first, platform env-var fallback.
    const { getWorkspaceSecretWithSource } = await import("@/lib/workspace-secrets.server");
    const secret = await getWorkspaceSecretWithSource(
      data.workspaceId,
      "LOVABLE_API_KEY",
      "LOVABLE_API_KEY",
    );
    if (!secret) throw new Error("AI tools are not available right now. Contact support.");

    const ai: AiCtx = { key: secret.key, usage: { prompt: 0, completion: 0 } };

    // Platform-key usage is metered against workspace credits so an authenticated
    // member can't burn platform AI budget uncapped. Reserve up front (free trial
    // quota, then purchased credits) — throws "Out of AI credits" when empty.
    const { reservePlatformAi, settlePlatformAi } = await import("@/lib/ai-metering.server");
    let billing: import("@/lib/ai-metering.server").PlatformBilling | null = null;
    if (secret.source === "platform") {
      billing = await reservePlatformAi(data.workspaceId);
    }

    let result: ActionResult | null = null;
    let errorMessage: string | null = null;
    try {
      switch (data.actionType) {
        case "fix_thin_page":
          result = await fixThinPage(data.workspaceId, data.payload, ai);
          break;
        case "add_meta":
          result = await addMeta(data.workspaceId, data.payload, ai);
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

    await logAction(errorMessage, result);

    if (errorMessage || !result) throw new Error(errorMessage ?? "Action failed");
    return result;
  });
