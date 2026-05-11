// supabase/functions/generate-course-content/index.ts
// One-shot generator: POST { course: {slug,title,subtitle,tier,category} } -> structured content JSON
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://fresh-web.lovable.app",
  "https://www.poolrentalnearme.com",
  "https://poolrentalnearme.com",
]);

function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://fresh-web.lovable.app";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const SYSTEM = `You are a senior pSEO content strategist for PoolRentalNearMe (PRNM), a U.S. marketplace where homeowners rent their pools by the hour. Write expert-level, original long-form course content for pool hosts. Be concrete, U.S.-focused, with real numbers (typical hourly rates $40-150/hr, deposit norms, common city ranges). Never copy boilerplate. Avoid fluff. Use second person ("you"). Write like a founder mentor talking to a host who wants to make $3K-$10K/month from their backyard pool.`;

const TOOL = {
  type: "function",
  function: {
    name: "emit_course_content",
    description: "Emit structured long-form course content. Total prose across all sections MUST be at least 2,500 words.",
    parameters: {
      type: "object",
      properties: {
        seo_title: { type: "string" },
        seo_description: { type: "string" },
        excerpt: { type: "string" },
        overview: { type: "string", description: "300-400 words" },
        who_its_for: { type: "string", description: "150-200 words" },
        learning_outcomes: { type: "array", items: { type: "string" } },
        modules: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string" }, content: { type: "string", description: "200-300 words" } },
            required: ["title", "content"],
          },
        },
        host_playbook: { type: "string", description: "300-400 words" },
        pricing_tactics: { type: "string", description: "200-300 words" },
        common_mistakes: { type: "array", items: { type: "string" } },
        faq: {
          type: "array",
          items: {
            type: "object",
            properties: { question: { type: "string" }, answer: { type: "string" } },
            required: ["question", "answer"],
          },
        },
        related_topics: { type: "array", items: { type: "string" } },
        duration_minutes: { type: "integer" },
        level: { type: "string" },
      },
      required: ["seo_title","seo_description","excerpt","overview","who_its_for","learning_outcomes","modules","host_playbook","pricing_tactics","common_mistakes","faq","related_topics","duration_minutes","level"],
      additionalProperties: false,
    },
  },
};

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    // Require admin auth
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "");
    if (!token) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: u, error: uErr } = await sb.auth.getUser(token);
    if (uErr || !u.user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const { data: role } = await sb.from("user_roles").select("role").eq("user_id", u.user.id).eq("role", "admin").maybeSingle();
    if (!role) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });

    const { course } = await req.json();
    const KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!KEY) throw new Error("LOVABLE_API_KEY missing");

    const userPrompt = `Course title: ${course.title}
Subtitle: ${course.subtitle}
Tier: ${course.tier}
Category: ${course.category}

Write the full long-form course content for the PRNM Learning Academy. Total prose across overview + who_its_for + all module contents + host_playbook + pricing_tactics + faq answers MUST exceed 2,500 words. Be specific to this booking type. Reference real U.S. pool-rental market dynamics, typical hourly rates, deposit norms, and platform mechanics.`;

    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: userPrompt }],
        tools: [TOOL],
        tool_choice: { type: "function", function: { name: "emit_course_content" } },
      }),
    });

    if (!r.ok) {
      const text = await r.text();
      return new Response(JSON.stringify({ error: `gateway ${r.status}: ${text}` }), { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const data = await r.json();
    const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    const content = typeof args === "string" ? JSON.parse(args) : args;
    return new Response(JSON.stringify({ content }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
