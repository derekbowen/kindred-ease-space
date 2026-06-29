import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

// In-memory rate limiter: 1000 req/min/IP. Per-Worker-instance only —
// good enough to dampen single-source abuse. Mirrors public-page-lookup.
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

function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return request.headers.get("cf-connecting-ip") || "unknown";
}

const Body = z.object({
  hostname: z.string().min(3).max(253),
  slug: z.string().min(1).max(500),
});

function normalizeHostname(input: string): string {
  return (input || "")
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Default to no-store. Negative results (domain_not_found / page_not_found)
      // would otherwise be cached for 60s at the edge, so a newly verified
      // domain or freshly published page would 404 to embedders for up to a
      // minute. Successful lookups can opt back into a short cache via `extra`.
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

export const Route = createFileRoute("/api/public/page-lookup")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: { ...CORS_HEADERS, "Access-Control-Max-Age": "86400" },
        }),

      POST: async ({ request }) => {
        const ip = clientIp(request);
        if (!rateLimit(ip)) {
          return json(429, { ok: false, error: "rate_limited" }, { "Cache-Control": "no-store" });
        }

        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return json(400, { ok: false, error: "invalid_json" }, { "Cache-Control": "no-store" });
        }

        const parsed = Body.safeParse(raw);
        if (!parsed.success) {
          return json(400, { ok: false, error: "invalid_input" }, { "Cache-Control": "no-store" });
        }

        const hostname = normalizeHostname(parsed.data.hostname);
        const slug = parsed.data.slug.replace(/^\/+/, "");
        if (!hostname.includes(".")) {
          return json(400, { ok: false, error: "invalid_hostname" }, { "Cache-Control": "no-store" });
        }

        const { data: domain } = await sb()
          .from("workspace_domains")
          .select("workspace_id")
          .eq("hostname", hostname)
          .eq("verified", true)
          .maybeSingle();
        if (!domain) return json(200, { ok: false, error: "domain_not_found" });

        const { data: tenantPage } = await sb()
          .from("tenant_pages")
          .select("id, slug, title, body_markdown, meta_description, updated_at")
          .eq("workspace_id", domain.workspace_id)
          .eq("slug", slug)
          .eq("status", "published")
          .maybeSingle();

        if (tenantPage) {
          return json(
            200,
            {
              ok: true,
              page: {
                id: tenantPage.id,
                slug: tenantPage.slug,
                title: tenantPage.title,
                body_markdown: tenantPage.body_markdown,
                seo_title: tenantPage.title,
                seo_description: tenantPage.meta_description,
                hero_image_url: null,
                updated_at: tenantPage.updated_at,
              },
            },
            { "Cache-Control": "public, max-age=60" },
          );
        }

        const { data: page } = await sb()
          .from("content_pages")
          .select("id, slug, title, body_markdown, seo_title, seo_description, hero_image_url, updated_at")
          .eq("workspace_id", domain.workspace_id)
          .eq("slug", slug)
          .eq("status", "published")
          .eq("in_sitemap", true)
          .maybeSingle();
        if (!page) return json(200, { ok: false, error: "page_not_found" });

        return json(200, { ok: true, page }, { "Cache-Control": "public, max-age=60" });
      },
    },
  },
});
