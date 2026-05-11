// Coach orchestrator: tool-using agent with streaming responses.
// Auth: workspace member required. Uses tenant BYOK -> platform fallback via the same
// adapters as ai-proxy. Tool loop max 8 iterations.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";

const RequestSchema = z.object({
  conversation_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  user_message: z.string().trim().min(1).max(8000),
  context: z
    .object({
      page_id: z.string().uuid().optional(),
      route: z.string().max(500).optional(),
    })
    .optional(),
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PLATFORM_DEFAULT_MODEL = "google/gemini-3-flash-preview";

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
};

// ---------- Tool definitions exposed to the LLM ----------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_workspace_overview",
      description: "Counts of pages, listings, integrations status. Always call first for 'what should I work on' questions.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "query_pages",
      description: "List tenant pages with optional filters.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["draft", "published", "archived"] },
          search: { type: "string", description: "Substring match on slug or title" },
          limit: { type: "number", default: 20 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_listings",
      description: "List synced Sharetribe listings.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
          category: { type: "string" },
          limit: { type: "number", default: 20 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_page_seo_audit",
      description: "Audit one page: word count, title/meta length, H1 presence, internal link count.",
      parameters: {
        type: "object",
        properties: { page_id: { type: "string" } },
        required: ["page_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "suggest_internal_links",
      description: "Find related workspace pages that should link to a given page.",
      parameters: {
        type: "object",
        properties: { page_id: { type: "string" } },
        required: ["page_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_listing_coverage",
      description: "Find listings missing from any page and pages with zero matching listings.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

// ---------- Tool implementations ----------
async function executeTool(
  admin: ReturnType<typeof createClient>,
  workspaceId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_workspace_overview": {
      const [pages, listings, integ, ws] = await Promise.all([
        admin.from("tenant_pages").select("status", { count: "exact", head: false }).eq("workspace_id", workspaceId),
        admin.from("tenant_listings").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId),
        admin.from("tenant_integrations").select("provider, status").eq("workspace_id", workspaceId),
        admin.from("workspaces").select("name, plan, subscription_status").eq("id", workspaceId).single(),
      ]);
      const allPages = (pages.data ?? []) as Array<{ status: string }>;
      const published = allPages.filter((p) => p.status === "published").length;
      return {
        workspace: ws.data,
        total_pages: allPages.length,
        published_pages: published,
        draft_pages: allPages.length - published,
        total_listings: listings.count ?? 0,
        integrations: integ.data ?? [],
      };
    }
    case "query_pages": {
      const { status, search, limit } = args as { status?: string; search?: string; limit?: number };
      let q = admin
        .from("tenant_pages")
        .select("id, slug, title, status, meta_description, published_at, updated_at")
        .eq("workspace_id", workspaceId)
        .order("updated_at", { ascending: false })
        .limit(Math.min(limit ?? 20, 50));
      if (status) q = q.eq("status", status);
      if (search) q = q.or(`slug.ilike.%${search}%,title.ilike.%${search}%`);
      const { data, error } = await q;
      if (error) return { error: error.message };
      return { pages: data };
    }
    case "query_listings": {
      const { city, category, limit } = args as { city?: string; category?: string; limit?: number };
      let q = admin
        .from("tenant_listings")
        .select("id, title, slug, city, state, category, price_amount, price_currency")
        .eq("workspace_id", workspaceId)
        .limit(Math.min(limit ?? 20, 50));
      if (city) q = q.ilike("city", city);
      if (category) q = q.eq("category", category);
      const { data, error } = await q;
      if (error) return { error: error.message };
      return { listings: data };
    }
    case "get_page_seo_audit": {
      const { page_id } = args as { page_id: string };
      const { data: page, error } = await admin
        .from("tenant_pages")
        .select("id, slug, title, meta_description, h1, body_markdown")
        .eq("workspace_id", workspaceId)
        .eq("id", page_id)
        .single();
      if (error || !page) return { error: "Page not found in this workspace" };
      const body = (page.body_markdown ?? "") as string;
      const wordCount = body.trim().split(/\s+/).filter(Boolean).length;
      const internalLinks = (body.match(/\]\(\/p\//g) ?? []).length;
      const issues: string[] = [];
      if (!page.title || (page.title as string).length > 60) issues.push("Title missing or >60 chars (Google truncates)");
      if (!page.meta_description) issues.push("Missing meta description");
      else if ((page.meta_description as string).length > 160) issues.push("Meta description >160 chars");
      if (!page.h1) issues.push("Missing H1");
      if (wordCount < 300) issues.push(`Thin content: ${wordCount} words (recommend 800+)`);
      if (internalLinks === 0) issues.push("Zero internal links to other pages");
      return {
        page: { id: page.id, slug: page.slug, title: page.title },
        word_count: wordCount,
        title_length: (page.title as string | null)?.length ?? 0,
        meta_length: (page.meta_description as string | null)?.length ?? 0,
        has_h1: !!page.h1,
        internal_link_count: internalLinks,
        issues,
        seo_score: Math.max(0, 100 - issues.length * 15),
      };
    }
    case "suggest_internal_links": {
      const { page_id } = args as { page_id: string };
      const { data: target } = await admin
        .from("tenant_pages")
        .select("id, slug, title")
        .eq("workspace_id", workspaceId)
        .eq("id", page_id)
        .single();
      if (!target) return { error: "Page not found" };
      const tokens = ((target.title as string | null) ?? "").toLowerCase().split(/\W+/).filter((t) => t.length > 4);
      if (tokens.length === 0) return { suggestions: [], note: "Page title too short to derive related terms" };
      const ors = tokens.slice(0, 3).map((t) => `title.ilike.%${t}%`).join(",");
      const { data: candidates } = await admin
        .from("tenant_pages")
        .select("id, slug, title, body_markdown")
        .eq("workspace_id", workspaceId)
        .eq("status", "published")
        .neq("id", page_id)
        .or(ors)
        .limit(20);
      const suggestions = (candidates ?? [])
        .filter((c) => !((c.body_markdown as string | null) ?? "").includes(`/p/${target.slug}`))
        .slice(0, 10)
        .map((c) => ({ id: c.id, slug: c.slug, title: c.title }));
      return { target_slug: target.slug, suggestions, count: suggestions.length };
    }
    case "check_listing_coverage": {
      const [{ data: listings }, { data: pages }] = await Promise.all([
        admin.from("tenant_listings").select("id, city, category").eq("workspace_id", workspaceId),
        admin.from("tenant_pages").select("listing_filter, status").eq("workspace_id", workspaceId).eq("status", "published"),
      ]);
      const cityCoverage = new Set<string>();
      for (const p of (pages ?? [])) {
        const f = (p.listing_filter as { city?: string } | null) ?? {};
        if (f.city) cityCoverage.add(String(f.city).toLowerCase());
      }
      const cities = new Map<string, number>();
      for (const l of (listings ?? [])) {
        if (l.city) cities.set(String(l.city).toLowerCase(), (cities.get(String(l.city).toLowerCase()) ?? 0) + 1);
      }
      const uncoveredCities = [...cities.entries()]
        .filter(([c]) => !cityCoverage.has(c))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([city, count]) => ({ city, listing_count: count }));
      return {
        total_listings: listings?.length ?? 0,
        total_published_pages: pages?.length ?? 0,
        uncovered_cities: uncoveredCities,
        suggestion: uncoveredCities.length > 0
          ? `${uncoveredCities.length} cities have listings but no dedicated page. Top: ${uncoveredCities[0].city} (${uncoveredCities[0].listing_count} listings).`
          : "All cities with listings have at least one page.",
      };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---------- Provider call (non-streaming inner; streaming outer SSE) ----------
async function callOpenAICompatible(
  base: string,
  apiKey: string,
  body: { model: string; messages: ChatMessage[]; tools: typeof TOOLS; tool_choice?: "auto" | "none" },
) {
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${text.slice(0, 600)}`);
  return JSON.parse(text);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const PUBLISHABLE = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, PUBLISHABLE, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: ures } = await userClient.auth.getUser();
    if (!ures?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const userId = ures.user.id;
    const body = await req.json() as {
      conversation_id: string;
      workspace_id: string;
      user_message: string;
      context?: { page_id?: string; route?: string };
    };
    if (!body.conversation_id || !body.workspace_id || !body.user_message) {
      return new Response(JSON.stringify({ error: "conversation_id, workspace_id, user_message required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const { data: isMember } = await admin.rpc("is_workspace_member", {
      _workspace_id: body.workspace_id, _user_id: userId,
    });
    if (!isMember) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Load active system prompt
    const { data: prompt } = await admin
      .from("coach_system_prompts").select("body").eq("is_active", true).order("version", { ascending: false }).limit(1).single();

    // Workspace summary
    const wsOverview = await executeTool(admin, body.workspace_id, "get_workspace_overview", {}) as Record<string, unknown>;

    // Load history (last 20)
    const { data: history } = await admin
      .from("coach_messages")
      .select("role, content, tool_calls")
      .eq("conversation_id", body.conversation_id)
      .order("created_at", { ascending: true })
      .limit(40);

    const systemContent = `${prompt?.body ?? "You are a helpful SEO coach."}

WORKSPACE CONTEXT:
${JSON.stringify(wsOverview, null, 2)}

${body.context ? `CURRENT PAGE CONTEXT: ${JSON.stringify(body.context)}` : ""}`;

    // Insert user message
    await admin.from("coach_messages").insert({
      conversation_id: body.conversation_id,
      role: "user",
      content: body.user_message,
    });

    // Build messages array for LLM
    const messages: ChatMessage[] = [{ role: "system", content: systemContent }];
    for (const m of (history ?? [])) {
      const msg: ChatMessage = { role: m.role as ChatMessage["role"], content: (m.content ?? "") as string };
      if (m.tool_calls) msg.tool_calls = m.tool_calls as ChatMessage["tool_calls"];
      messages.push(msg);
    }
    messages.push({ role: "user", content: body.user_message });

    // Resolve provider key
    const { data: creds } = await admin
      .from("tenant_ai_credentials").select("provider, status").eq("workspace_id", body.workspace_id);
    const validByok = (creds ?? []).find((c) => c.status === "valid");

    let apiBase = "https://ai.gateway.lovable.dev/v1";
    let apiKey = LOVABLE_API_KEY ?? "";
    let model = PLATFORM_DEFAULT_MODEL;
    let usedByok = false;

    if (validByok) {
      const { data: key } = await admin.rpc("tenant_get_ai_credential", {
        _workspace_id: body.workspace_id, _provider: validByok.provider,
      });
      if (key) {
        apiKey = key as string;
        usedByok = true;
        if (validByok.provider === "openai") {
          apiBase = "https://api.openai.com/v1"; model = "gpt-4o-mini";
        } else if (validByok.provider === "openrouter") {
          apiBase = "https://openrouter.ai/api/v1"; model = "openai/gpt-4o-mini";
        }
        // Anthropic / Google fall through to gateway with platform key for tool-loop simplicity (v1)
        // Future: native adapters with tool support
        if (validByok.provider === "anthropic" || validByok.provider === "google") {
          apiBase = "https://ai.gateway.lovable.dev/v1";
          apiKey = LOVABLE_API_KEY ?? "";
          model = PLATFORM_DEFAULT_MODEL;
          usedByok = false;
        }
      }
    }

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "No AI provider configured" }), {
        status: 500, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Set up SSE stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        try {
          let totalPromptTokens = 0;
          let totalCompletionTokens = 0;
          const toolCallRecords: Array<{ name: string; input: unknown; output: unknown }> = [];

          // Tool loop
          for (let iter = 0; iter < 8; iter++) {
            const resp = await callOpenAICompatible(apiBase, apiKey, {
              model, messages, tools: TOOLS, tool_choice: "auto",
            });
            const choice = resp.choices?.[0];
            const msg = choice?.message;
            totalPromptTokens += resp.usage?.prompt_tokens ?? 0;
            totalCompletionTokens += resp.usage?.completion_tokens ?? 0;

            if (msg?.tool_calls && msg.tool_calls.length > 0) {
              messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
              for (const tc of msg.tool_calls) {
                const toolName = tc.function.name;
                let parsedArgs: Record<string, unknown> = {};
                try { parsedArgs = JSON.parse(tc.function.arguments || "{}"); } catch { /* noop */ }
                send("tool_start", { id: tc.id, name: toolName, args: parsedArgs });
                const output = await executeTool(admin, body.workspace_id, toolName, parsedArgs);
                toolCallRecords.push({ name: toolName, input: parsedArgs, output });
                send("tool_result", { id: tc.id, name: toolName, output });
                messages.push({
                  role: "tool", tool_call_id: tc.id, name: toolName,
                  content: JSON.stringify(output).slice(0, 8000),
                });
              }
              continue;
            }

            // Final assistant text — stream it word-by-word for UX
            const finalText = msg?.content ?? "";
            const words = finalText.split(/(\s+)/);
            for (const w of words) {
              send("delta", { text: w });
              await new Promise((r) => setTimeout(r, 8));
            }

            // Persist final assistant message
            await admin.from("coach_messages").insert({
              conversation_id: body.conversation_id,
              role: "assistant",
              content: finalText,
              tool_calls: toolCallRecords.length > 0 ? toolCallRecords : null,
              tokens_used: totalPromptTokens + totalCompletionTokens,
            });

            // Update conversation
            await admin.from("coach_conversations")
              .update({ updated_at: new Date().toISOString() })
              .eq("id", body.conversation_id);

            send("done", {
              prompt_tokens: totalPromptTokens,
              completion_tokens: totalCompletionTokens,
              used_byok: usedByok,
              model,
            });
            controller.close();
            return;
          }

          send("error", { message: "Tool loop exceeded 8 iterations" });
          controller.close();
        } catch (e) {
          const m = e instanceof Error ? e.message : "Unknown error";
          console.error("[coach-chat]", m);
          send("error", { message: m });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        ...cors,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : "Unknown error";
    console.error("[coach-chat] outer", m);
    return new Response(JSON.stringify({ error: m }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
