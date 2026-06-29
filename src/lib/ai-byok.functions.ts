import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, assertWorkspaceOwner, workspaceIdSchema } from "./admin-helpers.functions";

export const AI_PROVIDERS = ["openai", "anthropic", "google", "openrouter"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

const providerSchema = z.enum(AI_PROVIDERS);

export type CredentialRow = {
  provider: AiProvider;
  last_four: string;
  status: "untested" | "valid" | "invalid";
  default_models: Record<string, string>;
  last_tested_at: string | null;
  last_error: string | null;
  updated_at: string;
};

export type UsageSummary = {
  monthCostUsd: number;
  monthCalls: number;
  monthTokens: number;
  byok: { calls: number; costUsd: number };
  platform: { calls: number; costUsd: number };
  quotaRemaining: number;
  quotaLifetimeUsed: number;
  recent: Array<{
    created_at: string;
    provider: string;
    model: string;
    feature: string | null;
    total_tokens: number;
    cost_usd_micros: number;
    used_byok: boolean;
    status: string;
    error: string | null;
  }>;
};

// ---------- list ----------

export const listAiCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }): Promise<{ rows: CredentialRow[] }> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const { data: rows } = await supabaseAdmin
      .from("tenant_ai_credentials")
      .select("provider, last_four, status, default_models, last_tested_at, last_error, updated_at")
      .eq("workspace_id", data.workspaceId)
      .order("provider");
    return { rows: (rows ?? []) as CredentialRow[] };
  });

// ---------- upsert (saves to vault) ----------

const upsertSchema = z.object({
  workspaceId: workspaceIdSchema,
  provider: providerSchema,
  apiKey: z.string().min(8).max(500),
  defaultModels: z.record(z.string(), z.string()).optional(),
});

export const upsertAiCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const trimmed = data.apiKey.trim();
    const lastFour = trimmed.slice(-4);
    // Must use the authenticated client — RPC checks auth.uid() for owner.
    const { error } = await context.supabase.rpc("tenant_set_ai_credential", {
      _workspace_id: data.workspaceId,
      _provider: data.provider,
      _api_key: trimmed,
      _last_four: lastFour,
      _default_models: data.defaultModels ?? {},
    });
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });

// ---------- delete ----------

export const deleteAiCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, provider: providerSchema }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const { error } = await context.supabase.rpc("tenant_delete_ai_credential", {
      _workspace_id: data.workspaceId,
      _provider: data.provider,
    });
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });

// ---------- test key ----------

async function fetchVaultKey(workspaceId: string, provider: AiProvider): Promise<string | null> {
  const { data, error } = await supabaseAdmin.rpc("tenant_get_ai_credential", {
    _workspace_id: workspaceId,
    _provider: provider,
  });
  if (error) throw new Error(error.message);
  return (data as string | null) ?? null;
}

async function testProviderKey(provider: AiProvider, apiKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (provider === "openai") {
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!r.ok) return { ok: false, error: `OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}` };
      return { ok: true };
    }
    if (provider === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (!r.ok) return { ok: false, error: `Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}` };
      return { ok: true };
    }
    if (provider === "google") {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      );
      if (!r.ok) return { ok: false, error: `Google ${r.status}: ${(await r.text()).slice(0, 200)}` };
      return { ok: true };
    }
    if (provider === "openrouter") {
      const r = await fetch("https://openrouter.ai/api/v1/auth/key", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!r.ok) return { ok: false, error: `OpenRouter ${r.status}: ${(await r.text()).slice(0, 200)}` };
      return { ok: true };
    }
    return { ok: false, error: "Unknown provider" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" };
  }
}

export const testAiCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, provider: providerSchema }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const apiKey = await fetchVaultKey(data.workspaceId, data.provider);
    if (!apiKey) return { ok: false as const, error: "No key stored for this provider." };
    const result = await testProviderKey(data.provider, apiKey);
    await supabaseAdmin
      .from("tenant_ai_credentials")
      .update({
        status: result.ok ? "valid" : "invalid",
        last_tested_at: new Date().toISOString(),
        last_error: result.ok ? null : result.error,
      })
      .eq("workspace_id", data.workspaceId)
      .eq("provider", data.provider);
    return result;
  });

// ---------- usage summary ----------

export const getAiUsageSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }): Promise<UsageSummary> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const { data: rows } = await supabaseAdmin
      .from("ai_usage_log")
      .select("created_at, provider, model, feature, total_tokens, cost_usd_micros, used_byok, status, error")
      .eq("workspace_id", data.workspaceId)
      .gte("created_at", monthStart.toISOString())
      .order("created_at", { ascending: false })
      .limit(500);

    const list = rows ?? [];
    let monthCostMicros = 0;
    let monthTokens = 0;
    let byokCalls = 0;
    let byokCostMicros = 0;
    let platformCalls = 0;
    let platformCostMicros = 0;
    for (const r of list) {
      monthCostMicros += r.cost_usd_micros ?? 0;
      monthTokens += r.total_tokens ?? 0;
      if (r.used_byok) {
        byokCalls++;
        byokCostMicros += r.cost_usd_micros ?? 0;
      } else {
        platformCalls++;
        platformCostMicros += r.cost_usd_micros ?? 0;
      }
    }

    const { data: q } = await supabaseAdmin
      .from("workspace_ai_quota")
      .select("platform_credits_remaining, lifetime_platform_used")
      .eq("workspace_id", data.workspaceId)
      .maybeSingle();

    return {
      monthCostUsd: monthCostMicros / 1_000_000,
      monthCalls: list.length,
      monthTokens,
      byok: { calls: byokCalls, costUsd: byokCostMicros / 1_000_000 },
      platform: { calls: platformCalls, costUsd: platformCostMicros / 1_000_000 },
      quotaRemaining: q?.platform_credits_remaining ?? 20,
      quotaLifetimeUsed: q?.lifetime_platform_used ?? 0,
      recent: list.slice(0, 25).map((r) => ({
        created_at: r.created_at as string,
        provider: r.provider as string,
        model: r.model as string,
        feature: (r.feature as string | null) ?? null,
        total_tokens: r.total_tokens ?? 0,
        cost_usd_micros: r.cost_usd_micros ?? 0,
        used_byok: !!r.used_byok,
        status: r.status as string,
        error: (r.error as string | null) ?? null,
      })),
    };
  });
