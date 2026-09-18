import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decideCapacity } from "@/lib/billing-capacity";
import { readGrantedPagesOrNull } from "@/lib/entitlement-grants.server";

const sb = () => supabaseAdmin as any;

export function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}

/**
 * The host exactly as the visitor (and Googlebot) requested it, minus scheme,
 * path and port. `www.` is PRESERVED.
 *
 * This is the host sitemap <loc> values must be built from. It is deliberately
 * separate from normalizeHost(), which strips `www.` so apex and www resolve to
 * the same workspace row — a lookup convenience that must never leak into
 * emitted URLs.
 */
export function requestHost(raw: string): string {
  return (raw || "")
    .split(",")[0]!
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

/** Lookup key only. Strips `www.` so a workspace matches on apex or www. */
export function normalizeHost(raw: string): string {
  return requestHost(raw).replace(/^www\./, "");
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

  // A workspace whose pages no longer serve must not keep advertising them.
  // Leaving them in the sitemap after cancellation points Google at URLs that
  // now 404, which is the slowest possible way to get them deindexed and
  // makes the customer's site look broken rather than simply unsubscribed.
  // Fails open, for the same reason the page path does: a read error must not
  // blank a paying customer's sitemap.
  const { data: billing, error: billingError } = await sb()
    .from("workspaces")
    .select("subscription_status, trial_ends_at, current_period_end")
    .eq("id", workspaceId)
    .maybeSingle();
  if (billingError) {
    console.error("[tenantSitemapXml] billing read failed, emitting anyway:", billingError.message);
  } else if (billing) {
    // Same reasoning as the page-serving gate: a beta account is entitled by
    // its grant, not by Stripe. `null` means the grant read failed, which is
    // not evidence of no grant — emit the sitemap rather than blank it.
    const granted = await readGrantedPagesOrNull(workspaceId);
    const decision = decideCapacity({
      subscriptionStatus: billing.subscription_status,
      trialEndsAt: billing.trial_ends_at,
      currentPeriodEnd: billing.current_period_end,
      grantedPages: granted ?? 0,
    });
    if (granted !== null && !decision.serve) {
      // An empty urlset, not null: the host IS a verified tenant host, so
      // falling back to the platform sitemap would advertise founders.click
      // URLs on the customer's domain.
      return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
    }
  }
  // Emit URLs on the host that was actually requested, NOT the www-stripped
  // lookup key. a.$slug.tsx canonicalizes to the request host, so using the
  // stripped key here made the sitemap advertise https://customer.com/a/x
  // while the page itself declared https://www.customer.com/a/x canonical —
  // Google sees a sitemap of URLs that canonicalize somewhere else. Worse, a
  // customer who connected only `www` has no apex route at all, so every
  // sitemap URL would fail to resolve.
  const h = requestHost(hostname);

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
