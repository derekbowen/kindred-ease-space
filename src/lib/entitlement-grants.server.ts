/**
 * ACTIVE ADMIN GRANTS, read server-side.
 *
 * Every caller of `decideCapacity` needs this number, because a free beta
 * account has no Stripe object at all: without it the billing facts read as
 * "no subscription" and the workspace is refused publishing and serving no
 * matter how large its grant.
 *
 * The sum is computed in SQL (`public.workspace_granted_pages`) rather than by
 * selecting rows and adding them here, so that the active-grant predicate —
 * not revoked, already started, not yet expired — has exactly one definition.
 * Expiry is therefore a timestamp comparison at read time; no sweep job has to
 * run for a grant to lapse.
 *
 * Both functions are service-role only. `anon` and `authenticated` hold no
 * EXECUTE privilege on either, so a customer cannot ask the database what they
 * have been granted, let alone change it.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

/**
 * Pages granted and active right now. Throws on a read failure rather than
 * returning 0 — callers must choose their own fail direction, and silently
 * reporting "no grant" would dark a beta customer's live site on a transient
 * database blip.
 */
export async function readGrantedPages(workspaceId: string): Promise<number> {
  const { data, error } = await sb().rpc("workspace_granted_pages", {
    _workspace_id: workspaceId,
  });
  if (error) {
    throw new Error(`granted pages read failed: ${error.message}`);
  }
  const n = typeof data === "number" ? data : Number(data ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * The same read for paths that must never fail closed — the public page
 * serving gate and the sitemap, both of which already serve on a billing read
 * error rather than take a paying customer's site down over a blip.
 *
 * Returns `null` when the read failed, which those callers treat as "cannot
 * evaluate, so do not withhold" — distinct from a confident 0.
 */
export async function readGrantedPagesOrNull(workspaceId: string): Promise<number | null> {
  try {
    return await readGrantedPages(workspaceId);
  } catch (e) {
    console.error(
      "[entitlement-grants] granted pages read failed, not withholding:",
      workspaceId,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

export type GrantRow = {
  id: string;
  workspace_id: string;
  grant_type: "trial" | "beta" | "promotional" | "manual";
  page_limit: number;
  starts_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  granted_by: string;
  reason: string;
  metadata: Record<string, any>;
  created_at: string;
};

/** Whether a grant row is contributing capacity at `now`. Mirrors the SQL predicate. */
export function isGrantActive(g: GrantRow, now: number = Date.now()): boolean {
  if (g.revoked_at) return false;
  const starts = Date.parse(g.starts_at);
  if (Number.isFinite(starts) && starts > now) return false;
  if (g.expires_at === null) return true; // NULL expiry means never expires
  const ends = Date.parse(g.expires_at);
  return Number.isFinite(ends) ? ends > now : false;
}
