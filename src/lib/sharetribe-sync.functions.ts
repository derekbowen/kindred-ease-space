import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertWorkspaceOwner } from "./admin-helpers.functions";
import {
  validateSharetribeCredentials,
  runSharetribeSyncForWorkspace,
} from "./sharetribe-sync.server";

async function assertMember(workspaceId: string, userId: string) {
  const { data, error } = await (supabaseAdmin as any).rpc("is_workspace_member", {
    _workspace_id: workspaceId,
    _user_id: userId,
  });
  if (error || !data) throw new Error("forbidden");
}

export const getSharetribeIntegration = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);
    const { data: row } = await (supabaseAdmin as any)
      .from("tenant_integrations")
      .select(
        "id, marketplace_url, marketplace_id, client_id, status, last_sync_at, last_sync_status, last_sync_error, listings_count, created_at, updated_at",
      )
      .eq("workspace_id", data.workspaceId)
      .eq("provider", "sharetribe")
      .maybeSingle();
    return { integration: row ?? null };
  });

export const connectSharetribe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        workspaceId: z.string().uuid(),
        marketplaceUrl: z.string().url().max(500),
        marketplaceId: z.string().uuid(),
        clientId: z.string().min(8).max(200),
        clientSecret: z.string().min(8).max(500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // Connecting rotates/overwrites stored credentials — owner-only.
    await assertWorkspaceOwner(data.workspaceId, context.userId);

    const v = await validateSharetribeCredentials({
      clientId: data.clientId,
      clientSecret: data.clientSecret,
    });
    if (!v.ok) return { ok: false as const, error: v.error };
    if (v.marketplaceId !== data.marketplaceId) {
      return {
        ok: false as const,
        error: `Marketplace ID mismatch (API returned ${v.marketplaceId})`,
      };
    }

    // Save secret via vault helper, called as the user (RLS-checked).
    const { supabase } = context;
    const { data: vaultId, error: vaultErr } = await (supabase as any).rpc(
      "tenant_set_integration_secret",
      { _workspace_id: data.workspaceId, _client_secret: data.clientSecret },
    );
    if (vaultErr || !vaultId) {
      console.error("[connectSharetribe] vault error", vaultErr);
      return { ok: false as const, error: "Failed to encrypt credentials" };
    }

    const { error: upsertErr } = await (supabaseAdmin as any)
      .from("tenant_integrations")
      .upsert(
        {
          workspace_id: data.workspaceId,
          provider: "sharetribe",
          marketplace_url: data.marketplaceUrl.replace(/\/+$/, ""),
          marketplace_id: data.marketplaceId,
          client_id: data.clientId,
          client_secret_vault_id: vaultId,
          status: "connected",
          last_sync_error: null,
        },
        { onConflict: "workspace_id,provider" },
      );
    if (upsertErr) {
      console.error("[connectSharetribe] upsert error", upsertErr);
      return { ok: false as const, error: "Failed to save integration" };
    }

    return { ok: true as const };
  });

export const disconnectSharetribe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    // Disconnecting hard-deletes the integration AND every synced listing — owner-only.
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    await (supabaseAdmin as any)
      .from("tenant_integrations")
      .delete()
      .eq("workspace_id", data.workspaceId)
      .eq("provider", "sharetribe");
    await (supabaseAdmin as any).from("tenant_listings").delete().eq("workspace_id", data.workspaceId);
    return { ok: true as const };
  });

export const runSharetribeSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);
    try {
      const r = await runSharetribeSyncForWorkspace(data.workspaceId);
      return { ok: true as const, ...r };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "sync_failed",
      };
    }
  });
