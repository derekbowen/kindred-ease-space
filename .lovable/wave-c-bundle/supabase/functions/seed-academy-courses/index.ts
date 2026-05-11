// One-shot seed function (admin-only): upsert all academy courses from bundled seed.json
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import seed from "./seed.json" with { type: "json" };

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

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(url, key);

    // Require admin auth
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "");
    if (!token) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const { data: u, error: uErr } = await sb.auth.getUser(token);
    if (uErr || !u.user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const { data: role } = await sb.from("user_roles").select("role").eq("user_id", u.user.id).eq("role", "admin").maybeSingle();
    if (!role) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });

    const rows = (seed as any[]).map((r) => ({
      slug: r.slug,
      title: r.title,
      subtitle: r.subtitle,
      excerpt: r.excerpt,
      category: r.category,
      tier: r.tier,
      embed_url: r.embed_url,
      cover_image_url: r.cover_image_url,
      seo_title: r.seo_title,
      seo_description: r.seo_description,
      duration_minutes: r.duration_minutes,
      level: r.level,
      long_form_content: r.long_form_content,
      is_featured: r.is_featured,
      is_published: true,
      language: "en",
    }));

    const { data, error } = await sb.from("courses").upsert(rows, { onConflict: "slug" }).select("slug");
    if (error) throw error;
    return new Response(JSON.stringify({ ok: true, count: data?.length ?? 0, slugs: data?.map((d: any) => d.slug) }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
