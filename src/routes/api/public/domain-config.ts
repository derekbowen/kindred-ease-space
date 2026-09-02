import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { clientIp } from "@/lib/public-rate-limit";

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

        const { data: row, error: lookupError } = await sb()
          .from("workspace_domains")
          .select(
            "connection_type, status, customer_origin, route_prefix, workspace_id, founders_disabled, updated_at",
          )
          .eq("hostname", hostname)
          .eq("verified", true)
          .maybeSingle();

        // A FAILED QUERY IS NOT A MISSING DOMAIN. This distinction is the whole
        // safety contract, and dropping the error made the two identical.
        //
        // The edge treats 404 as authoritative — "this host really isn't ours" —
        // and responds by DELETING its last-known-good config and serving 404
        // for the whole hostname. In full_proxy that is the customer's entire
        // marketplace down, and it destroys the stale-config safety net on the
        // way out.
        //
        // So anything that is not a clean "query ran, no row" must be a 5xx.
        // The edge falls back to last-known-good on 5xx, which is exactly the
        // behaviour we want when OUR side is broken.
        //
        // The concrete way this bites: deploy code selecting a column whose
        // migration has not been applied yet and PostgREST 400s every request.
        // Every connected customer would have gone dark, from a schema drift.
        if (lookupError) {
          console.error("[domain-config] lookup failed", hostname, lookupError.message);
          return new Response(JSON.stringify({ error: "control_plane_error" }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          });
        }

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
