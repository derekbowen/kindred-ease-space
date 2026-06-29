import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendEmail, welcomeEmailTemplate } from "@/lib/email.server";

const STARTER_TRIAL_CREDITS = 250;

export const createWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        name: z.string().min(2).max(80),
        marketplaceDomain: z
          .string()
          .min(3)
          .max(120)
          .regex(/^[a-z0-9.-]+$/i, "Use only letters, numbers, dots and dashes"),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const slugBase =
      data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "workspace";
    const slug = `${slugBase}-${Math.random().toString(36).slice(2, 8)}`;
    const domain = data.marketplaceDomain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

    const { count: ownedWorkspaces } = await supabaseAdmin
      .from("workspace_members")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("role", "owner");

    const { data: ws, error } = await supabaseAdmin
      .from("workspaces")
      .insert({
        slug,
        name: data.name,
        marketplace_domain: domain,
        owner_user_id: userId,
        plan: "starter",
        subscription_status: "trialing",
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select("id, slug")
      .single();

    if (error || !ws) {
      console.error("[createWorkspace] insert error", error);
      // Surface the underlying reason — a generic message makes a stuck signup
      // impossible to diagnose for the user (and us).
      throw new Error(
        error?.message ? `Couldn't create workspace: ${error.message}` : "Failed to create workspace. Please try again.",
      );
    }

    // Owner membership is essential — if it fails the user would land back on
    // onboarding forever (getMe sees no workspace). Check it, and roll back the
    // orphaned workspace so a retry is clean.
    const { error: memberErr } = await supabaseAdmin.from("workspace_members").insert({
      workspace_id: ws.id,
      user_id: userId,
      role: "owner",
    });
    if (memberErr) {
      console.error("[createWorkspace] member insert error", memberErr);
      await supabaseAdmin.from("workspaces").delete().eq("id", ws.id);
      throw new Error(`Couldn't link you to the workspace: ${memberErr.message}`);
    }

    // Trial credits only on a user's first owned workspace. Non-fatal if grant fails.
    if ((ownedWorkspaces ?? 0) === 0) {
      try {
        const { error: grantErr } = await supabaseAdmin.rpc("grant_credits", {
          _workspace_id: ws.id,
          _amount: STARTER_TRIAL_CREDITS,
          _reason: "trial_grant",
          _ref_type: "trial",
          _ref_id: ws.id,
          _metadata: { source: "onboarding" },
        });
        if (grantErr) console.error("[createWorkspace] grant_credits failed (non-fatal)", grantErr);
      } catch (e) {
        console.error("[createWorkspace] grant_credits threw (non-fatal)", e);
      }
    }

    // Fire-and-forget welcome email — never block workspace creation.
    const userEmail = (context.claims as { email?: string } | undefined)?.email;
    if (userEmail) {
      welcomeEmailTemplate({
        name: data.name,
        workspaceSlug: ws.slug,
      }).then((tpl) => {
        if (!tpl) return;
        return sendEmail({
          to: userEmail,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
          idempotencyKey: `welcome-${ws.id}`,
          meta: { workspace_id: ws.id, kind: "welcome" },
        });
      }).catch((err) => console.error("[createWorkspace] welcome email failed", err));
    }

    return { workspaceId: ws.id, slug: ws.slug };
  });

/**
 * Auto-provision a workspace so a new user never hits a setup wall. If they
 * already belong to one, returns it. Otherwise creates a default workspace
 * (name/domain are filled in later from the optional setup portal in Settings).
 * Idempotent: safe to call on every app entry.
 */
export const ensureWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context;

    const { data: existing } = await supabaseAdmin
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    if (existing?.workspace_id) return { workspaceId: existing.workspace_id, created: false };

    const slug = `ws-${Math.random().toString(36).slice(2, 10)}`;
    const { data: ws, error } = await supabaseAdmin
      .from("workspaces")
      .insert({
        slug,
        name: "My Marketplace",
        owner_user_id: userId,
        plan: "starter",
        subscription_status: "trialing",
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select("id")
      .single();
    if (error || !ws) {
      console.error("[ensureWorkspace] insert error", error);
      throw new Error(error?.message ? `Couldn't set up your workspace: ${error.message}` : "Couldn't set up your workspace.");
    }

    const { error: memberErr } = await supabaseAdmin
      .from("workspace_members")
      .insert({ workspace_id: ws.id, user_id: userId, role: "owner" });
    if (memberErr) {
      // TOCTOU: a parallel ensureWorkspace() call already created an owner
      // membership for this user (blocked by the partial unique index
      // workspace_members_one_owner_per_user). Roll back our orphan workspace
      // and return the winner so the caller still gets a usable workspaceId.
      console.warn("[ensureWorkspace] owner-membership race; reconciling", memberErr.message);
      await supabaseAdmin.from("workspaces").delete().eq("id", ws.id);
      const { data: winner } = await supabaseAdmin
        .from("workspace_members")
        .select("workspace_id")
        .eq("user_id", userId)
        .eq("role", "owner")
        .limit(1)
        .maybeSingle();
      if (winner?.workspace_id) return { workspaceId: winner.workspace_id, created: false };
      throw new Error(`Couldn't link you to the workspace: ${memberErr.message}`);
    }

    // Non-fatal trial credits — first workspace only (auto_provision is first-time).
    try {
      const { error: grantErr } = await supabaseAdmin.rpc("grant_credits", {
        _workspace_id: ws.id,
        _amount: STARTER_TRIAL_CREDITS,
        _reason: "trial_grant",
        _ref_type: "trial",
        _ref_id: ws.id,
        _metadata: { source: "auto_provision" },
      });
      if (grantErr) console.error("[ensureWorkspace] grant_credits failed (non-fatal)", grantErr);
    } catch (e) {
      console.error("[ensureWorkspace] grant_credits failed (non-fatal)", e);
    }

    return { workspaceId: ws.id, created: true };
  });


/** Editable workspace profile — the optional "setup portal" (name + domain). */
export const updateWorkspaceProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        workspaceId: z.string().uuid(),
        name: z.string().trim().min(2).max(80).optional(),
        marketplaceDomain: z.string().trim().max(120).optional().or(z.literal("")),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { data: isOwner } = await supabaseAdmin.rpc("is_workspace_owner", {
      _workspace_id: data.workspaceId,
      _user_id: context.userId,
    });
    if (!isOwner) throw new Error("Not allowed");

    const patch: { name?: string; marketplace_domain?: string | null } = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.marketplaceDomain !== undefined) {
      patch.marketplace_domain = data.marketplaceDomain
        ? data.marketplaceDomain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")
        : null;
    }
    const { error } = await supabaseAdmin.from("workspaces").update(patch).eq("id", data.workspaceId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const getWorkspaceOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ workspaceId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Explicit membership check — don't trust the client-supplied workspaceId.
    const { data: isMember } = await supabaseAdmin.rpc("is_workspace_member", {
      _workspace_id: data.workspaceId,
      _user_id: userId,
    });
    if (!isMember) throw new Error("Not allowed");

    const [
      { data: ws },
      { data: balance },
      { count: tenantPageCount },
      { count: listingCount },
      { data: sharetribe },
    ] = await Promise.all([
      supabase
        .from("workspaces")
        .select("id, name, plan, subscription_status, trial_ends_at, marketplace_domain, domain_verified_at, current_period_end")
        .eq("id", data.workspaceId)
        .single(),
      supabase
        .from("credit_balances")
        .select("balance, monthly_allowance, cycle_resets_at, lifetime_spent")
        .eq("workspace_id", data.workspaceId)
        .maybeSingle(),
      supabaseAdmin
        .from("tenant_pages")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", data.workspaceId)
        .eq("status", "published"),
      supabaseAdmin
        .from("tenant_listings")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", data.workspaceId),
      supabaseAdmin
        .from("tenant_integrations")
        .select("status, listings_count, last_sync_at")
        .eq("workspace_id", data.workspaceId)
        .eq("provider", "sharetribe")
        .maybeSingle(),
    ]);

    const sharetribeConnected = sharetribe?.status === "connected";

    return {
      workspace: ws ?? null,
      balance: balance ?? null,
      stats: {
        publishedPages: tenantPageCount ?? 0,
        syncedListings: listingCount ?? 0,
        sharetribeConnected,
        sharetribeListingsCount: sharetribe?.listings_count ?? listingCount ?? 0,
        lastSharetribeSync: sharetribe?.last_sync_at ?? null,
      },
    };
  });

export const updateWorkspaceBranding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        workspaceId: z.string().uuid(),
        brandName: z.string().trim().max(60).nullable().optional(),
        brandColor: z
          .string()
          .trim()
          .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #1e90ff")
          .nullable()
          .optional(),
        logoUrl: z.string().url().max(500).nullable().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;

    const { data: isOwner } = await supabaseAdmin.rpc("is_workspace_owner", {
      _workspace_id: data.workspaceId,
      _user_id: userId,
    });
    if (!isOwner) throw new Error("Not allowed");

    const patch: { brand_name?: string | null; brand_color?: string | null; logo_url?: string | null } = {};
    if (data.brandName !== undefined) patch.brand_name = data.brandName || null;
    if (data.brandColor !== undefined) patch.brand_color = data.brandColor || null;
    if (data.logoUrl !== undefined) patch.logo_url = data.logoUrl || null;

    const { error } = await supabaseAdmin
      .from("workspaces")
      .update(patch)
      .eq("id", data.workspaceId);

    if (error) {
      console.error("[updateWorkspaceBranding] update error", error);
      throw new Error("Failed to update branding. Please try again.");
    }

    return { ok: true };
  });
