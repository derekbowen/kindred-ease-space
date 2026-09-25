import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import {
  CustomerFacingError,
  buildCityBrief,
  customerMessage,
  deterministicRequestId,
  findExistingCityPage,
} from "@/lib/generation.server";
import { QuickPageInputSchema, runQuickPage } from "@/lib/admin-quick-page.functions";
import { ADD_META_MAX_PAGES } from "@/lib/ai/limits";
import { AI_MESSAGES } from "@/lib/ai/customer-error";
import type { AiBillingClass, AiDb, AiKey } from "@/lib/ai/spend.server";
import type { OpenAiTransport } from "@/lib/ai/openai.server";

/**
 * Confirmed mutation runner for coach insight actions. The UI shows a
 * confirmation dialog, then invokes this fn. We perform the mutation, log
 * success or failure to coach_action_log, and return a summary.
 *
 * Every AI call here goes through the one spend flow (runMeteredAiCall):
 * a hold of the maximum cost before the call, settlement at the actual cost
 * after it, the route's hard limits (add_meta 800 tokens / 30 s per page,
 * fix_thin_page 3000 / 90 s, add_internal_links 4000 / 90 s), gpt-5-nano.
 * create_city_page is a page GENERATION and runs through the shared
 * generation core (runQuickPage): the pause switch, the daily-cap slot, who
 * pays, the spend hold and an idempotent request id apply to it exactly as
 * they do to the Quick Page Builder.
 *
 * The input is strict per action: the payload of each action type is an
 * exact shape, and a body carrying any other key — a model, a token count —
 * is a validation error. add_meta writes at most ADD_META_MAX_PAGES (20)
 * pages per confirmed action, one metered call each.
 *
 * What reaches the browser and coach_action_log is a customer sentence only.
 */

const uuid = z.string().uuid();
const origin = {
  workspaceId: workspaceIdSchema,
  briefingId: uuid.optional(),
  insightIndex: z.number().int().nonnegative().max(50).optional(),
};

export const CoachActionInputSchema = z.discriminatedUnion("actionType", [
  z
    .object({
      ...origin,
      actionType: z.literal("fix_thin_page"),
      payload: z.object({ page_id: uuid }).strict(),
    })
    .strict(),
  z
    .object({
      ...origin,
      actionType: z.literal("add_meta"),
      // Bounded input; at most ADD_META_MAX_PAGES of them are written.
      payload: z
        .union([
          z.object({ page_ids: z.array(uuid).min(1).max(100) }).strict(),
          z.object({ page_id: uuid }).strict(),
        ]),
    })
    .strict(),
  z
    .object({
      ...origin,
      actionType: z.literal("create_city_page"),
      payload: z
        .object({
          city: z.string().trim().min(1).max(120),
          state: z.string().trim().max(80).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...origin,
      actionType: z.literal("add_internal_links"),
      payload: z.object({ page_id: uuid }).strict(),
    })
    .strict(),
]);
export type CoachActionInput = z.infer<typeof CoachActionInputSchema>;

type JsonValue = string | number | boolean | null | { [k: string]: JsonValue } | JsonValue[];
export type ActionResult = { ok: true; summary: string; details?: Record<string, JsonValue> };

/** What every AI action needs: who, whose key, who pays. Test seams in `deps`. */
export type ActionCtx = {
  workspaceId: string;
  userId: string;
  key: AiKey;
  billingClass: AiBillingClass;
  deps?: { db?: AiDb; transport?: OpenAiTransport };
};

const NOT_FOUND = "That page was not found in this workspace.";

/**
 * An edit is delivered only when it landed on exactly ONE page row: a page
 * deleted (or moved) during the call updates nothing, and "nothing" must not
 * be charged as a delivered edit (round-4 correctness L4). Throwing here
 * settles the call as not_delivered — the customer refunded in full.
 */
function assertOneRowUpdated(rows: unknown[] | null | undefined): void {
  const n = Array.isArray(rows) ? rows.length : 0;
  if (n !== 1) {
    console.error("[coach] page edit updated", n, "rows; not delivered");
    throw new CustomerFacingError(NOT_FOUND);
  }
}

async function loadPage(workspaceId: string, pageId: string) {
  const { data: page, error } = await supabaseAdmin
    .from("tenant_pages")
    .select("id, title, slug, body_markdown, meta_description")
    .eq("id", pageId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!page) throw new CustomerFacingError(NOT_FOUND);
  return page;
}

async function fixThinPage(ctx: ActionCtx, pageId: string): Promise<ActionResult> {
  const { runMeteredAiCall } = await import("@/lib/ai/spend.server");
  const page = await loadPage(ctx.workspaceId, pageId);
  const res = await runMeteredAiCall({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    requestId: crypto.randomUUID(),
    route: "fix_thin_page",
    source: "fix_thin_page",
    key: ctx.key,
    billingClass: ctx.billingClass,
    instructions:
      "You expand thin SEO pages. Return Markdown only, 600-1000 words, no frontmatter, use ## and ### headings, end with a CTA paragraph.",
    input: `Expand this page. Title: "${page.title}". Existing body:\n\n${page.body_markdown ?? page.meta_description ?? ""}`,
    check: (out) =>
      out.text.trim().length < 300
        ? { code: "thin_output", message: "The AI could not expand this page. Try again in a minute." }
        : null,
    // Saved before the call is settled: the customer pays only for an edit
    // that landed.
    deliver: async (out) => {
      const { data: rows, error: upErr } = await supabaseAdmin
        .from("tenant_pages")
        .update({ body_markdown: out.text.trim() })
        .eq("id", pageId)
        .eq("workspace_id", ctx.workspaceId)
        .select("id");
      if (upErr) throw new Error(upErr.message);
      assertOneRowUpdated(rows);
    },
    deps: ctx.deps,
  });
  const expanded = res.output.text.trim();

  return {
    ok: true,
    summary: `Expanded "${page.title}" to ${expanded.length} chars`,
    details: { pageId, creditsCharged: res.settlement.creditsCharged },
  };
}

const MetaSchema = z
  .object({ seo_title: z.string().min(1), seo_description: z.string().min(1) })
  .strict();
export const META_FORMAT = {
  name: "page_meta",
  schema: {
    type: "object",
    properties: {
      seo_title: { type: "string", description: "≤60 chars" },
      seo_description: { type: "string", description: "≤155 chars" },
    },
    required: ["seo_title", "seo_description"],
    additionalProperties: false,
  },
  parse: (v: unknown) => {
    const r = MetaSchema.safeParse(v);
    return r.success ? r.data : null;
  },
};

/** Refusals that apply to every later call of the same action: stop instead of asking again. */
const STOP_CODES = new Set([
  "rate_limited",
  "platform_paused",
  "workspace_budget_exhausted",
  "budget_exhausted",
  "insufficient",
  "no_key",
  "auth",
  "bad_request",
]);

async function addMeta(
  ctx: ActionCtx,
  payload: { page_ids: string[] } | { page_id: string },
): Promise<ActionResult> {
  const { runMeteredAiCall } = await import("@/lib/ai/spend.server");
  const requested = "page_ids" in payload ? [...new Set(payload.page_ids)] : [payload.page_id];
  const ids = requested.slice(0, ADD_META_MAX_PAGES);

  const { data: pages, error } = await supabaseAdmin
    .from("tenant_pages")
    .select("id, title, body_markdown, meta_description")
    .in("id", ids)
    .eq("workspace_id", ctx.workspaceId);
  if (error) throw new Error(error.message);
  if (!pages || pages.length === 0) throw new CustomerFacingError(NOT_FOUND);

  let updated = 0;
  let creditsCharged = 0;
  let stoppedBy: string | null = null;
  for (const p of pages) {
    try {
      const res = await runMeteredAiCall({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        requestId: crypto.randomUUID(),
        route: "add_meta",
        source: "add_meta",
        key: ctx.key,
        billingClass: ctx.billingClass,
        instructions:
          "You write SEO meta for one page: seo_title of at most 60 characters and seo_description of at most 155 characters. No prose.",
        input: `Page title: "${p.title}". Body excerpt:\n${(p.body_markdown ?? p.meta_description ?? "").slice(0, 1200)}`,
        format: META_FORMAT,
        // Saved before the call is settled: a page whose update fails is
        // refunded (not_delivered) and skipped.
        deliver: async (out) => {
          const { data: rows, error: upErr } = await supabaseAdmin
            .from("tenant_pages")
            .update({ meta_description: out.data!.seo_description.slice(0, 320) })
            .eq("id", p.id)
            .eq("workspace_id", ctx.workspaceId)
            .select("id");
          if (upErr) throw new Error(`page update failed: ${upErr.message}`);
          assertOneRowUpdated(rows);
        },
        deps: ctx.deps,
      });
      creditsCharged += res.settlement.creditsCharged;
      updated += 1;
    } catch (e) {
      const code = e instanceof CustomerFacingError ? e.code : undefined;
      if (code && STOP_CODES.has(code)) {
        // Every later page would be refused the same way (and a refusal
        // before the call costs nothing): stop and say why.
        stoppedBy = e instanceof Error ? e.message : null;
        break;
      }
      console.error("[coach add_meta] page skipped", p.id, code ?? (e instanceof Error ? e.message : String(e)));
    }
  }
  if (updated === 0 && stoppedBy) throw new CustomerFacingError(stoppedBy);
  const capped = requested.length > ids.length ? ` (the first ${ADD_META_MAX_PAGES} of ${requested.length})` : "";
  return {
    ok: true,
    summary: `Updated meta on ${updated} of ${ids.length} pages${capped}`,
    details: { updated, requested: requested.length, processed: ids.length, creditsCharged },
  };
}

/**
 * Draft a city page through the shared generation core. No provider call, no
 * key resolution and no metering happen here: runQuickPage decides who pays,
 * holds and settles, under the platform pause switch and the daily-cap slot.
 * Grounding in the tenant's live inventory (the ONLY numbers the model may
 * use) is the core's own rule.
 */
async function createCityPage(
  workspaceId: string,
  userId: string,
  payload: { city: string; state?: string },
  origin: { briefingId?: string; insightIndex?: number },
  deps?: ActionCtx["deps"],
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
    { db: deps?.db, transport: deps?.transport, source: "coach_city_page" },
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

async function addInternalLinks(ctx: ActionCtx, pageId: string): Promise<ActionResult> {
  const { runMeteredAiCall } = await import("@/lib/ai/spend.server");
  const page = await loadPage(ctx.workspaceId, pageId);
  const original = page.body_markdown ?? "";
  if (!original) throw new CustomerFacingError("That page has no body to add links to yet.");

  const { data: candidates } = await supabaseAdmin
    .from("tenant_pages")
    .select("title, slug")
    .eq("workspace_id", ctx.workspaceId)
    .eq("status", "published")
    .neq("id", pageId)
    .limit(50);

  const targets = (candidates ?? [])
    .filter((c) => c.slug)
    .map((c) => `- /a/${c.slug} — ${c.title}`)
    .join("\n");
  if (!targets) {
    throw new CustomerFacingError("There are no other published pages to link to yet.");
  }

  // Count internal links. Pages live at /a/{slug} — the prompt asks for /a/
  // links, so /a/ is what is counted (a /p/ count was always 0).
  const countLinks = (md: string) => (md.match(/\]\(\/a\//g) ?? []).length;
  const before = countLinks(original);

  const res = await runMeteredAiCall({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    requestId: crypto.randomUUID(),
    route: "add_internal_links",
    source: "add_internal_links",
    key: ctx.key,
    billingClass: ctx.billingClass,
    instructions:
      "You add 3-6 contextual internal links to a markdown page. Use Markdown link syntax [anchor text](/a/slug). Only link to slugs from the provided list. Do NOT change other content. Return the FULL updated markdown only.",
    input: `Existing page (title: "${page.title}"):\n\n${original}\n\nAvailable internal link targets:\n${targets}`,
    check: (out) => {
      const text = out.text.trim();
      if (countLinks(text) <= before) {
        return { code: "no_links_added", message: "The AI did not add any new internal links. Try again." };
      }
      // A rewrite that lost a chunk of the page is not an internal-link edit.
      if (text.length < original.length * 0.8) {
        return { code: "content_lost", message: "The AI response dropped part of the page, so nothing was changed. Try again." };
      }
      return null;
    },
    // Saved before the call is settled: the customer pays only for links
    // that landed on the page.
    deliver: async (out) => {
      const { data: rows, error: upErr } = await supabaseAdmin
        .from("tenant_pages")
        .update({ body_markdown: out.text.trim() })
        .eq("id", pageId)
        .eq("workspace_id", ctx.workspaceId)
        .select("id");
      if (upErr) throw new Error(upErr.message);
      assertOneRowUpdated(rows);
    },
    deps: ctx.deps,
  });
  const updated = res.output.text.trim();
  const added = countLinks(updated) - before;

  return {
    ok: true,
    summary: `Added ${added} internal link${added === 1 ? "" : "s"} to "${page.title}"`,
    details: { pageId, added, creditsCharged: res.settlement.creditsCharged },
  };
}

/**
 * The action pipeline behind the server fn: the caller has authorised
 * `userId` for the workspace. Throws; the boundary turns anything that is not
 * a CustomerFacingError into the generic sentence.
 */
export async function runCoachActionPipeline(
  data: CoachActionInput,
  userId: string,
  deps?: ActionCtx["deps"],
): Promise<ActionResult> {
  if (data.actionType === "create_city_page") {
    return createCityPage(data.workspaceId, userId, data.payload, {
      briefingId: data.briefingId,
      insightIndex: data.insightIndex,
    }, deps);
  }
  const { resolveAiKey, billingClassFor } = await import("@/lib/ai/spend.server");
  const key = await resolveAiKey(data.workspaceId, deps?.db);
  const ctx: ActionCtx = {
    workspaceId: data.workspaceId,
    userId,
    key,
    billingClass: billingClassFor(key, { route: data.actionType }),
    deps,
  };
  switch (data.actionType) {
    case "fix_thin_page":
      return fixThinPage(ctx, data.payload.page_id);
    case "add_meta":
      return addMeta(ctx, data.payload);
    case "add_internal_links":
      return addInternalLinks(ctx, data.payload.page_id);
  }
}

export const runCoachAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => CoachActionInputSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    try {
      await assertWorkspaceMember(data.workspaceId, userId);
    } catch (e) {
      throw new Error(customerMessage(e, AI_MESSAGES.unavailable));
    }

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

    // What is logged and thrown is the customer-facing message only:
    // database and provider text is withheld (customerMessage logs it).
    let result: ActionResult | null = null;
    let errorMessage: string | null = null;
    try {
      result = await runCoachActionPipeline(data, userId);
    } catch (e) {
      errorMessage = customerMessage(e, AI_MESSAGES.unavailable);
    }
    await logAction(errorMessage, result);
    if (errorMessage || !result) throw new Error(errorMessage ?? AI_MESSAGES.unavailable);
    return result;
  });
