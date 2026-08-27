import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

export function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}

export function normalizeHost(raw: string): string {
  return (raw || "")
    .split(",")[0]! // x-forwarded-host can be a comma-separated list; take the first
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
}

// Platform hosts always serve the marketing sitemap, never a tenant's.
const PLATFORM_HOSTS = new Set(["founders.click"]);

export function isPlatformHost(hostname: string): boolean {
  return PLATFORM_HOSTS.has(normalizeHost(hostname));
}

/**
 * Resolve a public host to a workspace id via a verified custom domain OR a
 * verified marketplace_domain. Mirrors current_workspace_id_by_host's trust
 * boundary (verified only) so unverified/spoofed hosts never expose a sitemap.
 */
export async function workspaceIdForHost(hostname: string): Promise<string | null> {
  const h = normalizeHost(hostname);
  if (!h || !h.includes(".") || isPlatformHost(h)) return null;

  const { data: domain } = await sb()
    .from("workspace_domains")
    .select("workspace_id")
    .eq("hostname", h)
    .eq("verified", true)
    .maybeSingle();
  if (domain?.workspace_id) return domain.workspace_id as string;

  const { data: ws } = await sb()
    .from("workspaces")
    .select("id")
    .eq("marketplace_domain", h)
    .not("domain_verified_at", "is", null)
    .maybeSingle();
  return (ws?.id as string) ?? null;
}

/**
 * Tenant page sitemap XML for a host. Returns null when the host is not a
 * verified tenant host (caller should fall back to the platform sitemap), or an
 * (possibly empty) <urlset> string when it is.
 */
export async function tenantSitemapXml(hostname: string): Promise<string | null> {
  const workspaceId = await workspaceIdForHost(hostname);
  if (!workspaceId) return null;
  const h = normalizeHost(hostname);

  const [{ data: tenantPages }, { data: legacyPages }] = await Promise.all([
    sb()
      .from("tenant_pages")
      .select("slug, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "published")
      .order("updated_at", { ascending: false })
      .limit(50_000),
    sb()
      .from("content_pages")
      .select("slug, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "published")
      .eq("in_sitemap", true)
      .order("updated_at", { ascending: false })
      .limit(50_000),
  ]);

  const seen = new Set<string>();
  const rows = [...(tenantPages || []), ...(legacyPages || [])].filter((p: any) => {
    const slug = String(p.slug || "").replace(/^\/+/, "");
    if (!slug || seen.has(slug)) return false;
    seen.add(slug);
    return true;
  });

  const urls = rows
    .map((p: any) => {
      const slug = String(p.slug || "").replace(/^\/+/, "");
      const loc = `https://${h}/a/${escapeXml(slug)}`;
      const lastmod = p.updated_at
        ? new Date(p.updated_at).toISOString()
        : new Date().toISOString();
      return `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
}
