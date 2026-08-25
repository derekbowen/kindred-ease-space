import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { creditsForUsage } from "@/lib/ai-pricing";

/**
 * Server-only metering for AI paths that spend the PLATFORM key (i.e. when a
 * workspace has not configured its own BYOK key). Mirrors the accounting in the
 * ai-proxy edge function so no authenticated tool can burn platform AI budget
 * uncapped: spend the free trial quota first, then purchased credits, and refuse
 * (no hard cap — just "top up") when the balance is empty.
 *
 * NEVER import from client code.
 */
export type PlatformBilling = "free_quota" | "credits";

export async function reservePlatformAi(workspaceId: string): Promise<PlatformBilling> {
  const { error: qErr } = await supabaseAdmin.rpc("consume_platform_ai_credit", {
    _workspace_id: workspaceId,
  });
  if (!qErr) return "free_quota";
  if (typeof qErr.message === "string" && qErr.message.includes("platform_ai_quota_exhausted")) {
    const { data: bal } = await supabaseAdmin
      .from("credit_balances")
      .select("balance")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (!bal || (bal.balance ?? 0) <= 0) {
      throw new Error("Out of AI credits. Top up in Billing to keep using this tool.");
    }
    return "credits";
  }
  throw new Error(qErr.message);
}

export async function settlePlatformAi(opts: {
  workspaceId: string;
  userId?: string | null;
  billing: PlatformBilling;
  model: string;
  promptTokens: number;
  completionTokens: number;
  feature: string;
}): Promise<number> {
  let creditsCharged = 0;
  if (opts.billing === "credits") {
    creditsCharged = creditsForUsage(opts.model, opts.promptTokens, opts.completionTokens);
    if (creditsCharged > 0) {
      const { error } = await supabaseAdmin.rpc("deduct_credits", {
        _workspace_id: opts.workspaceId,
        _amount: creditsCharged,
        _reason: "ai_usage",
        _ai_model: opts.model,
        _ref_type: opts.feature,
        _metadata: { provider: "platform" },
      });
      if (error) console.error("[settlePlatformAi] deduct_credits failed", error.message);
    }
  }
  await supabaseAdmin.from("ai_usage_log").insert({
    workspace_id: opts.workspaceId,
    user_id: opts.userId ?? undefined,
    provider: "platform",
    model: opts.model,
    feature: opts.feature,
    prompt_tokens: opts.promptTokens,
    completion_tokens: opts.completionTokens,
    total_tokens: opts.promptTokens + opts.completionTokens,
    used_byok: false,
    status: "ok",
  });
  return creditsCharged;
}
