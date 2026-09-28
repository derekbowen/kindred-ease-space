/**
 * THE PAGE DRAFT PIPELINE — the one way a page gets written.
 *
 * Opportunity (or a manual pick) → template → filter → draft. Everything a
 * request can be refused for is checked BEFORE anything costs money:
 *
 *   replay (this request id already has a draft) → title/slug → template
 *   active and renderable → the filter meets the template's contract → exact
 *   inventory count (listing templates need MIN_LISTINGS_FOR_PAGE) → an
 *   existing page for the target is returned instead (resume/review, never a
 *   duplicate) → grounding read → pause switch → billing state → who pays →
 *   the daily-cap slot (one per request id) → CLAIM the draft row → the
 *   metered call (spend hold, marks, OpenAI) → the draft row is filled in
 *   (deliver, before settlement) → settle.
 *
 * The draft row is claimed BEFORE the provider call, keyed by the page's
 * target (tenant_pages_live_target_uidx admits one live page per target), so
 * two tabs or two double-clicks can never generate two pages for one target
 * — the loser gets the winner's page and its slot back. A regeneration claims
 * the existing draft with a conditional update instead. A failure after the
 * claim keeps the row (title, filter, brief — and the previous body, on a
 * regeneration) marked failed with a customer sentence; a refusal before the
 * provider call removes a row this request created empty, since nothing was
 * written.
 *
 * generation_request_id is only written on delivery: reserve_generation_slot
 * reads a page carrying the id as "consumed", so the claim keeps its id in
 * generation.request_id until the content exists.
 *
 * NEVER import from client code.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { AiDb } from "@/lib/ai/spend.server";
import type { OpenAiTransport } from "@/lib/ai/openai.server";
import {
  CustomerFacingError,
  GENERATION_ALREADY_USED_MESSAGE,
  GENERATION_IN_PROGRESS_MESSAGE,
  GENERATION_PAUSED_MESSAGE,
  GENERATION_UNAVAILABLE_MESSAGE,
  billingStatusFor,
  customerMessage,
  dailyCapMessage,
  effectiveDailyCap,
  generatePageContent,
  isInternalWorkspace,
  markGenerationProviderCalled,
  readPlatformSettings,
  readSpendSettlement,
  releaseGenerationSlot,
  reserveGenerationSlot,
  resolveBillingMode,
  validatePageRequest,
  type GeneratedContent,
  type ItemBillingStatus,
} from "@/lib/generation.server";
import type { AiQualityTier } from "@/lib/ai/models";
import {
  MIN_LISTINGS_FOR_PAGE,
  placeLabel,
  resolveFilter,
  targetKey,
  type PageKind,
  type ResolvedFilter,
} from "@/lib/coverage/target";
import { countMatchingListings } from "@/lib/coverage/inventory.server";
import {
  RENDERABLE_PAGE_KINDS,
  TEMPLATE_CONTRACTS,
  checkFilterForTemplate,
  isPageKind,
} from "@/lib/templates/contracts";
import {
  BRIEF_MAX_CHARS,
  PAGE_SYSTEM_PROMPT,
  buildPagePrompt,
  formatGroundingBlock,
  minBodyCharsFor,
} from "@/lib/page-grounding";
import { readGroundingFacts } from "@/lib/page-grounding.server";
import { findUniqueTenantSlug } from "@/lib/tenant-page-helpers.server";

const sb = () => supabaseAdmin as any;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const TEMPLATE_UNAVAILABLE_MESSAGE =
  "That page template isn't available right now. Pick another template or contact support.";
export const DRAFT_NOT_EDITABLE_MESSAGE =
  "Only drafts can be regenerated. Unpublish the page first, or edit its text directly.";
export const GENERATION_BILLING_MESSAGE =
  "Your plan doesn't include creating pages right now. Choose a plan in Billing to continue.";
export const DRAFT_INTERRUPTED_MESSAGE =
  "Writing this draft was interrupted before it finished. Nothing was lost — try again.";

export function notEnoughListingsMessage(kind: PageKind, count: number): string {
  const c = TEMPLATE_CONTRACTS[kind];
  return count === 0
    ? `No published listings match this ${c.name}, so there is nothing for the page to show. Pick another location or category, or sync your listings again.`
    : `Only ${count} published listing${count === 1 ? "" : "s"} match this ${c.name}. A page needs at least ${MIN_LISTINGS_FOR_PAGE} to be useful.`;
}

/** A claimed draft older than this with no result was abandoned (the provider timeout is shorter). */
export const DRAFT_STALE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type TemplateRow = {
  id: string;
  slug: string;
  name: string | null;
  is_active: boolean | null;
  config_schema: unknown;
};

/**
 * Offered only when active in the database, stored with the contract this
 * code enforces, and registered with a renderer — a template the public page
 * cannot draw is never offered, and never drawn as another one.
 */
export function isUsableTemplate(
  row: Pick<TemplateRow, "slug" | "is_active" | "config_schema">,
): boolean {
  if (!isPageKind(row.slug) || row.is_active !== true) return false;
  if (!(RENDERABLE_PAGE_KINDS as readonly string[]).includes(row.slug)) return false;
  const schema = row.config_schema as { kind?: unknown } | null;
  return !!schema && typeof schema === "object" && schema.kind === row.slug;
}

export async function readTemplates(): Promise<TemplateRow[]> {
  const { data, error } = await sb()
    .from("page_templates")
    .select("id, slug, name, is_active, config_schema")
    .in("slug", [...RENDERABLE_PAGE_KINDS]);
  if (error) throw new Error(`template read failed: ${error.message}`);
  return (data ?? []) as TemplateRow[];
}

export async function loadUsableTemplate(kind: PageKind): Promise<TemplateRow> {
  const row = (await readTemplates()).find((t) => t.slug === kind);
  if (!row || !isUsableTemplate(row)) throw new CustomerFacingError(TEMPLATE_UNAVAILABLE_MESSAGE);
  return row;
}

// ---------------------------------------------------------------------------
// Checks shared by the builder's review step and the draft request
// ---------------------------------------------------------------------------

export type TargetCheck = {
  kind: PageKind;
  filter: ResolvedFilter;
  listingCount: number;
  targetKey: string | null;
  /** Plain sentences; empty = this target can be drafted. */
  problems: string[];
};

/**
 * Is this (kind, filter) draftable? Pure checks first, then the exact count.
 * Never throws for a customer problem — it returns the sentences; it throws
 * only when the count itself cannot be read.
 */
export async function checkTarget(
  workspaceId: string,
  kind: PageKind,
  rawFilter: unknown,
): Promise<TargetCheck> {
  const problems = checkFilterForTemplate(kind, rawFilter).map((p) => p.message);
  const filter = resolveFilter(rawFilter);
  if (!filter || filter.version !== 2) {
    return {
      kind,
      filter: filter ?? {
        version: 2,
        constraints: {},
        labels: { country: null, region: null, city: null, category: null },
        limit: 24,
      },
      listingCount: 0,
      targetKey: null,
      problems: problems.length
        ? problems
        : ["This page's listing filter isn't valid. Pick the location or category again."],
    };
  }
  if (kind === "resource_article" && Object.keys(filter.constraints).length > 0) {
    // An article is editorial: its related listings are the whole marketplace.
    problems.push("A Resource Article isn't tied to one location or category.");
  }
  const listingCount = await countMatchingListings(workspaceId, filter);
  if (TEMPLATE_CONTRACTS[kind].requiresListings && listingCount < MIN_LISTINGS_FOR_PAGE) {
    problems.push(notEnoughListingsMessage(kind, listingCount));
  }
  return { kind, filter, listingCount, targetKey: targetKey(kind, filter), problems };
}

// ---------------------------------------------------------------------------
// Draft rows
// ---------------------------------------------------------------------------

export type GenerationState = {
  state: "generating" | "ready" | "failed";
  request_id: string;
  tier: AiQualityTier;
  source: string;
  started_at: string;
  finished_at?: string;
  elapsed_ms?: number;
  brief?: string;
  description?: string;
  error?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  credits_charged?: number;
  cost_micros?: number | null;
  billing?: ItemBillingStatus;
  suggested_title?: string;
};

export type DraftPageRef = {
  id: string;
  slug: string;
  title: string | null;
  status: string;
  kind: PageKind | null;
  generation: GenerationState | null;
  contentVersion: number;
};

const PAGE_REF_COLUMNS =
  "id, slug, title, status, content_version, generation, generation_request_id, body_markdown, page_templates:template_id(slug)";

type PageRefRow = {
  id: string;
  slug: string;
  title: string | null;
  status: string;
  content_version: number | null;
  generation: GenerationState | null;
  generation_request_id: string | null;
  body_markdown: string | null;
  page_templates: { slug: string } | null;
};

function toRef(r: PageRefRow): DraftPageRef {
  const kind = r.page_templates?.slug;
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    status: r.status,
    kind: isPageKind(kind) ? kind : null,
    generation: r.generation ?? null,
    contentVersion: Number(r.content_version) || 1,
  };
}

/** Is this claimed row still being written, or abandoned? */
export function isGenerationActive(
  g: GenerationState | null | undefined,
  now = Date.now(),
): boolean {
  if (!g || g.state !== "generating") return false;
  const t = Date.parse(g.started_at);
  return Number.isFinite(t) && now - t < DRAFT_STALE_MS;
}

/** The page a request id claimed or produced, if any. */
export async function findPageByDraftRequest(
  workspaceId: string,
  requestId: string,
): Promise<PageRefRow | null> {
  const { data, error } = await sb()
    .from("tenant_pages")
    .select(PAGE_REF_COLUMNS)
    .eq("workspace_id", workspaceId)
    .or(`generation_request_id.eq.${requestId},generation->>request_id.eq.${requestId}`)
    .limit(1);
  if (error) throw new Error(`draft read failed: ${error.message}`);
  return ((data ?? []) as PageRefRow[])[0] ?? null;
}

/** The live (not archived) page that owns a target, if any. */
export async function findLivePageForTarget(
  workspaceId: string,
  key: string,
): Promise<PageRefRow | null> {
  const { data, error } = await sb()
    .from("tenant_pages")
    .select(PAGE_REF_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("target_key", key)
    .neq("status", "archived")
    .limit(1);
  if (error) throw new Error(`page read failed: ${error.message}`);
  return ((data ?? []) as PageRefRow[])[0] ?? null;
}

const errText = (e: { message?: string; details?: string } | null | undefined) =>
  `${e?.message ?? ""} ${e?.details ?? ""}`;

/** Legacy fields some readers still use (the old publish intent check). */
export function legacyVariables(kind: PageKind, filter: ResolvedFilter): Record<string, string> {
  const v: Record<string, string> = { template: kind };
  if (filter.labels.city) v.city = filter.labels.city;
  if (filter.labels.region) v.state = filter.labels.region;
  if (filter.labels.country) v.country = filter.labels.country;
  if (filter.labels.category) v.category_plural = filter.labels.category;
  return v;
}

type ClaimResult = { claimed: PageRefRow; created: boolean } | { existing: PageRefRow };

/** Insert the draft row for a new page, owning its target. */
async function claimNewDraft(p: {
  workspaceId: string;
  template: TemplateRow;
  kind: PageKind;
  rawFilter: unknown;
  filter: ResolvedFilter;
  targetKey: string | null;
  title: string;
  description: string;
  baseSlug: string;
  generation: GenerationState;
}): Promise<ClaimResult> {
  let slug = await findUniqueTenantSlug(p.workspaceId, p.baseSlug);
  const row = {
    workspace_id: p.workspaceId,
    template_id: p.template.id,
    title: p.title,
    h1: p.title,
    meta_description: p.description || null,
    body_markdown: null,
    variables: legacyVariables(p.kind, p.filter),
    listing_filter: p.rawFilter,
    target_key: p.targetKey,
    status: "draft",
    noindex: false,
    content_version: 1,
    generation: p.generation,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await sb()
      .from("tenant_pages")
      .insert({ ...row, slug })
      .select(PAGE_REF_COLUMNS)
      .single();
    if (!error) return { claimed: data as PageRefRow, created: true };
    if (error.code === "23505" && /live_target/.test(errText(error)) && p.targetKey) {
      const existing = await findLivePageForTarget(p.workspaceId, p.targetKey);
      if (existing) return { existing };
      continue; // archived or removed between the two reads: try again
    }
    if (error.code === "23505" && /slug/.test(errText(error))) {
      slug = await findUniqueTenantSlug(p.workspaceId, p.baseSlug);
      continue;
    }
    throw new Error(`draft insert failed: ${error.message}`);
  }
  throw new Error("draft insert failed: could not claim a unique address for this page");
}

/**
 * Claim an existing DRAFT for regeneration: only when it is a draft of this
 * workspace and nobody is writing it right now (or that run was abandoned).
 */
async function claimExistingDraft(p: {
  workspaceId: string;
  pageId: string;
  generation: GenerationState;
}): Promise<PageRefRow | null> {
  const staleBefore = new Date(Date.now() - DRAFT_STALE_MS).toISOString();
  const { data, error } = await sb()
    .from("tenant_pages")
    .update({ generation: p.generation })
    .eq("id", p.pageId)
    .eq("workspace_id", p.workspaceId)
    .eq("status", "draft")
    .or(
      `generation.is.null,generation->>state.is.null,generation->>state.neq.generating,generation->>started_at.lt.${staleBefore}`,
    )
    .select(PAGE_REF_COLUMNS);
  if (error) throw new Error(`draft claim failed: ${error.message}`);
  return ((data ?? []) as PageRefRow[])[0] ?? null;
}

/** Record a failed run on the row it claimed (only while the claim is still this request's). */
async function markDraftFailed(
  workspaceId: string,
  pageId: string,
  generation: GenerationState,
  message: string,
): Promise<void> {
  const finished = new Date().toISOString();
  const { error } = await sb()
    .from("tenant_pages")
    .update({
      generation: {
        ...generation,
        state: "failed",
        error: message,
        finished_at: finished,
        elapsed_ms: Date.parse(finished) - Date.parse(generation.started_at),
      },
    })
    .eq("id", pageId)
    .eq("workspace_id", workspaceId)
    .eq("generation->>request_id", generation.request_id);
  if (error) {
    console.error(
      "[page-drafts] could not record the failure",
      JSON.stringify({ workspaceId, pageId, error: error.message }),
    );
  }
}

/** Remove a row this request created and nothing was written into. */
async function dropEmptyClaim(
  workspaceId: string,
  pageId: string,
  requestId: string,
): Promise<void> {
  const { error } = await sb()
    .from("tenant_pages")
    .delete()
    .eq("id", pageId)
    .eq("workspace_id", workspaceId)
    .eq("generation->>request_id", requestId)
    .is("body_markdown", null)
    .eq("status", "draft");
  if (error) {
    console.error(
      "[page-drafts] could not remove an empty claim",
      JSON.stringify({ workspaceId, pageId, error: error.message }),
    );
  }
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export type DraftRequest = {
  workspaceId: string;
  userId: string;
  requestId: string;
  tier: AiQualityTier;
  brief?: string | null;
} & (
  | {
      mode: "new";
      kind: PageKind;
      filter: unknown;
      title: string;
      slug?: string | null;
      description?: string | null;
    }
  | { mode: "regenerate"; pageId: string }
);

export type DraftResult =
  | {
      outcome: "ready";
      page: DraftPageRef;
      replayed: boolean;
      billing: ItemBillingStatus;
      creditsCharged: number;
    }
  | { outcome: "generating"; page: DraftPageRef }
  | { outcome: "failed"; page: DraftPageRef; error: string }
  /** A page already covers this target: open it instead (nothing generated). */
  | { outcome: "exists"; page: DraftPageRef };

export type DraftDeps = { db?: AiDb; transport?: OpenAiTransport; now?: () => number };

/** What a request id already has, as a result — no generation, no charge. */
async function replay(
  workspaceId: string,
  requestId: string,
  row: PageRefRow,
): Promise<DraftResult> {
  const page = toRef(row);
  const g = row.generation;
  const ours = g?.request_id === requestId;
  if (ours && g?.state === "generating") {
    return isGenerationActive(g)
      ? { outcome: "generating", page }
      : { outcome: "failed", page, error: DRAFT_INTERRUPTED_MESSAGE };
  }
  if (ours && g?.state === "failed") {
    return { outcome: "failed", page, error: g.error || GENERATION_UNAVAILABLE_MESSAGE };
  }
  let creditsCharged = 0;
  let billing: ItemBillingStatus = "free";
  const spend = await readSpendSettlement(workspaceId, requestId);
  if (spend?.status === "settled") {
    creditsCharged = spend.creditsCharged;
    billing = billingStatusFor({ settled: true, billing: spend.billing, creditsCharged });
  } else if (spend && (spend.status === "held" || spend.status === "called")) {
    billing = "pending";
  }
  return { outcome: "ready", page, replayed: true, billing, creditsCharged };
}

/**
 * Generation is part of a plan that may publish: an expired trial, a lapsed
 * subscription or a stale one does not draft pages it could never publish
 * (and does not spend on them). A read failure refuses (fails closed for cost).
 */
async function assertMayGenerate(workspaceId: string): Promise<void> {
  const { readEntitlement } = await import("@/lib/entitlements.functions");
  let ent: Awaited<ReturnType<typeof readEntitlement>>;
  try {
    ent = await readEntitlement(workspaceId);
  } catch (e) {
    console.error(
      "[page-drafts] entitlement read failed",
      workspaceId,
      e instanceof Error ? e.message : String(e),
    );
    throw new CustomerFacingError(GENERATION_UNAVAILABLE_MESSAGE);
  }
  if (!ent.canPublish) {
    throw new CustomerFacingError(
      ent.billingReason
        ? `${ent.billingReason} ${GENERATION_BILLING_MESSAGE}`
        : GENERATION_BILLING_MESSAGE,
    );
  }
}

/**
 * Write (or rewrite) one draft. The caller has authorised `userId` for the
 * workspace. Throws CustomerFacingError for refusals before anything was
 * claimed; returns { outcome: "failed" } for a failure after the claim (the
 * draft row, and any earlier content in it, is kept).
 */
export async function runPageDraft(req: DraftRequest, deps: DraftDeps = {}): Promise<DraftResult> {
  const ws = req.workspaceId;

  // 0. Replay: this request id already claimed or produced a page.
  const prior = await findPageByDraftRequest(ws, req.requestId);
  if (prior) return replay(ws, req.requestId, prior);

  // 1. What is being written — all checks that cost nothing.
  let kind: PageKind;
  let rawFilter: unknown;
  let title: string;
  let description: string;
  let baseSlug: string;
  let existingPage: PageRefRow | null = null;
  if (req.mode === "new") {
    kind = req.kind;
    rawFilter = req.filter;
    title = req.title.trim();
    description = (req.description ?? "").trim();
    baseSlug = validatePageRequest({ title, slug: req.slug }).baseSlug;
  } else {
    const { data, error } = await sb()
      .from("tenant_pages")
      .select(`${PAGE_REF_COLUMNS}, listing_filter, meta_description`)
      .eq("workspace_id", ws)
      .eq("id", req.pageId)
      .maybeSingle();
    if (error) throw new Error(`page read failed: ${error.message}`);
    if (!data) throw new CustomerFacingError("That page doesn't exist any more.");
    existingPage = data as PageRefRow;
    if (existingPage.status !== "draft") throw new CustomerFacingError(DRAFT_NOT_EDITABLE_MESSAGE);
    if (isGenerationActive(existingPage.generation))
      throw new CustomerFacingError(GENERATION_IN_PROGRESS_MESSAGE);
    const slugKind = existingPage.page_templates?.slug;
    if (!isPageKind(slugKind)) throw new CustomerFacingError(TEMPLATE_UNAVAILABLE_MESSAGE);
    kind = slugKind;
    rawFilter = (data as any).listing_filter;
    title = String(existingPage.title ?? "").trim();
    description = String((data as any).meta_description ?? "").trim();
    baseSlug = validatePageRequest({ title, slug: existingPage.slug }).baseSlug;
  }
  const template = await loadUsableTemplate(kind);
  const target = await checkTarget(ws, kind, rawFilter);
  if (target.problems.length > 0) throw new CustomerFacingError(target.problems.join(" "));

  // 1b. A page already owns this target: resume or review it, never duplicate.
  if (req.mode === "new" && target.targetKey) {
    const live = await findLivePageForTarget(ws, target.targetKey);
    if (live) return { outcome: "exists", page: toRef(live) };
  }

  // 2. The facts the page is written from (read now: a failed read costs nothing).
  const brief = (req.brief ?? existingPage?.generation?.brief ?? "")
    .trim()
    .slice(0, BRIEF_MAX_CHARS);
  const facts = await readGroundingFacts(ws, kind, target.filter, target.listingCount);
  const prompt = {
    instructions: PAGE_SYSTEM_PROMPT,
    input: buildPagePrompt({
      kind,
      title,
      description,
      brief,
      grounding: formatGroundingBlock(facts),
    }),
    minBodyChars: minBodyCharsFor(kind),
  };

  // 3. Pause switch (fails closed), plan state, who pays.
  const settings = await readPlatformSettings();
  if (settings.paused) throw new CustomerFacingError(GENERATION_PAUSED_MESSAGE);
  await assertMayGenerate(ws);
  const billing = await resolveBillingMode(ws, deps.db);

  // 4. The daily-cap slot for this request id (no cap for internal unlimited).
  const cap = effectiveDailyCap(settings.dailyCap, await isInternalWorkspace(ws, deps.db));
  const slot = await reserveGenerationSlot(ws, req.requestId, cap);
  if (slot === "cap_reached") throw new CustomerFacingError(dailyCapMessage(settings.dailyCap, 0));
  if (slot === "in_progress") throw new CustomerFacingError(GENERATION_IN_PROGRESS_MESSAGE);
  if (slot === "consumed") {
    const again = await findPageByDraftRequest(ws, req.requestId);
    if (again) return replay(ws, req.requestId, again);
    throw new CustomerFacingError(GENERATION_ALREADY_USED_MESSAGE);
  }

  // 5. Claim the row (the slot is ours: give it back on any refusal here).
  const now = deps.now ?? Date.now;
  const generation: GenerationState = {
    state: "generating",
    request_id: req.requestId,
    tier: req.tier,
    source: "builder",
    started_at: new Date(now()).toISOString(),
    ...(brief ? { brief } : {}),
    ...(description ? { description } : {}),
  };
  let claimed: PageRefRow;
  let created = false;
  try {
    if (req.mode === "new") {
      const r = await claimNewDraft({
        workspaceId: ws,
        template,
        kind,
        rawFilter,
        filter: target.filter,
        targetKey: target.targetKey,
        title,
        description,
        baseSlug,
        generation,
      });
      if ("existing" in r) {
        await releaseGenerationSlot(ws, req.requestId);
        return { outcome: "exists", page: toRef(r.existing) };
      }
      claimed = r.claimed;
      created = r.created;
    } else {
      const r = await claimExistingDraft({ workspaceId: ws, pageId: req.pageId, generation });
      if (!r) {
        await releaseGenerationSlot(ws, req.requestId);
        throw new CustomerFacingError(GENERATION_IN_PROGRESS_MESSAGE);
      }
      claimed = r;
    }
  } catch (e) {
    await releaseGenerationSlot(ws, req.requestId);
    throw e;
  }

  // 6. The metered call; deliver fills the claimed row before settlement.
  let slotMarked = false;
  let gen: GeneratedContent;
  let delivered: PageRefRow | null = null;
  const claimedVersion = Number(claimed.content_version) || 1;
  try {
    gen = await generatePageContent({
      workspaceId: ws,
      userId: req.userId,
      requestId: req.requestId,
      source: "quick_page",
      tier: req.tier,
      title,
      description,
      topic: title,
      prompt,
      billing,
      beforeProviderCall: async () => {
        await markGenerationProviderCalled(ws, req.requestId);
        slotMarked = true;
      },
      deliver: async (draft) => {
        const finished = new Date(now()).toISOString();
        const seoTitle = draft.seo_title.trim().slice(0, 70) || title.slice(0, 70);
        const seoDescription = draft.seo_description.trim().slice(0, 320) || description || null;
        const suggested = draft.title.trim();
        const { data, error } = await sb()
          .from("tenant_pages")
          .update({
            title,
            h1: title,
            seo_title: seoTitle,
            meta_description: seoDescription,
            body_markdown: draft.body_markdown.trim(),
            generation_request_id: req.requestId,
            generation_billing_mode: draft.billingMode,
            content_version: claimedVersion + 1,
            generation: {
              ...generation,
              state: "ready",
              finished_at: finished,
              elapsed_ms: Date.parse(finished) - Date.parse(generation.started_at),
              ...(suggested && suggested !== title
                ? { suggested_title: suggested.slice(0, 140) }
                : {}),
            },
          })
          .eq("id", claimed.id)
          .eq("workspace_id", ws)
          .eq("status", "draft")
          .eq("generation->>request_id", req.requestId)
          .select(PAGE_REF_COLUMNS);
        if (error) throw new Error(`draft save failed: ${error.message}`);
        delivered = ((data ?? []) as PageRefRow[])[0] ?? null;
        if (!delivered)
          throw new Error("draft save failed: the draft changed while it was being written");
      },
      deps: { db: deps.db, transport: deps.transport },
    });
  } catch (e) {
    if (!slotMarked) await releaseGenerationSlot(ws, req.requestId);
    const message = customerMessage(e, GENERATION_UNAVAILABLE_MESSAGE);
    if (!slotMarked && created) {
      // Refused before the provider was called: nothing was written, so the
      // empty row this request created goes, and the refusal is the answer.
      await dropEmptyClaim(ws, claimed.id, req.requestId);
      throw e;
    }
    await markDraftFailed(ws, claimed.id, generation, message);
    const page = toRef({
      ...claimed,
      generation: { ...generation, state: "failed", error: message },
    });
    return { outcome: "failed", page, error: message };
  }

  // Record usage and spend on the draft for the owner (best effort).
  const saved = delivered as PageRefRow | null;
  if (!saved) throw new Error("page draft: generation returned without a saved draft");
  const usageNote = {
    ...(saved.generation ?? generation),
    model: gen.model,
    input_tokens: gen.usage?.inputTokens,
    output_tokens: gen.usage?.outputTokens,
    credits_charged: gen.settlement.creditsCharged,
    cost_micros: gen.settlement.costMicros,
    billing: billingStatusFor(gen.settlement),
  };
  const { error: noteErr } = await sb()
    .from("tenant_pages")
    .update({ generation: usageNote })
    .eq("id", saved.id)
    .eq("workspace_id", ws)
    .eq("generation->>request_id", req.requestId);
  if (noteErr) console.error("[page-drafts] usage note failed", saved.id, noteErr.message);

  return {
    outcome: "ready",
    page: toRef({ ...saved, generation: usageNote as GenerationState }),
    replayed: false,
    billing: billingStatusFor(gen.settlement),
    creditsCharged: gen.settlement.creditsCharged,
  };
}

/** Status of a request (the builder polls this while a draft is written). */
export async function draftStatus(
  workspaceId: string,
  requestId: string,
): Promise<DraftResult | null> {
  const row = await findPageByDraftRequest(workspaceId, requestId);
  return row ? replay(workspaceId, requestId, row) : null;
}

/** "Pool in Austin, TX" — the default H1 for a target (the owner can change it). */
export function suggestedTitle(kind: PageKind, filter: ResolvedFilter): string {
  const cat = humanLabel(filter.labels.category);
  const place = placeLabel(filter.labels);
  if (kind === "city_hub") return cat ? `${cat} in ${place}` : `Rentals in ${place}`;
  if (kind === "category_page")
    return place ? `${cat ?? "Listings"} in ${place}` : `${cat ?? "Listings"}`;
  return "";
}

/** "pool-spa" → "Pool spa": marketplaces often store category ids, not names. */
export function humanLabel(raw: string | null | undefined): string | null {
  const s = String(raw ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
