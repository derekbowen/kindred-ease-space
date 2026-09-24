import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import { resolvePlatformModel } from "@/lib/ai-pricing";
import { getPageBuilderContext } from "@/lib/page-builder.functions";
import {
  ATTEMPTS_EXHAUSTED_MESSAGE,
  GENERATION_DEFAULT_MODEL,
  GENERATION_MODEL_IDS,
  GENERATION_MODEL_OPTIONS,
  GENERATION_PAUSED_MESSAGE,
  GENERATION_UNAVAILABLE_MESSAGE,
  MAX_ITEM_ATTEMPTS,
  STALE_RUNNING_MS,
  TYPICAL_PAGE_TOKENS,
  UNBILLED_ITEM_MESSAGE,
  attemptsExhausted,
  buildCityBrief,
  checkStoredPageContract,
  contractFailureMessage,
  countConsumedLast24h,
  customerMessage,
  dailyCapMessage,
  dailyCapRemaining,
  findExistingCityPage,
  generatePageContent,
  initialBillingStatus,
  isStaleRunning,
  persistGeneratedPage,
  planJobItems,
  readPlatformSettings,
  resolveBillingMode,
  resolvePlatformSettlementMode,
  selectTargets,
  settleGeneration,
  type BillingMode,
  type GenerationTarget,
  type ItemBillingStatus,
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
 */

const sb = () => supabaseAdmin as any;

export const DEFAULT_MIN_LISTINGS = 3;

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
  if (!job) throw new Error("Generation job not found");
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

/** Record what settlement did. An unbilled item fails so its retry bills without regenerating. */
async function recordSettlement(
  itemId: string,
  attempts: number,
  settled: { creditsCharged: number; billing: string; billingStatus: ItemBillingStatus },
): Promise<void> {
  if (settled.billing === "unbilled") {
    await markItemFenced(itemId, attempts, {
      status: "failed",
      credits_charged: 0,
      billing_status: "unbilled",
      error: UNBILLED_ITEM_MESSAGE,
    });
    return;
  }
  await markItemFenced(itemId, attempts, {
    status: "done",
    credits_charged: settled.creditsCharged,
    billing_status: settled.billingStatus,
    error: null,
  });
}

// ---------------------------------------------------------------------------
// Server functions
// ---------------------------------------------------------------------------

export const listGenerationTargets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        minListings: z.number().int().min(1).max(100).default(DEFAULT_MIN_LISTINGS),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);

    const [{ targets, syncedListings, dominantCategory }, settings, consumed24h] =
      await Promise.all([
        loadTargets(data.workspaceId, data.minListings),
        readPlatformSettings(),
        countConsumedLast24h(data.workspaceId),
      ]);

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
      dailyCap: settings.dailyCap,
      remainingToday: dailyCapRemaining(settings.dailyCap, consumed24h),
      models: GENERATION_MODEL_OPTIONS,
      defaultModel: GENERATION_DEFAULT_MODEL,
    };
  });

export const startGenerationJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        targetKeys: z.array(z.string().min(1).max(300)).min(1).max(200),
        model: z.string().max(120).optional(),
        minListings: z.number().int().min(1).max(100).default(DEFAULT_MIN_LISTINGS),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);

    const settings = await readPlatformSettings();
    if (settings.paused) {
      throw new Error("Generation is paused platform-wide right now.");
    }
    if (data.model && !GENERATION_MODEL_IDS.includes(data.model)) {
      throw new Error("That model is not available. Pick one from the list.");
    }
    const model = resolvePlatformModel(data.model ?? GENERATION_DEFAULT_MODEL);

    const { targets, dominantCategory } = await loadTargets(data.workspaceId, data.minListings);
    const targetByKey = new Map(targets.map((t) => [t.targetKey, t]));
    const unknown = data.targetKeys.filter((k) => !targetByKey.has(k));
    if (unknown.length) {
      throw new Error(
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
        throw new Error(
          "Those cities are being written right now in another session. Give it a few minutes, then refresh.",
        );
      }
      if (plan.exhausted.length) {
        throw new Error(
          `Those cities were given up on after ${MAX_ITEM_ATTEMPTS} failed attempts each. Contact support if you need them written.`,
        );
      }
      throw new Error("Every city you picked already has a generated draft. Nothing to do.");
    }

    // The cap counts queued and in-flight items too (a reservation), so this
    // job's own rows count against it the moment they are created.
    const consumed24h = await countConsumedLast24h(data.workspaceId);
    const remaining = dailyCapRemaining(settings.dailyCap, consumed24h);
    if (newWork > remaining) {
      throw new Error(dailyCapMessage(settings.dailyCap, remaining));
    }

    const { data: job, error: jobErr } = await sb()
      .from("generation_jobs")
      .insert({
        workspace_id: data.workspaceId,
        requested_by: context.userId,
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
  });

export const getGenerationJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, jobId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    return loadJob(data.workspaceId, data.jobId);
  });

/**
 * "Stop after this one". The job is marked cancelled and every item still
 * waiting its turn is skipped (releasing its daily-cap slot). The item being
 * written right now finishes normally — its page is already paid for by the
 * time this lands — and settleJobStatus leaves a cancelled job alone.
 */
export const cancelGenerationJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, jobId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
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
  });

/**
 * One unit of work. Safe to call repeatedly for the same item:
 *   done                → returned unchanged, nothing charged
 *   skipped             → returned unchanged
 *   running (fresh)     → returned unchanged, someone else has it
 *   running (stale 3m+) → treated as abandoned and taken over
 *   pending / failed    → claimed, then:
 *       page already linked → settle if still owed, mark done (no generation)
 *       page exists for the city → link it, mark done (no generation, no charge)
 *       otherwise → generate, persist DRAFT, link page, settle
 *
 * Policy gates (pause, attempt ceiling, daily cap, funds) run BEFORE the
 * claim and never consume an attempt: they cost nothing and clear on their
 * own. The attempt counter is reserved for work that actually ran.
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
  if (!item) throw new Error("Generation item not found");
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
  // has nothing left to generate — only a charge to record — so it is never
  // stranded by its attempt count.
  if (!row.page_id && attemptsExhausted(row.attempts)) return refuse(ATTEMPTS_EXHAUSTED_MESSAGE);

  const model = resolvePlatformModel(job?.model ?? GENERATION_DEFAULT_MODEL);
  const owesSettlement =
    !!row.page_id && (row.billing_status === "pending" || row.billing_status === "unbilled");

  let billing: ResolvedBilling | null = null;
  let settlementMode: BillingMode | null = null;
  try {
    if (!row.page_id) {
      // The batch path's reservation is this item's own row: it was claimed
      // as pending (before anything was generated) and counts from the moment
      // it exists, which is what stops two tabs from each fitting under the
      // cap. So the re-check here excludes only itself — its slot must not
      // read as "one over the cap". Quick pages reserve a row in
      // generation_reservations instead (reserveGenerationSlot).
      const consumed = await countConsumedLast24h(workspaceId, { excludeItemId: row.id });
      const remaining = dailyCapRemaining(settings.dailyCap, consumed);
      if (remaining === 0) return refuse(dailyCapMessage(settings.dailyCap, 0));
      billing = await resolveBillingMode(workspaceId, model);
    } else if (owesSettlement) {
      // A 'pending'/'unbilled' record means the page was written on the
      // platform key and the charge is still owed. The key in use TODAY is
      // irrelevant — a BYOK key added since does not retroactively pay.
      settlementMode = await resolvePlatformSettlementMode(workspaceId, model);
    }
  } catch (e) {
    // Only a customer-written refusal (no key, out of funds) is stored on the
    // item; a database error is logged and replaced.
    return refuse(customerMessage(e, GENERATION_UNAVAILABLE_MESSAGE).slice(0, 300));
  }

  // ---- Claim with an optimistic guard so two tabs cannot both run the same item. ----
  const { data: claimed, error: claimErr } = await sb()
    .from("generation_items")
    .update({ status: "running", attempts: row.attempts + 1, error: null })
    .eq("id", row.id)
    .eq("status", row.status)
    .eq("attempts", row.attempts)
    .select("*")
    .maybeSingle();
  if (claimErr) throw new Error(claimErr.message);
  if (!claimed) return { item: await freshItem(row.id), changed: false };
  const token = (claimed as GenerationItemRow).attempts;

  if (job?.status === "queued") {
    await sb().from("generation_jobs").update({ status: "running" }).eq("id", row.job_id);
  }

  const target = row.target;
  try {
    if (row.page_id) {
      // The draft exists (a previous run died between persisting and
      // settling). Never generate again; settle only what is still owed.
      if (owesSettlement) {
        const settled = await settleGeneration({
          workspaceId,
          userId,
          keySource: "platform",
          billingMode: settlementMode ?? "platform",
          model,
          promptTokens: row.prompt_tokens ?? TYPICAL_PAGE_TOKENS.prompt,
          completionTokens: row.completion_tokens ?? TYPICAL_PAGE_TOKENS.completion,
          feature: "batch_generation",
          refId: row.page_id,
        });
        await recordSettlement(row.id, token, settled);
      } else {
        await markItemFenced(row.id, token, { status: "done", error: null });
      }
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
      } else {
        const brief = buildCityBrief({
          city: target.city,
          state: target.state,
          categoryPlural: target.categoryPlural,
        });
        const gen = await generatePageContent({
          workspaceId,
          title: brief.title,
          description: brief.description,
          topic: brief.topic,
          city: target.city,
          state: target.state,
          categoryPlural: target.categoryPlural,
          model,
          billing: billing ?? undefined,
        });
        const page = await persistGeneratedPage({
          workspaceId,
          generated: gen,
          requestedTitle: brief.title,
          requestedDescription: brief.description,
          city: target.city,
          state: target.state,
          categoryPlural: target.categoryPlural,
        });
        // Link the page BEFORE settling, and insist the write landed. If the
        // request dies after this line the item still knows its page, so a
        // re-claim settles instead of writing a second one.
        await markItemFenced(row.id, token, {
          page_id: page.id,
          slug: page.slug,
          prompt_tokens: gen.promptTokens,
          completion_tokens: gen.completionTokens,
          billing_status: initialBillingStatus(gen.billingMode),
        });
        const settled = await settleGeneration({
          workspaceId,
          userId,
          keySource: gen.keySource,
          billingMode: gen.billingMode,
          model: gen.model,
          promptTokens: gen.promptTokens,
          completionTokens: gen.completionTokens,
          feature: "batch_generation",
          refId: page.id,
        });
        await recordSettlement(row.id, token, settled);
      }
    }
  } catch (e) {
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
    const { error: failErr } = await sb()
      .from("generation_items")
      .update({ status: "failed", error: msg.slice(0, 300) })
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

const itemInput = (d: unknown) =>
  z.object({ workspaceId: workspaceIdSchema, itemId: z.string().uuid() }).parse(d);

export const processGenerationItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(itemInput)
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    return runItem(data.workspaceId, context.userId, data.itemId);
  });

export const retryGenerationItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(itemInput)
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    return runItem(data.workspaceId, context.userId, data.itemId, { onlyIfFailed: true });
  });

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
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, jobId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
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
        const msg = e instanceof Error ? e.message : "Could not publish";
        results.push({ ...base, outcome: "error", message: msg.slice(0, 300) });
      }
    }

    return {
      results,
      published: results.filter((r) => r.outcome === "published").length,
      keptAsDraft: results.filter((r) => r.outcome === "draft").length,
      limitReached: limitHit,
    };
  });
