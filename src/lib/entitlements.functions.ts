import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { planByKey, TRIAL_PAGE_LIMIT } from "@/lib/plan-catalog";

const sb = () => supabaseAdmin as any;

export type PageEntitlement = {
  planKey: string | null;
  planName: string;
  subscriptionStatus: string;
  monthlyPrice: number | null;
  pageLimit: number;
  pageLimitBase: number;
  pageLimitAddon: number;
  pageLimitBonus: number;
  publishedPages: number;
  draftPages: number;
  suspendedPages: number;
  remaining: number;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  isTrial: boolean;
  aiBalance: number;
};

/**
 * The entitlement read the dashboard/billing/publishing UIs run on. Stripe is
 * payment truth; the webhook projects it into workspaces.page_limit_*; this is
 * the fast internal read of that state (§11 of the billing spec) — the client
 * can never supply or inflate its own limit.
 */
/** Count rows without fetching them.
 *
 *  This used to `select("status")` for the whole workspace and tally in JS.
 *  That is wrong at exactly the scale we sell: PostgREST caps returned rows,
 *  so a workspace above the cap reported FEWER published pages than it has,
 *  and `remaining` was correspondingly overstated. Plans go to 5,000 pages
 *  (10,000 grandfathered), so this was reachable on a normal Scale plan and
 *  above — the accounting broke precisely for the biggest customers.
 *
 *  The atomic gate in publish_tenant_pages() counts in SQL under an advisory
 *  lock, so nobody could actually over-publish. The damage was to what we
 *  TOLD the customer: a Scale customer at 1,200 published pages could be shown
 *  headroom they did not have, and only discover the truth when publish denied
 *  them. head:true returns the count and no rows.
 */
async function countByStatus(workspaceId: string, status: string): Promise<number> {
  const { count, error } = await sb()
    .from("tenant_pages")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", status);
  if (error) {
    // Never silently report 0 published pages — that reads as "all your
    // capacity is free" and is the most dangerous possible wrong answer.
    console.error("[entitlements] count failed", workspaceId, status, error.message);
    throw new Error(`entitlement count failed: ${error.message}`);
  }
  return count ?? 0;
}

export async function readEntitlement(workspaceId: string): Promise<PageEntitlement> {
  const [wsRes, published, drafts, suspended, { data: bal }] = await Promise.all([
    sb()
      .from("workspaces")
      .select(
        "plan, subscription_status, trial_ends_at, current_period_end, page_limit_base, page_limit_addon, page_limit_bonus, page_bonus_expires_at",
      )
      .eq("id", workspaceId)
      .maybeSingle(),
    countByStatus(workspaceId, "published"),
    countByStatus(workspaceId, "draft"),
    countByStatus(workspaceId, "billing_suspended"),
    sb().from("credit_balances").select("balance").eq("workspace_id", workspaceId).maybeSingle(),
  ]);
  const ws = wsRes.data;
  if (!ws) {
    // Distinguish "no such workspace" from "entitlement schema missing"
    // (migration not applied) — both fail closed, but ops needs to tell them
    // apart from the logs.
    if (wsRes.error) {
      console.error("[entitlements] read failed", workspaceId, wsRes.error.message);
      throw new Error(`entitlement read failed: ${wsRes.error.message}`);
    }
    throw new Error("workspace not found");
  }

  const bonusActive =
    ws.page_bonus_expires_at && new Date(ws.page_bonus_expires_at).getTime() > Date.now();
  const base = ws.page_limit_base ?? TRIAL_PAGE_LIMIT;
  const addon = ws.page_limit_addon ?? 0;
  const bonus = bonusActive ? (ws.page_limit_bonus ?? 0) : 0;
  const limit = base + addon + bonus;

  const status: string = ws.subscription_status ?? "trialing";
  const isTrial = status === "trialing";
  const plan = planByKey(ws.plan);

  return {
    planKey: ws.plan ?? null,
    planName: isTrial && !plan ? "Free trial" : (plan?.name ?? ws.plan ?? "Free trial"),
    subscriptionStatus: status,
    monthlyPrice: plan?.monthlyPrice ?? null,
    pageLimit: limit,
    pageLimitBase: base,
    pageLimitAddon: addon,
    pageLimitBonus: bonus,
    publishedPages: published,
    draftPages: drafts,
    suspendedPages: suspended,
    remaining: Math.max(limit - published, 0),
    currentPeriodEnd: ws.current_period_end ?? null,
    trialEndsAt: ws.trial_ends_at ?? null,
    isTrial,
    aiBalance: bal?.balance ?? 0,
  };
}

export const getPageEntitlement = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: isMember } = await sb().rpc("is_workspace_member", {
      _workspace_id: data.workspaceId,
      _user_id: context.userId,
    });
    if (!isMember) throw new Error("forbidden");
    return readEntitlement(data.workspaceId);
  });

/**
 * Atomic publish through the DB gate (advisory lock + count-under-lock inside
 * publish_tenant_pages). Callers write content as drafts first, then flip
 * through here — the check and the flip are one transaction, so 1,000 parallel
 * publish requests cannot oversubscribe the limit.
 */
export async function publishPagesAtomically(
  workspaceId: string,
  pageIds: string[],
): Promise<{
  published: number;
  denied: number;
  limit: number;
  publishedTotal: number;
  remaining: number;
}> {
  const { data, error } = await sb().rpc("publish_tenant_pages", {
    _workspace_id: workspaceId,
    _page_ids: pageIds,
  });
  if (error) {
    // Fail closed AND loud: content stays a draft, the customer sees the
    // error, and ops can grep this line. A missing RPC (migration not applied)
    // lands here too.
    console.error("[entitlements] publish gate failed", workspaceId, error.message);
    throw new Error(`publish gate failed: ${error.message}`);
  }
  const r = data as {
    published: number;
    denied: number;
    limit: number;
    published_total: number;
    remaining: number;
  };
  return {
    published: r.published,
    denied: r.denied,
    limit: r.limit,
    publishedTotal: r.published_total,
    remaining: r.remaining,
  };
}

export function pageLimitMessage(limit: number): string {
  return `You've reached your ${limit.toLocaleString()}-page publishing limit. Upgrade your plan in Billing to publish more, or unpublish pages you no longer need.`;
}
