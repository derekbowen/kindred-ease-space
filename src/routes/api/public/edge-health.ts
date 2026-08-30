import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

// Receives health reports from the Founders edge Worker (see
// edge/founders-edge/worker.js, reportStale). The edge tells us it is running
// on stale config BEFORE a customer has to tell us their site is broken.
//
// Three properties this endpoint must have, in priority order:
//
//  1. It must never fail the Worker. The Worker fires this with waitUntil and
//     ignores the result, but a slow or 500ing endpoint still burns edge CPU
//     during an incident. Everything here is cheap and always answers 202.
//
//  2. It must never amplify the outage it reports. Once config is stale, every
//     request to that host is a candidate report. The Worker throttles per
//     isolate; this is the authoritative per-hostname throttle.
//
//  3. It must not be a write primitive for the public internet. It is
//     unauthenticated by necessity — the Worker has no credential to present —
//     so it only records hostnames we actually manage, and stores no
//     caller-supplied free text.

const REPORT_INTERVAL_MS = 60_000;
const lastWriteAt = new Map<string, number>();

// Hostname -> is it ours. Avoids a workspace_domains read per report during an
// incident, and stops unknown hosts reaching the database at all.
const KNOWN_TTL_MS = 300_000;
const knownHosts = new Map<string, { known: boolean; at: number }>();

const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(ip: string, limit = 600, windowMs = 60_000): boolean {
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

function sweep<T>(map: Map<string, T>, keep: (v: T) => boolean, cap = 2000) {
  if (map.size <= cap) return;
  for (const [k, v] of map) if (!keep(v)) map.delete(k);
}

const Body = z.object({
  hostname: z.string().min(3).max(253),
  // Mirrors edge_health_state_check in 20260830020000_boundary_contract.sql.
  // Kept in sync deliberately: an unknown state should be rejected here with a
  // 202 rather than become a constraint violation in the database.
  state: z.enum(["HEALTHY", "CONTROL_PLANE_DEGRADED", "STALE_CONFIG", "BROKEN"]),
  stale_age_s: z.number().int().min(0).max(31_536_000).optional(),
});

// Telemetry is never load-bearing: the Worker keeps serving whatever this says.
const accepted = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 202,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export const Route = createFileRoute("/api/public/edge-health")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!rateLimit(clientIp(request))) return accepted();

        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return accepted();
        }
        const parsed = Body.safeParse(raw);
        if (!parsed.success) return accepted();

        const hostname = parsed.data.hostname
          .toLowerCase()
          .trim()
          .replace(/^https?:\/\//, "")
          .replace(/\/.*$/, "")
          .replace(/:\d+$/, "");
        if (!hostname) return accepted();

        const now = Date.now();

        // Throttle before the existence check, so a flood costs one Map lookup.
        const last = lastWriteAt.get(hostname);
        if (last && now - last < REPORT_INTERVAL_MS) return accepted();

        try {
          let entry = knownHosts.get(hostname);
          if (!entry || now - entry.at > KNOWN_TTL_MS) {
            const { data } = await sb()
              .from("workspace_domains")
              .select("hostname")
              .eq("hostname", hostname)
              .maybeSingle();
            entry = { known: Boolean(data), at: now };
            knownHosts.set(hostname, entry);
            sweep(knownHosts, (v) => now - v.at <= KNOWN_TTL_MS);
          }
          // A host we don't manage cannot generate rows. Otherwise this is an
          // unauthenticated insert endpoint with an attacker-chosen key.
          if (!entry.known) return accepted();

          lastWriteAt.set(hostname, now);
          sweep(lastWriteAt, (t) => now - t <= REPORT_INTERVAL_MS);

          const { error } = await sb().from("edge_health_events").insert({
            hostname,
            state: parsed.data.state,
            stale_age_s: parsed.data.stale_age_s ?? null,
            detail: null,
          });
          if (error) {
            // Most likely cause: 20260830020000_boundary_contract.sql has not
            // been applied yet. Log loudly — a silent drop here would mean the
            // edge believes it is reporting and nobody is listening.
            console.error("[edge-health] insert failed", hostname, error.message);
          } else if (parsed.data.state !== "HEALTHY") {
            // Surfaced in server logs so a degraded edge is visible even
            // before anyone queries the table.
            console.error(
              `[edge-health] ${parsed.data.state} hostname=${hostname} stale_age_s=${
                parsed.data.stale_age_s ?? "n/a"
              }`,
            );
          }
        } catch (e) {
          console.error("[edge-health] unavailable", String(e));
        }

        return accepted();
      },
    },
  },
});
