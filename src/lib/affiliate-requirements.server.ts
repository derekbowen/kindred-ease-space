/**
 * Server side of the Affiliate add-on's connection requirement (see
 * ./affiliate-requirements.ts): read how the workspace is connected to
 * Sharetribe, and refuse what the add-on cannot do on that connection.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  affiliateConnectionProblem,
  connectionModeOf,
  type SharetribeConnectionMode,
} from "@/lib/affiliate-requirements";

const sb = () => supabaseAdmin as any;

/**
 * The workspace's Sharetribe connection mode, read fresh. Throws when the
 * read fails: callers that gate on it must not guess.
 */
export async function readSharetribeConnectionMode(
  workspaceId: string,
): Promise<SharetribeConnectionMode> {
  const { data, error } = await sb()
    .from("tenant_integrations")
    .select("auth_mode")
    .eq("workspace_id", workspaceId)
    .eq("provider", "sharetribe")
    .maybeSingle();
  if (error) {
    console.error("[affiliate-requirements] connection read failed", workspaceId, error.message);
    throw new Error("Couldn't check your Sharetribe connection. Try again in a minute.");
  }
  return connectionModeOf(data as { auth_mode?: string | null } | null);
}

/**
 * Throws the customer sentence unless the workspace is connected through the
 * Integration API. Called by startAffiliateTrial before the trial starts.
 */
export async function assertAffiliateConnection(workspaceId: string): Promise<void> {
  const problem = affiliateConnectionProblem(await readSharetribeConnectionMode(workspaceId));
  if (problem) throw new Error(problem);
}
