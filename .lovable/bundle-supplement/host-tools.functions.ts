import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const slugSchema = z.object({ slug: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/) });

export const listHostTools = createServerFn({ method: "GET" }).handler(async () => {
  const { data, error } = await supabaseAdmin
    .from("host_tools")
    .select("slug,title,summary,category,icon,sort_order")
    .eq("is_published", true)
    .order("sort_order", { ascending: true });
  if (error) console.error("listHostTools:", error);
  return { tools: data ?? [] };
});

export const getHostTool = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => slugSchema.parse(d))
  .handler(async ({ data }) => {
    const { data: tool, error } = await supabaseAdmin
      .from("host_tools")
      .select("*")
      .eq("slug", data.slug)
      .eq("is_published", true)
      .maybeSingle();
    if (error) console.error("getHostTool:", error);
    return { tool: tool ?? null };
  });

// ===== Message Board =====

export const listThreads = createServerFn({ method: "GET" }).handler(async () => {
  const { data, error } = await supabaseAdmin
    .from("mb_threads")
    .select("id,title,body,author_name,reply_count,like_count,is_pinned,last_activity_at,created_at,user_id")
    .order("is_pinned", { ascending: false })
    .order("last_activity_at", { ascending: false })
    .limit(100);
  if (error) console.error("listThreads:", error);
  return { threads: data ?? [] };
});

export const getThread = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const [{ data: thread }, { data: replies }] = await Promise.all([
      supabaseAdmin.from("mb_threads").select("*").eq("id", data.id).maybeSingle(),
      supabaseAdmin
        .from("mb_replies")
        .select("id,body,author_name,like_count,created_at,user_id")
        .eq("thread_id", data.id)
        .order("created_at", { ascending: true }),
    ]);
    return { thread: thread ?? null, replies: replies ?? [] };
  });

const createThreadSchema = z.object({
  title: z.string().min(3).max(200),
  body: z.string().min(5).max(10000),
});

export const createThread = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createThreadSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: profile } = await context.supabase
      .from("profiles")
      .select("display_name, full_name")
      .eq("user_id", context.userId)
      .maybeSingle();
    const author_name = profile?.display_name || profile?.full_name || "Pool Host";
    const { data: thread, error } = await context.supabase
      .from("mb_threads")
      .insert({
        title: data.title,
        body: data.body,
        user_id: context.userId,
        author_name,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return { thread };
  });

const createReplySchema = z.object({
  thread_id: z.string().uuid(),
  body: z.string().min(2).max(10000),
});

export const createReply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createReplySchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: profile } = await context.supabase
      .from("profiles")
      .select("display_name, full_name")
      .eq("user_id", context.userId)
      .maybeSingle();
    const author_name = profile?.display_name || profile?.full_name || "Pool Host";
    const { data: reply, error } = await context.supabase
      .from("mb_replies")
      .insert({
        thread_id: data.thread_id,
        body: data.body,
        user_id: context.userId,
        author_name,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return { reply };
  });

// ===== AI generators (Lovable AI Gateway) =====

const aiSchema = z.object({
  tool: z.enum([
    "host-marketing-engine",
    "pool-listing-ai-writer",
    "review-response-generator",
    "email-sms-campaigns",
    "pool-host-pricing-ai",
    "pool-water-chemistry",
  ]),
  prompt: z.string().min(3).max(8000),
});

const SYSTEM_PROMPTS: Record<string, string> = {
  "host-marketing-engine":
    "You are a marketing strategist for pool hosts on poolrentalnearme.com. Generate flyers, social posts, DM scripts, and campaigns. Output in clear sections with markdown headings. Be concrete and ready-to-publish.",
  "pool-listing-ai-writer":
    "You write high-converting pool rental listings. Output: 1) 3 SEO-optimized title options, 2) a 200-300 word description, 3) 8 photo tips, 4) recommended amenity highlights. Use markdown.",
  "review-response-generator":
    "You write professional, warm, brand-safe replies to guest reviews for pool hosts. If the review is negative, acknowledge, take responsibility where appropriate, and invite resolution offline. Keep under 150 words.",
  "email-sms-campaigns":
    "You design drip campaigns for pool hosts. Output: an email sequence (3-5 messages with subject lines + body), and a parallel SMS sequence (under 160 chars each). Use markdown sections.",
  "pool-host-pricing-ai":
    "You are a pricing strategist for pool rentals. Given the host's inputs, recommend hourly rate, weekend premium, peak-season rate, and party-pricing tiers. Justify each number with one line of reasoning.",
  "pool-water-chemistry":
    "You are a certified pool operator. Given test readings (FC, pH, TA, CYA, CH, salt, temp), output: 1) Status of each reading (low/ok/high), 2) Exact chemical doses in ounces or pounds with brand-neutral product names, 3) Step-by-step instructions, 4) Re-test schedule. Be concise and safe.",
};

export const runAiTool = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => aiSchema.parse(d))
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPTS[data.tool] },
          { role: "user", content: data.prompt },
        ],
      }),
    });

    if (res.status === 429) throw new Error("Rate limit reached. Try again in a moment.");
    if (res.status === 402) throw new Error("AI credits exhausted. Add funds in Workspace settings.");
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`AI request failed: ${txt.slice(0, 200)}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content ?? "";
    return { content };
  });
