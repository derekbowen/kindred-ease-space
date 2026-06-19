// Daily briefing generator. Called by pg_cron via /api/public/hooks (or directly).
// For each active workspace, runs analysis and asks the LLM for top 3 highest-ROI actions.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  // This function runs with verify_jwt = false (so pg_cron can call it), which
  // leaves it open to the internet. When CRON_SECRET is configured, require it —
  // this gates the otherwise-unauthenticated endpoint that fans out expensive
  // LLM calls across every workspace. (Set CRON_SECRET on the function, the
  // pg_cron job header, and the app; until then behaviour is unchanged.)
  const CRON_SECRET = Deno.env.get("CRON_SECRET");
  if (CRON_SECRET) {
    const provided = req.headers.get("x-cron-secret");
    if (provided !== CRON_SECRET) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const today = new Date().toISOString().slice(0, 10);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const onlyWorkspaceId = (body as { workspace_id?: string }).workspace_id;

    let q = admin.from("workspaces").select("id, name").neq("subscription_status", "canceled");
    if (onlyWorkspaceId) q = q.eq("id", onlyWorkspaceId);
    const { data: workspaces } = await q;

    const results: Array<{ workspace_id: string; ok: boolean; error?: string }> = [];

    for (const ws of (workspaces ?? [])) {
      try {
        // Skip if briefing already exists for today
        const { data: existing } = await admin
          .from("coach_daily_briefings")
          .select("id")
          .eq("workspace_id", ws.id)
          .eq("briefing_date", today)
          .maybeSingle();
        if (existing && !onlyWorkspaceId) {
          results.push({ workspace_id: ws.id as string, ok: true });
          continue;
        }

        // Gather signals
        const [pages, listings] = await Promise.all([
          admin.from("tenant_pages").select("id, slug, title, status, meta_description, body_markdown, listing_filter")
            .eq("workspace_id", ws.id),
          admin.from("tenant_listings").select("id, city, category").eq("workspace_id", ws.id),
        ]);
        const allPages = (pages.data ?? []) as Array<{ id: string; slug: string; title: string; status: string; meta_description: string | null; body_markdown: string | null; listing_filter: { city?: string } | null }>;
        const published = allPages.filter((p) => p.status === "published");
        const drafts = allPages.filter((p) => p.status === "draft");

        // Thin pages
        const thinPages = published.filter((p) => ((p.body_markdown ?? "").split(/\s+/).filter(Boolean).length) < 300);
        // Missing meta
        const missingMeta = published.filter((p) => !p.meta_description);

        // Uncovered cities
        const cityCoverage = new Set<string>();
        for (const p of published) {
          const f = p.listing_filter ?? {};
          if (f.city) cityCoverage.add(String(f.city).toLowerCase());
        }
        const cityCounts = new Map<string, number>();
        for (const l of (listings.data ?? []) as Array<{ city: string | null }>) {
          if (l.city) cityCounts.set(l.city.toLowerCase(), (cityCounts.get(l.city.toLowerCase()) ?? 0) + 1);
        }
        const uncoveredCities = [...cityCounts.entries()]
          .filter(([c]) => !cityCoverage.has(c))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);

        const summary = {
          total_pages: allPages.length,
          published: published.length,
          drafts: drafts.length,
          thin_pages: thinPages.length,
          thin_examples: thinPages.slice(0, 3).map((p) => ({ id: p.id, slug: p.slug })),
          missing_meta: missingMeta.length,
          missing_meta_examples: missingMeta.slice(0, 3).map((p) => ({ id: p.id, slug: p.slug })),
          uncovered_cities: uncoveredCities.map(([city, count]) => ({ city, listing_count: count })),
          total_listings: listings.data?.length ?? 0,
        };

        // Ask LLM for top 3 insights — use platform key (briefings are an internal feature)
        let insights: Array<Record<string, unknown>> = [];
        if (LOVABLE_API_KEY) {
          const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "google/gemini-3-flash-preview",
              messages: [
                {
                  role: "system",
                  content: `You produce a daily briefing for a Sharetribe marketplace operator. Return STRICT JSON only: {"insights":[{"title":"...","description":"...","priority":"high|medium|low","action_type":"fix_thin_page|add_meta|create_city_page|other","action_payload":{...}}]}. Max 3 insights. Lead with highest ROI. Be specific — reference page slugs and city names from the data. Each description under 25 words.`,
                },
                { role: "user", content: `Workspace data:\n${JSON.stringify(summary)}` },
              ],
              response_format: { type: "json_object" },
            }),
          });
          if (r.ok) {
            const j = await r.json();
            try {
              const parsed = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
              insights = Array.isArray(parsed.insights) ? parsed.insights.slice(0, 3) : [];
            } catch { /* leave empty */ }
          }
        }

        // Fallback if LLM failed
        if (insights.length === 0) {
          if (thinPages.length > 0) insights.push({
            title: `${thinPages.length} thin pages need content`,
            description: `Pages under 300 words rarely rank. Start with /p/${thinPages[0].slug}.`,
            priority: "high", action_type: "fix_thin_page",
            action_payload: { page_id: thinPages[0].id },
          });
          if (uncoveredCities.length > 0) insights.push({
            title: `Create page for ${uncoveredCities[0][0]}`,
            description: `${uncoveredCities[0][1]} listings in ${uncoveredCities[0][0]} have no dedicated page.`,
            priority: "high", action_type: "create_city_page",
            action_payload: { city: uncoveredCities[0][0] },
          });
          if (missingMeta.length > 0) insights.push({
            title: `${missingMeta.length} pages missing meta description`,
            description: `Quick win — add meta descriptions to boost CTR.`,
            priority: "medium", action_type: "add_meta",
            action_payload: { page_ids: missingMeta.slice(0, 5).map((p) => p.id) },
          });
        }

        await admin.from("coach_daily_briefings").upsert({
          workspace_id: ws.id, briefing_date: today, insights,
          generated_at: new Date().toISOString(), viewed_at: null,
        }, { onConflict: "workspace_id,briefing_date" });

        results.push({ workspace_id: ws.id as string, ok: true });
      } catch (e) {
        results.push({ workspace_id: ws.id as string, ok: false, error: e instanceof Error ? e.message : "unknown" });
      }
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : "Unknown error";
    console.error("[coach-briefing-cron]", m);
    return new Response(JSON.stringify({ error: m }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
