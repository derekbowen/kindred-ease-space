import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";

const sb = () => supabaseAdmin as any;

export type SettingsContext = {
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
  configuredAiProviders: string[];
};

export const getSettingsContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }): Promise<SettingsContext> => {
    const role = await assertWorkspaceMember(data.workspaceId, context.userId);
    const isOwner = role === "owner";

    const [
      { data: ws },
      { data: domains },
      { data: integration },
      { data: secrets },
      { data: aiCreds },
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
      sb().from("tenant_ai_credentials").select("provider").eq("workspace_id", data.workspaceId),
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
      configuredAiProviders: (aiCreds ?? []).map((c: any) => c.provider as string),
    };
  });
