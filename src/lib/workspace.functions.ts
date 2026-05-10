import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const STARTER_TRIAL_CREDITS = 250;

export const createWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        name: z.string().min(2).max(80),
        marketplaceDomain: z
          .string()
          .min(3)
          .max(120)
          .regex(/^[a-z0-9.-]+$/i, "Use only letters, numbers, dots and dashes"),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const slugBase =
      data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "workspace";
    const slug = `${slugBase}-${Math.random().toString(36).slice(2, 8)}`;
    const domain = data.marketplaceDomain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

    const { data: ws, error } = await supabaseAdmin
      .from("workspaces")
      .insert({
        slug,
        name: data.name,
        marketplace_domain: domain,
        owner_user_id: userId,
        plan: "trial",
        subscription_status: "trialing",
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select("id, slug")
      .single();

    if (error || !ws) throw new Error(error?.message ?? "Failed to create workspace");

    await supabaseAdmin.from("workspace_members").insert({
      workspace_id: ws.id,
      user_id: userId,
      role: "owner",
    });

    await supabaseAdmin.rpc("grant_credits", {
      _workspace_id: ws.id,
      _amount: STARTER_TRIAL_CREDITS,
      _reason: "trial_grant",
      _ref_type: "trial",
      _ref_id: ws.id,
      _metadata: { source: "onboarding" },
    });

    return { workspaceId: ws.id, slug: ws.slug };
  });

export const getWorkspaceOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ workspaceId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const [{ data: ws }, { data: balance }, { count: pageCount }, { count: leadCount }] =
      await Promise.all([
        supabase
          .from("workspaces")
          .select("id, name, plan, subscription_status, trial_ends_at, marketplace_domain, domain_verified_at, current_period_end")
          .eq("id", data.workspaceId)
          .single(),
        supabase
          .from("credit_balances")
          .select("balance, monthly_allowance, cycle_resets_at, lifetime_spent")
          .eq("workspace_id", data.workspaceId)
          .maybeSingle(),
        supabase
          .from("content_pages")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", data.workspaceId)
          .eq("status", "published"),
        supabase
          .from("provider_leads")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", data.workspaceId),
      ]);

    return {
      workspace: ws ?? null,
      balance: balance ?? null,
      stats: {
        publishedPages: pageCount ?? 0,
        leads: leadCount ?? 0,
      },
    };
  });
