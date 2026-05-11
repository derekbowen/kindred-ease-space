import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const sb = () => supabaseAdmin as any;

async function assertAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
  if (!data) throw new Error("Forbidden");
}

export type IgLeadRow = {
  id: string;
  instagram_url: string;
  source_url: string | null;
  profile_handle: string | null;
  profile_name: string | null;
  snippet: string | null;
  query: string | null;
  contacted: boolean;
  contacted_at: string | null;
  notes: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
};

export const listIgLeads = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      filter: z.enum(["all", "new", "contacted"]).default("new"),
      limit: z.number().min(1).max(500).default(200),
    }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    let q = sb().from("ig_leads").select("*").order("created_at", { ascending: false }).limit(data.limit);
    if (data.filter === "new") q = q.eq("contacted", false);
    if (data.filter === "contacted") q = q.eq("contacted", true);
    const { data: rows, error } = await q;
    if (error) return { ok: false, rows: [] as IgLeadRow[], error: error.message };
    return { ok: true, rows: (rows || []) as IgLeadRow[] };
  });

export const runIgLeadHuntNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin((context as any).userId);
    const { runIgLeadHunt } = await import("./ig-lead-hunter.server");
    return runIgLeadHunt();
  });

export const setIgLeadContacted = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), contacted: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { error } = await sb().from("ig_leads").update({
      contacted: data.contacted,
      contacted_at: data.contacted ? new Date().toISOString() : null,
    }).eq("id", data.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

export const bulkSetIgLeadsContacted = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      ids: z.array(z.string().uuid()).min(1).max(500),
      contacted: z.boolean(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { error, count } = await sb()
      .from("ig_leads")
      .update(
        {
          contacted: data.contacted,
          contacted_at: data.contacted ? new Date().toISOString() : null,
        },
        { count: "exact" },
      )
      .in("id", data.ids);
    if (error) return { ok: false, updated: 0, error: error.message };
    return { ok: true, updated: count ?? data.ids.length };
  });

export const updateIgLeadNotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), notes: z.string().max(2000) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { error } = await sb().from("ig_leads").update({ notes: data.notes }).eq("id", data.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

export const deleteIgLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { error } = await sb().from("ig_leads").delete().eq("id", data.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });
