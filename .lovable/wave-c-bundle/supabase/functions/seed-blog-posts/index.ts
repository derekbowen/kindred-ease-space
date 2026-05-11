// Admin-only seed endpoint: upsert blog posts.
// Auth: requires Bearer JWT for a user with the 'admin' role.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Restrict CORS to first-party origins. seed endpoints are not public APIs.
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
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: cors });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(url, key);

    // Verify Bearer JWT and admin role
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!token) return json({ error: "Unauthorized" }, 401);
    const { data: u, error: uErr } = await sb.auth.getUser(token);
    if (uErr || !u.user) return json({ error: "Unauthorized" }, 401);
    const { data: role } = await sb
      .from("user_roles")
      .select("role")
      .eq("user_id", u.user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!role) return json({ error: "Forbidden" }, 403);

    const body = await req.json().catch(() => null);
    const posts = Array.isArray(body?.posts) ? body.posts : null;
    if (!posts || posts.length === 0 || posts.length > 500) {
      return json({ error: "Invalid posts payload" }, 400);
    }

    const rows = posts.map((p: Record<string, unknown>) => ({
      ...p,
      author: "PoolRentalNearMe Editorial",
      is_published: true,
      published_at: new Date().toISOString(),
    }));

    const { error, count } = await sb
      .from("blog_posts")
      .upsert(rows, { onConflict: "slug", count: "exact" });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, count });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
