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

export type WorkspaceDomainRow = {
  id: string;
  hostname: string;
  verified: boolean;
  verified_at: string | null;
  ssl_status: string | null;
  created_at: string;
  verification_token?: string;
  verification_method?: string | null;
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

export const listWorkspaceDomains = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }): Promise<{ rows: WorkspaceDomainRow[] }> => {
    const role = await assertWorkspaceMember(data.workspaceId, context.userId);
    const isOwner = role === "owner";
    const { data: rows } = await sb()
      .from("workspace_domains")
      .select(
        "id, hostname, verified, verified_at, ssl_status, created_at, verification_token, verification_method",
      )
      .eq("workspace_id", data.workspaceId)
      .order("created_at", { ascending: false });
    return {
      rows: (rows || []).map((r: any) => ({
        id: r.id,
        hostname: r.hostname,
        verified: r.verified,
        verified_at: r.verified_at,
        ssl_status: r.ssl_status,
        created_at: r.created_at,
        verification_method: r.verification_method,
        // Only owners see the verification token.
        verification_token: isOwner ? r.verification_token : undefined,
      })),
    };
  });

export const addWorkspaceDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, hostname: z.string().min(3).max(253) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const hostname = normalizeHostname(data.hostname);
    if (!isValidHostname(hostname)) {
      return { ok: false as const, error: "Invalid hostname. Use a domain like example.com." };
    }
    const token = genToken();
    const { data: row, error } = await sb()
      .from("workspace_domains")
      .insert({
        workspace_id: data.workspaceId,
        hostname,
        verification_token: token,
        verified: false,
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
      dns_target: "proxy.founders.click",
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
      .update({ verified: true, verified_at: verifiedAt, verification_method: method })
      .eq("id", row.id);
    if (upErr) return { ok: false as const, error: upErr.message };

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

export const deleteWorkspaceDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const { error } = await sb()
      .from("workspace_domains")
      .delete()
      .eq("workspace_id", data.workspaceId)
      .eq("id", data.id);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });
