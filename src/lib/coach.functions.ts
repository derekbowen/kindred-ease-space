import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const listConversations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ workspaceId: z.string().uuid() }).parse)
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows } = await supabase
      .from("coach_conversations")
      .select("id, title, context_type, updated_at")
      .eq("workspace_id", data.workspaceId)
      .order("updated_at", { ascending: false })
      .limit(50);
    return { conversations: rows ?? [] };
  });

export const createConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    workspaceId: z.string().uuid(),
    title: z.string().max(200).optional(),
    contextType: z.string().optional(),
    contextRefId: z.string().uuid().optional(),
  }).parse)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("coach_conversations")
      .insert({
        workspace_id: data.workspaceId,
        user_id: userId,
        title: data.title ?? "New conversation",
        context_type: data.contextType ?? "general",
        context_ref_id: data.contextRefId ?? null,
      })
      .select("id, title, context_type, updated_at")
      .single();
    if (error) throw new Error(error.message);
    return { conversation: row };
  });

export const renameConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    conversationId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
  }).parse)
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("coach_conversations")
      .update({ title: data.title })
      .eq("id", data.conversationId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ conversationId: z.string().uuid() }).parse)
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("coach_conversations")
      .delete()
      .eq("id", data.conversationId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getMessages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ conversationId: z.string().uuid() }).parse)
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows } = await supabase
      .from("coach_messages")
      .select("id, role, content, tool_calls, tokens_used, created_at")
      .eq("conversation_id", data.conversationId)
      .order("created_at", { ascending: true });
    return { messages: rows ?? [] };
  });

export const getTodayBriefing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ workspaceId: z.string().uuid() }).parse)
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const today = new Date().toISOString().slice(0, 10);
    const { data: row } = await supabase
      .from("coach_daily_briefings")
      .select("id, briefing_date, insights, generated_at, viewed_at")
      .eq("workspace_id", data.workspaceId)
      .eq("briefing_date", today)
      .maybeSingle();
    return { briefing: row };
  });

export const generateBriefingNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ workspaceId: z.string().uuid() }).parse)
  .handler(async ({ data }) => {
    const url = `${process.env.SUPABASE_URL}/functions/v1/coach-briefing-cron`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
      },
      body: JSON.stringify({ workspace_id: data.workspaceId }),
    });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, error: t.slice(0, 300) };
    }
    return { ok: true };
  });

export const dismissInsight = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    workspaceId: z.string().uuid(),
    briefingId: z.string().uuid(),
    insightIndex: z.number(),
  }).parse)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await supabase.from("coach_action_log").insert({
      workspace_id: data.workspaceId,
      user_id: userId,
      action_type: "dismissed_insight",
      details: { briefing_id: data.briefingId, insight_index: data.insightIndex },
    });
    return { ok: true };
  });
