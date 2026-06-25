import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Server-only BYOK helper. Reads a per-workspace API key from Supabase Vault
 * via the `tenant_get_workspace_secret` SECURITY DEFINER RPC. Falls back to an
 * env var if no per-workspace key has been configured.
 *
 * NEVER import this file from client code. NEVER expose returned values to
 * the browser.
 */
export async function getWorkspaceSecret(
  workspaceId: string,
  keyName: string,
  envFallback?: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin.rpc("tenant_get_workspace_secret", {
    _workspace_id: workspaceId,
    _key_name: keyName,
  });
  if (error) {
    console.error(`workspace-secrets: failed to read ${keyName}:`, error.message);
  }
  if (typeof data === "string" && data.length > 0) return data;
  if (envFallback) {
    const envVal = process.env[envFallback];
    if (envVal) return envVal;
  }
  return null;
}

export async function requireWorkspaceSecret(
  workspaceId: string,
  keyName: string,
  envFallback?: string,
): Promise<string> {
  const v = await getWorkspaceSecret(workspaceId, keyName, envFallback);
  if (!v) {
    throw new Error(
      `Missing API key '${keyName}' for this workspace. Add it under Settings → API Keys.`,
    );
  }
  return v;
}
