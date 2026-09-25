import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  assertWorkspaceMember,
  assertWorkspaceOwner,
  workspaceIdSchema,
} from "./admin-helpers.functions";

/**
 * Bring-your-own-key, OpenAI only, ONE store: the workspace secret
 * OPENAI_API_KEY (workspace_secrets, encrypted in Vault) — the same secret
 * the AI Keys page manages and the only key source any AI path reads
 * (src/lib/ai/spend.server.ts resolveAiKey). tenant_ai_credentials is
 * retired as a key source: nothing here or anywhere else reads a key from it.
 *
 * The key test is a models.retrieve through the provider module — no tokens
 * are generated, so nothing is spent and nothing is reserved.
 */

export const AI_PROVIDERS = ["openai"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** The workspace secret every AI path reads for the workspace's own key. */
export const BYOK_SECRET_NAME = "OPENAI_API_KEY";

const providerSchema = z.enum(AI_PROVIDERS);

export type CredentialRow = {
  provider: AiProvider;
  last_four: string;
  status: "untested" | "valid" | "invalid";
  updated_at: string;
};

/**
 * Usage VOLUME for the workspace this month, and what its own key was
 * billed. What the platform side costs is never shown here: included AI is
 * described by ONE figure, getAiAllowance (src/lib/ai-allowance.functions.ts),
 * never by quota units, credits or provider dollars.
 */
export type UsageSummary = {
  monthCalls: number;
  monthTokens: number;
  byok: { calls: number; costUsd: number };
  platform: { calls: number };
  recent: Array<{
    created_at: string;
    provider: string;
    model: string;
    feature: string | null;
    total_tokens: number;
    /** What the workspace's own key was billed; null for calls on the platform key (included). */
    cost_usd_micros: number | null;
    used_byok: boolean;
    status: string;
    error: string | null;
  }>;
};

const SAVE_FAILED = "Could not save the key. Try again, or contact support if it keeps happening.";
const DELETE_FAILED = "Could not remove the key. Try again, or contact support if it keeps happening.";

// ---------- list ----------

export const listAiCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).strict().parse(d))
  .handler(async ({ data, context }): Promise<{ rows: CredentialRow[] }> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const { data: row } = await supabaseAdmin
      .from("workspace_secrets")
      .select("key_name, last_four, updated_at")
      .eq("workspace_id", data.workspaceId)
      .eq("key_name", BYOK_SECRET_NAME)
      .maybeSingle();
    if (!row) return { rows: [] };
    return {
      rows: [
        {
          provider: "openai",
          last_four: (row as { last_four?: string | null }).last_four ?? "",
          status: "untested",
          updated_at: (row as { updated_at: string }).updated_at,
        },
      ],
    };
  });

// ---------- upsert (the one store) ----------

const upsertSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    provider: providerSchema,
    apiKey: z.string().min(8).max(500),
  })
  // No model, no default model, no provider parameter: the platform decides those.
  .strict();

export const upsertAiCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    // The authenticated client: the RPC's owner check reads auth.uid().
    const { error } = await context.supabase.rpc("tenant_set_workspace_secret", {
      _workspace_id: data.workspaceId,
      _key_name: BYOK_SECRET_NAME,
      _value: data.apiKey.trim(),
    });
    if (error) {
      console.error("[ai-byok] save failed", error.message);
      return { ok: false as const, error: SAVE_FAILED };
    }
    return { ok: true as const };
  });

// ---------- delete ----------

export const deleteAiCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, provider: providerSchema }).strict().parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const { data: row } = await supabaseAdmin
      .from("workspace_secrets")
      .select("id")
      .eq("workspace_id", data.workspaceId)
      .eq("key_name", BYOK_SECRET_NAME)
      .maybeSingle();
    if (!row) return { ok: true as const };
    const { error } = await context.supabase.rpc("tenant_delete_workspace_secret", {
      _workspace_id: data.workspaceId,
      _id: (row as { id: string }).id,
    });
    if (error) {
      console.error("[ai-byok] delete failed", error.message);
      return { ok: false as const, error: DELETE_FAILED };
    }
    return { ok: true as const };
  });

// ---------- test key (zero tokens) ----------

export const testAiCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, provider: providerSchema }).strict().parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const { data: apiKey, error } = await supabaseAdmin.rpc("tenant_get_workspace_secret", {
      _workspace_id: data.workspaceId,
      _key_name: BYOK_SECRET_NAME,
    });
    if (error) {
      console.error("[ai-byok] key read failed", error.message);
      return { ok: false as const, error: "Could not read the saved key. Try again in a minute." };
    }
    if (typeof apiKey !== "string" || !apiKey) {
      return { ok: false as const, error: "No key is saved for this workspace yet." };
    }
    const { verifyOpenAiKey } = await import("@/lib/ai/openai.server");
    const check = await verifyOpenAiKey(apiKey);
    if (check.ok) return { ok: true as const };
    const error_ =
      check.reason === "invalid_key"
        ? "The AI provider rejected this key. Check it and save it again."
        : check.reason === "no_access"
          ? "This key cannot use the model the app runs on. Check the key's project permissions."
          : "The key could not be tested right now. Try again in a minute.";
    return { ok: false as const, error: error_ };
  });

// ---------- usage summary ----------

export const getAiUsageSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).strict().parse(d))
  .handler(async ({ data, context }): Promise<UsageSummary> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const { data: rows } = await supabaseAdmin
      .from("ai_usage_log")
      .select(
        "created_at, provider, model, feature, total_tokens, cost_usd_micros, used_byok, status, error",
      )
      .eq("workspace_id", data.workspaceId)
      .gte("created_at", monthStart.toISOString())
      .order("created_at", { ascending: false })
      .limit(500);

    const list = rows ?? [];
    let monthTokens = 0;
    let byokCalls = 0;
    let byokCostMicros = 0;
    let platformCalls = 0;
    for (const r of list) {
      monthTokens += r.total_tokens ?? 0;
      if (r.used_byok) {
        byokCalls++;
        byokCostMicros += r.cost_usd_micros ?? 0;
      } else {
        platformCalls++;
      }
    }

    return {
      monthCalls: list.length,
      monthTokens,
      byok: { calls: byokCalls, costUsd: byokCostMicros / 1_000_000 },
      platform: { calls: platformCalls },
      recent: list.slice(0, 25).map((r) => ({
        created_at: r.created_at as string,
        provider: r.provider as string,
        model: r.model as string,
        feature: (r.feature as string | null) ?? null,
        total_tokens: r.total_tokens ?? 0,
        cost_usd_micros: r.used_byok ? (r.cost_usd_micros ?? 0) : null,
        used_byok: !!r.used_byok,
        status: r.status as string,
        // Only short failure codes are ever stored here (ai_settle refuses
        // anything else); nothing from a provider or the database.
        error: (r.error as string | null) ?? null,
      })),
    };
  });
