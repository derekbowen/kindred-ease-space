import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

// Read by the Founders edge Worker on a config-cache miss to decide how to
// route a hostname. Returns routing config ONLY for domains that are verified
// and routable — unknown hosts get 404, which the Worker turns into a refusal
// to serve (host-header security: never serve a domain we don't manage).
//
// Cacheable: the Worker caches positive answers for 60s and negatives for 10s,
// so config changes (disconnect, suspension) propagate within a minute.

const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(ip: string, limit = 2000, windowMs = 60_000): boolean {
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

const Query = z.object({ hostname: z.string().min(3).max(253) });

export const Route = createFileRoute("/api/public/domain-config")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!rateLimit(clientIp(request))) {
          return new Response(JSON.stringify({ error: "rate_limited" }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }

        const url = new URL(request.url);
        const parsed = Query.safeParse({ hostname: url.searchParams.get("hostname") ?? "" });
        if (!parsed.success) {
          return new Response(JSON.stringify({ error: "hostname_required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const hostname = parsed.data.hostname
          .toLowerCase()
          .trim()
          .replace(/^https?:\/\//, "")
          .replace(/\/.*$/, "")
          .replace(/:\d+$/, "");

        const { data: row } = await sb()
          .from("workspace_domains")
          .select(
            "connection_type, status, customer_origin, route_prefix, workspace_id, founders_disabled, updated_at",
          )
          .eq("hostname", hostname)
          .eq("verified", true)
          .maybeSingle();

        if (!row || row.status === "disconnected") {
          return new Response(JSON.stringify({ error: "domain_not_found" }), {
            status: 404,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=10",
            },
          });
        }

        // KILL SWITCH. Deliberately still a 200 with the origin attached: a 404
        // here would make the edge treat the host as unknown, which in
        // full_proxy is the whole-domain outage we are trying to escape. The
        // emergency state must hand the edge everything it needs to pass 100%
        // of traffic — /a/* included — straight to the customer.
        if (row.founders_disabled) {
          return new Response(
            JSON.stringify({
              hostname,
              mode: row.connection_type,
              route_prefix: row.route_prefix || "/a/",
              customer_origin:
                row.customer_origin && row.customer_origin.toLowerCase() !== hostname
                  ? row.customer_origin
                  : null,
              disabled: true,
              active: false,
              status: row.status,
              config_version: row.updated_at,
            }),
            {
              headers: {
                "Content-Type": "application/json",
                // Short TTL so re-enabling takes effect quickly.
                "Cache-Control": "public, max-age=15",
              },
            },
          );
        }

        // Loop safety: never hand the edge an origin that would route straight
        // back into itself.
        const origin =
          row.customer_origin && row.customer_origin.toLowerCase() !== hostname
            ? row.customer_origin
            : null;

        return new Response(
          JSON.stringify({
            hostname,
            mode: row.connection_type,
            route_prefix: row.route_prefix || "/a/",
            customer_origin: origin,
            // 'active' means both routes tested; earlier states still let the
            // Worker serve /a/* so activation tests can pass.
            active: row.status === "active",
            status: row.status,
            disabled: false,
            // Lets the edge tell one config generation from another when
            // reasoning about stale copies.
            config_version: row.updated_at,
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=60",
            },
          },
        );
      },
    },
  },
});
