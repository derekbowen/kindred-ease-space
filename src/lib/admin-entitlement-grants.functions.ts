/**
 * ADMIN ENTITLEMENT GRANTS — free beta and test accounts, without Stripe.
 *
 * This is a billing override, so it is written to the same standard as billing:
 *
 *   - Platform admin only, via has_role(uid,'admin'). A workspace OWNER has no
 *     path here. Owning the workspace you are granting to is irrelevant — the
 *     check never looks at membership, only at the platform role.
 *   - Every mutation goes through the service-role client. `authenticated` and
 *     `anon` hold no INSERT/UPDATE/DELETE privilege on the grants table at all
 *     (see 20260918000000_entitlement_grants.sql), so there is no second path.
 *   - Append-only. Editing a grant is revoke + replace, never an in-place
 *     rewrite, so what was granted and by whom cannot be altered afterwards.
 *   - Every action writes billing_events with actor, before, after and reason.
 *
 * No Stripe object is created. A granted workspace has no subscription, no
 * customer record and no $0 price — it is entitled because an admin said so,
 * and the entitlement resolver treats that as a first-class reason to serve.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { readEntitlement } from "@/lib/entitlements.functions";
import { isGrantActive, type GrantRow } from "@/lib/entitlement-grants.server";

const sb = () => supabaseAdmin as any;

/** The product default offered in the admin UI. Admin may override all three. */
export const DEFAULT_BETA_GRANT = {
  grantType: "beta" as const,
  pageLimit: 50,
  durationDays: 30,
};

const GRANT_TYPES = ["trial", "beta", "promotional", "manual"] as const;

/**
 * Platform-admin assertion.
 *
 * Deliberately identical in shape to help-admin.functions.ts and
 * admin-canonical-audit.functions.ts: one pattern for "is this a platform
 * operator", so there is one thing to audit rather than three. Note it runs
 * through the service-role client — `has_role` is granted to authenticated too,
 * but reading it with the caller's own JWT would make the answer depend on RLS
 * on user_roles, and a role check that can be starved by a policy is not a
 * check.
 */
async function assertAdmin(userId: string): Promise<void> {
  const { data, error } = await sb().rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error) {
    // Fail CLOSED and loudly. An unreachable role check is not permission.
    console.error("[entitlement-grants] admin check failed", userId, error.message);
    throw new Error("forbidden");
  }
  if (!data) throw new Error("forbidden");
}

async function audit(
  workspaceId: string,
  eventType: "trial.granted" | "trial.updated" | "trial.revoked",
  actorId: string,
  before: any,
  after: any,
  reason: string,
): Promise<void> {
  const { error } = await sb()
    .from("billing_events")
    .insert({
      workspace_id: workspaceId,
      event_type: eventType,
      data: {
        actor_user_id: actorId,
        before: before ?? null,
        after: after ?? null,
        reason,
        recorded_at: new Date().toISOString(),
      },
    });
  if (error) {
    // The grant already happened. Losing its audit row is serious enough to
    // shout about, but throwing here would report failure for work that
    // succeeded and invite a retry that double-grants.
    console.error("[entitlement-grants] AUDIT WRITE FAILED", workspaceId, eventType, error.message);
  }
}

export type GrantSummary = {
  grants: GrantRow[];
  activeGrantIds: string[];
  /** Effective entitlement as the resolver computes it — not a second opinion. */
  entitlement: Awaited<ReturnType<typeof readEntitlement>>;
};

/**
 * Everything the admin screen shows for one workspace: the commercial plan, the
 * effective limit, pages used, and the full grant history.
 *
 * The entitlement figures come from readEntitlement(), the same function the
 * customer's own dashboard uses, so the admin view cannot disagree with what
 * the customer is actually allowed.
 */
export const listWorkspaceGrants = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<GrantSummary> => {
    await assertAdmin(context.userId);
    const [{ data: rows, error }, entitlement] = await Promise.all([
      sb()
        .from("workspace_entitlement_grants")
        .select("*")
        .eq("workspace_id", data.workspaceId)
        .order("created_at", { ascending: false }),
      readEntitlement(data.workspaceId),
    ]);
    if (error) throw new Error(`grant list failed: ${error.message}`);
    const grants = (rows ?? []) as GrantRow[];
    const now = Date.now();
    return {
      grants,
      activeGrantIds: grants.filter((g) => isGrantActive(g, now)).map((g) => g.id),
      entitlement,
    };
  });

/**
 * Every workspace, for the admin picker. Admin-only: this is a platform-wide
 * list, and a workspace member has no business enumerating other tenants.
 *
 * Returns the commercial facts only — the effective limit is deliberately NOT
 * computed here. Doing so would mean one readEntitlement() per workspace on a
 * list view, and the number that matters is shown once a workspace is selected.
 */
export const listGrantableWorkspaces = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const { data, error } = await sb()
      .from("workspaces")
      .select("id, name, slug, plan, subscription_status, trial_ends_at, is_internal")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(`workspace list failed: ${error.message}`);
    return (data ?? []) as Array<{
      id: string;
      name: string;
      slug: string | null;
      plan: string | null;
      subscription_status: string | null;
      trial_ends_at: string | null;
      is_internal: boolean;
    }>;
  });

const GrantInput = z.object({
  workspaceId: z.string().uuid(),
  grantType: z.enum(GRANT_TYPES),
  pageLimit: z.number().int().min(0).max(1_000_000),
  /** Omitted means "starts now". A future date schedules the grant. */
  startsAt: z.string().datetime().optional(),
  /** Omitted or null with noExpiry means permanent. */
  expiresAt: z.string().datetime().nullable().optional(),
  noExpiry: z.boolean().default(false),
  reason: z.string().trim().min(3).max(1000),
  metadata: z.record(z.string(), z.any()).optional(),
});

/**
 * Create a grant. Does not touch Stripe, the workspace row, or any page.
 *
 * Multiple concurrent grants are allowed and additive by design — a 50-page
 * beta plus a 20-page apology promo is 70 pages, and both stay separately
 * revocable and separately explicable.
 */
export const grantEntitlement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => GrantInput.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);

    const expiresAt = data.noExpiry ? null : (data.expiresAt ?? null);
    if (!data.noExpiry && expiresAt === null) {
      // Silence here would create a permanent grant from a UI where the
      // operator simply forgot the date. Permanence must be chosen, not
      // defaulted into.
      throw new Error("expires_at_required_unless_no_expiry");
    }

    const { data: row, error } = await sb()
      .from("workspace_entitlement_grants")
      .insert({
        workspace_id: data.workspaceId,
        grant_type: data.grantType,
        page_limit: data.pageLimit,
        starts_at: data.startsAt ?? new Date().toISOString(),
        expires_at: expiresAt,
        granted_by: context.userId,
        reason: data.reason,
        metadata: data.metadata ?? {},
      })
      .select("*")
      .single();
    if (error) throw new Error(`grant failed: ${error.message}`);

    await audit(data.workspaceId, "trial.granted", context.userId, null, row, data.reason);
    return row as GrantRow;
  });

/**
 * Revoke a grant. Sets revoked_at — the only column any statement after INSERT
 * may write — so the record of what was granted survives the revocation.
 *
 * Capacity disappears on the next entitlement evaluation, which is the next
 * read. Nothing is swept, no page is deleted, no URL is destroyed.
 */
export const revokeGrant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ grantId: z.string().uuid(), reason: z.string().trim().min(3).max(1000) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);

    const { data: before, error: readErr } = await sb()
      .from("workspace_entitlement_grants")
      .select("*")
      .eq("id", data.grantId)
      .maybeSingle();
    if (readErr) throw new Error(`grant read failed: ${readErr.message}`);
    if (!before) throw new Error("grant_not_found");
    if (before.revoked_at) return before as GrantRow; // already revoked; idempotent

    const { data: after, error } = await sb()
      .from("workspace_entitlement_grants")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.grantId)
      .is("revoked_at", null)
      .select("*")
      .single();
    if (error) throw new Error(`revoke failed: ${error.message}`);

    await audit(before.workspace_id, "trial.revoked", context.userId, before, after, data.reason);
    return after as GrantRow;
  });

/**
 * Extend or change a grant: revoke the old one and create its replacement, in
 * that order, recorded as `trial.updated`.
 *
 * Modelled as two rows rather than an UPDATE because the question worth
 * answering later is "what did we promise this customer, and when did it
 * change" — which an in-place edit destroys.
 */
export const replaceGrant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => GrantInput.extend({ replacesGrantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);

    const { data: before, error: readErr } = await sb()
      .from("workspace_entitlement_grants")
      .select("*")
      .eq("id", data.replacesGrantId)
      .maybeSingle();
    if (readErr) throw new Error(`grant read failed: ${readErr.message}`);
    if (!before) throw new Error("grant_not_found");
    if (before.workspace_id !== data.workspaceId) throw new Error("workspace_mismatch");

    const expiresAt = data.noExpiry ? null : (data.expiresAt ?? null);
    if (!data.noExpiry && expiresAt === null) {
      throw new Error("expires_at_required_unless_no_expiry");
    }

    if (!before.revoked_at) {
      const { error: revErr } = await sb()
        .from("workspace_entitlement_grants")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", data.replacesGrantId)
        .is("revoked_at", null);
      if (revErr) throw new Error(`replace failed at revoke: ${revErr.message}`);
    }

    const { data: after, error } = await sb()
      .from("workspace_entitlement_grants")
      .insert({
        workspace_id: data.workspaceId,
        grant_type: data.grantType,
        page_limit: data.pageLimit,
        starts_at: data.startsAt ?? new Date().toISOString(),
        expires_at: expiresAt,
        granted_by: context.userId,
        reason: data.reason,
        metadata: { ...(data.metadata ?? {}), replaces_grant_id: data.replacesGrantId },
      })
      .select("*")
      .single();
    if (error) throw new Error(`replace failed at insert: ${error.message}`);

    await audit(data.workspaceId, "trial.updated", context.userId, before, after, data.reason);
    return after as GrantRow;
  });
