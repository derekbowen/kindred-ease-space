/**
 * Internal-link target builder for /p/{slug} templates.
 *
 * Produces a LinkTarget[] suitable for <AutoLinkedContent /> based on:
 *   - evergreen hub pages (always linkable, low-priority)
 *   - the page's own city + nearby cities by display name (if applicable)
 *
 * All targets resolve under /p/{slug} so they pass through fresh-web's
 * canonical content dispatcher and never hit a legacy 404.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { LinkTarget } from "@/components/auto-linked-content";
import { parseCitySlug } from "@/lib/city-slug";

const HUB_TARGETS: LinkTarget[] = [
  { phrase: "earnings calculator", to: "/p/earnings-calculator", priority: 9, title: "Pool host earnings calculator" },
  { phrase: "free host tools", to: "/p/free-host-tools", priority: 9, title: "Free pool host tools" },
  { phrase: "host tools", to: "/p/free-host-tools", priority: 8, title: "Free pool host tools" },
  { phrase: "how it works", to: "/p/how-it-works", priority: 8, title: "How pool rental works" },
  { phrase: "become a pool host", to: "/p/hosting", priority: 8, title: "Become a pool host" },
  { phrase: "pool host", to: "/p/hosting", priority: 5, title: "Become a pool host" },
  { phrase: "pool pros", to: "/p/pool-pros", priority: 7, title: "Pool pros directory" },
  { phrase: "all locations", to: "/p/all-locations", priority: 6, title: "All pool rental locations" },
  { phrase: "swimply alternative", to: "/p/swimply-alternative-vs-pool-rental-near-me", priority: 7, title: "Swimply alternative" },
  { phrase: "giggster", to: "/p/giggster-vs-pool-rental-near-me", priority: 6, title: "Giggster vs Pool Rental Near Me" },
  { phrase: "peerspace", to: "/p/peerspace-vs-pool-rental-near-me", priority: 6, title: "Peerspace vs Pool Rental Near Me" },
];

export const getInternalLinkTargets = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    z
      .object({
        citySlug: z.string().nullable().optional(),
        nearbyCitySlugs: z.array(z.string()).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<LinkTarget[]> => {
    const targets: LinkTarget[] = [...HUB_TARGETS];
    const slugs = new Set<string>();
    if (data.citySlug) slugs.add(data.citySlug);
    for (const s of data.nearbyCitySlugs ?? []) slugs.add(s);

    if (slugs.size > 0) {
      try {
        const { data: rows } = await (supabaseAdmin as any)
          .from("cities")
          .select("slug, name, state_code")
          .in("slug", Array.from(slugs))
          .eq("is_published", true);
        for (const r of (rows ?? []) as Array<{ slug: string; name: string; state_code: string | null }>) {
          // Link city by display name (e.g. "Los Angeles") to the canonical
          // host-acq page for that city if state_code present, else the city
          // public-pool page.
          const stateLow = r.state_code ? r.state_code.toLowerCase() : null;
          const hostAcqSlug = stateLow
            ? `become-a-swimming-pool-host-${r.slug}${r.slug.endsWith(`-${stateLow}`) ? "" : `-${stateLow}`}`
            : `become-a-swimming-pool-host-${r.slug}`;
          targets.push({
            phrase: r.name,
            to: `/p/${hostAcqSlug}`,
            title: `Become a pool host in ${r.name}`,
            priority: 4,
          });
          // Also offer "{City}, {ST}" phrasing
          if (r.state_code) {
            targets.push({
              phrase: `${r.name}, ${r.state_code}`,
              to: `/p/${hostAcqSlug}`,
              title: `Become a pool host in ${r.name}, ${r.state_code}`,
              priority: 6,
            });
          }
        }
      } catch (err) {
        console.error("getInternalLinkTargets cities lookup failed:", err);
      }
    }

    return targets;
  });

/** Server-side helper used by loaders that already have a citySlug list. */
export function fallbackCityNamePhrases(citySlugs: string[]): LinkTarget[] {
  return citySlugs.map((slug) => {
    const { city, stateCode } = parseCitySlug(slug);
    return {
      phrase: stateCode ? `${city}, ${stateCode}` : city,
      to: `/p/become-a-swimming-pool-host-${slug}${stateCode && !slug.endsWith(`-${stateCode.toLowerCase()}`) ? `-${stateCode.toLowerCase()}` : ""}`,
      title: `Become a pool host in ${city}`,
      priority: 4,
    };
  });
}
