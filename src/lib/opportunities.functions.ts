/**
 * Opportunity Engine server functions — the customer-facing surface.
 *
 * Controlled rollout: availability requires BOTH the global kill switch
 * (OPPORTUNITY_ENGINE_ENABLED) AND explicit per-workspace enrollment, so an
 * unvalidated recommendation engine can never reach every customer at once.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertWorkspaceMember, assertWorkspaceOwner, workspaceIdSchema } from "./admin-helpers.functions";

const sb = () => supabaseAdmin as any;

export const OPPORTUNITY_FEATURE = "opportunity_engine_v1";

/** Master kill switch. Necessary but NOT sufficient. */
export function opportunityEngineEnabled(): boolean {
  const v = process.env.OPPORTUNITY_ENGINE_ENABLED ?? "";
  return v === "1" || v.toLowerCase() === "true";
}

/** A workspace sees the engine only when the global switch is on AND that
 *  workspace is explicitly enrolled. Enrollment rows are service-role-only, so
 *  a customer cannot enrol themselves into an unvalidated engine. */
async function workspaceEnrolled(workspaceId: string): Promise<boolean> {
  const { data } = await sb()
    .from("feature_enrollments")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("feature", OPPORTUNITY_FEATURE)
    .maybeSingle();
  return Boolean(data);
}

async function assertAvailable(workspaceId: string) {
  if (!opportunityEngineEnabled()) {
    throw new Error("Opportunity Engine is not enabled for this environment");
  }
  if (!(await workspaceEnrolled(workspaceId))) {
    throw new Error("Opportunity Engine is not enabled for this workspace");
  }
}

export const getOpportunityFlag = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema.optional() }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const global = opportunityEngineEnabled();
    if (!global || !data.workspaceId) return { enabled: false, global };
    try {
      await assertWorkspaceMember(data.workspaceId, context.userId);
    } catch {
      return { enabled: false, global };
    }
    return { enabled: await workspaceEnrolled(data.workspaceId), global };
  });

export const setAnalysisDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, domain: z.string().min(3).max(253) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAvailable(data.workspaceId);
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const host = data.domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/:\d+$/, "");
    if (!host.includes(".") || /\s/.test(host)) {
      return { ok: false as const, error: "Enter a domain like example.com" };
    }
    const { error } = await sb().from("workspaces").update({ analysis_domain: host }).eq("id", data.workspaceId);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, domain: host };
  });

/** Full pipeline: scan the site, roll up inventory, discover opportunities. */
export const runOpportunityAnalysis = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        skipScan: z.boolean().default(false),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAvailable(data.workspaceId);
    await assertWorkspaceOwner(data.workspaceId, context.userId);

    const { data: ws } = await sb()
      .from("workspaces")
      .select("analysis_domain")
      .eq("id", data.workspaceId)
      .maybeSingle();

    const steps: Array<{ step: string; ok: boolean; detail: string }> = [];

    if (!data.skipScan && ws?.analysis_domain) {
      try {
        const { runSiteScan } = await import("./opportunity/site-scan.server");
        const r = await runSiteScan(data.workspaceId, ws.analysis_domain);
        steps.push({
          step: "site_scan",
          ok: true,
          detail: `${r.pagesFetched} pages analyzed of ${r.urlsDiscovered} discovered`,
        });
      } catch (e) {
        steps.push({
          step: "site_scan",
          ok: false,
          detail: e instanceof Error ? e.message : "scan failed",
        });
      }
    } else {
      steps.push({
        step: "site_scan",
        ok: false,
        detail: ws?.analysis_domain ? "skipped" : "no analysis domain set",
      });
    }

    try {
      const { rebuildInventoryAggregates } = await import("./opportunity/inventory.server");
      const r = await rebuildInventoryAggregates(data.workspaceId);
      steps.push({ step: "inventory", ok: true, detail: `${r.rows} location/category groups` });
    } catch (e) {
      steps.push({
        step: "inventory",
        ok: false,
        detail: e instanceof Error ? e.message : "aggregation failed",
      });
    }

    try {
      const { runDiscovery } = await import("./opportunity/discovery.server");
      const report = await runDiscovery(data.workspaceId);
      steps.push({
        step: "discovery",
        ok: true,
        detail: `${report.candidatesGenerated} candidates, ${report.buildNewPage} recommended`,
      });
      return { ok: true as const, steps, report };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "discovery failed";
      console.error("[opportunities] discovery failed", data.workspaceId, msg);
      steps.push({ step: "discovery", ok: false, detail: msg });
      return { ok: false as const, steps, error: msg };
    }
  });

export type OpportunityListItem = {
  id: string;
  intent_label: string;
  recommendation: string;
  band: string | null;
  confidence: string | null;
  proposed_slug: string | null;
  geo_city: string | null;
  geo_state: string | null;
  explanation: string[];
  nearest_page_ref: string | null;
  status: string;
  tenant_page_id: string | null;
  /** Internal score — returned for owner debugging only, never rendered. */
  opportunity_score: number | null;
};

export const listOpportunities = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        recommendation: z.string().max(40).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAvailable(data.workspaceId);
    await assertWorkspaceMember(data.workspaceId, context.userId);
    let q = sb()
      .from("seo_opportunities")
      .select(
        "id, intent_label, recommendation, band, confidence, proposed_slug, geo_city, geo_state, explanation, nearest_page_ref, status, tenant_page_id, opportunity_score",
      )
      .eq("workspace_id", data.workspaceId)
      .order("opportunity_score", { ascending: false, nullsFirst: false })
      .limit(300);
    if (data.recommendation) q = q.eq("recommendation", data.recommendation);
    const { data: rows } = await q;

    const all = (rows ?? []) as OpportunityListItem[];
    const counts = {
      build: all.filter((r) => r.recommendation === "BUILD_NEW_PAGE").length,
      improve: all.filter((r) => r.recommendation === "IMPROVE_EXISTING").length,
      wait: all.filter((r) => r.recommendation === "WAIT_FOR_INVENTORY").length,
      reject: all.filter((r) => r.recommendation === "DO_NOT_BUILD").length,
    };
    return { rows: all, counts };
  });

export const getOpportunity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAvailable(data.workspaceId);
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const [{ data: opp }, { data: evidence }] = await Promise.all([
      sb()
        .from("seo_opportunities")
        .select("*")
        .eq("workspace_id", data.workspaceId)
        .eq("id", data.id)
        .maybeSingle(),
      sb()
        .from("opportunity_evidence")
        .select("source, metric, value_num, value_text, detail")
        .eq("opportunity_id", data.id),
    ]);
    if (!opp) return { ok: false as const, error: "not found" };
    return { ok: true as const, opportunity: opp, evidence: evidence ?? [] };
  });

/** Approve → brief → existing generation → tenant_pages DRAFT.
 *  Publishing is untouched: the draft goes through the existing gate later. */
export const approveOpportunity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAvailable(data.workspaceId);
    await assertWorkspaceOwner(data.workspaceId, context.userId);

    const { data: opp } = await sb()
      .from("seo_opportunities")
      .select("id, recommendation, status, intent_label, proposed_slug, geo_city, geo_state, normalized_category")
      .eq("workspace_id", data.workspaceId)
      .eq("id", data.id)
      .maybeSingle();
    if (!opp) return { ok: false as const, error: "not found" };
    if (opp.recommendation !== "BUILD_NEW_PAGE") {
      return { ok: false as const, error: `This opportunity is marked ${opp.recommendation}` };
    }

    const { buildPageBrief, briefToPrompt } = await import("./opportunity/brief.server");
    const brief = await buildPageBrief(data.workspaceId, data.id);

    await sb()
      .from("seo_opportunities")
      .update({
        status: "generating",
        approved_at: new Date().toISOString(),
        customer_action: "approved",
        page_brief: brief as any,
      })
      .eq("id", data.id);

    try {
      const { createQuickPage } = await import("./admin-quick-page.functions");
      // `topic` is capped at 2000 chars by the generator's schema; the full
      // brief is persisted on the opportunity regardless.
      const prompt = briefToPrompt(brief).slice(0, 1990);
      const res: any = await createQuickPage({
        data: {
          workspaceId: data.workspaceId,
          title: brief.proposedTitle.slice(0, 140),
          topic: prompt,
          slug: brief.proposedSlug || undefined,
          city: brief.geography.city || undefined,
          state: brief.geography.state || undefined,
          categoryPlural: brief.category || "listings",
          // Approved opportunities produce a DRAFT for review. The existing
          // publish gate is untouched and runs later, as normal.
          autoPublish: false,
        },
      });

      const pageId = res?.page?.id ?? null;
      await sb()
        .from("seo_opportunities")
        .update({
          status: pageId ? "draft_ready" : "approved",
          generated_at: new Date().toISOString(),
          tenant_page_id: pageId,
        })
        .eq("id", data.id);

      if (pageId) {
        await sb().from("tenant_pages").update({ opportunity_id: data.id }).eq("id", pageId);
      }

      return { ok: true as const, pageId, brief };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "generation failed";
      console.error("[opportunities] generation failed", data.id, msg);
      await sb()
        .from("seo_opportunities")
        .update({ status: "approved", customer_action: "approved_generation_failed" })
        .eq("id", data.id);
      return { ok: false as const, error: msg };
    }
  });

export const skipOpportunity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAvailable(data.workspaceId);
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    await sb()
      .from("seo_opportunities")
      .update({ status: "rejected", customer_action: "skipped" })
      .eq("workspace_id", data.workspaceId)
      .eq("id", data.id);
    return { ok: true as const };
  });
