import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  OPENROUTER_BASE,
  PLATFORM_MODEL_ALLOWLIST,
  creditsForUsage,
  resolvePlatformModel,
} from "@/lib/ai-pricing";
import { getWorkspaceSecretWithSource } from "@/lib/workspace-secrets.server";
import {
  findUniqueTenantSlug,
  getActiveTemplateId,
  slugifyPage,
} from "@/lib/tenant-page-helpers.server";
import { checkPageBeforePublish, type ContractCheck } from "@/lib/seo/page-contract.server";

/**
 * Shared page-generation core. The Quick Page Builder, the Opportunity Engine
 * and the batch "Generate Content" job all run through here so there is ONE
 * prompt, ONE inventory-grounding rule, ONE metering path and ONE model policy.
 *
 * Ordering matters and is the whole point of this module:
 *   1. generatePageContent  — cheap availability check, then the AI call.
 *      Nothing is charged here. A failed generation costs the customer nothing
 *      and a retry does not pay twice.
 *   2. persistGeneratedPage — the draft row. Never auto-publishes.
 *   3. settleGeneration     — charges the platform quota/credits ONLY now,
 *      and only when the key came from the platform (BYOK is the customer's
 *      own provider bill).
 *
 * The pure helpers at the top have no I/O so tests can import this file
 * without a database or network (supabaseAdmin is a lazy proxy).
 *
 * NEVER import from client code.
 */

// ---------------------------------------------------------------------------
// Pure helpers (no I/O)
// ---------------------------------------------------------------------------

/**
 * Cheapest allowlisted model. The old default ('google/gemini-2.5-flash') was
 * not on the allowlist, so resolvePlatformModel silently swapped it for the
 * Pro-tier default and customers paid ~4x for "flash".
 */
export const GENERATION_DEFAULT_MODEL = "google/gemini-3-flash-preview";

/** A typical city page: ~1.5K prompt tokens (brief + inventory) and ~1.5K out. */
const TYPICAL_PAGE_TOKENS = { prompt: 1500, completion: 1500 };

/** Credits one page is likely to cost on a platform key, for the cost hint. */
export function estimatedCreditsPerPage(model: string): number {
  return creditsForUsage(model, TYPICAL_PAGE_TOKENS.prompt, TYPICAL_PAGE_TOKENS.completion);
}

/** Human labels + a one-line cost hint per allowlisted model, for pickers. */
export const GENERATION_MODEL_OPTIONS: Array<{ id: string; label: string; hint: string }> = [
  {
    id: "google/gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash Lite",
    note: "lightest, shorter copy",
  },
  { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash", note: "fast and cheap" },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash", note: "balanced" },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", note: "best quality" },
]
  .filter((m) => PLATFORM_MODEL_ALLOWLIST.includes(m.id))
  .map((m) => ({
    id: m.id,
    label: m.label,
    hint: `${m.note} — about ${estimatedCreditsPerPage(m.id)} credit${estimatedCreditsPerPage(m.id) === 1 ? "" : "s"} per page on the platform key`,
  }));

/**
 * Stable identity for a batch target. Batch items are idempotent by THIS key,
 * never by slug — slugs get suffixed on collision (findUniqueTenantSlug) so
 * two runs for the same city would otherwise produce austin, austin-2, ...
 */
export function buildTargetKey(t: { city: string; state?: string | null }): string {
  const city = String(t.city ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const state = String(t.state ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return `city:${city}|${state}`;
}

export type CityTargetInput = {
  city: string;
  state: string | null;
  listingCount: number;
  hasPage: boolean;
};

export type GenerationTarget = CityTargetInput & { targetKey: string };

/**
 * Which cities deserve a page: enough published listings to render a
 * non-thin page, and no page for that city yet. The order is by inventory
 * size so the highest-value gaps come first.
 */
export function selectTargets(
  context: { cities: CityTargetInput[] },
  minListings = 3,
): GenerationTarget[] {
  const seen = new Set<string>();
  const out: GenerationTarget[] = [];
  for (const c of context.cities ?? []) {
    if (!c.city || !String(c.city).trim()) continue;
    if (c.hasPage) continue;
    if ((c.listingCount ?? 0) < minListings) continue;
    const targetKey = buildTargetKey(c);
    if (seen.has(targetKey)) continue;
    seen.add(targetKey);
    out.push({ ...c, targetKey });
  }
  return out.sort((a, b) => b.listingCount - a.listingCount);
}

/** Pages a workspace may still generate today. Never negative. */
export function dailyCapRemaining(cap: number, doneLast24h: number): number {
  const c = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
  const d = Number.isFinite(doneLast24h) ? Math.max(0, Math.floor(doneLast24h)) : 0;
  return Math.max(0, c - d);
}

export type ExistingItemLike = { target_key: string; status: string };

/**
 * Decide what a new job does with each requested key, given the workspace's
 * existing items (UNIQUE on workspace_id + target_key):
 *   - done      → reused as-is; NOT regenerated, NOT charged again
 *   - pending / running / failed / skipped → re-attached to the new job so the
 *                 browser can (re)drive them; still one row per key
 *   - unknown   → created
 */
export function planJobItems(
  requestedKeys: string[],
  existing: ExistingItemLike[],
): { create: string[]; reattach: string[]; alreadyDone: string[] } {
  const byKey = new Map(existing.map((e) => [e.target_key, e.status]));
  const create: string[] = [];
  const reattach: string[] = [];
  const alreadyDone: string[] = [];
  const seen = new Set<string>();
  for (const key of requestedKeys) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const status = byKey.get(key);
    if (status === undefined) create.push(key);
    else if (status === "done") alreadyDone.push(key);
    else reattach.push(key);
  }
  return { create, reattach, alreadyDone };
}

/** Running items older than this are treated as abandoned and retried. */
export const STALE_RUNNING_MS = 3 * 60_000;

export function isStaleRunning(updatedAt: string | null | undefined, now = Date.now()): boolean {
  if (!updatedAt) return true;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > STALE_RUNNING_MS;
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The brief a batch item generates from. Mirrors the "City Hub" preset. */
export function buildCityBrief(t: {
  city: string;
  state?: string | null;
  categoryPlural?: string | null;
}): { title: string; topic: string; description: string } {
  const place = `${t.city}${t.state ? `, ${t.state}` : ""}`;
  const cat = (t.categoryPlural ?? "").trim() || "listings";
  return {
    title: `${cap(cat)} in ${place}`,
    description: `Browse ${cat} in ${place} and find the right option for you.`,
    topic: `City hub page for ${place}. Cover: who uses ${cat} here, popular local use cases, what to look for when booking, and a strong CTA to browse the live listings shown on the page. Use only real facts — do not invent pricing or availability.`,
  };
}

export type InventoryRow = {
  title: string | null;
  price_amount: number | null;
  price_currency: string | null;
};

/**
 * The grounding block. "The ONLY numbers you may use" is what separates a
 * factual per-city page from the templated filler Google's scaled-content
 * policy demotes — keep that wording.
 */
export function formatInventoryFacts(city: string, rows: InventoryRow[]): string {
  const prices = rows
    .map((r) => r.price_amount)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
  const currency = rows.find((r) => r.price_currency)?.price_currency ?? "USD";
  const sample = rows
    .slice(0, 5)
    .map((r) => `- ${r.title}`)
    .join("\n");
  return `

Live inventory facts for ${city} — the ONLY numbers you may use; never invent pricing, counts, or listings:
- ${rows.length} published listings
- ${
    prices.length
      ? `Price range ${(prices[0]! / 100).toFixed(0)}–${(prices[prices.length - 1]! / 100).toFixed(0)} ${currency}`
      : "No price data — do not state or estimate prices"
  }
${sample ? `- Example listings:\n${sample}` : "- No example listings yet."}`;
}

export const GENERATION_SYSTEM_PROMPT = `
You write SEO-optimised brand content for a marketplace business.
Voice: confident, friendly, customer-first, never spammy. Short paragraphs.
Real, useful copy — no filler, no "in this article we will".
Format: Markdown only. Use ## and ### headings.
Always end with a short CTA paragraph.
Return your answer ONLY by calling the write_page tool.
`.trim();

export const WRITE_PAGE_TOOL = {
  type: "function" as const,
  function: {
    name: "write_page",
    description: "Return the generated page content.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        seo_title: { type: "string", description: "≤60 chars" },
        seo_description: { type: "string", description: "≤155 chars" },
        body_markdown: {
          type: "string",
          description: "Full markdown body, 600-1200 words, no frontmatter",
        },
      },
      required: ["title", "seo_title", "seo_description", "body_markdown"],
      additionalProperties: false,
    },
  },
};

export function buildUserPrompt(p: {
  title: string;
  description?: string | null;
  topic: string;
  inventoryFacts?: string;
}): string {
  return `Write a brand page.

Title (H1): "${p.title}"
${p.description ? `One-line summary: "${p.description}"` : ""}

What this page should be about (interpret literally and build the article around this):
${p.topic}
${p.inventoryFacts ?? ""}

Length: 600-1200 words.
Use ## for the main sections and ### for sub-points. Lead with a strong opening — no fluff.
seo_title (≤60 chars) and seo_description (≤155 chars) optimised for the topic.`;
}

export type WritePageOutput = {
  title: string;
  seo_title: string;
  seo_description: string;
  body_markdown: string;
};

export type OpenRouterResult = WritePageOutput & {
  promptTokens: number;
  completionTokens: number;
};

/** Anything shorter than this is a refusal or a truncated stream, not a page. */
export const MIN_BODY_CHARS = 300;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * One forced tool call to OpenRouter. `fetchImpl` is injectable so the
 * parsing rules (tool-call shape, short-body rejection, non-2xx text) are
 * testable offline.
 */
export async function callOpenRouterWritePage(opts: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  fetchImpl?: FetchLike;
}): Promise<OpenRouterResult> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const resp = await doFetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: opts.userPrompt },
      ],
      tools: [WRITE_PAGE_TOOL],
      tool_choice: { type: "function", function: { name: "write_page" } },
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`AI provider ${resp.status}: ${t.slice(0, 300)}`);
  }
  const json: any = await resp.json();
  const promptTokens = Number(json?.usage?.prompt_tokens ?? 0) || 0;
  const completionTokens = Number(json?.usage?.completion_tokens ?? 0) || 0;
  const tc = json?.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc?.function?.arguments) throw new Error("AI response missing tool call");
  let gen: Partial<WritePageOutput>;
  try {
    gen =
      typeof tc.function.arguments === "string"
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments;
  } catch {
    throw new Error("AI response was not valid JSON");
  }
  if (!gen.body_markdown || gen.body_markdown.length < MIN_BODY_CHARS) {
    throw new Error(`Generated body too short (${gen.body_markdown?.length ?? 0} chars)`);
  }
  return {
    title: String(gen.title ?? ""),
    seo_title: String(gen.seo_title ?? ""),
    seo_description: String(gen.seo_description ?? ""),
    body_markdown: gen.body_markdown,
    promptTokens,
    completionTokens,
  };
}

// ---------------------------------------------------------------------------
// Database-backed steps
// ---------------------------------------------------------------------------

const sb = () => supabaseAdmin as any;

export type KeySource = "byok" | "platform";

/** BYOK first, platform env-var fallback — and REMEMBER which one it was. */
export async function resolveGenerationKey(
  workspaceId: string,
): Promise<{ key: string; source: KeySource }> {
  const found = await getWorkspaceSecretWithSource(
    workspaceId,
    "OPENROUTER_API_KEY",
    "OPENROUTER_API_KEY",
  );
  if (!found) {
    throw new Error("No AI key configured. Add a BYOK OpenRouter key under Settings → API Keys.");
  }
  return found;
}

/**
 * Cheap read-only check that the workspace can pay for ONE platform call:
 * free trial quota left, or a positive credit balance. Nothing is reserved —
 * consumption happens in settleGeneration after the page row exists.
 */
export async function assertPlatformAiAvailable(workspaceId: string): Promise<void> {
  const [{ data: quota }, { data: bal }] = await Promise.all([
    supabaseAdmin
      .from("workspace_ai_quota")
      .select("platform_credits_remaining")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    supabaseAdmin
      .from("credit_balances")
      .select("balance")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
  ]);
  // No quota row yet means the RPC will create one with the default free
  // allowance on first consume, so "missing" counts as available.
  const freeLeft = quota ? (quota.platform_credits_remaining ?? 0) > 0 : true;
  const credits = (bal?.balance ?? 0) > 0;
  if (!freeLeft && !credits) {
    throw new Error("Out of AI credits. Top up in Billing to keep generating.");
  }
}

export type GenerateInput = {
  workspaceId: string;
  title: string;
  description?: string | null;
  topic: string;
  city?: string | null;
  state?: string | null;
  categoryPlural?: string | null;
  /** Category used to narrow the inventory grounding query, if known. */
  category?: string | null;
  model?: string | null;
  fetchImpl?: FetchLike;
};

export type GeneratedContent = WritePageOutput & {
  promptTokens: number;
  completionTokens: number;
  model: string;
  keySource: KeySource;
};

/**
 * Step 1: produce content. Charges nothing. Throws with a customer-readable
 * message on any failure (no key, no credits, provider error, thin output).
 */
export async function generatePageContent(input: GenerateInput): Promise<GeneratedContent> {
  const { key, source } = await resolveGenerationKey(input.workspaceId);
  const model = resolvePlatformModel(input.model ?? GENERATION_DEFAULT_MODEL);
  if (source === "platform") await assertPlatformAiAvailable(input.workspaceId);

  // Ground generation in the tenant's real inventory when a city is targeted.
  let inventoryFacts = "";
  const city = input.city?.trim();
  if (city) {
    let q = supabaseAdmin
      .from("tenant_listings")
      .select("title, price_amount, price_currency")
      .eq("workspace_id", input.workspaceId)
      .ilike("city", city)
      .eq("state_published", true);
    if (input.category) q = q.eq("category", input.category);
    const { data: cityListings } = await q.limit(100);
    inventoryFacts = formatInventoryFacts(city, (cityListings ?? []) as InventoryRow[]);
  }

  const gen = await callOpenRouterWritePage({
    apiKey: key,
    model,
    systemPrompt: GENERATION_SYSTEM_PROMPT,
    userPrompt: buildUserPrompt({
      title: input.title,
      description: input.description,
      topic: input.topic,
      inventoryFacts,
    }),
    fetchImpl: input.fetchImpl,
  });
  return { ...gen, model, keySource: source };
}

export type PersistedPage = { id: string; slug: string; title: string; url_path: string };

/**
 * Step 2: the draft row. Always status 'draft' — publishing is a separate,
 * gated step (page contract + entitlement) that callers run explicitly.
 */
export async function persistGeneratedPage(input: {
  workspaceId: string;
  generated: WritePageOutput;
  requestedTitle: string;
  requestedDescription?: string | null;
  slug?: string | null;
  city?: string | null;
  state?: string | null;
  categoryPlural?: string | null;
}): Promise<PersistedPage> {
  const baseSlug = slugifyPage(input.slug || input.requestedTitle);
  if (!baseSlug) throw new Error("Could not derive slug from title");
  const slug = await findUniqueTenantSlug(input.workspaceId, baseSlug);
  const templateId = await getActiveTemplateId("city_hub");

  const pageTitle = input.generated.title || input.requestedTitle;
  const city = input.city?.trim() || "";
  const state = input.state?.trim() || "";
  const categoryPlural = input.categoryPlural?.trim() || "listings";
  const variables: Record<string, string> = {};
  if (city) variables.city = city;
  if (state) variables.state = state;
  if (categoryPlural) variables.category_plural = categoryPlural;
  const listingFilter: Record<string, unknown> = { limit: 24, sort: "newest" };
  if (city) listingFilter.city = city;
  if (state) listingFilter.state = state;

  const { data: inserted, error: insErr } = await sb()
    .from("tenant_pages")
    .insert({
      workspace_id: input.workspaceId,
      template_id: templateId,
      slug,
      title: pageTitle,
      meta_description: (input.generated.seo_description || input.requestedDescription || "").slice(
        0,
        320,
      ),
      h1: pageTitle,
      body_markdown: input.generated.body_markdown,
      variables,
      listing_filter: listingFilter,
      status: "draft",
    })
    .select("id, slug, title")
    .single();
  if (insErr) throw new Error(insErr.message);
  return { ...inserted, url_path: `/a/${inserted.slug}` };
}

/**
 * Step 3: settle. Runs ONLY after a page row exists. Platform key → spend the
 * free quota first (consume_platform_ai_credit), then purchased credits.
 * BYOK → nothing to charge; the call is logged for the usage history only.
 */
export async function settleGeneration(opts: {
  workspaceId: string;
  userId?: string | null;
  keySource: KeySource;
  model: string;
  promptTokens: number;
  completionTokens: number;
  feature: string;
  refId?: string | null;
}): Promise<{ creditsCharged: number; billing: "byok" | "free_quota" | "credits" }> {
  let creditsCharged = 0;
  let billing: "byok" | "free_quota" | "credits" = "byok";

  if (opts.keySource === "platform") {
    const { error: qErr } = await supabaseAdmin.rpc("consume_platform_ai_credit", {
      _workspace_id: opts.workspaceId,
    });
    if (!qErr) {
      billing = "free_quota";
    } else if (
      typeof qErr.message === "string" &&
      qErr.message.includes("platform_ai_quota_exhausted")
    ) {
      billing = "credits";
      creditsCharged = creditsForUsage(opts.model, opts.promptTokens, opts.completionTokens);
      if (creditsCharged > 0) {
        const { error } = await supabaseAdmin.rpc("deduct_credits", {
          _workspace_id: opts.workspaceId,
          _amount: creditsCharged,
          _reason: "ai_usage",
          _ai_model: opts.model,
          _ref_type: opts.feature,
          _ref_id: opts.refId ?? undefined,
          _metadata: { provider: "platform", feature: opts.feature },
        });
        // The page already exists; a failed deduction is an ops problem, not
        // a reason to take the customer's content away.
        if (error) console.error("[settleGeneration] deduct_credits failed", error.message);
      }
    } else {
      console.error("[settleGeneration] consume_platform_ai_credit failed", qErr.message);
    }
  }

  await supabaseAdmin.from("ai_usage_log").insert({
    workspace_id: opts.workspaceId,
    user_id: opts.userId ?? undefined,
    provider: opts.keySource === "byok" ? "openrouter" : "platform",
    model: opts.model,
    feature: opts.feature,
    prompt_tokens: opts.promptTokens,
    completion_tokens: opts.completionTokens,
    total_tokens: opts.promptTokens + opts.completionTokens,
    used_byok: opts.keySource === "byok",
    status: "ok",
  });
  return { creditsCharged, billing };
}

/** Run the published-page contract against a stored draft. */
export async function checkStoredPageContract(
  workspaceId: string,
  pageId: string,
): Promise<ContractCheck & { status: string | null; slug: string; title: string | null }> {
  const { data: page, error } = await sb()
    .from("tenant_pages")
    .select(
      "id, slug, title, meta_description, h1, body_markdown, listing_filter, variables, status",
    )
    .eq("workspace_id", workspaceId)
    .eq("id", pageId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!page) throw new Error("Page not found");
  const check = await checkPageBeforePublish(workspaceId, {
    id: page.id,
    slug: page.slug,
    title: page.title,
    metaDescription: page.meta_description,
    h1: page.h1,
    bodyMarkdown: page.body_markdown,
    listingFilter: page.listing_filter,
    variables: page.variables,
  });
  return { ...check, status: page.status ?? null, slug: page.slug, title: page.title ?? null };
}

/** Plain-language reason a draft could not go live. */
export function contractFailureMessage(check: ContractCheck): string {
  const msgs = check.blocking.map((v) => v.message);
  return msgs.length
    ? `Kept as a draft: ${msgs.join(" ")}`
    : "Kept as a draft: the page did not pass the pre-publish checks.";
}
