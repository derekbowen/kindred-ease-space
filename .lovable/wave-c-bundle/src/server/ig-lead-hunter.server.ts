/**
 * IG Lead Hunter — server only.
 *
 * Daily Google search for Instagram profiles whose bio/posts mention pool rentals.
 * No direct IG scraping (would get blocked). Pure SerpApi google engine with
 * site:instagram.com operators. Each result is parsed into an ig_leads row.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

export const IG_LEAD_QUERIES = [
  'site:instagram.com "rent my pool"',
  'site:instagram.com "pool for rent"',
  'site:instagram.com "private pool rental"',
  'site:instagram.com "rent our pool"',
  'site:instagram.com "book my pool"',
  'site:instagram.com "swimply"',
  'site:instagram.com "peerspace pool"',
  'site:instagram.com "backyard pool rental"',
];

type SerpResult = { title?: string; link?: string; snippet?: string };

async function googleSearch(query: string, num = 30): Promise<SerpResult[]> {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error("SERPAPI_KEY not configured");
  const params = new URLSearchParams({
    engine: "google",
    q: query,
    api_key: key,
    num: String(num),
    hl: "en",
    gl: "us",
  });
  const resp = await fetch(`https://serpapi.com/search.json?${params}`);
  if (!resp.ok) {
    console.warn("[ig-lead-hunter] serpapi", resp.status, await resp.text().catch(() => ""));
    return [];
  }
  const json = await resp.json();
  return (json?.organic_results || []) as SerpResult[];
}

/**
 * Parse an instagram.com URL.
 * - Profile URL → handle from path, source = profile URL.
 * - Post / reel / tv URL → handle from result title (`Name (@handle) ...`),
 *   source = the actual post URL so admins can open the exact post.
 * Returns null only when we can't recover a usable handle.
 */
function parseIgResult(url: string, title: string | undefined): { handle: string; profileUrl: string; sourceUrl: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)instagram\.com$/.test(u.hostname)) return null;

  const seg = u.pathname.split("/").filter(Boolean);
  if (!seg.length) return null;
  const first = seg[0].toLowerCase();
  const skipSystem = ["explore", "stories", "directory", "accounts", "developer", "about", "legal"];
  if (skipSystem.includes(first)) return null;

  // Normalize: strip query/hash
  const cleanUrl = `https://www.instagram.com${u.pathname}${u.pathname.endsWith("/") ? "" : "/"}`;

  const postLike = ["p", "reel", "reels", "tv"].includes(first);
  if (postLike) {
    // Recover handle from title: "Jane Doe (@janedoe) on Instagram..."
    const m = title?.match(/\(@([a-zA-Z0-9._]{2,30})\)/);
    if (!m) return null;
    const handle = m[1];
    return {
      handle,
      profileUrl: `https://www.instagram.com/${handle}/`,
      sourceUrl: cleanUrl,
    };
  }

  const handle = seg[0];
  if (!/^[a-zA-Z0-9._]{2,30}$/.test(handle)) return null;
  const profileUrl = `https://www.instagram.com/${handle}/`;
  return { handle, profileUrl, sourceUrl: cleanUrl };
}

function extractProfileName(title: string | undefined, handle: string): string | null {
  if (!title) return null;
  // Common IG title pattern: "Jane Doe (@janedoe) • Instagram photos and videos"
  const m = title.match(/^(.+?)\s*\(@/);
  if (m) return m[1].trim();
  return title.split("|")[0].split("•")[0].trim() || null;
}

export async function runIgLeadHunt(opts: { queries?: string[]; perQuery?: number } = {}): Promise<{
  ok: boolean;
  queries_run: number;
  results_seen: number;
  inserted: number;
  refreshed: number;
  reason?: string;
}> {
  const queries = opts.queries ?? IG_LEAD_QUERIES;
  const perQuery = opts.perQuery ?? 30;

  let resultsSeen = 0;
  let inserted = 0;
  let refreshed = 0;
  const seenUrls = new Set<string>();

  for (const q of queries) {
    let results: SerpResult[] = [];
    try {
      results = await googleSearch(q, perQuery);
    } catch (e: any) {
      console.warn("[ig-lead-hunter] query failed", q, e?.message);
      continue;
    }
    for (const r of results) {
      resultsSeen++;
      if (!r.link) continue;
      const parsed = parseIgResult(r.link, r.title);
      if (!parsed) continue;
      // Dedupe by source URL — same post shouldn't get re-inserted, but multiple
      // posts from one profile are kept as separate leads (each is its own DM hook).
      if (seenUrls.has(parsed.sourceUrl)) continue;
      seenUrls.add(parsed.sourceUrl);

      const profile_name = extractProfileName(r.title, parsed.handle);
      const snippet = r.snippet?.slice(0, 600) || null;

      // Upsert by source_url so the actual post link is the unique key.
      const { data: existing } = await sb()
        .from("ig_leads")
        .select("id")
        .eq("source_url", parsed.sourceUrl)
        .maybeSingle();

      if (existing) {
        await sb().from("ig_leads").update({
          last_seen_at: new Date().toISOString(),
          instagram_url: parsed.profileUrl,
          ...(snippet ? { snippet } : {}),
          ...(profile_name ? { profile_name } : {}),
          query: q,
        }).eq("id", existing.id);
        refreshed++;
      } else {
        const { error } = await sb().from("ig_leads").insert({
          instagram_url: parsed.profileUrl,
          source_url: parsed.sourceUrl,
          profile_handle: parsed.handle,
          profile_name,
          snippet,
          query: q,
        });
        if (!error) inserted++;
      }
    }
  }

  return {
    ok: true,
    queries_run: queries.length,
    results_seen: resultsSeen,
    inserted,
    refreshed,
  };
}
