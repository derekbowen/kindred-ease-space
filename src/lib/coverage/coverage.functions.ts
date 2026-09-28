/**
 * Server functions for the Opportunities screen and the dashboard.
 * Membership is checked on every call; reads and writes use the service role
 * after that check (coverage_dismissals has no client policies).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import {
  loadCoverage,
  type CoverageItem,
  type CoverageReport,
  type CoverageState,
} from "./coverage.server";

const sb = () => supabaseAdmin as any;

export const COVERAGE_VIEWS = [
  "open",
  "missing",
  "draft",
  "published",
  "archived",
  "insufficient",
  "dismissed",
  "all",
] as const;
export type CoverageView = (typeof COVERAGE_VIEWS)[number];

export const GetCoverageInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    view: z.enum(COVERAGE_VIEWS).default("open"),
    kind: z.enum(["all", "city_hub", "category_page"]).default("all"),
    page: z.number().int().min(1).max(100_000).default(1),
    pageSize: z.number().int().min(10).max(200).default(50),
  })
  .strict();

/** Which items a view shows. Totals are never affected by the view. */
export function inView(item: CoverageItem, view: CoverageView): boolean {
  if (view === "all") return true;
  if (view === "dismissed") return item.dismissed;
  if (item.dismissed) return false;
  if (view === "open")
    return item.state === "missing" || item.state === "draft" || item.state === "archived";
  if (view === "published") return item.state === "published" || item.state === "suspended";
  return item.state === (view as CoverageState);
}

export type CoveragePage = Omit<CoverageReport, "items"> & {
  items: CoverageItem[];
  view: CoverageView;
  kind: "all" | "city_hub" | "category_page";
  page: number;
  pageSize: number;
  /** Items in this view (before paging). */
  viewTotal: number;
};

export const getCoverage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => GetCoverageInputSchema.parse(d))
  .handler(async ({ data, context }): Promise<CoveragePage> => {
    await assertWorkspaceMember(data.workspaceId, (context as any).userId);
    const report = await loadCoverage(data.workspaceId);
    const filtered = report.items.filter(
      (i) => inView(i, data.view) && (data.kind === "all" || i.kind === data.kind),
    );
    const start = (data.page - 1) * data.pageSize;
    return {
      ...report,
      items: filtered.slice(start, start + data.pageSize),
      view: data.view,
      kind: data.kind,
      page: data.page,
      pageSize: data.pageSize,
      viewTotal: filtered.length,
    };
  });

export const getCoverageSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).strict().parse(d))
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, (context as any).userId);
    const report = await loadCoverage(data.workspaceId);
    return { totals: report.totals, evidence: report.evidence };
  });

const DismissInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    targetKey: z.string().trim().min(3).max(400),
    dismissed: z.boolean(),
  })
  .strict();

export const setCoverageDismissed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => DismissInputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const userId = (context as any).userId as string;
    await assertWorkspaceMember(data.workspaceId, userId);
    if (data.dismissed) {
      const { error } = await sb().from("coverage_dismissals").upsert(
        {
          workspace_id: data.workspaceId,
          target_key: data.targetKey,
          dismissed_by: userId,
          dismissed_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,target_key" },
      );
      if (error) throw new Error("Couldn't dismiss this opportunity. Try again.");
    } else {
      const { error } = await sb()
        .from("coverage_dismissals")
        .delete()
        .eq("workspace_id", data.workspaceId)
        .eq("target_key", data.targetKey);
      if (error) throw new Error("Couldn't restore this opportunity. Try again.");
    }
    return { ok: true as const };
  });
