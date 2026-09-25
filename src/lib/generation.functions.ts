import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import { modelForTier, tierForModel } from "@/lib/ai/models";
import { SPEND_REFUSAL_CODES } from "@/lib/ai/spend-refusals";
import { getPageBuilderContext } from "@/lib/page-builder.functions";
import {
  ATTEMPTS_EXHAUSTED_MESSAGE,
  CustomerFacingError,
  GENERATION_DEFAULT_TIER,
  GENERATION_PAUSED_MESSAGE,
  GENERATION_TIERS,
  GENERATION_TIER_OPTIONS,
  GENERATION_UNAVAILABLE_MESSAGE,
  MAX_ITEM_ATTEMPTS,
  STALE_RUNNING_MS,
  attemptsExhausted,
  batchAttemptRequestId,
  billingStatusFor,
  buildCityBrief,
  checkStoredPageContract,
  contractFailureMessage,
  countConsumedLast24h,
  customerMessage,
  dailyCapMessage,
  dailyCapRemaining,
  effectiveDailyCap,
  findExistingCityPage,
  generatePageContent,
  isInternalWorkspace,
  isStaleRunning,
  markGenerationProviderCalled,
  persistGeneratedPage,
  planJobItems,
  readPlatformSettings,
  releaseGenerationSlot,
  reserveGenerationSlot,
  resolveBillingMode,
  selectTargets,
  type GeneratedContent,
  type GenerationSlot,
  type GenerationTarget,
  type ItemBillingStatus,
  type PersistedPage,
  type ResolvedBilling,
} from "@/lib/generation.server";

/**
 * Batch generation ("Generate Content"). The browser creates a job, then
 * drives processGenerationItem one item at a time and shows live progress —
 * no queue worker, no cron, nothing that can silently spend money while the
 * customer is away. Every step is idempotent by target key so a closed tab
 * or a retry never produces a duplicate page or a second charge.
 *
 * Batch items are ALWAYS drafts. Publishing is a separate button that runs
 * every draft through the page contract and the atomic entitlement gate.
 *
 * Every handler answers with customer-written sentences only: a thrown
 * database or provider error is logged and replaced (customerMessage) at the
 * boundary, and every input schema is strict (a body carrying a model or any
 * provider parameter is a validation error).
 */

const sb = () => supabaseAdmin as any;

export const DEFAULT_MIN_LISTINGS = 3;

/** Run a handler body; anything but a CustomerFacingError reaches the browser as the generic sentence. */
async function customerSafe<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new Error(customerMessage(e, GENERATION_UNAVAILABLE_MESSAGE));
  }
}

export type GenerationJobRow = {
  id: string;
  workspace_id: string;
  requested_by: string | null;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  model: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

export type GenerationItemRow = {
  id: string;
  job_id: string;
  workspace_id: string;
  target_key: string;
  target: { city: string; state: string | null; listingCount: number; categoryPlural: string };
  slug: string | null;
  page_id: string | null;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  error: string | null;
  attempts: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  credits_charged: number;
  billing_status: ItemBillingStatus;
  created_at: string;
  updated_at: string;
};

export type TargetListing = GenerationTarget & {
  /** A finished batch item with a live draft exists for this city. */
  alreadyGenerated: boolean;
  /** Status of the batch item for this city, if any. */
  itemStatus: GenerationItemRow["status"] | null;
  pageId: string | null;
  /** The item hit MAX_ITEM_ATTEMPTS without producing a page. */
  attemptsExhausted: boolean;
};

/** City gaps from synced published listings, via the Page Builder's view. */
async function loadTargets(
  workspaceId: string,
  minListings: number,
): Promise<{
  targets: GenerationTarget[];
  syncedListings: number;
  dominantCategory: string | null;
}> {
  const ctx = await getPageBuilderContext({ data: { workspaceId } });
  return {
    targets: selectTargets({ cities: ctx.cities }, minListings),
    syncedListings: ctx.stats.syncedListings,
    dominantCategory: ctx.dominantCategory,
  };
}

async function loadJob(workspaceId: string, jobId: string) {
  const [{ data: job, error: jErr }, { data: items, error: iErr }] = await Promise.all([
    sb()
      .from("generation_jobs")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("id", jobId)
      .maybeSingle(),
    sb()
      .from("generation_items")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("job_id", jobId)
      .order("created_at", { ascending: true }),
  ]);
  if (jErr) throw new Error(jErr.message);
  if (iErr) throw new Error(iErr.message);
  if (!job) throw new CustomerFacingError("That generation job was not found.");
  return { job: job as GenerationJobRow, items: (items ?? []) as GenerationItemRow[] };
}

/**
 * Roll the job status up from its items once nothing is left to do. A job
 * the customer cancelled stays cancelled — the item that was mid-flight when
 * they pressed Stop still finishes, and must not flip the job back to done.
 */
async function settleJobStatus(workspaceId: string, jobId: string) {
  const { data: items } = await sb()
    .from("generation_items")
    .select("status")
    .eq("workspace_id", workspaceId)
    .eq("job_id", jobId);
  const rows = (items ?? []) as Array<{ status: string }>;
  const open = rows.some((r) => r.status === "pending" || r.status === "running");
  if (open) return;
  const anyDone = rows.some((r) => r.status === "done");
  await sb()
    .from("generation_jobs")
    .update({ status: anyDone ? "done" : "failed", finished_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", jobId)
    .in("status", ["queued", "running"]);
}

async function freshItem(itemId: string): Promise<GenerationItemRow> {
  const { data, error } = await sb().from("generation_items").select("*").eq("id", itemId).single();
  if (error) throw new Error(error.message);
  return data as GenerationItemRow;
}

/**
 * A PRE-claim write that lands only while the item is still exactly as the
 * caller read it (same status, same attempts). A driver that claimed the item
 * meanwhile bumped `attempts`, so this matches zero rows and its live claim
 * is left alone: a refusal or a cancel from a second driver must never void
 * someone else's in-flight work — their fenced page-link write would then
 * find no row and the page they wrote would be orphaned and unbilled.
 * Returns whether the write landed.
 */
async function markItemIfUnchanged(
  row: { id: string; status: string; attempts: number },
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await sb()
    .from("generation_items")
    .update(patch)
    .eq("id", row.id)
    .eq("status", row.status)
    .eq("attempts", row.attempts)
    .select("id");
  if (error) throw new Error(error.message);
  return !!data && data.length > 0;
}

class LostClaimError extends Error {
  constructor() {
    super("Another run has taken over this item");
    this.name = "LostClaimError";
  }
}

/**
 * A write that only lands while THIS run still holds the claim. `attempts`
 * is the fencing token: a stale-reclaim by another driver increments it, so
 * every later write from the old driver matches zero rows and stops here
 * instead of overwriting the new driver's page_id.
 */
async function markItemFenced(
  itemId: string,
  attempts: number,
  patch: Record<string, unknown>,
): Promise<void> {
  const { data, error } = await sb()
    .from("generation_items")
    .update(patch)
    .eq("id", itemId)
    .eq("status", "running")
    .eq("attempts", attempts)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new LostClaimError();
}

// ---------------------------------------------------------------------------
// Server functions
// ---------------------------------------------------------------------------

export const ListGenerationTargetsInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    minListings: z.number().int().min(1).max(100).default(DEFAULT_MIN_LISTINGS),
  })
  .strict();

export const listGenerationTargets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ListGenerationTargetsInputSchema.parse(d))
  .handler(async ({ data, context }) => customerSafe(async () => {
    await assertWorkspaceMember(data.workspaceId, context.userId);

    const [{ targets, syncedListings, dominantCategory }, settings, consumed24h, internal] =
      await Promise.all([
        loadTargets(data.workspaceId, data.minListings),
        readPlatformSettings(),
        countConsumedLast24h(data.workspaceId),
        isInternalWorkspace(data.workspaceId),
      ]);
    // The founder / internal unlimited entitlement has no daily cap.
    const dailyCap = effectiveDailyCap(settings.dailyCap, internal);

    // Only the items for the cities on screen (at most a few dozen), and only
    // the columns the listing needs — never the whole table.
    const keys = targets.map((t) => t.targetKey);
    let items: Array<{
      target_key: string;
      status: GenerationItemRow["status"];
      page_id: string | null;
      attempts: number;
    }> = [];
    if (keys.length) {
      const { data: rows, error } = await sb()
        .from("generation_items")
        .select("target_key, status, page_id, attempts")
        .eq("workspace_id", data.workspaceId)
        .in("target_key", keys)
        .limit(keys.length);
      if (error) throw new Error(error.message);
      items = rows ?? [];
    }
    const byKey = new Map(items.map((i) => [i.target_key, i]));

    const list: TargetListing[] = targets.map((t) => {
      const existing = byKey.get(t.targetKey);
      return {
        ...t,
        // A done item whose draft was deleted (page_id nulled by the FK) is
        // generatable again — "done" alone is not "has a page".
        alreadyGenerated: existing?.status === "done" && !!existing.page_id,
        itemStatus: existing?.status ?? null,
        pageId: existing?.page_id ?? null,
        attemptsExhausted:
          !!existing && existing.status !== "done" && attemptsExhausted(existing.attempts),
      };
    });

    return {
      targets: list,
      syncedListings,
      dominantCategory,
      minListings: data.minListings,
      paused: settings.paused,
      dailyCap,
      remainingToday: dailyCapRemaining(dailyCap, consumed24h),
      /** No daily cap: the workspace holds the founder / internal unlimited entitlement. */
      internalUnlimited: internal,
      // Quality tiers, never model names: the server maps a tier to a model.
      tiers: GENERATION_TIER_OPTIONS,
      defaultTier: GENERATION_DEFAULT_TIER,
    };
  }));

export const StartGenerationJobInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    targetKeys: z.array(z.string().min(1).max(300)).min(1).max(200),
    // A quality tier, never a model. The job stores the model the SERVER
    // resolved from it; runItem accepts nothing outside the allowlist.
    quality: z.enum(GENERATION_TIERS).default(GENERATION_DEFAULT_TIER),
    minListings: z.number().int().min(1).max(100).default(DEFAULT_MIN_LISTINGS),
  })
  .strict();

export type StartGenerationJobInput = z.infer<typeof StartGenerationJobInputSchema>;

export const startGenerationJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => StartGenerationJobInputSchema.parse(d))
  .handler(async ({ data, context }) => customerSafe(async () => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    return startJob(data, context.userId);
  }));

/**
 * The job start behind startGenerationJob; the caller has checked membership.
 * The job records the model the SERVER resolved from the requested tier
 * (modelForTier) — the value every item of the job then runs on (runItem
 * maps it back through tierForModel and refuses anything off the allowlist).
 */
async function startJob(data: StartGenerationJobInput, userId: string) {
  const settings = await readPlatformSettings();
  if (settings.paused) {
    throw new CustomerFacingError("Generation is paused platform-wide right now.");
  }
  const model = modelForTier(data.quality);

  const { targets, dominantCategory } = await loadTargets(data.workspaceId, data.minListings);
  const targetByKey = new Map(targets.map((t) => [t.targetKey, t]));
  const unknown = data.targetKeys.filter((k) => !targetByKey.has(k));
  if (unknown.length) {
    throw new CustomerFacingError(
      "Some of those cities are no longer eligible (a page may have been created since). Refresh the list and try again.",
    );
  }

  const { data: existing, error: exErr } = await sb()
    .from("generation_items")
    .select("target_key, status, page_id, updated_at, attempts")
    .eq("workspace_id", data.workspaceId)
    .in("target_key", data.targetKeys);
  if (exErr) throw new Error(exErr.message);
  const plan = planJobItems(data.targetKeys, existing ?? []);
  const newWork = plan.create.length + plan.reattach.length;
  if (newWork === 0) {
    if (plan.inProgress.length) {
      throw new CustomerFacingError(
        "Those cities are being written right now in another session. Give it a few minutes, then refresh.",
      );
    }
    if (plan.exhausted.length) {
      throw new CustomerFacingError(
        `Those cities were given up on after ${MAX_ITEM_ATTEMPTS} failed attempts each. Contact support if you need them written.`,
      );
    }
    throw new CustomerFacingError("Every city you picked already has a generated draft. Nothing to do.");
  }

  // Sizing only: the job may not ask for more pages than today's cap has
  // left. The cap itself is enforced per item ATTEMPT — each one reserves
  // its own slot right before its claim (reserve_generation_slot) — so two
  // tabs starting jobs at once cannot overrun it: the items beyond the cap
  // are refused when they run, without consuming an attempt.
  const [consumed24h, internal] = await Promise.all([
    countConsumedLast24h(data.workspaceId),
    isInternalWorkspace(data.workspaceId),
  ]);
  const remaining = dailyCapRemaining(effectiveDailyCap(settings.dailyCap, internal), consumed24h);
  if (newWork > remaining) {
    throw new CustomerFacingError(dailyCapMessage(settings.dailyCap, remaining));
  }

  const { data: job, error: jobErr } = await sb()
    .from("generation_jobs")
    .insert({
      workspace_id: data.workspaceId,
      requested_by: userId,
      status: "queued",
      model,
    })
    .select("*")
    .single();
  if (jobErr) throw new Error(jobErr.message);

  const categoryPlural = dominantCategory || "listings";
  if (plan.create.length) {
    const rows = plan.create.map((key) => {
      const t = targetByKey.get(key)!;
      return {
        job_id: job.id,
        workspace_id: data.workspaceId,
        target_key: key,
        target: { city: t.city, state: t.state, listingCount: t.listingCount, categoryPlural },
        status: "pending",
      };
    });
    // UNIQUE (workspace_id, target_key) makes a concurrent double-click
    // safe: the second insert conflicts and is ignored, the row it collided
    // with is picked up by the job read below only if it belongs to this job.
    const { error: insErr } = await sb()
      .from("generation_items")
      .upsert(rows, { onConflict: "workspace_id,target_key", ignoreDuplicates: true });
    if (insErr) throw new Error(insErr.message);
  }

  // Re-attaching is guarded by the same state the plan saw, so an item that
  // moved on between the read and this write (another tab just claimed it)
  // is left alone. A live `running` row is NEVER reset to pending: that is
  // precisely how two drivers came to write the same city twice.
  const reattachPatch = { job_id: job.id, status: "pending", error: null };
  if (plan.reattachBy.idle.length) {
    const { error } = await sb()
      .from("generation_items")
      .update(reattachPatch)
      .eq("workspace_id", data.workspaceId)
      .in("target_key", plan.reattachBy.idle)
      .in("status", ["pending", "failed", "skipped"])
      .lt("attempts", MAX_ITEM_ATTEMPTS);
    if (error) throw new Error(error.message);
  }
  if (plan.reattachBy.staleRunning.length) {
    const cutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
    const { error } = await sb()
      .from("generation_items")
      .update(reattachPatch)
      .eq("workspace_id", data.workspaceId)
      .in("target_key", plan.reattachBy.staleRunning)
      .eq("status", "running")
      .lt("updated_at", cutoff);
    if (error) throw new Error(error.message);
  }
  if (plan.reattachBy.pageDeleted.length) {
    // The draft is gone; this is a fresh life for the item, so its attempt
    // budget and billing record start over (the credit ledger keeps history).
    const { error } = await sb()
      .from("generation_items")
      .update({
        ...reattachPatch,
        attempts: 0,
        slug: null,
        page_id: null,
        prompt_tokens: null,
        completion_tokens: null,
        credits_charged: 0,
        billing_status: "pending",
      })
      .eq("workspace_id", data.workspaceId)
      .in("target_key", plan.reattachBy.pageDeleted)
      .eq("status", "done")
      .is("page_id", null);
    if (error) throw new Error(error.message);
  }

  const loaded = await loadJob(data.workspaceId, job.id);
  return {
    ...loaded,
    alreadyDone: plan.alreadyDone,
    inProgress: plan.inProgress,
    exhausted: plan.exhausted,
  };
}

const jobInput = (d: unknown) =>
  z.object({ workspaceId: workspaceIdSchema, jobId: z.string().uuid() }).strict().parse(d);

export const getGenerationJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(jobInput)
  .handler(async ({ data, context }) => customerSafe(async () => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    return loadJob(data.workspaceId, data.jobId);
  }));

/**
 * "Stop after this one". The job is marked cancelled and every item still
 * waiting its turn is skipped (a waiting item holds no daily-cap slot: slots
 * are taken per attempt, right before the claim). The item being
 * written right now finishes normally — its page is already paid for by the
 * time this lands — and settleJobStatus leaves a cancelled job alone.
 */
export const cancelGenerationJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(jobInput)
  .handler(async ({ data, context }) => customerSafe(async () => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const { error: jobErr } = await sb()
      .from("generation_jobs")
      .update({ status: "cancelled", finished_at: new Date().toISOString() })
      .eq("workspace_id", data.workspaceId)
      .eq("id", data.jobId)
      .in("status", ["queued", "running"]);
    if (jobErr) throw new Error(jobErr.message);
    const { error: itemErr } = await sb()
      .from("generation_items")
      .update({ status: "skipped", error: "Job was cancelled" })
      .eq("workspace_id", data.workspaceId)
      .eq("job_id", data.jobId)
      .eq("status", "pending");
    if (itemErr) throw new Error(itemErr.message);
    return loadJob(data.workspaceId, data.jobId);
  }));

/**
 * One unit of work. Safe to call repeatedly for the same item:
 *   done                → returned unchanged, nothing charged
 *   skipped             → returned unchanged
 *   running (fresh)     → returned unchanged, someone else has it
 *   running (stale 3m+) → treated as abandoned and taken over
 *   pending / failed    → claimed, then:
 *       page already linked → marked done (no generation; the attempt that
 *                             wrote it was settled when it ran)
 *       page exists for the city → link it, mark done (no generation, no charge)
 *       otherwise → reserve, generate, settle, persist DRAFT, link page
 *
 * Policy gates (pause, attempt ceiling, the job's model, who pays, the daily
 * cap) run BEFORE the claim and never consume an attempt: they cost nothing
 * and clear on their own. The spend refusals that can only come after the
 * claim — no funds, the workspace's or the platform's daily AI cap, the kill
 * switch, the rate limit, a refused mark (SPEND_REFUSAL_CODES) — do not
 * consume one either: the failure write puts the attempt back (round-4
 * correctness M1). The attempt counter is reserved for work that reached, or
 * may have reached, the provider.
 *
 * The daily cap is a RESERVATION per attempt: an attempt that can reach the
 * provider first takes a slot through reserve_generation_slot under an id
 * unique to that attempt (batchAttemptRequestId) — the SAME id its spend hold
 * is taken under — so the slot is counted for 24 hours no matter what later
 * happens to the item or its page. The slot is given back only when this run
 * ends without marking it (a refusal, a lost claim, an existing page linked
 * instead, a failure before the call).
 */
async function runItem(
  workspaceId: string,
  userId: string,
  itemId: string,
  opts: { onlyIfFailed?: boolean } = {},
): Promise<{ item: GenerationItemRow; changed: boolean }> {
  const { data: item, error } = await sb()
    .from("generation_items")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", itemId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!item) throw new CustomerFacingError("That generation item was not found.");
  const row = item as GenerationItemRow;

  if (row.status === "done") return { item: row, changed: false };
  if (row.status === "skipped") return { item: row, changed: false };
  if (opts.onlyIfFailed && row.status !== "failed") return { item: row, changed: false };
  if (row.status === "running" && !isStaleRunning(row.updated_at)) {
    return { item: row, changed: false };
  }

  const { data: job } = await sb()
    .from("generation_jobs")
    .select("id, status, model")
    .eq("id", row.job_id)
    .maybeSingle();
  if (job?.status === "cancelled") {
    // Fenced on the state this run read: if another driver claimed the item
    // meanwhile, nothing is written and its claim stands.
    const changed = await markItemIfUnchanged(row, { status: "skipped", error: "Job was cancelled" });
    return { item: await freshItem(row.id), changed };
  }

  // ---- Policy gates: no attempt consumed, nothing claimed. ----
  // Same fence as the cancel above: a refusal lands only on the row as read.
  const refuse = async (message: string) => {
    const changed = await markItemIfUnchanged(row, { status: "failed", error: message });
    return { item: await freshItem(row.id), changed };
  };

  const settings = await readPlatformSettings();
  if (settings.paused) return refuse(GENERATION_PAUSED_MESSAGE);
  // The ceiling bounds GENERATION spend. An item whose draft already exists
  // has nothing left to generate, so it is never stranded by its count.
  if (!row.page_id && attemptsExhausted(row.attempts)) return refuse(ATTEMPTS_EXHAUSTED_MESSAGE);

  // The job records the model the server resolved when it started; anything
  // outside the allowlist is refused, never mapped to some other model.
  const tier = job?.model ? tierForModel(job.model) : GENERATION_DEFAULT_TIER;
  if (!tier) {
    console.error("[generation] job model outside the allowlist", row.job_id, job?.model);
    return refuse(GENERATION_UNAVAILABLE_MESSAGE);
  }

  // ---- Who pays, then the daily-cap slot for THIS attempt, before the claim. ----
  let billing: ResolvedBilling | null = null;
  let slotId: string | null = null;
  if (!row.page_id) {
    try {
      billing = await resolveBillingMode(workspaceId);
    } catch (e) {
      // Only a customer-written refusal (no key) is stored on the item; a
      // database error is logged and replaced. Nothing was reserved.
      return refuse(customerMessage(e, GENERATION_UNAVAILABLE_MESSAGE).slice(0, 300));
    }
    // One slot per provider call, under an id unique to the attempt the claim
    // below will make: two drivers racing for the same attempt compute the
    // same id and only one is granted it. The founder / internal unlimited
    // entitlement lifts the cap, never the slot.
    const attemptId = await batchAttemptRequestId(row);
    const cap = effectiveDailyCap(settings.dailyCap, await isInternalWorkspace(workspaceId));
    let slot: GenerationSlot;
    try {
      slot = await reserveGenerationSlot(workspaceId, attemptId, cap);
    } catch (e) {
      return refuse(customerMessage(e, GENERATION_UNAVAILABLE_MESSAGE).slice(0, 300));
    }
    if (slot === "cap_reached") return refuse(dailyCapMessage(settings.dailyCap, 0));
    if (slot !== "reserved") {
      // 'in_progress' / 'consumed': another driver holds (or already spent)
      // this very attempt. It records the outcome; this run touches nothing.
      return { item: await freshItem(row.id), changed: false };
    }
    slotId = attemptId;
  }
  // Only this run was granted the slot, and it gives it back only on a way
  // out that never marked it. release_generation_slot frees an unmarked row
  // only, so a spent slot cannot come back even by mistake.
  const releaseSlot = async () => {
    if (slotId) await releaseGenerationSlot(workspaceId, slotId);
  };

  // ---- Claim with an optimistic guard so two tabs cannot both run the same item. ----
  const { data: claimed, error: claimErr } = await sb()
    .from("generation_items")
    .update({ status: "running", attempts: row.attempts + 1, error: null })
    .eq("id", row.id)
    .eq("status", row.status)
    .eq("attempts", row.attempts)
    .select("*")
    .maybeSingle();
  if (claimErr) {
    await releaseSlot();
    throw new Error(claimErr.message);
  }
  if (!claimed) {
    // The item moved on since it was read (cancelled, re-attached, claimed):
    // this run generates nothing, so its slot goes back.
    await releaseSlot();
    return { item: await freshItem(row.id), changed: false };
  }
  const token = (claimed as GenerationItemRow).attempts;

  if (job?.status === "queued") {
    await sb().from("generation_jobs").update({ status: "running" }).eq("id", row.job_id);
  }

  const target = row.target;
  let slotMarked = false;
  let gen: GeneratedContent | null = null;
  let saved: PersistedPage | null = null;
  try {
    if (row.page_id) {
      // The draft exists (a previous run died between linking and finishing).
      // Its attempt was settled when it called the provider: nothing is owed
      // and nothing is generated again.
      await markItemFenced(row.id, token, { status: "done", error: null });
    } else {
      const existing = await findExistingCityPage(workspaceId, target.city, target.state);
      if (existing) {
        // Same predicate the eligibility list uses. Link, do not duplicate
        // and do not charge: nothing was generated.
        await markItemFenced(row.id, token, {
          status: "done",
          page_id: existing.id,
          slug: existing.slug,
          credits_charged: 0,
          billing_status: "free",
          error: null,
        });
        // No provider call came of this attempt: its slot goes back.
        await releaseSlot();
      } else {
        const brief = buildCityBrief({
          city: target.city,
          state: target.state,
          categoryPlural: target.categoryPlural,
        });
        if (!slotId || !billing) throw new Error("batch attempt reached generation without a slot");
        const attemptSlot = slotId;
        // The spend hold is taken under the attempt's id; the slot is marked
        // immediately before the provider call, then the hold. From there the
        // attempt is settled whatever happens, never released.
        gen = await generatePageContent({
          workspaceId,
          userId,
          requestId: attemptSlot,
          source: "batch_generation",
          tier,
          title: brief.title,
          description: brief.description,
          topic: brief.topic,
          city: target.city,
          state: target.state,
          categoryPlural: target.categoryPlural,
          billing,
          beforeProviderCall: async () => {
            await markGenerationProviderCalled(workspaceId, attemptSlot);
            slotMarked = true;
          },
          // The draft is saved before the call is settled: the customer is
          // charged only for a page that exists.
          deliver: async (draft) => {
            saved = await persistGeneratedPage({
              workspaceId,
              generated: draft,
              requestedTitle: brief.title,
              requestedDescription: brief.description,
              city: target.city,
              state: target.state,
              categoryPlural: target.categoryPlural,
            });
          },
        });
        const page = saved as PersistedPage | null;
        if (!page) throw new Error("batch item: generation returned without a saved page");
        // Link the page with what the settlement charged, and insist the
        // write landed. If the request dies after this line the item still
        // knows its page, so a re-claim finishes it instead of writing a
        // second one.
        await markItemFenced(row.id, token, {
          status: "done",
          page_id: page.id,
          slug: page.slug,
          prompt_tokens: gen.usage?.inputTokens ?? null,
          completion_tokens: gen.usage?.outputTokens ?? null,
          credits_charged: gen.settlement.creditsCharged,
          billing_status: billingStatusFor(gen.settlement),
          error: null,
        });
      }
    }
  } catch (e) {
    if (!slotMarked) {
      // Failed before the provider could be called: nothing was spent (the
      // spend hold, if any, was released by the spend flow).
      await releaseSlot();
    }
    if (e instanceof LostClaimError) {
      // The row belongs to another run now; it will record its own outcome.
      console.error("[generation] claim lost", row.id);
      return { item: await freshItem(row.id), changed: false };
    }
    // What the item records is what the customer reads: provider and policy
    // refusals verbatim, anything else (PostgREST text, constraint names)
    // replaced by the generic sentence. customerMessage logs the raw error.
    const msg = customerMessage(e, GENERATION_UNAVAILABLE_MESSAGE);
    console.error("[generation] item failed", row.id, msg);
    // A spend refusal before the provider call (the slot was never marked,
    // and the refusal left the attempt's request id unspent) puts the attempt
    // back: it cost nothing, so it must not bring the item closer to "gave
    // up after 3 attempts". Fenced on the claim's token like every write.
    const refusedBeforeCall =
      !slotMarked && e instanceof CustomerFacingError && !!e.code && SPEND_REFUSAL_CODES.has(e.code);
    const { error: failErr } = await sb()
      .from("generation_items")
      .update({
        status: "failed",
        error: msg.slice(0, 300),
        ...(refusedBeforeCall ? { attempts: token - 1 } : {}),
      })
      .eq("id", row.id)
      .eq("status", "running")
      .eq("attempts", token);
    if (failErr) {
      // The item stays 'running' until the stale window reclaims it; that is
      // recoverable, a silent swallow is not.
      console.error("[generation] could not record item failure", row.id, failErr.message);
    }
  }

  await settleJobStatus(workspaceId, row.job_id);
  return { item: await freshItem(row.id), changed: true };
}

export const GenerationItemInputSchema = z
  .object({ workspaceId: workspaceIdSchema, itemId: z.string().uuid() })
  .strict();
const itemInput = (d: unknown) => GenerationItemInputSchema.parse(d);

export const processGenerationItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(itemInput)
  .handler(async ({ data, context }) => customerSafe(async () => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    return runItem(data.workspaceId, context.userId, data.itemId);
  }));

export const retryGenerationItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(itemInput)
  .handler(async ({ data, context }) => customerSafe(async () => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    return runItem(data.workspaceId, context.userId, data.itemId, { onlyIfFailed: true });
  }));

export type PublishOutcome = "published" | "already_published" | "draft" | "limit" | "error";

export type PublishResult = {
  itemId: string;
  pageId: string;
  slug: string | null;
  title: string | null;
  outcome: PublishOutcome;
  message: string;
};

/**
 * Take every finished draft in the job through the page contract and then
 * the atomic entitlement gate, one page at a time so each result is precise.
 * A page that fails the contract stays a draft with the reason; once the plan
 * limit is hit the rest are reported as such without further calls.
 */
export const publishGeneratedPages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(jobInput)
  .handler(async ({ data, context }) => customerSafe(async () => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const { items } = await loadJob(data.workspaceId, data.jobId);
    const { publishPagesAtomically, pageLimitMessage } =
      await import("@/lib/entitlements.functions");

    const results: PublishResult[] = [];
    let limitHit = false;
    let limitMsg = "";
    for (const item of items) {
      if (item.status !== "done" || !item.page_id) continue;
      const base = { itemId: item.id, pageId: item.page_id, slug: item.slug, title: null };
      try {
        const check = await checkStoredPageContract(data.workspaceId, item.page_id);
        const withTitle = { ...base, slug: check.slug, title: check.title };
        if (check.status === "published") {
          results.push({ ...withTitle, outcome: "already_published", message: "Already live." });
          continue;
        }
        if (!check.ok) {
          results.push({ ...withTitle, outcome: "draft", message: contractFailureMessage(check) });
          continue;
        }
        if (limitHit) {
          results.push({ ...withTitle, outcome: "limit", message: limitMsg });
          continue;
        }
        const gate = await publishPagesAtomically(data.workspaceId, [item.page_id]);
        if (gate.published === 0) {
          limitHit = true;
          limitMsg = `${pageLimitMessage(gate.limit)} The page stays a draft.`;
          results.push({ ...withTitle, outcome: "limit", message: limitMsg });
        } else {
          results.push({ ...withTitle, outcome: "published", message: "Published." });
        }
      } catch (e) {
        // Never the database's text: the customer reads one plain sentence.
        const msg = customerMessage(e, "Could not publish this page right now. Try again in a minute.");
        results.push({ ...base, outcome: "error", message: msg.slice(0, 300) });
      }
    }

    return {
      results,
      published: results.filter((r) => r.outcome === "published").length,
      keptAsDraft: results.filter((r) => r.outcome === "draft").length,
      limitReached: limitHit,
    };
  }));
