import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ACADEMY_SLUGS } from "@/lib/academy-config";

/**
 * Verifies every course / academy link on the landing page resolves to a
 * published `/p/{slug}` content page (i.e. nginx forwards it to fresh-web
 * and it does NOT fall through to Sharetribe's 404).
 *
 * Slug list comes from `@/lib/academy-config` so this stays in lockstep
 * with the homepage source of truth.
 */
const SLUG_LABELS: Record<string, string> = {
  "learning-academy": "Browse 100+ free courses (CTA)",
  "host-training-academy": "Earn certifications (CTA)",
  "elearning-academy-tax-deduction-tracking-guide-pool-hosts": "Taxes & Pool Rental Income",
  "elearning-academy-dealing-with-difficult-scenarios-pool-hosts": "Difficult Guest Scenarios",
  "elearning-academy-hoa-navigation-guide-pool-hosts": "HOA Navigation",
  "elearning-academy-dealing-with-neighbor-complaints-in-real-time": "Neighbor Complaints",
  "elearning-academy-content-marketing-for-pool-rentals": "Content Marketing",
  "elearning-academy-listing-optimization-photography-conversion": "Photography & Listings",
};

const LANDING_ACADEMY_LINKS: Array<{ label: string; href: string }> =
  ACADEMY_SLUGS.map((slug) => ({
    label: SLUG_LABELS[slug] ?? slug,
    href: `/p/${slug}`,
  }));

export type LandingLinkCheck = {
  label: string;
  href: string;
  ok: boolean;
  status: "published" | "missing" | "unpublished";
};

async function assertAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Forbidden");
}

export const checkLandingAcademyLinks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin((context as any).userId);
    const sb = supabaseAdmin as any;

    const paths = LANDING_ACADEMY_LINKS.map((l) => l.href);
    const { data: rows } = await sb
      .from("content_pages")
      .select("url_path, status")
      .in("url_path", paths);

    const byPath = new Map<string, string>();
    for (const r of (rows || []) as Array<{ url_path: string; status: string }>) {
      byPath.set(r.url_path, r.status);
    }

    const results: LandingLinkCheck[] = LANDING_ACADEMY_LINKS.map((l) => {
      const status = byPath.get(l.href);
      if (!status) return { ...l, ok: false, status: "missing" };
      if (status !== "published") return { ...l, ok: false, status: "unpublished" };
      return { ...l, ok: true, status: "published" };
    });

    const okCount = results.filter((r) => r.ok).length;
    return {
      results,
      total: results.length,
      ok: okCount,
      broken: results.length - okCount,
      checkedAt: new Date().toISOString(),
    };
  });
