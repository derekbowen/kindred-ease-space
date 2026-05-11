import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function assertAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Forbidden: admin only");
}

export type AdminIdentity = {
  isAuthenticated: boolean;
  isAdmin: boolean;
  userId: string | null;
  email: string | null;
  displayName: string | null;
};

/**
 * Returns identity + admin status. Never throws on non-admin so the UI can
 * show a helpful "request access" screen with the user's id/email.
 */
export const getAdminIdentity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AdminIdentity> => {
    const { userId, claims } = context as { userId: string; claims: any };
    const email = (claims?.email as string | undefined) ?? null;

    const [{ data: roleRow }, { data: profile }] = await Promise.all([
      supabaseAdmin.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle(),
      supabaseAdmin.from("profiles").select("display_name, full_name").eq("user_id", userId).maybeSingle(),
    ]);

    return {
      isAuthenticated: true,
      isAdmin: !!roleRow,
      userId,
      email,
      displayName: profile?.full_name || profile?.display_name || null,
    };
  });

export type AdminTeamMember = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  full_name: string | null;
  granted_at: string | null;
  last_sign_in_at: string | null;
};

async function fetchAuthUsersByIds(ids: string[]): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  if (ids.length === 0) return map;
  const idSet = new Set(ids);
  for (let page = 1; page <= 20; page++) {
    const { data: list, error } = await (supabaseAdmin as any).auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Auth lookup failed: ${error.message}`);
    const users = list?.users || [];
    for (const u of users) {
      if (idSet.has(u.id)) map.set(u.id, u);
    }
    if (users.length < 200 || map.size === idSet.size) break;
  }
  return map;
}

export const listAdmins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ admins: AdminTeamMember[] }> => {
    await assertAdmin((context as any).userId);
    const { data: roles } = await supabaseAdmin
      .from("user_roles")
      .select("user_id, created_at")
      .eq("role", "admin");
    const ids = (roles || []).map((r: any) => r.user_id);
    if (ids.length === 0) return { admins: [] };
    const [{ data: profiles }, authMap] = await Promise.all([
      supabaseAdmin.from("profiles").select("user_id, display_name, full_name").in("user_id", ids),
      fetchAuthUsersByIds(ids),
    ]);
    const pmap = new Map<string, any>();
    (profiles || []).forEach((p: any) => pmap.set(p.user_id, p));
    const admins: AdminTeamMember[] = (roles || []).map((r: any) => ({
      user_id: r.user_id,
      email: authMap.get(r.user_id)?.email ?? null,
      display_name: pmap.get(r.user_id)?.display_name ?? null,
      full_name: pmap.get(r.user_id)?.full_name ?? null,
      granted_at: r.created_at ?? null,
      last_sign_in_at: authMap.get(r.user_id)?.last_sign_in_at ?? null,
    }));
    admins.sort((a, b) => (a.full_name || a.display_name || a.email || a.user_id).localeCompare(b.full_name || b.display_name || b.email || b.user_id));
    return { admins };
  });

export const createAdminUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    email: z.string().email(),
    password: z.string().min(8),
    full_name: z.string().optional(),
  }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true; user_id: string }> => {
    await assertAdmin((context as any).userId);
    const email = data.email.trim().toLowerCase();

    // Check if user already exists
    let userId: string | null = null;
    for (let page = 1; page <= 10 && !userId; page++) {
      const { data: list, error } = await (supabaseAdmin as any).auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(`Lookup failed: ${error.message}`);
      const users = list?.users || [];
      const hit = users.find((u: any) => (u.email || "").toLowerCase() === email);
      if (hit) userId = hit.id;
      if (users.length < 200) break;
    }

    if (userId) {
      // Update existing user's password
      const { error } = await (supabaseAdmin as any).auth.admin.updateUserById(userId, { password: data.password });
      if (error) throw new Error(error.message);
    } else {
      const { data: created, error } = await (supabaseAdmin as any).auth.admin.createUser({
        email,
        password: data.password,
        email_confirm: true,
        user_metadata: data.full_name ? { full_name: data.full_name, display_name: data.full_name } : {},
      });
      if (error) throw new Error(error.message);
      userId = created?.user?.id;
      if (!userId) throw new Error("Failed to create user");
    }

    const { error: insErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: userId, role: "admin" });
    if (insErr && !/duplicate|unique/i.test(insErr.message)) {
      throw new Error(insErr.message);
    }
    return { ok: true, user_id: userId };
  });

export const setAdminPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    user_id: z.string().uuid(),
    password: z.string().min(8),
  }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    await assertAdmin((context as any).userId);
    const { error } = await (supabaseAdmin as any).auth.admin.updateUserById(data.user_id, { password: data.password });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const sendAdminPasswordReset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ email: z.string().email() }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    await assertAdmin((context as any).userId);
    const { error } = await (supabaseAdmin as any).auth.admin.generateLink({
      type: "recovery",
      email: data.email.trim().toLowerCase(),
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const UUID = z.string().uuid();

export const grantAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ identifier: z.string().min(3) }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true; user_id: string }> => {
    await assertAdmin((context as any).userId);

    const raw = data.identifier.trim();
    let targetId: string | null = null;

    // 1. UUID? use directly
    if (UUID.safeParse(raw).success) {
      targetId = raw;
    } else if (raw.includes("@")) {
      // 2. Email lookup via auth admin
      const email = raw.toLowerCase();
      // listUsers paginated; search up to 10 pages of 200 (covers 2k users)
      for (let page = 1; page <= 10 && !targetId; page++) {
        const { data: list, error } = await (supabaseAdmin as any).auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw new Error(`Lookup failed: ${error.message}`);
        const users = list?.users || [];
        const hit = users.find((u: any) => (u.email || "").toLowerCase() === email);
        if (hit) targetId = hit.id;
        if (users.length < 200) break;
      }
      if (!targetId) throw new Error(`No user found with email ${email}. They must sign up at /auth first.`);
    } else {
      throw new Error("Provide a user UUID or email address.");
    }

    const { error: insErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: targetId, role: "admin" });
    // ignore unique-violation (already admin)
    if (insErr && !/duplicate|unique/i.test(insErr.message)) {
      throw new Error(insErr.message);
    }
    return { ok: true, user_id: targetId };
  });

export const revokeAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ user_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const callerId = (context as any).userId as string;
    await assertAdmin(callerId);

    if (data.user_id === callerId) {
      throw new Error("You can't remove your own admin role. Ask another admin.");
    }

    // Don't allow removing the last admin
    const { count } = await supabaseAdmin
      .from("user_roles")
      .select("*", { count: "exact", head: true })
      .eq("role", "admin");
    if ((count ?? 0) <= 1) {
      throw new Error("Refusing to remove the last admin.");
    }

    const { error } = await supabaseAdmin
      .from("user_roles")
      .delete()
      .eq("user_id", data.user_id)
      .eq("role", "admin");
    if (error) throw new Error(error.message);
    return { ok: true };
  });
