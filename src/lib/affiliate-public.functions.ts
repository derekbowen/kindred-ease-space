import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getRequestIP } from "@tanstack/react-start/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

// Per-instance rate limiter (mirrors public-page-lookup): dampens abuse of the
// unauthenticated public endpoints.
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(ip: string, limit = 60, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || b.resetAt < now) { buckets.set(ip, { count: 1, resetAt: now + windowMs }); return true; }
  b.count += 1;
  return b.count <= limit;
}

export type PublicAffiliateForm = {
  workspaceName: string;
  formSlug: string;
  branding: { logo: string | null; primary: string | null; secondary: string | null };
  programs: Array<{ id: string; name: string }>;
};

/** Resolve the public affiliate sign-up form for a workspace form-slug. */
export const getPublicAffiliateForm = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ slug: z.string().trim().min(1).max(60) }).parse(d))
  .handler(async ({ data }): Promise<{ form: PublicAffiliateForm | null }> => {
    const { data: settings } = await sb()
      .from("workspace_affiliate_settings")
      .select("workspace_id, form_slug, addon_status, workspaces:workspace_id(name, brand_name, logo_url, brand_color)")
      .eq("form_slug", data.slug)
      .maybeSingle();
    if (!settings || (settings.addon_status !== "active" && settings.addon_status !== "trialing")) {
      return { form: null };
    }
    const { data: programs } = await sb()
      .from("affiliate_programs")
      .select("id, name, brand_primary_color")
      .eq("workspace_id", settings.workspace_id)
      .eq("active", true)
      .order("created_at", { ascending: true });
    const ws = settings.workspaces ?? {};
    return {
      form: {
        workspaceName: ws.brand_name || ws.name || "Affiliate Program",
        formSlug: settings.form_slug,
        branding: { logo: ws.logo_url ?? null, primary: ws.brand_color ?? null, secondary: null },
        programs: ((programs ?? []) as any[]).map((p) => ({ id: p.id, name: p.name })),
      },
    };
  });

/** Public application submission from the hosted sign-up page. */
export const submitAffiliateApplication = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({
      slug: z.string().trim().min(1).max(60),
      programId: z.string().uuid(),
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().email().max(200),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    let ip = "unknown";
    try { ip = getRequestIP({ xForwardedFor: true }) || "unknown"; } catch { /* not in request ctx */ }
    if (!rateLimit(ip)) return { ok: false as const, error: "Too many requests. Please try again shortly." };

    const { data: settings } = await sb()
      .from("workspace_affiliate_settings")
      .select("workspace_id, addon_status")
      .eq("form_slug", data.slug)
      .maybeSingle();
    if (!settings) return { ok: false as const, error: "This affiliate program isn't available." };

    // Verify the program belongs to this workspace and is active.
    const { data: program } = await sb()
      .from("affiliate_programs")
      .select("id")
      .eq("id", data.programId)
      .eq("workspace_id", settings.workspace_id)
      .eq("active", true)
      .maybeSingle();
    if (!program) return { ok: false as const, error: "That program is no longer accepting applications." };

    const { error } = await sb().from("affiliate_applications").insert({
      workspace_id: settings.workspace_id,
      program_id: data.programId,
      name: data.name,
      email: data.email,
      status: "pending",
    });
    if (error) return { ok: false as const, error: "Could not submit your application. Please try again." };
    return { ok: true as const };
  });
