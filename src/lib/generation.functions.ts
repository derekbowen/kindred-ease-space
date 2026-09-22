import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import { PLATFORM_MODEL_ALLOWLIST, resolvePlatformModel } from "@/lib/ai-pricing";
import { getPageBuilderContext } from "@/lib/page-builder.functions";
import {
  GENERATION_DEFAULT_MODEL,
  GENERATION_MODEL_OPTIONS,
  buildCityBrief,
  checkStoredPageContract,
  contractFailureMessage,
  dailyCapRemaining,
  generatePageContent,
  isStaleRunning,
  persistGeneratedPage,
  planJobItems,
  selectTargets,
  settleGeneration,
  type GenerationTarget,
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
const DEFAULT_DAILY_CAP = 50;

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
  created_at: string;
  updated_at: string;
};

export type TargetListing = GenerationTarget & {
  /** A finished batch item exists for this city (draft already generated). */
  alreadyGenerated: boolean;
  /** Status of the most recent batch item for this city, if any. */
  itemStatus: GenerationItemRow["status"] | null;
  pageId: string | null;
};

// ---------------------------------------------------------------------------
// Platform-wide knobs (service-role only table)
// ---------------------------------------------------------------------------

async function readPlatformSettings(): Promise<{ paused: boolean; dailyCap: number }> {
  const { data, error } = await sb()
    .from("platform_settings")
    .select("key, value")
    .in("key", ["generation_paused", "generation_daily_cap"]);
  if (error) {
    // Fail closed on the pause switch: if we cannot read it, assume paused —
    // a broken settings read must never turn into an uncapped spend.
    console.error("[generation] platform_settings read failed", error.message);
    return { paused: true, dailyCap: 0 };
  }
  const map = new Map<string, unknown>((data ?? []).map((r: any) => [r.key, r.value]));
  const paused = map.get("generation_paused") === true;
  const capRaw = Number(map.get("generation_daily_cap") ?? DEFAULT_DAILY_CAP);
  return { paused, dailyCap: Number.isFinite(capRaw) ? capRaw : DEFAULT_DAILY_CAP };
}

async function countDoneLast24h(workspaceId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { count, error } = await sb()
    .from("generation_items")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "done")
    .gte("updated_at", since);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

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

/** Roll the job status up from its items once nothing is left to do. */
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
    .eq("id", jobId);
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

    const [{ targets, syncedListings, dominantCategory }, settings, done24h, { data: items }] =
      await Promise.all([
        loadTargets(data.workspaceId, data.minListings),
        readPlatformSettings(),
        countDoneLast24h(data.workspaceId),
        sb()
          .from("generation_items")
          .select("target_key, status, page_id")
          .eq("workspace_id", data.workspaceId),
      ]);

    const byKey = new Map<string, { status: GenerationItemRow["status"]; page_id: string | null }>(
      ((items ?? []) as Array<{ target_key: string; status: any; page_id: string | null }>).map(
        (i) => [i.target_key, { status: i.status, page_id: i.page_id }],
      ),
    );

    const list: TargetListing[] = targets.map((t) => {
      const existing = byKey.get(t.targetKey);
      return {
        ...t,
        alreadyGenerated: existing?.status === "done",
        itemStatus: existing?.status ?? null,
        pageId: existing?.page_id ?? null,
      };
    });

    return {
      targets: list,
      syncedListings,
      dominantCategory,
      minListings: data.minListings,
      paused: settings.paused,
      dailyCap: settings.dailyCap,
      remainingToday: dailyCapRemaining(settings.dailyCap, done24h),
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
    if (data.model && !PLATFORM_MODEL_ALLOWLIST.includes(data.model)) {
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
      .select("target_key, status")
      .eq("workspace_id", data.workspaceId)
      .in("target_key", data.targetKeys);
    if (exErr) throw new Error(exErr.message);
    const plan = planJobItems(data.targetKeys, existing ?? []);
    const newWork = plan.create.length + plan.reattach.length;
    if (newWork === 0) {
      throw new Error("Every city you picked already has a generated draft. Nothing to do.");
    }

    const done24h = await countDoneLast24h(data.workspaceId);
    const remaining = dailyCapRemaining(settings.dailyCap, done24h);
    if (newWork > remaining) {
      throw new Error(
        remaining === 0
          ? `You've hit today's limit of ${settings.dailyCap} generated pages. Try again in 24 hours.`
          : `You can generate ${remaining} more page${remaining === 1 ? "" : "s"} in the next 24 hours (limit ${settings.dailyCap} per day). Pick ${remaining} or fewer cities.`,
      );
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
    if (plan.reattach.length) {
      const { error: upErr } = await sb()
        .from("generation_items")
        .update({ job_id: job.id, status: "pending", error: null })
        .eq("workspace_id", data.workspaceId)
        .in("target_key", plan.reattach)
        .neq("status", "done");
      if (upErr) throw new Error(upErr.message);
    }

    const loaded = await loadJob(data.workspaceId, job.id);
    return { ...loaded, alreadyDone: plan.alreadyDone };
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
 * One unit of work. Safe to call repeatedly for the same item:
 *   done                → returned unchanged, nothing charged
 *   running (fresh)     → returned unchanged, someone else has it
 *   running (stale 3m+) → treated as abandoned and retried
 *   pending / failed    → claimed, generated, persisted as DRAFT, settled
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

  // Claim with an optimistic guard so two tabs cannot both run the same item.
  const { data: claimed, error: claimErr } = await sb()
    .from("generation_items")
    .update({ status: "running", attempts: row.attempts + 1, error: null })
    .eq("id", row.id)
    .eq("status", row.status)
    .eq("attempts", row.attempts)
    .select("*")
    .maybeSingle();
  if (claimErr) throw new Error(claimErr.message);
  if (!claimed) {
    const { data: fresh } = await sb()
      .from("generation_items")
      .select("*")
      .eq("id", row.id)
      .single();
    return { item: (fresh ?? row) as GenerationItemRow, changed: false };
  }

  const { data: job } = await sb()
    .from("generation_jobs")
    .select("id, status, model")
    .eq("id", row.job_id)
    .maybeSingle();
  if (job?.status === "queued") {
    await sb().from("generation_jobs").update({ status: "running" }).eq("id", row.job_id);
  }
  if (job?.status === "cancelled") {
    await sb()
      .from("generation_items")
      .update({ status: "skipped", error: "Job was cancelled" })
      .eq("id", row.id);
    const { data: fresh } = await sb()
      .from("generation_items")
      .select("*")
      .eq("id", row.id)
      .single();
    return { item: fresh as GenerationItemRow, changed: true };
  }

  const target = row.target;
  const brief = buildCityBrief({
    city: target.city,
    state: target.state,
    categoryPlural: target.categoryPlural,
  });

  try {
    const gen = await generatePageContent({
      workspaceId,
      title: brief.title,
      description: brief.description,
      topic: brief.topic,
      city: target.city,
      state: target.state,
      categoryPlural: target.categoryPlural,
      model: job?.model ?? GENERATION_DEFAULT_MODEL,
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
    const settled = await settleGeneration({
      workspaceId,
      userId,
      keySource: gen.keySource,
      model: gen.model,
      promptTokens: gen.promptTokens,
      completionTokens: gen.completionTokens,
      feature: "batch_generation",
      refId: page.id,
    });
    await sb()
      .from("generation_items")
      .update({
        status: "done",
        page_id: page.id,
        slug: page.slug,
        prompt_tokens: gen.promptTokens,
        completion_tokens: gen.completionTokens,
        credits_charged: settled.creditsCharged,
        error: null,
      })
      .eq("id", row.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Generation failed";
    console.error("[generation] item failed", row.id, msg);
    await sb()
      .from("generation_items")
      .update({ status: "failed", error: msg.slice(0, 300) })
      .eq("id", row.id);
  }

  await settleJobStatus(workspaceId, row.job_id);
  const { data: fresh } = await sb().from("generation_items").select("*").eq("id", row.id).single();
  return { item: fresh as GenerationItemRow, changed: true };
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
