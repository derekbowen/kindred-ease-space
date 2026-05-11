import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("has_role", {
    _user_id: userId,
    _role: "admin",
  });
  if (error || !data) throw new Error("forbidden");
}

const STATUSES = ["open", "in_progress", "waiting", "resolved", "closed"] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export const adminListTickets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        status: z.string().optional().nullable(),
        priority: z.string().optional().nullable(),
        q: z.string().trim().max(200).optional().nullable(),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .parse(d ?? {})
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);
    let query = supabaseAdmin
      .from("support_tickets")
      .select(
        "id,email,name,subject,message,category,priority,status,assigned_to,created_at,updated_at,resolved_at"
      )
      .order("updated_at", { ascending: false })
      .limit(data.limit);

    if (data.status && data.status !== "all") query = query.eq("status", data.status);
    if (data.priority && data.priority !== "all") query = query.eq("priority", data.priority);
    if (data.q) {
      const like = `%${data.q.replace(/[%_]/g, "")}%`;
      query = query.or(
        `subject.ilike.${like},email.ilike.${like},name.ilike.${like},message.ilike.${like}`
      );
    }
    const { data: rows, error } = await query;
    if (error) throw error;

    const counts = await supabaseAdmin
      .from("support_tickets")
      .select("status", { count: "exact", head: false });

    const statusCounts: Record<string, number> = {};
    for (const r of counts.data ?? []) {
      const s = (r as any).status as string;
      statusCounts[s] = (statusCounts[s] ?? 0) + 1;
    }

    return { tickets: rows ?? [], statusCounts };
  });

export const adminGetTicket = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);
    const [{ data: ticket, error: tErr }, { data: messages, error: mErr }] = await Promise.all([
      supabaseAdmin
        .from("support_tickets")
        .select(
          "id,email,name,subject,message,category,priority,status,assigned_to,attachments,created_at,updated_at,resolved_at"
        )
        .eq("id", data.id)
        .maybeSingle(),
      supabaseAdmin
        .from("support_ticket_messages")
        .select("id,author_id,author_name,body,is_internal,status_change,created_at")
        .eq("ticket_id", data.id)
        .order("created_at", { ascending: true }),
    ]);
    if (tErr) throw tErr;
    if (mErr) throw mErr;
    return { ticket, messages: messages ?? [] };
  });

export const adminUpdateTicket = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        status: z.enum(STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
      })
      .parse(d)
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);

    const { data: existing, error: exErr } = await supabaseAdmin
      .from("support_tickets")
      .select("status,priority")
      .eq("id", data.id)
      .maybeSingle();
    if (exErr) throw exErr;
    if (!existing) throw new Error("ticket_not_found");

    const patch: Record<string, any> = {};
    let statusChange: string | null = null;
    if (data.status && data.status !== existing.status) {
      patch.status = data.status;
      statusChange = `${existing.status} → ${data.status}`;
      if (data.status === "resolved" || data.status === "closed") {
        patch.resolved_at = new Date().toISOString();
      } else {
        patch.resolved_at = null;
      }
    }
    if (data.priority && data.priority !== existing.priority) {
      patch.priority = data.priority;
    }
    if (Object.keys(patch).length === 0) return { ok: true };

    const { error } = await supabaseAdmin
      .from("support_tickets")
      .update(patch as any)
      .eq("id", data.id);
    if (error) throw error;

    if (statusChange) {
      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("display_name,full_name")
        .eq("user_id", context.userId)
        .maybeSingle();
      await supabaseAdmin.from("support_ticket_messages").insert({
        ticket_id: data.id,
        author_id: context.userId,
        author_name: profile?.full_name ?? profile?.display_name ?? "Staff",
        body: `Status changed: ${statusChange}`,
        is_internal: true,
        status_change: statusChange,
      });
    }
    return { ok: true };
  });

export const adminPostTicketMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        ticket_id: z.string().uuid(),
        body: z.string().trim().min(1).max(10000),
        is_internal: z.boolean().default(false),
      })
      .parse(d)
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("display_name,full_name")
      .eq("user_id", context.userId)
      .maybeSingle();

    const { data: row, error } = await supabaseAdmin
      .from("support_ticket_messages")
      .insert({
        ticket_id: data.ticket_id,
        author_id: context.userId,
        author_name: profile?.full_name ?? profile?.display_name ?? "Staff",
        body: data.body,
        is_internal: data.is_internal,
      })
      .select("id")
      .single();
    if (error) throw error;

    // bump ticket updated_at
    await supabaseAdmin
      .from("support_tickets")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", data.ticket_id);

    return { id: row!.id as string };
  });
