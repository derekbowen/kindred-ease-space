import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendEmail, welcomeEmailTemplate } from "@/lib/email.server";

type ProvisionResult = { workspace_id: string; created: boolean; slug: string | null };

function isMissingProvisionRpc(message: string) {
  return (
    /provision_workspace_for_user/i.test(message) &&
    /(does not exist|could not find)/i.test(message)
  );
}

async function provisionWorkspace(
  supabase: any,
  userId: string,
  args: {
    name: string;
    marketplaceDomain?: string | null;
    slugHint?: string | null;
    ifExistsReturn: boolean;
  },
): Promise<ProvisionResult> {
  const { data, error } = await supabase.rpc("provision_workspace_for_user", {
    _name: args.name,
    _marketplace_domain: args.marketplaceDomain ?? null,
    _slug_hint: args.slugHint ?? null,
    _if_exists_return: args.ifExistsReturn,
  });
  if (!error) {
    const row = data as ProvisionResult | null;
    if (!row?.workspace_id) {
      throw new Error("Workspace provisioning returned no workspace_id");
    }
    return row;
  }
  if (!isMissingProvisionRpc(error.message)) {
    throw new Error(error.message);
  }

  // Migration not applied yet — fall back to service-role inserts.
  const { data: existing } = await supabaseAdmin
    .from("workspace_members")
    .select("workspace_id, workspaces(slug)")
    .eq("user_id", userId)
    .eq("role", "owner")
    .limit(1)
    .maybeSingle();
  if (existing?.workspace_id && args.ifExistsReturn) {
    const slug = (existing.workspaces as { slug?: string } | null)?.slug ?? null;
    return { workspace_id: existing.workspace_id, created: false, slug };
  }

  const slug = args.slugHint ?? `ws-${Math.random().toString(36).slice(2, 10)}`;
  const { data: ws, error: insertErr } = await supabaseAdmin
    .from("workspaces")
    .insert({
      slug,
      name: args.name,
      marketplace_domain: args.marketplaceDomain ?? null,
      owner_user_id: userId,
      plan: "starter",
      subscription_status: "trialing",
      trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single();
  if (insertErr || !ws) throw new Error(insertErr?.message ?? "workspace insert failed");

  const { error: memberErr } = await supabaseAdmin.from("workspace_members").insert({
    workspace_id: ws.id,
    user_id: userId,
    role: "owner",
  });
  if (memberErr) {
    await supabaseAdmin.from("workspaces").delete().eq("id", ws.id);
    throw new Error(memberErr.message);
  }

  return { workspace_id: ws.id, created: true, slug };
}

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
    const { supabase } = context;
    const slugBase =
      data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "workspace";
    const slug = `${slugBase}-${Math.random().toString(36).slice(2, 8)}`;
    const domain = data.marketplaceDomain
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");

    let ws: ProvisionResult;
    try {
      ws = await provisionWorkspace(supabase, context.userId, {
        name: data.name,
        marketplaceDomain: domain,
        slugHint: slug,
        ifExistsReturn: false,
      });
    } catch (e) {
      console.error("[createWorkspace] provision error", e);
      throw new Error(
        e instanceof Error
          ? `Couldn't create workspace: ${e.message}`
          : "Failed to create workspace.",
      );
    }

    // Fire-and-forget welcome email — never block workspace creation.
    const userEmail = (context.claims as { email?: string } | undefined)?.email;
    if (userEmail) {
      welcomeEmailTemplate({
        name: data.name,
        workspaceSlug: ws.slug ?? slug,
      })
        .then((tpl) => {
          if (!tpl) return;
          return sendEmail({
            to: userEmail,
            subject: tpl.subject,
            html: tpl.html,
            text: tpl.text,
            idempotencyKey: `welcome-${ws.workspace_id}`,
            meta: { workspace_id: ws.workspace_id, kind: "welcome" },
          });
        })
        .catch((err) => console.error("[createWorkspace] welcome email failed", err));
    }

    return { workspaceId: ws.workspace_id, slug: ws.slug ?? slug };
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
    const { supabase } = context;

    try {
      const ws = await provisionWorkspace(supabase, context.userId, {
        name: "My Marketplace",
        ifExistsReturn: true,
      });
      return { workspaceId: ws.workspace_id, created: ws.created };
    } catch (e) {
      console.error("[ensureWorkspace] provision error", e);
      throw new Error(
        e instanceof Error
          ? `Couldn't set up your workspace: ${e.message}`
          : "Couldn't set up your workspace.",
      );
    }
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
      const normalized = data.marketplaceDomain
        ? data.marketplaceDomain
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .replace(/\/.*$/, "")
            .replace(/:\d+$/, "")
        : "";
      if (
        normalized &&
        !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(normalized)
      ) {
        throw new Error("Invalid domain — use a hostname like yourmarketplace.com");
      }
      patch.marketplace_domain = normalized || null;
    }
    const { error } = await supabaseAdmin
      .from("workspaces")
      .update(patch)
      .eq("id", data.workspaceId);
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
        .select(
          "id, name, plan, subscription_status, trial_ends_at, marketplace_domain, domain_verified_at, current_period_end",
        )
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

    const patch: {
      brand_name?: string | null;
      brand_color?: string | null;
      logo_url?: string | null;
    } = {};
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
