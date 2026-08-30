import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  assertWorkspaceMember,
  assertWorkspaceOwner,
  workspaceIdSchema,
} from "./admin-helpers.functions";

const sb = () => supabaseAdmin as any;

export type DomainConnectionType = "full_proxy" | "subdomain" | "customer_proxy";

export type WorkspaceDomainRow = {
  id: string;
  hostname: string;
  verified: boolean;
  verified_at: string | null;
  ssl_status: string | null;
  created_at: string;
  verification_token?: string;
  verification_method?: string | null;
  connection_type: DomainConnectionType;
  status: string;
  customer_origin: string | null;
  route_prefix: string;
  dns_provider: string | null;
  last_error: string | null;
  activated_at: string | null;
  health_status: string | null;
};

function normalizeHostname(input: string): string {
  let h = (input || "").trim().toLowerCase();
  h = h
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  return h;
}

function isValidHostname(h: string): boolean {
  if (!h || h.length < 3 || h.length > 253) return false;
  if (/\s/.test(h)) return false;
  if (!h.includes(".")) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h);
}

function genToken(): string {
  return (crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")).slice(
    0,
    64,
  );
}

/** The hostname customers point DNS at. One value for every customer — the
 * edge reads per-domain routing from the database, never from config files. */
export const EDGE_HOSTNAME = "proxy.founders.click";

async function dohQuery(name: string, type: "A" | "CNAME" | "NS" | "TXT"): Promise<string[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { Accept: "application/dns-json" }, signal: ctrl.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return [];
    const json: any = await res.json();
    return ((json?.Answer as any[]) || [])
      .map((a) => String(a.data || "").replace(/^"|"$/g, "").replace(/\.$/, "").toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function guessDnsProvider(nsRecords: string[]): string | null {
  const ns = nsRecords.join(" ");
  if (ns.includes("cloudflare.com")) return "cloudflare";
  if (ns.includes("domaincontrol.com")) return "godaddy";
  if (ns.includes("registrar-servers.com")) return "namecheap";
  if (ns.includes("awsdns")) return "route53";
  if (ns.includes("wixdns")) return "wix";
  if (ns.includes("squarespacedns")) return "squarespace";
  if (ns.includes("googledomains") || ns.includes("google.com")) return "google";
  if (ns.includes("webflow")) return "webflow";
  return nsRecords[0] ?? null;
}

/**
 * Best-effort discovery of the customer's CURRENT web origin, captured BEFORE
 * any DNS cutover — in full-proxy mode the edge sends non-/a/* traffic back
 * here. A CNAME target (Webflow/Shopify/Netlify/…) is a proxyable origin; bare
 * A-record IPs are not (TLS/SNI would fail), so those need the www CNAME or a
 * manual origin.
 */
async function detectDomainDns(hostname: string): Promise<{
  dnsProvider: string | null;
  originCandidate: string | null;
}> {
  const parts = hostname.split(".");
  const registrable = parts.slice(-2).join(".");
  const [cname, wwwCname, ns] = await Promise.all([
    dohQuery(hostname, "CNAME"),
    dohQuery(`www.${registrable}`, "CNAME"),
    dohQuery(registrable, "NS"),
  ]);
  const candidate =
    cname.find((c) => c && c !== hostname && !c.endsWith("founders.click")) ||
    wwwCname.find((c) => c && c !== `www.${registrable}` && !c.endsWith("founders.click")) ||
    null;
  return { dnsProvider: guessDnsProvider(ns), originCandidate: candidate };
}

/** How many custom domains this workspace's plan allows. Server-side authority
 * — the client never supplies a limit. */
async function domainAllowance(workspaceId: string): Promise<number> {
  const { data: ws } = await sb()
    .from("workspaces")
    .select("plan, subscription_status")
    .eq("id", workspaceId)
    .maybeSingle();
  const entitled =
    ws && ["active", "trialing", "past_due"].includes(String(ws.subscription_status ?? ""));
  const { domainLimitForPlan, TRIAL_DOMAIN_LIMIT } = await import("@/lib/plan-catalog");
  return entitled ? domainLimitForPlan(String(ws?.plan ?? "")) : TRIAL_DOMAIN_LIMIT;
}

export const listWorkspaceDomains = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(
    async ({
      data,
      context,
    }): Promise<{ rows: WorkspaceDomainRow[]; domainLimit: number; edgeHostname: string }> => {
    const role = await assertWorkspaceMember(data.workspaceId, context.userId);
    const isOwner = role === "owner";
    const { data: rows } = await sb()
      .from("workspace_domains")
      .select(
        "id, hostname, verified, verified_at, ssl_status, created_at, verification_token, verification_method, connection_type, status, customer_origin, route_prefix, dns_provider, last_error, activated_at, health_status",
      )
      .eq("workspace_id", data.workspaceId)
      .order("created_at", { ascending: false });
    const limit = await domainAllowance(data.workspaceId);
    return {
      rows: (rows || []).map((r: any) => ({
        id: r.id,
        hostname: r.hostname,
        verified: r.verified,
        verified_at: r.verified_at,
        ssl_status: r.ssl_status,
        created_at: r.created_at,
        verification_method: r.verification_method,
        connection_type: (r.connection_type ?? "full_proxy") as DomainConnectionType,
        status: r.status ?? (r.verified ? "verified" : "verification_required"),
        customer_origin: r.customer_origin ?? null,
        route_prefix: r.route_prefix ?? "/a/",
        dns_provider: r.dns_provider ?? null,
        last_error: r.last_error ?? null,
        activated_at: r.activated_at ?? null,
        health_status: r.health_status ?? null,
        // Only owners see the verification token.
        verification_token: isOwner ? r.verification_token : undefined,
      })),
      domainLimit: limit,
      edgeHostname: EDGE_HOSTNAME,
    };
  });

export const addWorkspaceDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        hostname: z.string().min(3).max(253),
        connectionType: z.enum(["full_proxy", "subdomain", "customer_proxy"]).default("full_proxy"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const hostname = normalizeHostname(data.hostname);
    if (!isValidHostname(hostname)) {
      return { ok: false as const, error: "Invalid hostname. Use a domain like example.com." };
    }
    if (hostname.endsWith("founders.click")) {
      return { ok: false as const, error: "That hostname belongs to the platform." };
    }

    // Server-side domain entitlement — the plan decides, never the client.
    const [{ count: existing }, limit] = await Promise.all([
      sb()
        .from("workspace_domains")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", data.workspaceId)
        .neq("status", "disconnected"),
      domainAllowance(data.workspaceId),
    ]);
    if ((existing ?? 0) >= limit) {
      return {
        ok: false as const,
        error: `Your plan includes ${limit} connected domain${limit === 1 ? "" : "s"}. Upgrade to connect more.`,
        code: "domain_limit" as const,
      };
    }

    // Capture the customer's CURRENT origin and DNS provider BEFORE any
    // cutover — full-proxy mode routes non-/a/* traffic back to this origin.
    const detected = await detectDomainDns(hostname);

    const token = genToken();
    const { data: row, error } = await sb()
      .from("workspace_domains")
      .insert({
        workspace_id: data.workspaceId,
        hostname,
        verification_token: token,
        verified: false,
        connection_type: data.connectionType,
        status: "verification_required",
        customer_origin: detected.originCandidate,
        dns_provider: detected.dnsProvider,
        edge_hostname: EDGE_HOSTNAME,
        route_prefix: "/a/",
      })
      .select("id, hostname, verification_token")
      .maybeSingle();
    if (error) {
      if (String(error.message).toLowerCase().includes("duplicate")) {
        return { ok: false as const, error: "That hostname is already connected." };
      }
      return { ok: false as const, error: error.message };
    }

    // Seed marketplace_domain when unset so /p pages resolve on the tenant host immediately.
    const { data: ws } = await sb()
      .from("workspaces")
      .select("marketplace_domain")
      .eq("id", data.workspaceId)
      .maybeSingle();
    if (!ws?.marketplace_domain) {
      await sb()
        .from("workspaces")
        .update({ marketplace_domain: hostname })
        .eq("id", data.workspaceId);
    }

    return {
      ok: true as const,
      id: row.id as string,
      hostname: row.hostname as string,
      verification_token: row.verification_token as string,
      dns_target: EDGE_HOSTNAME,
      detected_origin: detected.originCandidate,
      dns_provider: detected.dnsProvider,
    };
  });

async function tryFileVerify(
  hostname: string,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`https://${hostname}/.well-known/founders-click-verify`, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.status !== 200) return { ok: false, error: `file not found (HTTP ${res.status})` };
    const body = (await res.text()).trim();
    if (!body.includes(token)) return { ok: false, error: "token mismatch in file" };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `file fetch failed: ${e?.message || "network error"}` };
  }
}

async function tryDnsVerify(
  hostname: string,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=_founders-click.${encodeURIComponent(hostname)}&type=TXT`,
      { headers: { Accept: "application/dns-json" }, signal: ctrl.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `DNS lookup failed (HTTP ${res.status})` };
    const json: any = await res.json();
    const answers: any[] = json?.Answer || [];
    const txts = answers.map((a) =>
      String(a.data || "")
        .replace(/^"|"$/g, "")
        .replace(/"\s*"/g, ""),
    );
    if (txts.length === 0) return { ok: false, error: "no TXT record found" };
    if (!txts.some((t) => t.includes(token)))
      return { ok: false, error: "token mismatch in DNS TXT" };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `DNS lookup failed: ${e?.message || "network error"}` };
  }
}

export const verifyWorkspaceDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const { data: row } = await sb()
      .from("workspace_domains")
      .select("id, hostname, verification_token, verified")
      .eq("workspace_id", data.workspaceId)
      .eq("id", data.id)
      .maybeSingle();
    if (!row) return { ok: false as const, error: "domain not found" };
    if (row.verified) return { ok: true as const, method: "already" as const };

    const fileRes = await tryFileVerify(row.hostname, row.verification_token);
    let method: "file" | "dns" | null = fileRes.ok ? "file" : null;
    let lastErr = fileRes.error;
    if (!method) {
      const dnsRes = await tryDnsVerify(row.hostname, row.verification_token);
      if (dnsRes.ok) method = "dns";
      else lastErr = `${lastErr || "file failed"}; ${dnsRes.error || "dns failed"}`;
    }

    if (!method) return { ok: false as const, error: lastErr || "verification failed" };

    const verifiedAt = new Date().toISOString();
    const { error: upErr } = await sb()
      .from("workspace_domains")
      .update({
        verified: true,
        verified_at: verifiedAt,
        verification_method: method,
        // Ownership proven → next step is pointing DNS at the edge.
        status: "dns_configuration_required",
        last_error: null,
      })
      .eq("id", row.id);
    if (upErr) return { ok: false as const, error: upErr.message };

    // Ownership is proven, so provision the edge now: custom hostname + Worker
    // route as ONE unit (see domain-provisioning.server.ts for why atomicity
    // matters — a hostname without its route falls through to the originless
    // fallback origin and that customer is hard down, not degraded).
    const { isEdgeProvisioningConfigured, provisionDomainAtEdge } = await import(
      "@/lib/domain-provisioning.server"
    );
    // If we CANNOT provision, say so and stop. Skipping silently used to let
    // the flow advance to "point your DNS at proxy.founders.click" without a
    // custom hostname or Worker route existing. That fallback origin is
    // deliberately originless (AAAA 100::), so a customer who followed those
    // instructions would take their own domain hard down, and nothing in the
    // product would have told them anything was wrong.
    //
    // Ownership really is verified, so that stays recorded. What is NOT true is
    // that the domain is ready for DNS, and the UI must not imply it.
    if (!isEdgeProvisioningConfigured()) {
      const blocked =
        "Domain verified, but founders.click can't route traffic yet: edge provisioning is not configured " +
        "(CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID). DO NOT change your DNS yet — pointing it at the edge " +
        "before routing exists would take your site offline. We've been notified.";
      console.error(
        "[domains] BLOCKED: edge provisioning unconfigured; refusing to advance",
        row.hostname,
      );
      await sb()
        .from("workspace_domains")
        .update({ status: "error", last_error: blocked })
        .eq("id", row.id);
      return { ok: false as const, error: blocked };
    }

    try {
      const cf = await provisionDomainAtEdge(row.hostname);
      await sb()
        .from("workspace_domains")
        .update({
          cloudflare_hostname_id: cf.hostnameId,
          cloudflare_route_id: cf.routeId,
          status: "ssl_pending",
          last_error: null,
        })
        .eq("id", row.id);
    } catch (e) {
      // Provisioning failed and rolled back — stay in
      // dns_configuration_required and surface it. Never advance toward
      // active on a half-built edge.
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[domains] edge provisioning failed", row.hostname, msg);
      await sb()
        .from("workspace_domains")
        .update({ status: "error", last_error: `Edge provisioning failed: ${msg}` })
        .eq("id", row.id);
      return { ok: false as const, error: `Edge provisioning failed: ${msg}` };
    }

    // Keep workspaces.marketplace_domain + domain_verified_at in sync so Settings
    // badges and host resolution stay accurate after custom-domain verification.
    const { data: ws } = await sb()
      .from("workspaces")
      .select("marketplace_domain")
      .eq("id", data.workspaceId)
      .maybeSingle();
    const wsPatch: { domain_verified_at: string; marketplace_domain?: string } = {
      domain_verified_at: verifiedAt,
    };
    if (!ws?.marketplace_domain) {
      wsPatch.marketplace_domain = row.hostname;
    }
    await sb().from("workspaces").update(wsPatch).eq("id", data.workspaceId);

    return { ok: true as const, method };
  });

export const updateDomainConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        id: z.string().uuid(),
        connectionType: z.enum(["full_proxy", "subdomain", "customer_proxy"]).optional(),
        customerOrigin: z.string().max(253).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const { data: row } = await sb()
      .from("workspace_domains")
      .select("id, hostname")
      .eq("workspace_id", data.workspaceId)
      .eq("id", data.id)
      .maybeSingle();
    if (!row) return { ok: false as const, error: "domain not found" };

    const patch: Record<string, any> = {};
    if (data.connectionType) patch.connection_type = data.connectionType;
    if (data.customerOrigin !== undefined) {
      const origin = data.customerOrigin ? normalizeHostname(data.customerOrigin) : null;
      if (origin && !isValidHostname(origin)) {
        return { ok: false as const, error: "Invalid origin hostname." };
      }
      // Loop protection: the edge must never be told to proxy a domain to itself.
      if (origin && origin === row.hostname) {
        return {
          ok: false as const,
          error: "The origin can't be the connected domain itself — that would loop.",
        };
      }
      patch.customer_origin = origin;
    }
    if (Object.keys(patch).length === 0) return { ok: true as const };
    const { error } = await sb().from("workspace_domains").update(patch).eq("id", row.id);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });

/**
 * Automated activation test — the last gate before a domain is declared live.
 * Proves, over the public internet: (1) /a/founders-domain-test traverses
 * DNS → edge → Founders origin and resolves this tenant; (2) in full-proxy
 * mode the customer's own site still answers. No employee, no SSH, no nginx.
 */
export const activateWorkspaceDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const { data: row } = await sb()
      .from("workspace_domains")
      .select("id, hostname, verified, connection_type, route_prefix, status")
      .eq("workspace_id", data.workspaceId)
      .eq("id", data.id)
      .maybeSingle();
    if (!row) return { ok: false as const, error: "domain not found" };
    if (!row.verified) {
      return { ok: false as const, error: "Verify domain ownership first." };
    }

    const prefix = (row.route_prefix || "/a/").replace(/\/$/, "");
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

    // Check 1: the Founders route answers through the customer's domain.
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12_000);
      const res = await fetch(`https://${row.hostname}${prefix}/founders-domain-test`, {
        redirect: "manual",
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const body = res.status === 200 ? await res.text() : "";
      const ok = res.status === 200 && body.includes("founders-click-domain-test: OK");
      checks.push({
        name: "founders_route",
        ok,
        detail: ok
          ? "Founders pages are reachable on your domain"
          : `HTTP ${res.status} from ${prefix}/founders-domain-test — DNS/edge routing not live yet`,
      });
    } catch (e: any) {
      checks.push({
        name: "founders_route",
        ok: false,
        detail: `fetch failed: ${e?.message || "network error"} — is DNS pointed at the edge?`,
      });
    }

    // Check 2 (full proxy only): the customer's existing site still works.
    if (row.connection_type === "full_proxy") {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12_000);
        const res = await fetch(`https://${row.hostname}/`, {
          redirect: "manual",
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const ok = res.status < 500;
        checks.push({
          name: "customer_site",
          ok,
          detail: ok
            ? `Existing site answers (HTTP ${res.status})`
            : `Existing site returned HTTP ${res.status} — origin fallback misconfigured`,
        });
      } catch (e: any) {
        checks.push({
          name: "customer_site",
          ok: false,
          detail: `site fetch failed: ${e?.message || "network error"}`,
        });
      }
    }

    const allOk = checks.every((c) => c.ok);
    const now = new Date().toISOString();
    const failDetail = checks
      .filter((c) => !c.ok)
      .map((c) => c.detail)
      .join("; ");
    // Safe-disable: a domain that was Connected and now fails its checks is
    // demoted to 'error' so the dashboard shows it loudly (origin passthrough
    // at the edge keeps running — we never turn off the customer's own
    // traffic; the fix for a damaged origin is reverting DNS, which the UI
    // instructs). A domain that was never active just records the failure.
    const patch = allOk
      ? {
          status: "active",
          activated_at: now,
          health_status: "ok",
          last_health_check: now,
          last_error: null,
        }
      : {
          status: row.status === "active" ? "error" : row.status,
          last_health_check: now,
          health_status: "failing",
          last_error: failDetail,
        };
    if (!allOk) {
      console.error("[domains] activation check failed", row.hostname, failDetail);
    }
    await sb().from("workspace_domains").update(patch).eq("id", row.id);

    return { ok: allOk, checks, status: allOk ? "active" : (patch.status as string) };
  });

export const deleteWorkspaceDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);

    // Tear the edge down before dropping our row, or the Cloudflare custom
    // hostname and Worker route are orphaned with nothing left pointing at
    // them. Teardown is best-effort and never blocks the disconnect.
    const { data: row } = await sb()
      .from("workspace_domains")
      .select("cloudflare_hostname_id, cloudflare_route_id")
      .eq("workspace_id", data.workspaceId)
      .eq("id", data.id)
      .maybeSingle();
    if (row?.cloudflare_hostname_id || row?.cloudflare_route_id) {
      const { deprovisionDomainAtEdge } = await import("@/lib/domain-provisioning.server");
      await deprovisionDomainAtEdge(
        row.cloudflare_hostname_id ?? null,
        row.cloudflare_route_id ?? null,
      );
    }

    const { error } = await sb()
      .from("workspace_domains")
      .delete()
      .eq("workspace_id", data.workspaceId)
      .eq("id", data.id);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });
