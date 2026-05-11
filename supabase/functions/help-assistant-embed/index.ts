// Embeds (or re-embeds) all published platform help articles into help_article_embeddings.
// Admin-only. Auth: requires the caller to be a user with role 'admin' in user_roles.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EMBED_MODEL = "google/gemini-embedding-001";
const EMBED_DIMS = 1536;
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;

function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chunk(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + CHUNK_CHARS);
    out.push(text.slice(i, end));
    if (end >= text.length) break;
    i = end - CHUNK_OVERLAP;
  }
  return out;
}

async function embedBatch(inputs: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs, dimensions: EMBED_DIMS }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`embeddings ${res.status}: ${t}`);
  }
  const j = await res.json();
  return (j.data as Array<{ embedding: number[] }>).map((d) => d.embedding);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY missing");

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // AuthN/AuthZ: require admin role
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const { data: isAdmin } = await admin.rpc("has_role", { _user_id: u.user.id, _role: "admin" });
    if (!isAdmin) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });

    const body = await req.json().catch(() => ({}));
    const articleId: string | undefined = body.articleId;

    let q = admin
      .from("help_articles")
      .select("id,title,excerpt,content,category_slug,tags,status,is_published,workspace_id")
      .is("workspace_id", null)
      .eq("is_published", true);
    if (articleId) q = q.eq("id", articleId);
    const { data: articles, error } = await q;
    if (error) throw error;

    let totalChunks = 0;
    for (const a of articles ?? []) {
      if ((a as any).status && (a as any).status !== "published") continue;
      const head = `# ${a.title}\nCategory: ${a.category_slug}\n${a.excerpt ?? ""}\n${(a.tags ?? []).join(", ")}`;
      const text = stripMarkdown(`${head}\n\n${a.content ?? ""}`);
      const pieces = chunk(text).filter((p) => p.trim().length > 40);
      if (pieces.length === 0) continue;
      // Embed in batches of 32
      const rows: { article_id: string; chunk_index: number; content: string; embedding: number[] }[] = [];
      for (let i = 0; i < pieces.length; i += 32) {
        const batch = pieces.slice(i, i + 32);
        const embs = await embedBatch(batch, LOVABLE_API_KEY);
        embs.forEach((emb, j) => rows.push({ article_id: a.id, chunk_index: i + j, content: batch[j], embedding: emb }));
      }
      // Replace existing chunks for this article
      await admin.from("help_article_embeddings").delete().eq("article_id", a.id);
      const { error: insErr } = await admin.from("help_article_embeddings").insert(rows as any);
      if (insErr) throw insErr;
      totalChunks += rows.length;
    }

    return new Response(JSON.stringify({ ok: true, articles: articles?.length ?? 0, chunks: totalChunks }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[help-assistant-embed]", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
