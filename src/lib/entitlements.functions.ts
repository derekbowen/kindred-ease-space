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
export async function readEntitlement(workspaceId: string): Promise<PageEntitlement> {
  const [{ data: ws }, { data: counts }, { data: bal }] = await Promise.all([
    sb()
      .from("workspaces")
      .select(
        "plan, subscription_status, trial_ends_at, current_period_end, page_limit_base, page_limit_addon, page_limit_bonus, page_bonus_expires_at",
      )
      .eq("id", workspaceId)
      .maybeSingle(),
    sb().from("tenant_pages").select("status").eq("workspace_id", workspaceId),
    sb().from("credit_balances").select("balance").eq("workspace_id", workspaceId).maybeSingle(),
  ]);
  if (!ws) throw new Error("workspace not found");

  const bonusActive =
    ws.page_bonus_expires_at && new Date(ws.page_bonus_expires_at).getTime() > Date.now();
  const base = ws.page_limit_base ?? TRIAL_PAGE_LIMIT;
  const addon = ws.page_limit_addon ?? 0;
  const bonus = bonusActive ? (ws.page_limit_bonus ?? 0) : 0;
  const limit = base + addon + bonus;

  let published = 0;
  let drafts = 0;
  let suspended = 0;
  for (const r of (counts ?? []) as Array<{ status: string }>) {
    if (r.status === "published") published++;
    else if (r.status === "billing_suspended") suspended++;
    else if (r.status === "draft") drafts++;
  }

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
  if (error) throw new Error(`publish gate failed: ${error.message}`);
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
