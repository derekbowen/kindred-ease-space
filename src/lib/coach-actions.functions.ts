import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";

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
  actionType: z.enum([
    "fix_thin_page",
    "add_meta",
    "create_city_page",
    "add_internal_links",
  ]),
  payload: z.record(z.string(), z.unknown()).default({}),
});

type JsonValue = string | number | boolean | null | { [k: string]: JsonValue } | JsonValue[];
type ActionResult = { ok: true; summary: string; details?: Record<string, JsonValue> };

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-2.5-flash";

async function callAI(systemPrompt: string, userPrompt: string, apiKey: string): Promise<string> {
  const r = await fetch(AI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
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
  const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return j.choices?.[0]?.message?.content?.trim() ?? "";
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

async function fixThinPage(workspaceId: string, payload: Record<string, unknown>, apiKey: string): Promise<ActionResult> {
  const pageId = String(payload.page_id ?? "");
  if (!pageId) throw new Error("Missing page_id");
  const { data: page, error } = await supabaseAdmin
    .from("content_pages")
    .select("id, title, slug, body_markdown, description, category")
    .eq("id", pageId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!page) throw new Error("Page not found");

  const expanded = await callAI(
    "You expand thin SEO pages. Return Markdown only, 600-1000 words, no frontmatter, use ## and ### headings, end with a CTA paragraph.",
    `Expand this page. Title: "${page.title}". Existing body:\n\n${page.body_markdown ?? page.description ?? ""}`,
    apiKey,
  );

  const { error: upErr } = await supabaseAdmin
    .from("content_pages")
    .update({ body_markdown: expanded })
    .eq("id", pageId)
    .eq("workspace_id", workspaceId);
  if (upErr) throw new Error(upErr.message);

  return { ok: true, summary: `Expanded "${page.title}" to ${expanded.length} chars`, details: { pageId } };
}

async function addMeta(workspaceId: string, payload: Record<string, unknown>, apiKey: string): Promise<ActionResult> {
  const ids: string[] = Array.isArray(payload.page_ids) ? (payload.page_ids as string[]) : payload.page_id ? [String(payload.page_id)] : [];
  if (ids.length === 0) throw new Error("Missing page_ids");

  const { data: pages, error } = await supabaseAdmin
    .from("content_pages")
    .select("id, title, body_markdown, description")
    .in("id", ids)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);

  let updated = 0;
  for (const p of pages ?? []) {
    const out = await callAI(
      'You write SEO meta. Return STRICT JSON: {"seo_title":"...","seo_description":"..."} with seo_title ≤60 chars and seo_description ≤155 chars. No prose.',
      `Page title: "${p.title}". Body excerpt:\n${(p.body_markdown ?? p.description ?? "").slice(0, 1200)}`,
      apiKey,
    );
    let parsed: { seo_title?: string; seo_description?: string } = {};
    try { parsed = JSON.parse(out.replace(/```json|```/g, "").trim()); } catch { /* skip */ }
    if (!parsed.seo_title || !parsed.seo_description) continue;
    const { error: upErr } = await supabaseAdmin
      .from("content_pages")
      .update({ seo_title: parsed.seo_title.slice(0, 60), seo_description: parsed.seo_description.slice(0, 155) })
      .eq("id", p.id)
      .eq("workspace_id", workspaceId);
    if (!upErr) updated += 1;
  }
  return { ok: true, summary: `Updated meta on ${updated} of ${ids.length} pages`, details: { updated, requested: ids.length } };
}

async function createCityPage(workspaceId: string, payload: Record<string, unknown>, apiKey: string): Promise<ActionResult> {
  const city = String(payload.city ?? "").trim();
  if (!city) throw new Error("Missing city");
  const title = `Pool Rental in ${city}`;
  const slug = slugify(city);

  const { data: existing } = await supabaseAdmin
    .from("content_pages")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  if (existing) throw new Error(`A page with slug "${slug}" already exists`);

  const body = await callAI(
    "You write SEO city pages for a pool rental marketplace. Return Markdown only, 700-1100 words, ## and ### headings, friendly tone, end with a CTA paragraph.",
    `Write the city page for ${city}. Cover: who rents pools, popular use cases, pricing range, what to look for, and a closing CTA.`,
    apiKey,
  );

  const seoOut = await callAI(
    'Return STRICT JSON: {"seo_title":"...","seo_description":"..."}. seo_title ≤60 chars; seo_description ≤155 chars. No prose.',
    `City page: "${title}". Body excerpt:\n${body.slice(0, 1200)}`,
    apiKey,
  );
  let seo: { seo_title?: string; seo_description?: string } = {};
  try { seo = JSON.parse(seoOut.replace(/```json|```/g, "").trim()); } catch { /* fall back */ }

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("content_pages")
    .insert({
      workspace_id: workspaceId,
      title,
      slug,
      category: "city",
      body_markdown: body,
      seo_title: (seo.seo_title ?? title).slice(0, 60),
      seo_description: (seo.seo_description ?? `Pool rentals in ${city}.`).slice(0, 155),
      status: "draft",
      in_sitemap: false,
    })
    .select("id, slug")
    .single();
  if (insErr) throw new Error(insErr.message);

  return { ok: true, summary: `Drafted "${title}" (${body.length} chars)`, details: { pageId: inserted.id, slug: inserted.slug } };
}

async function addInternalLinks(workspaceId: string, payload: Record<string, unknown>, apiKey: string): Promise<ActionResult> {
  const pageId = String(payload.page_id ?? "");
  if (!pageId) throw new Error("Missing page_id");

  const { data: page, error } = await supabaseAdmin
    .from("content_pages")
    .select("id, title, slug, body_markdown")
    .eq("id", pageId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!page || !page.body_markdown) throw new Error("Page not found or has no body");

  // Pull a candidate set of link targets from the same workspace
  const { data: candidates } = await supabaseAdmin
    .from("content_pages")
    .select("title, slug, category")
    .eq("workspace_id", workspaceId)
    .eq("status", "published")
    .neq("id", pageId)
    .not("slug", "is", null)
    .limit(50);

  const targets = (candidates ?? [])
    .filter((c) => c.slug)
    .map((c) => `- /p/${c.slug} — ${c.title} (${c.category ?? "page"})`).join("\n");

  if (!targets) throw new Error("No internal link candidates available");

  const updated = await callAI(
    'You add 3-6 contextual internal links to a markdown page. Use Markdown link syntax [anchor text](/p/slug). Only link to slugs from the provided list. Do NOT change other content. Return the FULL updated markdown only.',
    `Existing page (title: "${page.title}"):\n\n${page.body_markdown}\n\nAvailable internal link targets:\n${targets}`,
    apiKey,
  );

  // Count newly added internal links
  const before = (page.body_markdown.match(/\]\(\/p\//g) ?? []).length;
  const after = (updated.match(/\]\(\/p\//g) ?? []).length;
  const added = Math.max(0, after - before);
  if (added === 0) throw new Error("Model did not add any new internal links");

  const { error: upErr } = await supabaseAdmin
    .from("content_pages")
    .update({ body_markdown: updated })
    .eq("id", pageId)
    .eq("workspace_id", workspaceId);
  if (upErr) throw new Error(upErr.message);

  return { ok: true, summary: `Added ${added} internal link${added === 1 ? "" : "s"} to "${page.title}"`, details: { pageId, added } };
}

export const runCoachAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => ActionInput.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertWorkspaceMember(data.workspaceId, userId);

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    let result: ActionResult;
    let errorMessage: string | null = null;
    try {
      switch (data.actionType) {
        case "fix_thin_page":
          result = await fixThinPage(data.workspaceId, data.payload, apiKey);
          break;
        case "add_meta":
          result = await addMeta(data.workspaceId, data.payload, apiKey);
          break;
        case "create_city_page":
          result = await createCityPage(data.workspaceId, data.payload, apiKey);
          break;
        case "add_internal_links":
          result = await addInternalLinks(data.workspaceId, data.payload, apiKey);
          break;
      }
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
    }

    await supabase.from("coach_action_log").insert({
      workspace_id: data.workspaceId,
      user_id: userId,
      action_type: data.actionType,
      details: {
        status: errorMessage ? "error" : "success",
        briefing_id: data.briefingId ?? null,
        insight_index: data.insightIndex ?? null,
        payload: data.payload,
        result: errorMessage ? null : result!.details ?? null,
        summary: errorMessage ?? result!.summary,
      },
    });

    if (errorMessage) throw new Error(errorMessage);
    return result!;
  });
