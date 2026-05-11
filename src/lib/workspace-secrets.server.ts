import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Server-only BYOK helper. Reads a per-workspace API key from
 * `public.workspace_secrets`. Falls back to an env var if no per-workspace
 * key has been configured (useful in dev / for the original tenant).
 *
 * NEVER import this file from client code. NEVER expose returned values to
 * the browser.
 */
export async function getWorkspaceSecret(
  workspaceId: string,
  keyName: string,
  envFallback?: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("workspace_secrets")
    .select("value")
    .eq("workspace_id", workspaceId)
    .eq("key_name", keyName)
    .maybeSingle();
  if (error) {
    console.error(`workspace-secrets: failed to read ${keyName}:`, error.message);
  }
  if (data?.value) return data.value;
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
