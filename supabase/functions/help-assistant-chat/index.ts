// Streaming RAG chat for the founders.click help center.
// Public endpoint (no auth required) — visitors should be able to ask questions.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EMBED_MODEL = "google/gemini-embedding-001";
const EMBED_DIMS = 1536;
const CHAT_MODEL = "google/gemini-3-flash-preview";
const SITE = "https://founders.click";

type Msg = { role: "user" | "assistant"; content: string };

async function embedQuery(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text, dimensions: EMBED_DIMS }),
  });
  if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.data[0].embedding as number[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY missing");

    const { messages } = (await req.json()) as { messages: Msg[] };
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const query = (lastUser?.content ?? "").slice(0, 2000);

    // Retrieve top help chunks
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    let context = "";
    const sources: { title: string; url: string }[] = [];
    if (query.trim().length > 2) {
      try {
        const qEmb = await embedQuery(query, LOVABLE_API_KEY);
        const { data: matches, error } = await admin.rpc("match_help_chunks", {
          query_embedding: qEmb as unknown as string,
          match_count: 6,
        });
        if (error) console.error("match_help_chunks", error);
        if (matches?.length) {
          const seen = new Set<string>();
          context = matches
            .map((m: any, i: number) => {
              const url = `${SITE}/help/${m.category_slug}/${m.article_slug}`;
              if (!seen.has(url)) { seen.add(url); sources.push({ title: m.article_title, url }); }
              return `[Source ${i + 1}: ${m.article_title}]\n${m.content}`;
            })
            .join("\n\n---\n\n");
        }
      } catch (e) {
        console.error("retrieval error", e);
      }
    }

    const systemPrompt = `You are the founders.click support assistant. founders.click helps Sharetribe marketplace operators with SEO, content, and growth tooling.

Answer ONLY using the help center context below when it is relevant. If the answer is not in the context, say you don't have a documented answer and suggest contacting support at support@founders.click. Be concise. Use short paragraphs and bullet lists. When you reference a source, cite it inline as [1], [2], matching the Source numbers in the context. Do not invent URLs.

HELP CENTER CONTEXT:
${context || "(no relevant articles found)"}`;

    const upstream = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CHAT_MODEL,
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages.slice(-10),
        ],
      }),
    });

    if (!upstream.ok) {
      if (upstream.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit. Please try again in a moment." }), { status: 429, headers: { ...cors, "Content-Type": "application/json" } });
      }
      if (upstream.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Please contact support." }), { status: 402, headers: { ...cors, "Content-Type": "application/json" } });
      }
      const t = await upstream.text();
      console.error("ai gateway", upstream.status, t);
      return new Response(JSON.stringify({ error: "AI gateway error" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
    }

    // Prepend sources as a custom SSE event before piping the upstream stream.
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`event: sources\ndata: ${JSON.stringify(sources)}\n\n`));
        const reader = upstream.body!.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  } catch (e) {
    console.error("[help-assistant-chat]", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
