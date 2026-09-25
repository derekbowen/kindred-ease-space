// Daily briefing generator — the ONLY Supabase function that can make an
// OpenAI request. Called by pg_cron (coach-briefing-nightly, all workspaces)
// and on demand by the app's generateBriefingNow (one workspace), both with
// the shared CRON_SECRET (fails closed, unchanged).
//
// ONE briefing per workspace per UTC day, and at most ONE AI call for it:
//   - coach_briefing_claim: the first run claims (workspace, date); every
//     concurrent run is told 'in_progress' (an on-demand one waits for the
//     stored row), and once stored every run is told 'exists'. Nothing ever
//     regenerates or overwrites a stored briefing.
//   - the AI call goes through the same spend functions as the Worker:
//     ai_reserve (billing 'system': the platform ceiling and kill switch,
//     never a customer's credits) under a request id derived from the
//     workspace and the date, so even a takeover of a dead claim cannot make
//     a second call; ai_mark_called; the call; ai_settle.
//   - any refusal or failure falls back to deterministic heuristics.
// The response carries statuses only — no provider or database text.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  BRIEFING_LIMITS,
  BRIEFING_MODEL,
  REJECTED_BEFORE_GENERATION,
  callOpenAIStructured,
  type Usage,
} from "../_shared/openai.ts";
import { costMicrosForUsage, estimateMaxInputTokens, maxCostMicros } from "../_shared/ai-pricing.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ACTION_TYPES = ["fix_thin_page", "add_meta", "create_city_page", "add_internal_links", "other"] as const;
type Insight = {
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  action_type: (typeof ACTION_TYPES)[number];
  action_payload: Record<string, unknown>;
};

/** Structured Outputs schema for the briefing (strict: every key required, nullable where optional). */
export const BRIEFING_SCHEMA = {
  type: "object",
  properties: {
    insights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string", description: "Under 25 words" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          action_type: { type: "string", enum: [...ACTION_TYPES] },
          action_payload: {
            type: "object",
            properties: {
              page_id: { type: ["string", "null"] },
              page_ids: { type: ["array", "null"], items: { type: "string" } },
              city: { type: ["string", "null"] },
              state: { type: ["string", "null"] },
            },
            required: ["page_id", "page_ids", "city", "state"],
            additionalProperties: false,
          },
        },
        required: ["title", "description", "priority", "action_type", "action_payload"],
        additionalProperties: false,
      },
    },
  },
  required: ["insights"],
  additionalProperties: false,
} as const;

const INSTRUCTIONS =
  "You produce a daily briefing for a Sharetribe marketplace operator. At most 3 insights, highest ROI first. " +
  "Be specific: reference page slugs and city names from the data. Each description under 25 words. " +
  "action_type must match a fix the data supports: fix_thin_page (a thin page's id), add_meta (ids of pages missing meta), " +
  "create_city_page (an uncovered city), add_internal_links (a page id), or other. Only use ids that appear in the data; " +
  "set unused payload fields to null.";

/** Same derivation as the Worker's deterministicRequestId (SHA-256 → v4-shaped uuid). */
async function deterministicRequestId(seed: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
  const b = digest.slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Keep only what the coach actions accept: at most 3 insights, known action
 * types, and for each an exact payload built from ids and cities that are in
 * the data we sent (anything else becomes an 'other' insight without an
 * action). add_meta never carries more than 20 ids.
 */
function normalizeInsights(raw: unknown, known: { pageIds: Set<string>; cities: Set<string> }): Insight[] | null {
  const list = (raw as { insights?: unknown })?.insights;
  if (!Array.isArray(list)) return null;
  const out: Insight[] = [];
  for (const it of list.slice(0, 3)) {
    const o = it as Record<string, any>;
    if (!o || typeof o.title !== "string" || typeof o.description !== "string") continue;
    const priority = ["high", "medium", "low"].includes(o.priority) ? o.priority : "medium";
    const p = (o.action_payload ?? {}) as Record<string, unknown>;
    let action_type: Insight["action_type"] = ACTION_TYPES.includes(o.action_type) ? o.action_type : "other";
    let action_payload: Record<string, unknown> = {};
    if ((action_type === "fix_thin_page" || action_type === "add_internal_links") && typeof p.page_id === "string" && known.pageIds.has(p.page_id)) {
      action_payload = { page_id: p.page_id };
    } else if (action_type === "add_meta" && Array.isArray(p.page_ids)) {
      const ids = [...new Set(p.page_ids.filter((x): x is string => typeof x === "string" && known.pageIds.has(x)))].slice(0, 20);
      if (ids.length) action_payload = { page_ids: ids };
      else action_type = "other";
    } else if (action_type === "create_city_page" && typeof p.city === "string" && known.cities.has(p.city.toLowerCase())) {
      action_payload = typeof p.state === "string" && p.state.trim() ? { city: p.city, state: p.state.trim().slice(0, 80) } : { city: p.city };
    } else {
      action_type = "other";
    }
    out.push({
      title: o.title.trim().slice(0, 120),
      description: o.description.trim().slice(0, 300),
      priority,
      action_type,
      action_payload,
    });
  }
  return out.length ? out : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  // verify_jwt = false (so pg_cron can call it) leaves this open to the
  // internet: CRON_SECRET is mandatory and fails closed.
  const CRON_SECRET = Deno.env.get("CRON_SECRET");
  if (!CRON_SECRET) return json(503, { error: "cron_not_configured" });
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) return json(401, { error: "unauthorized" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // Supabase function secret. Unset → heuristics only (no AI call at all).
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    // The briefing day is the UTC date.
    const today = new Date().toISOString().slice(0, 10);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const onlyWorkspaceId = (body as { workspace_id?: string }).workspace_id;
    const onDemand = typeof onlyWorkspaceId === "string" && onlyWorkspaceId.length > 0;

    let q = admin.from("workspaces").select("id, name").neq("subscription_status", "canceled");
    if (onDemand) q = q.eq("id", onlyWorkspaceId);
    const { data: workspaces } = await q;

    const results: Array<{ workspace_id: string; status: string; ai?: boolean }> = [];
    for (const ws of (workspaces ?? []) as Array<{ id: string }>) {
      try {
        results.push({ workspace_id: ws.id, ...(await briefWorkspace(admin, ws.id, today, onDemand, OPENAI_API_KEY)) });
      } catch (e) {
        console.error("[coach-briefing-cron] workspace failed", ws.id, e instanceof Error ? e.message : String(e));
        results.push({ workspace_id: ws.id, status: "error" });
      }
    }
    return json(200, { processed: results.length, results });
  } catch (e) {
    console.error("[coach-briefing-cron]", e instanceof Error ? e.message : String(e));
    return json(500, { error: "internal_error" });
  }
});

async function briefingExists(admin: any, workspaceId: string, today: string): Promise<boolean> {
  const { data } = await admin
    .from("coach_daily_briefings")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("briefing_date", today)
    .maybeSingle();
  return !!data;
}

async function briefWorkspace(
  admin: any,
  workspaceId: string,
  today: string,
  onDemand: boolean,
  apiKey: string | undefined,
): Promise<{ status: string; ai?: boolean }> {
  const token = crypto.randomUUID();
  const claim = await admin.rpc("coach_briefing_claim", {
    _workspace_id: workspaceId,
    _briefing_date: today,
    _claim_token: token,
  });
  if (claim.error) throw new Error(`coach_briefing_claim failed: ${claim.error.message}`);
  const claimed = (claim.data as { status?: string } | null)?.status;
  if (claimed === "exists") return { status: "exists" };
  if (claimed === "in_progress") {
    // Another run is writing today's briefing. The cron moves on; an
    // on-demand request waits for it and returns the same stored row.
    if (onDemand) {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await briefingExists(admin, workspaceId, today)) return { status: "exists" };
      }
    }
    return { status: "in_progress" };
  }
  if (claimed !== "claimed") throw new Error(`coach_briefing_claim answered ${JSON.stringify(claim.data)}`);

  // Gather signals.
  const [pages, listings] = await Promise.all([
    admin
      .from("tenant_pages")
      .select("id, slug, title, status, meta_description, body_markdown, listing_filter")
      .eq("workspace_id", workspaceId),
    admin.from("tenant_listings").select("id, city, category").eq("workspace_id", workspaceId),
  ]);
  const allPages = (pages.data ?? []) as Array<{
    id: string;
    slug: string;
    title: string;
    status: string;
    meta_description: string | null;
    body_markdown: string | null;
    listing_filter: { city?: string } | null;
  }>;
  const published = allPages.filter((p) => p.status === "published");
  const drafts = allPages.filter((p) => p.status === "draft");
  const thinPages = published.filter((p) => (p.body_markdown ?? "").split(/\s+/).filter(Boolean).length < 300);
  const missingMeta = published.filter((p) => !p.meta_description);
  const cityCoverage = new Set<string>();
  for (const p of published) {
    const f = p.listing_filter ?? {};
    if (f.city) cityCoverage.add(String(f.city).toLowerCase());
  }
  const cityCounts = new Map<string, number>();
  for (const l of (listings.data ?? []) as Array<{ city: string | null }>) {
    if (l.city) cityCounts.set(l.city.toLowerCase(), (cityCounts.get(l.city.toLowerCase()) ?? 0) + 1);
  }
  const uncoveredCities = [...cityCounts.entries()]
    .filter(([c]) => !cityCoverage.has(c))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const summary = {
    total_pages: allPages.length,
    published: published.length,
    drafts: drafts.length,
    thin_pages: thinPages.length,
    thin_examples: thinPages.slice(0, 3).map((p) => ({ id: p.id, slug: p.slug })),
    missing_meta: missingMeta.length,
    missing_meta_examples: missingMeta.slice(0, 3).map((p) => ({ id: p.id, slug: p.slug })),
    uncovered_cities: uncoveredCities.map(([city, count]) => ({ city, listing_count: count })),
    total_listings: listings.data?.length ?? 0,
  };
  const known = {
    pageIds: new Set([...thinPages.slice(0, 3), ...missingMeta.slice(0, 3)].map((p) => p.id)),
    cities: new Set(uncoveredCities.map(([c]) => c)),
  };

  let insights: Insight[] | null = null;
  if (apiKey) insights = await aiInsights(admin, workspaceId, today, apiKey, summary, known);
  const ai = insights !== null;

  // Fallback if no AI answer: deterministic heuristics.
  if (!insights) {
    insights = [];
    if (thinPages.length > 0) {
      insights.push({
        title: `${thinPages.length} thin pages need content`,
        description: `Pages under 300 words rarely rank. Start with /a/${thinPages[0]!.slug}.`,
        priority: "high",
        action_type: "fix_thin_page",
        action_payload: { page_id: thinPages[0]!.id },
      });
    }
    if (uncoveredCities.length > 0) {
      insights.push({
        title: `Create page for ${uncoveredCities[0]![0]}`,
        description: `${uncoveredCities[0]![1]} listings in ${uncoveredCities[0]![0]} have no dedicated page.`,
        priority: "high",
        action_type: "create_city_page",
        action_payload: { city: uncoveredCities[0]![0] },
      });
    }
    if (missingMeta.length > 0) {
      insights.push({
        title: `${missingMeta.length} pages missing meta description`,
        description: `Quick win — add meta descriptions to boost CTR.`,
        priority: "medium",
        action_type: "add_meta",
        action_payload: { page_ids: missingMeta.slice(0, 5).map((p) => p.id) },
      });
    }
  }

  const stored = await admin.rpc("coach_briefing_store", {
    _workspace_id: workspaceId,
    _briefing_date: today,
    _claim_token: token,
    _insights: insights,
  });
  if (stored.error) throw new Error(`coach_briefing_store failed: ${stored.error.message}`);
  const s = (stored.data as { status?: string } | null)?.status;
  return { status: s === "stored" ? "created" : (s ?? "error"), ai };
}

/**
 * The day's one AI call, reserved like every other: ai_reserve with billing
 * 'system' under a request id derived from the workspace and the date. Any
 * refusal ('in_progress', 'done', 'platform_paused', 'budget_exhausted', …)
 * or failure returns null and the caller uses heuristics.
 */
async function aiInsights(
  admin: any,
  workspaceId: string,
  today: string,
  apiKey: string,
  summary: Record<string, unknown>,
  known: { pageIds: Set<string>; cities: Set<string> },
): Promise<Insight[] | null> {
  const requestId = await deterministicRequestId(`briefing:${workspaceId}:${today}`);
  const input = `Workspace data:\n${JSON.stringify(summary)}`;
  const maxInputTokens = estimateMaxInputTokens(INSTRUCTIONS, input, BRIEFING_SCHEMA as unknown as Record<string, unknown>);
  const ids = { _workspace_id: workspaceId, _request_id: requestId };

  const reserved = await admin.rpc("ai_reserve", {
    ...ids,
    _user_id: null,
    _feature: "daily_briefing",
    _source: "daily_briefing",
    _model: BRIEFING_MODEL,
    _max_input_tokens: maxInputTokens,
    _max_output_tokens: BRIEFING_LIMITS.maxOutputTokens,
    _max_cost_micros: maxCostMicros(BRIEFING_MODEL, maxInputTokens, BRIEFING_LIMITS.maxOutputTokens),
    _max_credits: 0,
    _billing_class: "system",
  });
  if (reserved.error || (reserved.data as { status?: string } | null)?.status !== "reserved") {
    if (reserved.error) console.error("[coach-briefing-cron] ai_reserve failed", reserved.error.message);
    return null;
  }
  const marked = await admin.rpc("ai_mark_called", ids);
  if (marked.error || marked.data !== true) {
    await admin.rpc("ai_release", ids);
    return null;
  }

  const res = await callOpenAIStructured({
    apiKey,
    instructions: INSTRUCTIONS,
    input,
    format: { name: "daily_briefing", schema: BRIEFING_SCHEMA as unknown as Record<string, unknown> },
  });

  // Settle exactly as the Worker does (billing 'system': only the platform
  // budget moves): the reported usage's cost; 0 when the request never left
  // or OpenAI rejected it before generation; the full hold when unknown.
  const usage: Usage | null = res.usage;
  const rejected = !res.ok && (!res.sent || (res.httpStatus !== null && REJECTED_BEFORE_GENERATION.has(res.httpStatus)));
  const cost = usage ? costMicrosForUsage(BRIEFING_MODEL, usage) : rejected ? 0 : null;
  const insights = res.ok ? normalizeInsights(res.data, known) : null;
  const settled = await admin.rpc("ai_settle", {
    ...ids,
    _input_tokens: usage?.inputTokens ?? null,
    _cached_input_tokens: usage?.cachedInputTokens ?? null,
    _output_tokens: usage?.outputTokens ?? null,
    _reasoning_tokens: usage?.reasoningTokens ?? null,
    _cost_micros: cost,
    _credits: cost === null ? null : 0,
    _outcome: insights ? "ok" : "failed",
    _error: res.ok ? (insights ? (usage ? null : "usage_missing") : "schema_mismatch") : res.kind,
  });
  if (settled.error) {
    // The reaper settles this call at the full hold within 35 minutes.
    console.error("[coach-briefing-cron] ai_settle failed", settled.error.message);
  }
  return insights;
}
