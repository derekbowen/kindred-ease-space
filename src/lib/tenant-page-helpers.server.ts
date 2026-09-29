import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

/** The longest page slug (the editor and the public route accept no more). */
export const PAGE_SLUG_MAX = 80;

export function slugifyPage(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PAGE_SLUG_MAX)
    .replace(/-+$/g, ""); // a cut can end on a dash: never keep one
}

/** Resolve an active page template id by slug (e.g. city_hub). */
export async function getActiveTemplateId(templateSlug: string): Promise<string> {
  const { data, error } = await sb()
    .from("page_templates")
    .select("id")
    .eq("slug", templateSlug)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) {
    throw new Error(
      `Page template "${templateSlug}" is not available. Run database migrations or contact support.`,
    );
  }
  return data.id as string;
}

/** Find a slug unique within the workspace's tenant_pages table. */
export async function findUniqueTenantSlug(workspaceId: string, baseSlug: string): Promise<string> {
  let slug = baseSlug;
  let suffix = 1;
  while (true) {
    const { data: existing } = await sb()
      .from("tenant_pages")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("slug", slug)
      .maybeSingle();
    if (!existing) return slug;
    suffix += 1;
    // Cut the base so base + "-N" still fits PAGE_SLUG_MAX, without a dash
    // at the cut: a suffixed slug must be one the editor can save.
    const room = PAGE_SLUG_MAX - String(suffix).length - 1;
    slug = `${baseSlug.slice(0, room).replace(/-+$/g, "")}-${suffix}`;
    if (suffix > 50) throw new Error("Could not find a unique slug");
  }
}
