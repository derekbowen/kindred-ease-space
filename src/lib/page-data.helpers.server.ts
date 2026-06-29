import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

/** Unified page row for SEO tools that scan both live tenant pages and legacy content_pages. */
export type ScannablePage = {
  id: string;
  source: "tenant" | "content";
  url_path: string;
  slug: string | null;
  title: string | null;
  body_markdown: string | null;
  meta_description: string | null;
  status: string;
  in_sitemap: boolean;
  updated_at: string;
  template_type: string | null;
  category: string;
};

export function tenantUrlPath(slug: string): string {
  return `/p/${slug.replace(/^\/+/, "").replace(/^p\//, "")}`;
}

export function parseTenantSlugFromPath(path: string): string | null {
  const m = path.match(/^\/p\/([^/?#]+)/);
  return m?.[1] ?? null;
}

/** Published pages from tenant_pages + legacy content_pages for scanners. */
export async function fetchPublishedPages(
  workspaceId: string,
  opts: { limit?: number; onlyInSitemap?: boolean } = {},
): Promise<ScannablePage[]> {
  const limit = opts.limit ?? 2000;

  let contentQ = sb()
    .from("content_pages")
    .select(
      "id, slug, url_path, title, body_markdown, seo_description, status, in_sitemap, updated_at, template_type, category",
    )
    .eq("workspace_id", workspaceId)
    .eq("status", "published");
  if (opts.onlyInSitemap) contentQ = contentQ.eq("in_sitemap", true);

  const [{ data: tenantRows }, { data: contentRows }] = await Promise.all([
    sb()
      .from("tenant_pages")
      .select("id, slug, title, body_markdown, meta_description, status, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "published")
      .order("updated_at", { ascending: false })
      .limit(limit),
    contentQ.order("updated_at", { ascending: false }).limit(limit),
  ]);

  const tenant = (tenantRows ?? []).map((r: any): ScannablePage => ({
    id: r.id,
    source: "tenant",
    slug: r.slug,
    url_path: tenantUrlPath(r.slug),
    title: r.title,
    body_markdown: r.body_markdown,
    meta_description: r.meta_description,
    status: r.status,
    in_sitemap: true,
    updated_at: r.updated_at,
    template_type: "city_hub",
    category: "tenant_page",
  }));

  const content = (contentRows ?? []).map((r: any): ScannablePage => ({
    id: r.id,
    source: "content",
    slug: r.slug,
    url_path: r.url_path || (r.slug ? tenantUrlPath(r.slug) : ""),
    title: r.title,
    body_markdown: r.body_markdown,
    meta_description: r.seo_description,
    status: r.status,
    in_sitemap: !!r.in_sitemap,
    updated_at: r.updated_at,
    template_type: r.template_type,
    category: r.category ?? "content",
  }));

  const seen = new Set<string>();
  const merged: ScannablePage[] = [];
  for (const row of [...tenant, ...content]) {
    const key = row.url_path || row.slug || row.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged.slice(0, limit);
}

/** Resolve an internal link target to published status (or null if missing). */
export async function resolveLinkTargetStatus(
  workspaceId: string,
  path: string,
): Promise<string | null> {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const tenantSlug = parseTenantSlugFromPath(normalized);
  if (tenantSlug) {
    const { data } = await sb()
      .from("tenant_pages")
      .select("status")
      .eq("workspace_id", workspaceId)
      .eq("slug", tenantSlug)
      .maybeSingle();
    if (data) return data.status as string;
  }

  const { data: byPath } = await sb()
    .from("content_pages")
    .select("status")
    .eq("workspace_id", workspaceId)
    .eq("url_path", normalized)
    .maybeSingle();
  if (byPath) return byPath.status as string;

  if (tenantSlug) {
    const { data: bySlug } = await sb()
      .from("content_pages")
      .select("status")
      .eq("workspace_id", workspaceId)
      .eq("slug", tenantSlug)
      .maybeSingle();
    if (bySlug) return bySlug.status as string;
  }

  return null;
}

/** Log a 404 hit for Missing Pages tooling. Fire-and-forget safe. */
export async function recordPage404(workspaceId: string, slug: string): Promise<void> {
  const url_path = tenantUrlPath(slug);
  try {
    const { data: existing } = await sb()
      .from("content_404_log")
      .select("id, hit_count")
      .eq("workspace_id", workspaceId)
      .eq("url_path", url_path)
      .is("resolved_at", null)
      .maybeSingle();

    if (existing?.id) {
      await sb()
        .from("content_404_log")
        .update({
          hit_count: (existing.hit_count ?? 0) + 1,
          last_seen_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      return;
    }

    const { error: insErr } = await sb().from("content_404_log").insert({
      workspace_id: workspaceId,
      url_path,
      slug,
      hit_count: 1,
    });
    // Race: another request inserted the same unresolved row between select and insert.
    if (insErr?.code === "23505") {
      const { data: raced } = await sb()
        .from("content_404_log")
        .select("id, hit_count")
        .eq("workspace_id", workspaceId)
        .eq("url_path", url_path)
        .is("resolved_at", null)
        .maybeSingle();
      if (raced?.id) {
        await sb()
          .from("content_404_log")
          .update({
            hit_count: (raced.hit_count ?? 0) + 1,
            last_seen_at: new Date().toISOString(),
          })
          .eq("id", raced.id);
      }
    }
  } catch (e) {
    console.error("[recordPage404]", e);
  }
}
