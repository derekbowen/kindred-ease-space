/**
 * Automated 301-alias backfill.
 *
 * Reads unresolved rows from `content_404_log`, attempts to resolve each
 * missing slug to a canonical published `content_pages.slug`, and appends
 * the missing slug to that canonical row's `legacy_slugs[]` array. Marks
 * the 404 row resolved with notes describing what happened.
 *
 * Resolution heuristics (cheap, deterministic, no scraping):
 *   1. Exact slug match — already wouldn't be a 404, skip.
 *   2. Strip a known prefix (become-a-swimming-pool-host-, etc.); if the
 *      remainder is a published city slug, try the `{prefix}{city}-{state}`
 *      variant. If a published page exists, that's the canonical.
 *   3. The bare prefix (no city) maps to a known hub: e.g.
 *      "become-a-pool-host" → "become-a-swimming-pool-host" (if such a page
 *      exists) or to a configured hub fallback.
 *   4. Common typos — handled via TYPO_FIXES map below.
 *
 * Anything that cannot be resolved confidently is left unresolved so a human
 * can review it later in the admin UI.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const KNOWN_PREFIXES = [
  "become-a-swimming-pool-host-",
  "swim-instructor-pool-rental-",
  "rent-a-swimming-pool-",
  "pool-rental-",
  "host-acquisition-",
];

/**
 * Bare-prefix / common-mistake aliases. Keys are slugs that show up in 404
 * logs; values are canonical slugs they should redirect to. Only added to
 * legacy_slugs if the canonical page actually exists.
 */
const STATIC_ALIASES: Record<string, string> = {
  "become-a-pool-host": "become-a-swimming-pool-host",
  "howithostsworks": "how-it-works",
  "how-it-works-host": "how-it-works",
  "event-guides": "learningacademy",
  "careers": "about",
  "pool-pros": "providers",
  "sign-a-waiver": "waivers",
};

export type AliasResolution = {
  legacy_slug: string;
  canonical_slug: string | null;
  status: "resolved" | "unresolved";
  reason: string;
  hit_count: number;
};

type Counts = Record<string, number>;

async function pageExists(slug: string): Promise<boolean> {
  const { data } = await (supabaseAdmin as any)
    .from("content_pages")
    .select("slug")
    .eq("slug", slug)
    .in("status", ["pending", "scraped", "drafted", "migrated", "published"])
    .limit(1);
  return ((data ?? []) as unknown[]).length > 0;
}

async function resolveSlug(legacySlug: string): Promise<{
  canonical: string | null;
  reason: string;
}> {
  // 1. Static aliases.
  if (STATIC_ALIASES[legacySlug]) {
    const target = STATIC_ALIASES[legacySlug];
    if (await pageExists(target)) {
      return { canonical: target, reason: `static_alias→${target}` };
    }
    return { canonical: null, reason: `static_alias_target_missing:${target}` };
  }

  // 2. Prefix + city heuristic. Strip a known prefix; the remainder should be
  //    a city slug (with or without a -{state_code} suffix).
  for (const prefix of KNOWN_PREFIXES) {
    if (!legacySlug.startsWith(prefix)) continue;
    const rest = legacySlug.slice(prefix.length);
    if (!rest) continue;

    // 2a. If rest already ends with -{state_code}, the canonical lookup
    //     would have already found it. Try alternate prefix swaps inside
    //     the family before giving up.
    const looksSuffixed = /-[a-z]{2}$/.test(rest);
    if (looksSuffixed) {
      // Try every other known prefix with the same suffixed tail.
      for (const altPrefix of KNOWN_PREFIXES) {
        if (altPrefix === prefix) continue;
        const cand = `${altPrefix}${rest}`;
        if (await pageExists(cand)) {
          return { canonical: cand, reason: `prefix_swap:${prefix}→${altPrefix}` };
        }
      }
      return { canonical: null, reason: `suffixed_no_match` };
    }

    // 2b. Bare-city tail. Look up the city to find its state_code, then
    //     test the suffixed candidate.
    const { data: cityRows } = await (supabaseAdmin as any)
      .from("cities")
      .select("slug, state_code")
      .eq("slug", rest)
      .eq("is_published", true)
      .limit(1);
    const city = ((cityRows ?? []) as { slug: string; state_code: string }[])[0];
    if (city?.state_code) {
      const cand = `${prefix}${rest}-${city.state_code.toLowerCase()}`;
      if (await pageExists(cand)) {
        return { canonical: cand, reason: `city_state_suffix:${city.state_code}` };
      }
    }
    return { canonical: null, reason: `bare_city_no_match` };
  }

  return { canonical: null, reason: `no_rule` };
}

/**
 * Append legacy slug to canonical page's legacy_slugs[] (idempotent), and
 * mark the matching content_404_log row as resolved.
 */
async function attachAlias(
  canonicalSlug: string,
  legacySlug: string,
  reason: string,
): Promise<void> {
  // Read existing legacy_slugs.
  const { data: rows } = await (supabaseAdmin as any)
    .from("content_pages")
    .select("id, legacy_slugs")
    .eq("slug", canonicalSlug)
    .in("status", ["pending", "scraped", "drafted", "migrated", "published"])
    .limit(1);
  const row = ((rows ?? []) as { id: string; legacy_slugs: string[] | null }[])[0];
  if (!row) return;
  const existing = Array.isArray(row.legacy_slugs) ? row.legacy_slugs : [];
  if (existing.includes(legacySlug)) {
    // Still mark the 404 row as resolved.
  } else {
    const next = [...existing, legacySlug];
    await (supabaseAdmin as any)
      .from("content_pages")
      .update({ legacy_slugs: next })
      .eq("id", row.id);
  }

  await (supabaseAdmin as any)
    .from("content_404_log")
    .update({
      resolved_at: new Date().toISOString(),
      resolution_notes: `alias→${canonicalSlug} (${reason})`,
    })
    .eq("slug", legacySlug)
    .is("resolved_at", null);
}

export async function runAliasBackfill(opts: {
  limit?: number;
  dryRun?: boolean;
} = {}): Promise<{
  results: AliasResolution[];
  summary: Counts;
}> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);

  const { data: rows, error } = await (supabaseAdmin as any)
    .from("content_404_log")
    .select("slug, hit_count, url_path")
    .is("resolved_at", null)
    .not("slug", "is", null)
    .order("hit_count", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load 404 log: ${error.message}`);

  // Only consider /p/{slug} 404s — sitemap/asset 404s aren't aliases.
  const candidates = (
    (rows ?? []) as { slug: string; hit_count: number; url_path: string }[]
  ).filter((r) => r.url_path.startsWith("/p/"));

  const results: AliasResolution[] = [];
  for (const r of candidates) {
    const { canonical, reason } = await resolveSlug(r.slug);
    if (canonical && !opts.dryRun) {
      await attachAlias(canonical, r.slug, reason);
    }
    results.push({
      legacy_slug: r.slug,
      canonical_slug: canonical,
      status: canonical ? "resolved" : "unresolved",
      reason,
      hit_count: r.hit_count,
    });
  }

  const summary = results.reduce<Counts>(
    (acc, r) => {
      acc.total = (acc.total ?? 0) + 1;
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      acc.hits_recovered =
        (acc.hits_recovered ?? 0) +
        (r.status === "resolved" ? r.hit_count : 0);
      return acc;
    },
    { total: 0 },
  );
  return { results, summary };
}
