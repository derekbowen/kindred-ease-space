import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getRequestIP, setResponseHeaders } from "@tanstack/react-start/server";

const sb = () => supabaseAdmin as any;

// Tiny in-memory rate limiter: 1000 requests / minute / IP. Per-instance only;
// good enough to dampen abuse from a single source between Worker callers.
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(ip: string, limit = 1000, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || b.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

function corsHeaders(): Headers {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "content-type");
  h.set("Cache-Control", "public, max-age=60");
  return h;
}

export const lookupPageByHostname = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({
      hostname: z.string().min(3).max(253),
      slug: z.string().min(1).max(500),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    setResponseHeaders(corsHeaders());

    let ip = "unknown";
    try { ip = getRequestIP({ xForwardedFor: true }) || "unknown"; } catch { /* not in request ctx */ }
    if (!rateLimit(ip)) {
      return { ok: false as const, error: "rate_limited" };
    }

    const hostname = data.hostname.toLowerCase().trim().replace(/^www\./, "");
    const slug = data.slug.replace(/^\/+/, "");

    const { data: domain } = await sb()
      .from("workspace_domains")
      .select("workspace_id")
      .eq("hostname", hostname)
      .eq("verified", true)
      .maybeSingle();
    if (!domain) return { ok: false as const, error: "domain_not_found" };

    const { data: page } = await sb()
      .from("content_pages")
      .select("id, slug, title, body_markdown, seo_title, seo_description, hero_image_url, updated_at")
      .eq("workspace_id", domain.workspace_id)
      .eq("slug", slug)
      .eq("status", "published")
      .eq("in_sitemap", true)
      .maybeSingle();
    if (!page) return { ok: false as const, error: "page_not_found" };

    return { ok: true as const, page };
  });
