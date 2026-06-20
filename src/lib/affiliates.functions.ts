import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, assertWorkspaceOwner, workspaceIdSchema } from "@/lib/admin-helpers.functions";

// New tables aren't in the generated types yet; use the same admin-cast pattern
// the rest of the server fns use.
const sb = () => supabaseAdmin as any;

// Add-on program limits per tier (mirrors the pricing decision: ~half Toppal).
const PROGRAM_LIMIT: Record<string, number> = { lite: 1, standard: 1, pro: 3 };

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "program";
}
function randomCode(len = 8): string {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += a[Math.floor(Math.random() * a.length)];
  return out;
}

/** Ensure a settings row exists and return it. */
async function ensureSettings(workspaceId: string) {
  const { data } = await sb()
    .from("workspace_affiliate_settings").select("*").eq("workspace_id", workspaceId).maybeSingle();
  if (data) return data;
  const { data: created } = await sb()
    .from("workspace_affiliate_settings")
    .insert({ workspace_id: workspaceId })
    .select("*")
    .maybeSingle();
  return created ?? { workspace_id: workspaceId, addon_status: "inactive", currency: "USD", referrer_param: "referrerID" };
}

/** Add-on must be active or trialing for write operations. */
async function assertAddon(workspaceId: string) {
  const s = await ensureSettings(workspaceId);
  if (s.addon_status !== "active" && s.addon_status !== "trialing") {
    throw new Error("The Affiliate add-on isn't active. Start the free trial or subscribe in Billing.");
  }
  return s;
}

// ---------------------------------------------------------------- settings

export const getAffiliateSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    return { settings: await ensureSettings(data.workspaceId) };
  });

export const updateAffiliateSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
      formSlug: z.string().trim().max(60).optional(),
      marketplaceBaseUrl: z.string().trim().url().max(300).optional().or(z.literal("")),
      currency: z.string().trim().length(3).optional(),
      referrerParam: z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "Must start with a letter; letters/numbers/-/_ only").max(40).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    await ensureSettings(data.workspaceId);
    const patch: Record<string, unknown> = {};
    if (data.formSlug !== undefined) patch.form_slug = slugify(data.formSlug);
    if (data.marketplaceBaseUrl !== undefined) patch.marketplace_base_url = data.marketplaceBaseUrl || null;
    if (data.currency !== undefined) patch.currency = data.currency.toUpperCase();
    if (data.referrerParam !== undefined) patch.referrer_param = data.referrerParam;
    const { error } = await sb().from("workspace_affiliate_settings").update(patch).eq("workspace_id", data.workspaceId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/** Start a 14-day add-on trial so the operator can use the tools immediately. */
export const startAffiliateTrial = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const s = await ensureSettings(data.workspaceId);
    if (s.addon_status === "active") return { ok: true as const, already: true };
    const { error } = await sb()
      .from("workspace_affiliate_settings")
      .update({ addon_status: "trialing", addon_tier: s.addon_tier ?? "standard" })
      .eq("workspace_id", data.workspaceId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

// ---------------------------------------------------------------- programs

export const listPrograms = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const { data: programs } = await sb()
      .from("affiliate_programs").select("*").eq("workspace_id", data.workspaceId).order("created_at", { ascending: false });
    const { data: affs } = await sb()
      .from("affiliates").select("program_id").eq("workspace_id", data.workspaceId);
    const counts = new Map<string, number>();
    for (const a of (affs ?? []) as Array<{ program_id: string }>) counts.set(a.program_id, (counts.get(a.program_id) ?? 0) + 1);
    return {
      programs: ((programs ?? []) as any[]).map((p) => ({ ...p, affiliate_count: counts.get(p.id) ?? 0 })),
    };
  });

export const getProgram = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema, id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const { data: program } = await sb()
      .from("affiliate_programs").select("*").eq("workspace_id", data.workspaceId).eq("id", data.id).maybeSingle();
    return { program: program ?? null };
  });

const ProgramInput = z.object({
  workspaceId: workspaceIdSchema,
  id: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(120),
  trigger: z.enum(["signup", "transaction"]).default("transaction"),
  payoutType: z.enum(["percentage", "fixed"]).default("percentage"),
  payoutValue: z.number().min(0).max(1_000_000),
  active: z.boolean().default(false),
  autoEnroll: z.boolean().default(false),
  maxReferrals: z.number().int().positive().nullable().optional(),
  maxTxnPerReferral: z.number().int().positive().nullable().optional(),
  minGmv: z.number().min(0).nullable().optional(),
  brandLogoUrl: z.string().url().max(500).nullable().optional().or(z.literal("")),
  brandPrimaryColor: z.string().max(9).nullable().optional(),
  brandSecondaryColor: z.string().max(9).nullable().optional(),
});

export const upsertProgram = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ProgramInput.parse(d))
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const settings = await assertAddon(data.workspaceId);

    const row: Record<string, unknown> = {
      workspace_id: data.workspaceId,
      name: data.name,
      trigger: data.trigger,
      payout_type: data.payoutType,
      payout_value: data.payoutValue,
      active: data.active,
      auto_enroll: data.autoEnroll,
      max_referrals: data.maxReferrals ?? null,
      max_txn_per_referral: data.maxTxnPerReferral ?? null,
      min_gmv: data.minGmv ?? null,
      brand_logo_url: data.brandLogoUrl || null,
      brand_primary_color: data.brandPrimaryColor || null,
      brand_secondary_color: data.brandSecondaryColor || null,
    };

    if (data.id) {
      const { error } = await sb().from("affiliate_programs").update(row).eq("id", data.id).eq("workspace_id", data.workspaceId);
      if (error) throw new Error(error.message);
      return { ok: true as const, id: data.id };
    }

    // New program — enforce the tier's program limit.
    const limit = PROGRAM_LIMIT[settings.addon_tier ?? "lite"] ?? 1;
    const { count } = await sb()
      .from("affiliate_programs").select("*", { count: "exact", head: true }).eq("workspace_id", data.workspaceId);
    if ((count ?? 0) >= limit) {
      throw new Error(`Your plan allows ${limit} program${limit === 1 ? "" : "s"}. Upgrade to add more.`);
    }
    // Unique slug within the workspace.
    let slug = slugify(data.name);
    let n = 1;
    while (true) {
      const { data: ex } = await sb()
        .from("affiliate_programs").select("id").eq("workspace_id", data.workspaceId).eq("slug", slug).maybeSingle();
      if (!ex) break;
      slug = `${slugify(data.name)}-${++n}`;
      if (n > 50) break;
    }
    row.slug = slug;
    const { data: created, error } = await sb().from("affiliate_programs").insert(row).select("id").maybeSingle();
    if (error) throw new Error(error.message);
    return { ok: true as const, id: created?.id as string };
  });

export const deleteProgram = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema, id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const { error } = await sb().from("affiliate_programs").delete().eq("id", data.id).eq("workspace_id", data.workspaceId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

// ---------------------------------------------------------------- affiliates

export const listAffiliates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
      programId: z.string().uuid().optional(),
      status: z.enum(["active", "deactivated"]).optional(),
      search: z.string().trim().max(120).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    let q = sb()
      .from("affiliates")
      .select("id, program_id, name, email, referral_code, status, created_at, affiliate_programs:program_id(name)")
      .eq("workspace_id", data.workspaceId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (data.programId) q = q.eq("program_id", data.programId);
    if (data.status) q = q.eq("status", data.status);
    if (data.search) {
      // Strip PostgREST metacharacters so a value like `foo,status.eq.draft`
      // can't inject extra filter conditions into the .or() expression.
      const s = data.search.replace(/[%_,()*]/g, "");
      if (s) q = q.or(`name.ilike.%${s}%,email.ilike.%${s}%`);
    }
    const { data: rows } = await q;

    // Per-affiliate GMV / revenue / payouts paid.
    const { data: txns } = await sb()
      .from("affiliate_transactions").select("affiliate_id, gmv, marketplace_revenue").eq("workspace_id", data.workspaceId);
    const { data: paid } = await sb()
      .from("affiliate_payouts").select("affiliate_id, amount").eq("workspace_id", data.workspaceId).eq("status", "paid");
    const gmv = new Map<string, number>(), rev = new Map<string, number>(), pay = new Map<string, number>();
    for (const t of (txns ?? []) as any[]) {
      gmv.set(t.affiliate_id, (gmv.get(t.affiliate_id) ?? 0) + Number(t.gmv || 0));
      rev.set(t.affiliate_id, (rev.get(t.affiliate_id) ?? 0) + Number(t.marketplace_revenue || 0));
    }
    for (const p of (paid ?? []) as any[]) pay.set(p.affiliate_id, (pay.get(p.affiliate_id) ?? 0) + Number(p.amount || 0));

    const settings = await ensureSettings(data.workspaceId);
    const base = settings.marketplace_base_url || "";
    const param = settings.referrer_param || "referrerID";

    return {
      affiliates: ((rows ?? []) as any[]).map((a) => ({
        id: a.id,
        program_id: a.program_id,
        program_name: a.affiliate_programs?.name ?? "—",
        name: a.name,
        email: a.email,
        status: a.status,
        link: base ? `${base}${base.includes("?") ? "&" : "?"}${param}=${a.referral_code}` : `?${param}=${a.referral_code}`,
        gmv: gmv.get(a.id) ?? 0,
        marketplace_revenue: rev.get(a.id) ?? 0,
        payouts_paid: pay.get(a.id) ?? 0,
      })),
    };
  });

export const createAffiliate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
      programId: z.string().uuid(),
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().email().max(200),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    await assertAddon(data.workspaceId);
    let code = randomCode();
    for (let i = 0; i < 5; i++) {
      const { data: ex } = await sb()
        .from("affiliates").select("id").eq("workspace_id", data.workspaceId).eq("referral_code", code).maybeSingle();
      if (!ex) break;
      code = randomCode();
    }
    const { data: created, error } = await sb().from("affiliates").insert({
      workspace_id: data.workspaceId,
      program_id: data.programId,
      name: data.name,
      email: data.email,
      referral_code: code,
      status: "active",
    }).select("id, referral_code").maybeSingle();
    if (error) throw new Error(error.message);
    return { ok: true as const, id: created?.id, referral_code: created?.referral_code };
  });

export const setAffiliateStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, id: z.string().uuid(), status: z.enum(["active", "deactivated"]) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const { error } = await sb().from("affiliates").update({ status: data.status }).eq("id", data.id).eq("workspace_id", data.workspaceId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

// ---------------------------------------------------------------- payouts

export const listPayouts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
      status: z.enum(["pending", "ready", "paid", "rejected"]).optional(),
      affiliateId: z.string().uuid().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    let q = sb()
      .from("affiliate_payouts")
      .select("*, affiliates:affiliate_id(name), affiliate_programs:program_id(name)")
      .eq("workspace_id", data.workspaceId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (data.status) q = q.eq("status", data.status);
    if (data.affiliateId) q = q.eq("affiliate_id", data.affiliateId);
    const { data: rows } = await q;
    const { data: all } = await sb()
      .from("affiliate_payouts").select("status").eq("workspace_id", data.workspaceId);
    const counts = { pending: 0, ready: 0, paid: 0, rejected: 0 } as Record<string, number>;
    for (const r of (all ?? []) as Array<{ status: string }>) counts[r.status] = (counts[r.status] ?? 0) + 1;
    return {
      counts,
      payouts: ((rows ?? []) as any[]).map((p) => ({
        id: p.id,
        created_at: p.created_at,
        affiliate_name: p.affiliates?.name ?? "—",
        program_name: p.affiliate_programs?.name ?? "—",
        event_type: p.event_type,
        txn_count: p.txn_count,
        amount: Number(p.amount || 0),
        status: p.status,
      })),
    };
  });

export const setPayoutStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
      id: z.string().uuid(),
      status: z.enum(["pending", "ready", "paid", "rejected"]),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const patch: Record<string, unknown> = { status: data.status };
    if (data.status === "paid") patch.paid_at = new Date().toISOString();
    const { error } = await sb().from("affiliate_payouts").update(patch).eq("id", data.id).eq("workspace_id", data.workspaceId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

// ---------------------------------------------------------------- dashboard

export const getAffiliateDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const settings = await ensureSettings(data.workspaceId);

    const [{ data: txns }, { data: programs }, { data: affiliates }, { data: referrals }, { data: payouts }] =
      await Promise.all([
        sb().from("affiliate_transactions").select("gmv, marketplace_revenue, occurred_at, referral_id").eq("workspace_id", data.workspaceId),
        sb().from("affiliate_programs").select("active").eq("workspace_id", data.workspaceId),
        sb().from("affiliates").select("status").eq("workspace_id", data.workspaceId),
        sb().from("affiliate_referrals").select("first_converted_at").eq("workspace_id", data.workspaceId),
        sb().from("affiliate_payouts").select("amount, status").eq("workspace_id", data.workspaceId),
      ]);

    const tx = (txns ?? []) as any[];
    const gmv = tx.reduce((a, t) => a + Number(t.gmv || 0), 0);
    const revenue = tx.reduce((a, t) => a + Number(t.marketplace_revenue || 0), 0);
    const totalPayouts = ((payouts ?? []) as any[]).filter((p) => p.status === "paid").reduce((a, p) => a + Number(p.amount || 0), 0);
    const refs = (referrals ?? []) as any[];
    const converted = refs.filter((r) => r.first_converted_at).length;
    const conversionRate = refs.length ? (converted / refs.length) * 100 : 0;

    // 12-month trailing performance series (GMV + revenue by month).
    const now = new Date();
    const series: Array<{ month: string; gmv: number; revenue: number }> = [];
    const buckets = new Map<string, { gmv: number; revenue: number }>();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      buckets.set(key, { gmv: 0, revenue: 0 });
    }
    for (const t of tx) {
      const d = new Date(t.occurred_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const b = buckets.get(key);
      if (b) { b.gmv += Number(t.gmv || 0); b.revenue += Number(t.marketplace_revenue || 0); }
    }
    for (const [month, v] of buckets) series.push({ month, gmv: v.gmv, revenue: v.revenue });

    return {
      addon: { status: settings.addon_status as string, tier: settings.addon_tier as string | null },
      currency: settings.currency as string,
      kpis: {
        gmv,
        marketplace_revenue: revenue,
        total_payouts: totalPayouts,
        conversion_rate: conversionRate,
        active_affiliates: ((affiliates ?? []) as any[]).filter((a) => a.status === "active").length,
        active_programs: ((programs ?? []) as any[]).filter((p) => p.active).length,
        referred_users: refs.length,
        converted_referred_users: converted,
      },
      series,
    };
  });

// ---------------------------------------------------------------- applications (admin)

export const listApplications = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, status: z.enum(["pending", "approved", "rejected"]).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    let q = sb()
      .from("affiliate_applications")
      .select("*, affiliate_programs:program_id(name)")
      .eq("workspace_id", data.workspaceId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (data.status) q = q.eq("status", data.status);
    const { data: rows } = await q;
    return { applications: ((rows ?? []) as any[]).map((r) => ({ ...r, program_name: r.affiliate_programs?.name ?? "—" })) };
  });

export const decideApplication = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, id: z.string().uuid(), approve: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const { data: app } = await sb()
      .from("affiliate_applications").select("*").eq("id", data.id).eq("workspace_id", data.workspaceId).maybeSingle();
    if (!app) throw new Error("Application not found");
    if (data.approve) {
      const code = randomCode();
      await sb().from("affiliates").insert({
        workspace_id: data.workspaceId, program_id: app.program_id,
        name: app.name, email: app.email, referral_code: code, status: "active",
      });
      await sb().from("affiliate_applications").update({ status: "approved" }).eq("id", data.id);
    } else {
      await sb().from("affiliate_applications").update({ status: "rejected" }).eq("id", data.id);
    }
    return { ok: true as const };
  });
