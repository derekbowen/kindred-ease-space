import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import { internalAccessFields, type InternalAccessFields } from "@/lib/billing-capacity";

const sb = () => supabaseAdmin as any;

/**
 * internalUnlimited / planLabel / revealLaunchHiddenFeatures: the founder /
 * internal unlimited entitlement, computed here from the workspace's grants
 * on every request (member-only, read-only; see InternalAccessFields).
 */
export type SettingsContext = InternalAccessFields & {
  role: string;
  isOwner: boolean;
  workspace: {
    id: string;
    name: string;
    marketplace_domain: string | null;
    domain_verified_at: string | null;
    brand_name: string | null;
    brand_color: string | null;
    logo_url: string | null;
  } | null;
  domains: Array<{ hostname: string; verified: boolean }>;
  sharetribeConnected: boolean;
  configuredSecretKeys: string[];
  /**
   * The AI providers this workspace has its own key for: ["openai"] when the
   * one BYOK store (the workspace secret OPENAI_API_KEY, what every AI call
   * reads) holds a key, otherwise []. Never the retired
   * tenant_ai_credentials rows, which no AI path reads.
   */
  configuredAiProviders: string[];
};

export const getSettingsContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }): Promise<SettingsContext> => {
    const role = await assertWorkspaceMember(data.workspaceId, context.userId);
    const isOwner = role === "owner";

    const { isInternalUnlimitedOrFalse } = await import("@/lib/entitlement-grants.server");
    const [
      { data: ws },
      { data: domains },
      { data: integration },
      { data: secrets },
      { data: ownAiKey },
      internal,
    ] = await Promise.all([
      sb()
        .from("workspaces")
        .select(
          "id, name, marketplace_domain, domain_verified_at, brand_name, brand_color, logo_url",
        )
        .eq("id", data.workspaceId)
        .maybeSingle(),
      sb()
        .from("workspace_domains")
        .select("hostname, verified")
        .eq("workspace_id", data.workspaceId)
        .order("created_at", { ascending: false }),
      sb()
        .from("tenant_integrations")
        .select("status")
        .eq("workspace_id", data.workspaceId)
        .eq("provider", "sharetribe")
        .maybeSingle(),
      isOwner
        ? sb().from("workspace_secrets").select("key_name").eq("workspace_id", data.workspaceId)
        : Promise.resolve({ data: [] }),
      // Existence only (the row id), for every member: the same read the model
      // picker makes (src/lib/ai-models.functions.ts).
      sb()
        .from("workspace_secrets")
        .select("id")
        .eq("workspace_id", data.workspaceId)
        .eq("key_name", "OPENAI_API_KEY")
        .maybeSingle(),
      isInternalUnlimitedOrFalse(data.workspaceId),
    ]);

    return {
      role,
      isOwner,
      workspace: ws ?? null,
      domains: (domains ?? []).map((d: any) => ({
        hostname: d.hostname,
        verified: d.verified,
      })),
      sharetribeConnected: integration?.status === "connected",
      configuredSecretKeys: (secrets ?? []).map((s: any) => s.key_name as string),
      configuredAiProviders: ownAiKey ? ["openai"] : [],
      ...internalAccessFields(internal),
    };
  });
