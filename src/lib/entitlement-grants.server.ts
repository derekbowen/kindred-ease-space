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
 *
 * THE FOUNDER / INTERNAL UNLIMITED ENTITLEMENT is a grant too (grant_type
 * 'internal', migration 20260924000700), and isInternalUnlimited below is its
 * one application-side predicate: the SQL predicate
 * workspace_is_internal_unlimited(uuid), read fresh on every call — no cache
 * of any kind, so nothing can leak between workspaces or outlive a
 * revocation. Keyed by the workspace only: never an email address, a
 * platform role or anything the client sends.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

/** The one database capability the predicate needs (supabase-js .rpc). A test seam. */
export type GrantRpcDb = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/**
 * Does this workspace hold an ACTIVE internal grant right now (not revoked,
 * started, not expired; a NULL expiry is permanent)? Throws on a read
 * failure: every caller picks its own fail direction — a limit check treats
 * a failure as "no" (the normal limits apply), never as "yes".
 */
export async function isInternalUnlimited(workspaceId: string, db?: GrantRpcDb): Promise<boolean> {
  const client = db ?? (supabaseAdmin as unknown as GrantRpcDb);
  const { data, error } = await client.rpc("workspace_is_internal_unlimited", {
    _workspace_id: workspaceId,
  });
  if (error) throw new Error(`internal entitlement read failed: ${error.message}`);
  return data === true;
}

/** isInternalUnlimited for a limit or a feature gate: a failed read is "no" (fail closed), logged. */
export async function isInternalUnlimitedOrFalse(workspaceId: string, db?: GrantRpcDb): Promise<boolean> {
  try {
    return await isInternalUnlimited(workspaceId, db);
  } catch (e) {
    console.error(
      "[entitlement-grants] internal entitlement read failed; treating as not internal:",
      workspaceId,
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
}

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

/** Every grant type the table accepts (CHECK in 20260924000700). */
export const GRANT_TYPES = ["trial", "beta", "promotional", "manual", "internal"] as const;
export type GrantType = (typeof GRANT_TYPES)[number];

/**
 * May this workspace use the Affiliate add-on? Its own add-on status says
 * active or trialing — or the workspace holds the founder / internal
 * unlimited entitlement (every add-on included). A failed internal read is
 * "no" (fail closed): the add-on status alone decides then.
 */
export async function affiliateAddonUsable(
  workspaceId: string,
  addonStatus: string | null | undefined,
  db?: GrantRpcDb,
): Promise<boolean> {
  if (addonStatus === "active" || addonStatus === "trialing") return true;
  return isInternalUnlimitedOrFalse(workspaceId, db);
}

export type GrantRow = {
  id: string;
  workspace_id: string;
  grant_type: GrantType;
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
