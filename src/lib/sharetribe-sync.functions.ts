import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertWorkspaceOwner } from "./admin-helpers.functions";
import {
  validateSharetribeCredentials,
  runSharetribeSyncForWorkspace,
  friendlySharetribeError,
  type SharetribeAuthMode,
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
        "id, marketplace_url, marketplace_id, marketplace_name, client_id, auth_mode, status, last_sync_at, last_sync_status, last_sync_error, listings_count, created_at, updated_at",
      )
      .eq("workspace_id", data.workspaceId)
      .eq("provider", "sharetribe")
      .maybeSingle();
    return { integration: row ?? null };
  });

const connectInput = z
  .object({
    workspaceId: z.string().uuid(),
    marketplaceUrl: z.string().min(8).max(500),
    authMode: z.enum(["marketplace", "integration"]).default("marketplace"),
    clientId: z.string().trim().min(8).max(200),
    // Only the Integration API needs a secret. Marketplace API applications
    // authenticate with the Client ID alone (public-read scope).
    clientSecret: z.string().min(8).max(500).optional(),
    // Optional cross-check: if the owner pastes their Marketplace ID it must
    // match what the API reports for the given credentials.
    marketplaceId: z.string().uuid().optional(),
  })
  .refine((d) => d.authMode !== "integration" || !!d.clientSecret, {
    message: "The Integration API needs a Client Secret.",
    path: ["clientSecret"],
  });

export const connectSharetribe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => connectInput.parse(d))
  .handler(async ({ data, context }) => {
    // Connecting rotates/overwrites stored credentials — owner-only.
    await assertWorkspaceOwner(data.workspaceId, context.userId);

    const authMode: SharetribeAuthMode = data.authMode;

    let marketplaceUrl = data.marketplaceUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(marketplaceUrl)) {
      marketplaceUrl = `https://${marketplaceUrl}`;
    }
    try {
      new URL(marketplaceUrl);
    } catch {
      return { ok: false as const, error: "That doesn't look like a valid marketplace URL." };
    }

    const v = await validateSharetribeCredentials({
      mode: authMode,
      clientId: data.clientId,
      clientSecret: authMode === "integration" ? data.clientSecret : undefined,
    });
    if (!v.ok) return { ok: false as const, error: v.error };
    if (data.marketplaceId && v.marketplaceId !== data.marketplaceId) {
      return {
        ok: false as const,
        error:
          "That Client ID belongs to a different marketplace than the Marketplace ID you entered. Leave the Marketplace ID blank or use the application from the right marketplace.",
      };
    }

    const { data: existing } = await (supabaseAdmin as any)
      .from("tenant_integrations")
      .select("id, client_secret_vault_id")
      .eq("workspace_id", data.workspaceId)
      .eq("provider", "sharetribe")
      .maybeSingle();

    let vaultId: string | null = null;
    if (authMode === "integration") {
      // Save secret via vault helper, called as the user (RLS-checked).
      const { supabase } = context;
      const { data: id, error: vaultErr } = await (supabase as any).rpc(
        "tenant_set_integration_secret",
        { _workspace_id: data.workspaceId, _client_secret: data.clientSecret },
      );
      if (vaultErr || !id) {
        console.error("[connectSharetribe] vault error", vaultErr);
        return { ok: false as const, error: "We couldn't store the Client Secret securely. Try again." };
      }
      vaultId = id as string;
    } else if (existing?.client_secret_vault_id) {
      // Switching an Integration API connection to the Marketplace API: the
      // old secret is no longer needed, so it must not stay decryptable.
      const { error: secretErr } = await (supabaseAdmin as any).rpc(
        "tenant_delete_integration_secret",
        { _workspace_id: data.workspaceId },
      );
      if (secretErr) {
        console.error("[connectSharetribe] vault secret cleanup failed", secretErr.message);
        return {
          ok: false as const,
          error: "We couldn't remove the previous Integration API secret. Try again.",
        };
      }
    }

    const { error: upsertErr } = await (supabaseAdmin as any).from("tenant_integrations").upsert(
      {
        workspace_id: data.workspaceId,
        provider: "sharetribe",
        marketplace_url: marketplaceUrl,
        marketplace_id: v.marketplaceId,
        marketplace_name: v.name ?? null,
        client_id: data.clientId,
        client_secret_vault_id: vaultId,
        auth_mode: authMode,
        status: "connected",
        last_sync_error: null,
      },
      { onConflict: "workspace_id,provider" },
    );
    if (upsertErr) {
      console.error("[connectSharetribe] upsert error", upsertErr);
      return { ok: false as const, error: "We couldn't save the connection. Try again." };
    }

    return { ok: true as const, marketplaceName: v.name ?? null, authMode };
  });

export const disconnectSharetribe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    // Disconnecting hard-deletes the integration AND every synced listing — owner-only.
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const { error: intErr } = await (supabaseAdmin as any)
      .from("tenant_integrations")
      .delete()
      .eq("workspace_id", data.workspaceId)
      .eq("provider", "sharetribe");
    if (intErr) {
      console.error("[disconnectSharetribe] integration delete failed", intErr.message);
      return { ok: false as const, error: "We couldn't remove the connection. Try again." };
    }
    const { error: listErr } = await (supabaseAdmin as any)
      .from("tenant_listings")
      .delete()
      .eq("workspace_id", data.workspaceId);
    if (listErr) {
      console.error("[disconnectSharetribe] listings delete failed", listErr.message);
      return {
        ok: false as const,
        error:
          "The connection was removed, but the synced listings could not be deleted. Try again to clear them.",
      };
    }
    // Remove the client secret from Vault — leaving a disconnected customer's
    // credential decryptable forever is a liability. Marketplace API
    // connections never stored one, so the delete is a no-op for them.
    const { error: secretErr } = await (supabaseAdmin as any).rpc(
      "tenant_delete_integration_secret",
      { _workspace_id: data.workspaceId },
    );
    if (secretErr) {
      console.error("[disconnectSharetribe] vault secret cleanup failed", secretErr.message);
    }
    return { ok: true as const };
  });

export const runSharetribeSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);
    const { data: row } = await (supabaseAdmin as any)
      .from("tenant_integrations")
      .select("auth_mode")
      .eq("workspace_id", data.workspaceId)
      .eq("provider", "sharetribe")
      .maybeSingle();
    const mode: SharetribeAuthMode = row?.auth_mode === "marketplace" ? "marketplace" : "integration";
    try {
      const r = await runSharetribeSyncForWorkspace(data.workspaceId);
      return { ok: true as const, ...r };
    } catch (e) {
      return { ok: false as const, error: friendlySharetribeError(e, mode) };
    }
  });

/**
 * Certify the marketplace connection: prove the customer's real listing and
 * search routes actually resolve, not merely that credentials authenticate.
 * Dynamic marketplace pages should not publish against an uncertified
 * integration.
 */
export const certifyMarketplace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const { certifyMarketplaceConnection } = await import("@/lib/marketplace/certification.server");
    const result = await certifyMarketplaceConnection(data.workspaceId);
    return { ok: result.status === "CERTIFIED", ...result };
  });
