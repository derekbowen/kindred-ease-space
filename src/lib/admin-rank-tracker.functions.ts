import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "./admin-helpers.functions";
import { requireWorkspaceSecret } from "./workspace-secrets.server";

const sb = () => supabaseAdmin as any;

export type TrackedKeywordRow = {
  id: string;
  keyword: string;
  target_url_path: string | null;
  market: string;
  is_active: boolean;
  last_position: number | null;
  previous_position: number | null;
  last_checked_at: string | null;
};

export const listTrackedKeywords = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }): Promise<{ rows: TrackedKeywordRow[] }> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const { data: rows } = await sb()
      .from("tracked_keywords")
      .select("*")
      .eq("workspace_id", data.workspaceId)
      .order("last_position", { ascending: true, nullsFirst: false });
    return { rows: (rows || []) as TrackedKeywordRow[] };
  });

export const addTrackedKeyword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        keyword: z.string().min(1).max(200),
        target_url_path: z.string().max(300).optional(),
        market: z.string().max(10).default("us"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const { error } = await sb()
      .from("tracked_keywords")
      .insert({
        workspace_id: data.workspaceId,
        keyword: data.keyword.trim(),
        target_url_path: data.target_url_path || null,
        market: data.market,
      });
    return error ? { ok: false as const, error: error.message } : { ok: true as const };
  });

export const deleteTrackedKeyword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const { error } = await sb()
      .from("tracked_keywords")
      .delete()
      .eq("workspace_id", data.workspaceId)
      .eq("id", data.id);
    return error ? { ok: false as const, error: error.message } : { ok: true as const };
  });

/**
 * Check current position via SerpApi (BYOK). Looks for the workspace's
 * marketplace_domain in the organic results.
 */
export const runSerpCheck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        id: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(50).default(20),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);

    let serpKey: string;
    try {
      serpKey = await requireWorkspaceSecret(data.workspaceId, "SERPAPI_KEY", "SERPAPI_KEY");
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "Missing SERPAPI_KEY" };
    }

    const { data: ws } = await sb()
      .from("workspaces")
      .select("marketplace_domain")
      .eq("id", data.workspaceId)
      .maybeSingle();
    const targetDomain: string = (ws?.marketplace_domain || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "")
      .toLowerCase();
    if (!targetDomain)
      return { ok: false as const, error: "Workspace has no marketplace_domain set." };

    let q = sb()
      .from("tracked_keywords")
      .select("*")
      .eq("workspace_id", data.workspaceId)
      .eq("is_active", true);
    if (data.id) q = q.eq("id", data.id);
    else q = q.order("last_checked_at", { ascending: true, nullsFirst: true }).limit(data.limit);
    const { data: kws } = await q;

    const results: {
      keyword: string;
      position: number | null;
      delta: number | null;
      error?: string;
    }[] = [];

    for (const kw of (kws || []) as TrackedKeywordRow[]) {
      try {
        const params = new URLSearchParams({
          engine: "google",
          q: kw.keyword,
          gl: kw.market || "us",
          hl: "en",
          num: "100",
          api_key: serpKey,
        });
        const resp = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
        if (!resp.ok) {
          results.push({
            keyword: kw.keyword,
            position: null,
            delta: null,
            error: `serpapi ${resp.status}`,
          });
          continue;
        }
        const json: any = await resp.json();
        const organic: any[] = Array.isArray(json?.organic_results) ? json.organic_results : [];
        let position: number | null = null;
        let urlFound: string | null = null;
        for (const r of organic) {
          const link: string = r?.link || "";
          if (link.toLowerCase().includes(targetDomain)) {
            position = typeof r?.position === "number" ? r.position : organic.indexOf(r) + 1;
            urlFound = link;
            break;
          }
        }
        const now = new Date().toISOString();
        await sb().from("serp_rankings").insert({
          workspace_id: data.workspaceId,
          keyword_id: kw.id,
          position,
          url_found: urlFound,
          checked_at: now,
        });
        await sb()
          .from("tracked_keywords")
          .update({
            previous_position: kw.last_position,
            last_position: position,
            last_checked_at: now,
          })
          .eq("id", kw.id);
        const delta =
          kw.last_position != null && position != null ? kw.last_position - position : null;
        results.push({ keyword: kw.keyword, position, delta });
      } catch (e: any) {
        results.push({
          keyword: kw.keyword,
          position: null,
          delta: null,
          error: e?.message || String(e),
        });
      }
    }
    return { ok: true as const, results };
  });
