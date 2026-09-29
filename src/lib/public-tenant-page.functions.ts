import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recordPage404 } from "@/lib/page-data.helpers.server";
import { decideCapacity } from "@/lib/billing-capacity";
import { readGrantedPagesOrNull } from "@/lib/entitlement-grants.server";
import { isPublicPageSlug } from "@/lib/public-page-slug";
import { isRenderableKind } from "@/components/templates/registry";
import { safeHttpUrl } from "@/components/templates/theme";
import type { TemplateData } from "@/components/templates/types";
import {
  TENANT_PAGE_COLUMNS,
  buildTenantPageData,
  type TenantPageRow,
} from "@/lib/tenant-page-data.server";

const sb = () => supabaseAdmin as any;

/**
 * Resolve the public request host server-side. Route loaders run during SSR
 * where `window` is undefined, so the host MUST come from request headers
 * (Cloudflare sets `x-forwarded-host` to the original tenant domain), not from
 * the client. Returns undefined when called outside a request context.
 */
function resolveRequestHost(): string | undefined {
  try {
    const raw = getRequestHeader("x-forwarded-host") || getRequestHeader("host");
    if (!raw) return undefined;
    // The LAST entry: a proxy that appends puts the host it saw last, so a
    // visitor-supplied first entry can't choose the tenant (see requestHost
    // in src/lib/sitemap.server.ts). The edge Worker sets a single value.
    return (raw.split(",").pop() ?? "").trim().toLowerCase().replace(/:\d+$/, "") || undefined;
  } catch {
    return undefined;
  }
}

// What a public page slug may look like lives in src/lib/public-page-slug.ts,
// a dependency-free module, so the sitemap can apply the very same rule and
// never advertise a URL the handler below refuses. Re-exported here so
// existing imports keep working.
export { PUBLIC_PAGE_SLUG_RE, isPublicPageSlug } from "@/lib/public-page-slug";

/** Everything a served page renders from — see src/components/templates/types.ts. */
export type PublicTenantPage = TemplateData;

export type PublicTenantPageResult = {
  page: PublicTenantPage | null;
  host: string | null;
  /** A permanent move (content_pages redirect row): the route answers 301. */
  redirect?: string;
  preview: boolean;
  /** Set when the page exists but the workspace is no longer entitled to serve it. */
  billingBlocked?: boolean;
  /** The page exists but its template has no active renderer: not served (404), never drawn as another template. */
  unsupportedTemplate?: string;
};

/** The legacy content_pages columns a page renders from (read-only). */
const LEGACY_PAGE_COLUMNS =
  "id, slug, title, seo_title, seo_description, body_markdown, updated_at, workspaces:workspace_id(name, brand_name, brand_color, logo_url)";

/**
 * Where a content_pages redirect row sends a request, or null to ignore it:
 * a same-site path or an absolute http(s) URL only, never back to the page
 * itself (a loop). In the platform preview a move to another /a/ page stays
 * inside the preview.
 */
export function redirectTarget(
  raw: unknown,
  slug: string,
  workspaceSlug?: string | null,
): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  let target: string | null;
  if (s.startsWith("/")) {
    target = s.startsWith("//") || s.includes("\\") || /[\s<>]/.test(s) ? null : s;
  } else {
    target = safeHttpUrl(s);
  }
  if (!target) return null;
  if (workspaceSlug) {
    const moved = /^\/[ap]\/([a-z0-9-]{1,200})\/?(?:[?#].*)?$/.exec(target);
    if (moved) target = `/s/${encodeURIComponent(workspaceSlug)}/${moved[1]}`;
  }
  const path = target.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const self = new Set([`/a/${slug}`, `/p/${slug}`]);
  if (workspaceSlug) self.add(`/s/${encodeURIComponent(workspaceSlug)}/${slug}`);
  return self.has(path) ? null : target;
}

export const getPublicTenantPage = createServerFn({ method: "GET" })
  .inputValidator((d) =>
    z
      .object({
        slug: z.string().min(1).max(200),
        // Platform-hosted preview: resolve the workspace by its slug instead of
        // the request host, so a fresh customer can view a page on founders.click
        // before their custom domain is connected/verified.
        workspaceSlug: z.string().min(1).max(120).optional(),
      })
      .parse(d),
  )
  .handler(
    async ({ data }): Promise<PublicTenantPageResult> =>
      loadPublicTenantPage(data, resolveRequestHost() ?? null),
  );

/**
 * The page a public request asks for, or why there is none. The request
 * host (or, in the preview, the workspace slug) picks the workspace; the
 * billing gate, then a redirect row, then the PUBLISHED page (drafts and
 * suspended or archived pages never serve), then the legacy content_pages
 * row. A page whose template has no active renderer is not served.
 *
 * Exported for the offline suite (tests/public-tenant-page.test.ts), which
 * drives it with the host a request would carry; the route calls
 * getPublicTenantPage.
 */
export async function loadPublicTenantPage(
  data: { slug: string; workspaceSlug?: string },
  host: string | null,
): Promise<PublicTenantPageResult> {
  let workspaceId: string | null = null;
  const preview = Boolean(data.workspaceSlug);

  // Not a slug — not a page. Nothing below may see it.
  if (!isPublicPageSlug(data.slug)) return { page: null, host, preview };

  if (data.workspaceSlug) {
    const { data: ws } = await sb()
      .from("workspaces")
      .select("id")
      .eq("slug", data.workspaceSlug)
      .maybeSingle();
    if (ws?.id) workspaceId = ws.id as string;
  } else if (host) {
    // Exact host only (migration 20260929000200): a host resolves to the
    // workspace that verified exactly that hostname.
    const { data: ws, error } = await sb().rpc("current_workspace_id_by_host", { _host: host });
    if (error) console.error("[getPublicTenantPage] host lookup failed:", error.message);
    if (ws) workspaceId = ws as string;
  }

  if (!workspaceId) return { page: null, host, preview };

  // BILLING GATE. The subscription promise is that pages stop when paying
  // stops; until now nothing on this path consulted billing at all, so a
  // cancelled customer kept serving on their own domain indefinitely.
  //
  // The platform-hosted preview (/s/{workspace}/{slug}) is NOT exempt. It
  // is a public URL that anyone can open, so exempting it kept a lapsed
  // tenant's pages viewable on founders.click — the opposite of "pages
  // pause when access ends". An owner who wants to see what paying brings
  // back has the editor for that.
  //
  // Fails OPEN. If this read errors we serve the page. A transient
  // database blip must never take down a paying customer's live site —
  // the cost of carrying a lapsed one for a few minutes is far lower.
  {
    const { data: billing, error: billingError } = await sb()
      .from("workspaces")
      .select("subscription_status, trial_ends_at, current_period_end")
      .eq("id", workspaceId)
      .maybeSingle();
    if (billingError) {
      console.error(
        "[getPublicTenantPage] billing read failed, serving anyway:",
        billingError.message,
      );
    } else if (billing) {
      // A free beta account has no Stripe object, so on billing facts alone
      // it reads as "no subscription" and would be withheld. Its grant is
      // what entitles it — the same resolver, not a bypass.
      //
      // `null` means the grant read itself failed. That is not evidence of
      // no grant, so it takes the same fail-open path as a billing read
      // error above: serve, and log.
      const granted = await readGrantedPagesOrNull(workspaceId);
      const decision = decideCapacity({
        subscriptionStatus: billing.subscription_status,
        trialEndsAt: billing.trial_ends_at,
        currentPeriodEnd: billing.current_period_end,
        grantedPages: granted ?? 0,
      });
      if (granted !== null && !decision.serve) {
        console.warn(
          `[getPublicTenantPage] withholding ${preview ? `preview ${data.workspaceSlug}` : (host ?? "?")}/${data.slug}: ${decision.state} — ${decision.reason}`,
        );
        return { page: null, host, preview, billingBlocked: true };
      }
    }
  }

  // A moved page: the route answers 301 so search engines carry its signals
  // to the new URL. The slug was validated above, so it cannot widen the
  // .or() expression.
  const { data: redirectRow } = await sb()
    .from("content_pages")
    .select("redirect_to")
    .eq("workspace_id", workspaceId)
    .eq("status", "redirect")
    .or(`slug.eq.${data.slug},url_path.eq./a/${data.slug},url_path.eq./p/${data.slug}`)
    .limit(1)
    .maybeSingle();
  const redirect = redirectTarget(redirectRow?.redirect_to, data.slug, data.workspaceSlug);
  if (redirect) return { page: null, host, redirect, preview };

  // Published only — the preview included. A read error is an error, never
  // a 404: a transient blip must not tell search engines the page is gone.
  const { data: page, error: pageError } = await sb()
    .from("tenant_pages")
    .select(TENANT_PAGE_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("slug", data.slug)
    .eq("status", "published")
    .maybeSingle();
  if (pageError) throw new Error(`page read failed: ${pageError.message}`);

  if (!page) {
    // Legacy content_pages rows (pre-unification), read-only. They are
    // editorial pages, so they render as a Resource Article.
    const { data: legacy, error: legacyError } = await sb()
      .from("content_pages")
      .select(LEGACY_PAGE_COLUMNS)
      .eq("workspace_id", workspaceId)
      .eq("slug", data.slug)
      .eq("status", "published")
      .limit(1)
      .maybeSingle();
    if (legacyError) throw new Error(`legacy page read failed: ${legacyError.message}`);
    if (!legacy) {
      // Don't pollute the 404 log with the owner's own preview hits.
      if (!preview) await recordPage404(workspaceId, data.slug);
      return { page: null, host, preview };
    }
    const row: TenantPageRow = {
      id: legacy.id ?? null,
      slug: legacy.slug ?? data.slug,
      title: legacy.title ?? null,
      seo_title: legacy.seo_title ?? null,
      meta_description: legacy.seo_description ?? null,
      h1: legacy.title ?? null,
      body_markdown: legacy.body_markdown ?? null,
      variables: {},
      listing_filter: null,
      noindex: false,
      published_at: null,
      updated_at: legacy.updated_at ?? null,
      workspaces: legacy.workspaces ?? null,
    };
    return {
      page: await buildTenantPageData(workspaceId, row, { kind: "resource_article", legacy: true }),
      host,
      preview,
    };
  }

  // The page renders with the component registered for its template, or not
  // at all — an unknown, unsupported or inactive template is never drawn as
  // another one.
  const template = (page as TenantPageRow).page_templates ?? null;
  const kind = template?.slug;
  if (!isRenderableKind(kind) || template?.is_active === false) {
    console.error(
      `[getPublicTenantPage] ${workspaceId}/${data.slug}: template "${String(kind ?? "")}" has no active renderer; not served`,
    );
    return { page: null, host, preview, unsupportedTemplate: String(kind ?? "") };
  }

  return {
    page: await buildTenantPageData(workspaceId, page as TenantPageRow, { kind }),
    host,
    preview,
  };
}
