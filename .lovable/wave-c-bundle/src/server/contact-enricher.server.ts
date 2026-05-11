/**
 * Contact enrichment — tiered cascade, server only.
 *
 * Tier 0 (free): targeted OSINT via existing Firecrawl search — county assessor,
 *   FB Page lookup, Google Business. Runs on every match. ~20-40% hit rate at $0.
 * Tier 1 ($0.10): BatchData skip-trace by property address. Only fires when
 *   match_confidence >= 70 AND AI extracted a probable street address.
 * Tier 2 ($0.20+): PeopleDataLabs person enrichment by name+city. Only fires
 *   when match_confidence >= 85 AND revenue_signal_score >= 50.
 *
 * Guardrails:
 *   - 90-day Supabase cache (enriched_contacts) — never re-pay for the same lead
 *   - $10/day hard spend cap (across BatchData + PDL combined)
 *   - Priority cities: LA, Phoenix, Dallas, Tampa, Miami, Houston, Austin, Atlanta,
 *     San Diego, Las Vegas. Non-priority cities skip Tier 1/2.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { validateUSPhone, validateEmail, formatPhoneForDisplay } from "./lead-validators.server";

const sb = () => supabaseAdmin as any;

const DAILY_SPEND_CAP_USD = 10;

const PRIORITY_CITIES = new Set(
  [
    "los angeles", "long beach", "anaheim", "santa monica", "burbank",
    "phoenix", "scottsdale", "mesa", "tempe", "chandler", "gilbert", "glendale",
    "dallas", "fort worth", "arlington", "plano", "frisco", "irving",
    "tampa", "st petersburg", "saint petersburg", "clearwater",
    "miami", "fort lauderdale", "hollywood", "hialeah",
    "houston", "sugar land", "the woodlands",
    "austin", "round rock", "cedar park",
    "atlanta", "marietta", "alpharetta",
    "san diego", "chula vista",
    "las vegas", "henderson", "north las vegas",
  ].map((c) => c.toLowerCase()),
);

type EnrichedShape = {
  full_name: string | null;
  emails: string[];
  phones: string[];
  social_profiles: string[];
  property_address: string | null;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
};

const EMPTY: EnrichedShape = {
  full_name: null,
  emails: [],
  phones: [],
  social_profiles: [],
  property_address: null,
  property_city: null,
  property_state: null,
  property_zip: null,
};

function sanitizeShape(s: EnrichedShape, firstName: string | null): EnrichedShape {
  const emails: string[] = [];
  for (const e of s.emails) {
    if (validateEmail(e, { firstName }).ok && !emails.includes(e.toLowerCase())) emails.push(e.toLowerCase());
  }
  const phones: string[] = [];
  for (const p of s.phones) {
    const v = validateUSPhone(p);
    if (v.ok && v.normalized) {
      const display = formatPhoneForDisplay(v.normalized);
      if (!phones.includes(display)) phones.push(display);
    }
  }
  return { ...s, emails, phones };
}

function normalizeKey(parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p || "").toLowerCase().trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("|");
}

function isPriorityCity(city: string | null): boolean {
  if (!city) return false;
  return PRIORITY_CITIES.has(city.toLowerCase().trim());
}

async function getDailySpend(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await sb()
    .from("enrichment_spend_log")
    .select("cost_usd")
    .eq("spend_date", today);
  return (data || []).reduce((sum: number, r: any) => sum + Number(r.cost_usd || 0), 0);
}

async function logSpend(provider: string, match_id: string | null, cost_usd: number, outcome: "hit" | "miss" | "error") {
  try {
    await sb().from("enrichment_spend_log").insert({
      provider,
      match_id,
      cost_usd,
      outcome,
    });
  } catch {
    /* non-fatal */
  }
}

async function readCache(cacheKey: string): Promise<EnrichedShape | null> {
  const { data } = await sb()
    .from("enriched_contacts")
    .select("*")
    .eq("cache_key", cacheKey)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!data) return null;
  return {
    full_name: data.full_name,
    emails: Array.isArray(data.emails) ? data.emails : [],
    phones: Array.isArray(data.phones) ? data.phones : [],
    social_profiles: Array.isArray(data.social_profiles) ? data.social_profiles : [],
    property_address: data.property_address,
    property_city: data.property_city,
    property_state: data.property_state,
    property_zip: data.property_zip,
  };
}

async function writeCache(cacheKey: string, tier: string, data: EnrichedShape, raw: any, cost: number) {
  try {
    await sb().from("enriched_contacts").upsert(
      {
        cache_key: cacheKey,
        source_tier: tier,
        full_name: data.full_name,
        emails: data.emails,
        phones: data.phones,
        social_profiles: data.social_profiles,
        property_address: data.property_address,
        property_city: data.property_city,
        property_state: data.property_state,
        property_zip: data.property_zip,
        raw_response: raw,
        cost_usd: cost,
        fetched_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 90 * 86400 * 1000).toISOString(),
      },
      { onConflict: "cache_key" },
    );
  } catch (e) {
    console.error("[enricher] cache write failed", e);
  }
}

// ============================================================================
// Tier 0 — free OSINT via Firecrawl search
// ============================================================================

async function firecrawlSearch(query: string, limit = 4): Promise<Array<{ url: string; title: string; description: string }>> {
  const fcKey = process.env.FIRECRAWL_API_KEY;
  if (!fcKey) return [];
  try {
    const resp = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
    });
    if (!resp.ok) return [];
    const json = await resp.json();
    const results = (json?.data?.web || json?.data || json?.web || []) as any[];
    return results.map((r) => ({
      url: r.url || "",
      title: r.title || "",
      description: r.description || r.snippet || "",
    })).filter((r) => r.url);
  } catch {
    return [];
  }
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const ADDRESS_RE = /\b\d{1,6}\s+[A-Z][a-zA-Z0-9.\- ]{2,40}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Ter|Terrace)\b/g;

async function tier0Osint(input: {
  match_id: string;
  first_name: string | null;
  city: string | null;
  state: string | null;
  existing_email: string | null;
  existing_phone: string | null;
}): Promise<EnrichedShape> {
  const out: EnrichedShape = { ...EMPTY, emails: [], phones: [], social_profiles: [] };

  const queries: string[] = [];
  if (input.first_name && input.city) {
    queries.push(`"${input.first_name}" "${input.city}" pool rental site:facebook.com`);
    queries.push(`"${input.first_name}" "${input.city}" ${input.state || ""} site:linkedin.com/in`);
    queries.push(`"${input.first_name}" "${input.city}" pool party rental`);
  }
  if (input.existing_email) queries.push(`"${input.existing_email}"`);
  if (input.existing_phone) queries.push(`"${input.existing_phone}"`);

  const allText: string[] = [];
  for (const q of queries.slice(0, 5)) {
    const results = await firecrawlSearch(q, 4);
    for (const r of results) {
      if (/facebook\.com\/[^/]+\/?$/i.test(r.url) || /linkedin\.com\/in\//i.test(r.url) || /instagram\.com\/[^/]+\/?$/i.test(r.url)) {
        if (!out.social_profiles.includes(r.url)) out.social_profiles.push(r.url);
      }
      allText.push(`${r.title} ${r.description}`);
    }
  }

  const blob = allText.join(" ");
  const emails = Array.from(new Set((blob.match(EMAIL_RE) || []).filter((e) =>
    !/swimply|peerspace|giggster|sentry|cloudflare|gstatic|googleusercontent|wixpress|squarespace/i.test(e),
  ))).slice(0, 3);
  const phones = Array.from(new Set(blob.match(PHONE_RE) || [])).slice(0, 3);
  const addresses = Array.from(new Set(blob.match(ADDRESS_RE) || []));

  out.emails = emails;
  out.phones = phones;
  if (addresses.length > 0) out.property_address = addresses[0];
  out.property_city = input.city;
  out.property_state = input.state;

  await logSpend("osint", input.match_id, 0, out.emails.length || out.phones.length || out.social_profiles.length ? "hit" : "miss");
  return out;
}

// ============================================================================
// Tier 1 — BatchData skip-trace (by property address)
// ============================================================================

async function tier1BatchData(input: {
  match_id: string;
  property_address: string;
  city: string | null;
  state: string | null;
}): Promise<{ data: EnrichedShape; cost: number }> {
  const apiKey = process.env.BATCHDATA_API_KEY;
  if (!apiKey) {
    return { data: EMPTY, cost: 0 };
  }
  const cost = 0.1;
  try {
    const resp = await fetch("https://api.batchdata.com/api/v1/property/skip-trace", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            propertyAddress: {
              street: input.property_address,
              city: input.city || undefined,
              state: input.state || undefined,
            },
          },
        ],
      }),
    });
    if (!resp.ok) {
      await logSpend("batchdata", input.match_id, 0, "error");
      return { data: EMPTY, cost: 0 };
    }
    const json = await resp.json();
    const person = json?.results?.persons?.[0] || json?.results?.[0]?.person || null;
    if (!person) {
      await logSpend("batchdata", input.match_id, cost, "miss");
      return { data: EMPTY, cost };
    }
    const data: EnrichedShape = {
      full_name: [person.name?.first, person.name?.last].filter(Boolean).join(" ") || null,
      emails: (person.emails || []).map((e: any) => e?.email || e).filter(Boolean).slice(0, 5),
      phones: (person.phoneNumbers || person.phones || []).map((p: any) => p?.number || p).filter(Boolean).slice(0, 5),
      social_profiles: [],
      property_address: input.property_address,
      property_city: input.city,
      property_state: input.state,
      property_zip: person.address?.zip || null,
    };
    await logSpend("batchdata", input.match_id, cost, data.emails.length || data.phones.length ? "hit" : "miss");
    return { data, cost };
  } catch (e) {
    console.error("[enricher] batchdata failed", e);
    await logSpend("batchdata", input.match_id, 0, "error");
    return { data: EMPTY, cost: 0 };
  }
}

// ============================================================================
// Tier 2 — PeopleDataLabs person enrichment (by name + city)
// ============================================================================

async function tier2Pdl(input: {
  match_id: string;
  first_name: string;
  city: string;
  state: string | null;
  existing_email: string | null;
}): Promise<{ data: EnrichedShape; cost: number }> {
  const apiKey = process.env.PDL_API_KEY;
  if (!apiKey) return { data: EMPTY, cost: 0 };
  const cost = 0.2;
  try {
    const params = new URLSearchParams();
    if (input.existing_email) params.set("email", input.existing_email);
    else {
      params.set("first_name", input.first_name);
      params.set("locality", input.city);
      if (input.state) params.set("region", input.state);
    }
    params.set("min_likelihood", "6");
    const resp = await fetch(`https://api.peopledatalabs.com/v5/person/enrich?${params}`, {
      method: "GET",
      headers: { "X-Api-Key": apiKey },
    });
    if (resp.status === 404) {
      await logSpend("pdl", input.match_id, 0, "miss");
      return { data: EMPTY, cost: 0 };
    }
    if (!resp.ok) {
      await logSpend("pdl", input.match_id, 0, "error");
      return { data: EMPTY, cost: 0 };
    }
    const json = await resp.json();
    const p = json?.data;
    if (!p) {
      await logSpend("pdl", input.match_id, cost, "miss");
      return { data: EMPTY, cost };
    }
    const data: EnrichedShape = {
      full_name: p.full_name || null,
      emails: (p.emails || []).map((e: any) => e?.address || e).filter(Boolean).slice(0, 5),
      phones: (p.phone_numbers || []).filter(Boolean).slice(0, 5),
      social_profiles: (p.profiles || []).map((s: any) => s?.url).filter(Boolean).slice(0, 10),
      property_address: null,
      property_city: p.location_locality || input.city,
      property_state: p.location_region || input.state,
      property_zip: p.location_postal_code || null,
    };
    await logSpend("pdl", input.match_id, cost, data.emails.length || data.phones.length ? "hit" : "miss");
    return { data, cost };
  } catch (e) {
    console.error("[enricher] pdl failed", e);
    await logSpend("pdl", input.match_id, 0, "error");
    return { data: EMPTY, cost: 0 };
  }
}

// ============================================================================
// Revenue signal scorer (uses listing markdown if available)
// ============================================================================

export function scoreRevenueSignal(markdown: string | null | undefined): { score: number; notes: string } {
  if (!markdown) return { score: 0, notes: "no listing text" };
  const notes: string[] = [];
  let score = 0;

  const priceMatch = markdown.match(/\$\s?(\d{2,4})(?:\s*\/\s*hour|\s*per hour|\s*\/hr|\s*\/h\b)/i);
  if (priceMatch) {
    const price = Number(priceMatch[1]);
    if (price >= 100) { score += 40; notes.push(`$${price}/hour premium pricing`); }
    else if (price >= 60) { score += 20; notes.push(`$${price}/hour mid pricing`); }
  }

  const reviewMatch = markdown.match(/(\d{1,4})\s*review/i);
  if (reviewMatch) {
    const reviews = Number(reviewMatch[1]);
    if (reviews >= 50) { score += 35; notes.push(`${reviews} reviews`); }
    else if (reviews >= 20) { score += 20; notes.push(`${reviews} reviews`); }
    else if (reviews >= 5) { score += 10; notes.push(`${reviews} reviews`); }
  }

  if (/super\s*host|top\s*host|elite\s*host/i.test(markdown)) {
    score += 15; notes.push("superhost badge");
  }

  const sinceMatch = markdown.match(/(?:host(?:ing)?\s+since|joined\s+in)\s+(20\d{2})/i);
  if (sinceMatch) {
    const year = Number(sinceMatch[1]);
    const monthsActive = (new Date().getFullYear() - year) * 12;
    if (monthsActive >= 12) { score += 15; notes.push(`hosting ${monthsActive}mo`); }
    else if (monthsActive >= 6) { score += 8; notes.push(`hosting ${monthsActive}mo`); }
  }

  return { score: Math.min(100, score), notes: notes.join(", ") };
}

// ============================================================================
// Main entry: tiered cascade for one match
// ============================================================================

export type EnrichResult = {
  ok: boolean;
  match_id: string;
  tier_reached: "osint" | "batchdata" | "pdl" | "skipped" | "cached";
  cost_usd: number;
  emails_found: number;
  phones_found: number;
  reason?: string;
};

export async function enrichHostMatch(match_id: string, opts?: { force_tier?: "osint" | "batchdata" | "pdl" }): Promise<EnrichResult> {
  const { data: match } = await sb()
    .from("competitor_host_matches")
    .select("*")
    .eq("id", match_id)
    .maybeSingle();
  if (!match) return { ok: false, match_id, tier_reached: "skipped", cost_usd: 0, emails_found: 0, phones_found: 0, reason: "match not found" };

  // Cache check
  const cacheKey = normalizeKey([
    match.candidate_email,
    match.candidate_phone,
    match.host_first_name,
    match.host_city,
    match.host_state,
  ]);
  if (cacheKey) {
    const cached = await readCache(cacheKey);
    if (cached) {
      await sb().from("competitor_host_matches").update({
        enriched_at: new Date().toISOString(),
        enriched_tier: "cached",
        enriched_emails: cached.emails,
        enriched_phones: cached.phones,
        enriched_socials: cached.social_profiles,
        property_address: cached.property_address,
      }).eq("id", match_id);
      return { ok: true, match_id, tier_reached: "cached", cost_usd: 0, emails_found: cached.emails.length, phones_found: cached.phones.length };
    }
  }

  // Pull listing markdown (cached on competitor_pages or competitor_urls? fall back to none)
  let listingMd: string | null = null;
  try {
    const { data: page } = await sb()
      .from("competitor_pages")
      .select("markdown")
      .eq("url", match.competitor_url)
      .maybeSingle();
    listingMd = page?.markdown || null;
  } catch { /* table may not have row */ }

  const revenue = scoreRevenueSignal(listingMd);

  // ---------- Tier 0: always run ----------
  const t0 = await tier0Osint({
    match_id,
    first_name: match.host_first_name,
    city: match.host_city,
    state: match.host_state,
    existing_email: match.candidate_email,
    existing_phone: match.candidate_phone,
  });

  let combined: EnrichedShape = sanitizeShape({ ...t0 }, match.host_first_name);
  let highestTier: EnrichResult["tier_reached"] = "osint";
  let totalCost = 0;

  // Daily cap check before any paid tier
  const spentToday = await getDailySpend();
  const overCap = spentToday >= DAILY_SPEND_CAP_USD;

  // 30-day per-listing cap: max 1 paid enrichment per competitor URL per 30 days
  let listingCapHit = false;
  try {
    const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const { data: recent } = await sb()
      .from("competitor_host_matches")
      .select("id, enrichment_cost_usd, enriched_at")
      .eq("competitor_url_id", match.competitor_url_id)
      .gt("enriched_at", since);
    const paidCalls = (recent || []).filter((r: any) => Number(r.enrichment_cost_usd || 0) > 0 && r.id !== match_id).length;
    if (paidCalls >= 1) listingCapHit = true;
  } catch { /* non-fatal */ }


  const priority = isPriorityCity(match.host_city);
  const confidence = Number(match.match_confidence || 0);

  // Hard refusal: if the match is junk (no validated contact AND no first name), don't burn money.
  const hasAnyValidatedSignal = combined.emails.length > 0 || combined.phones.length > 0 || !!match.host_first_name;
  if (!hasAnyValidatedSignal && !opts?.force_tier) {
    await sb().from("competitor_host_matches").update({
      enriched_at: new Date().toISOString(),
      enriched_tier: "osint",
      enriched_emails: combined.emails,
      enriched_phones: combined.phones,
      enriched_socials: combined.social_profiles,
      revenue_signal_score: revenue.score,
      revenue_signal_notes: revenue.notes,
      enrichment_cost_usd: 0,
    }).eq("id", match_id);
    return { ok: true, match_id, tier_reached: "osint", cost_usd: 0, emails_found: 0, phones_found: 0, reason: "no validated signal — paid tiers skipped" };
  }

  // ---------- Tier 1: BatchData ----------
  // Now also requires confidence >= 85 (was 70) AND the match isn't all-garbage.
  const tier1Eligible = !overCap && !listingCapHit && priority && confidence >= 85 && !!combined.property_address;
  const forceT1 = opts?.force_tier === "batchdata" || opts?.force_tier === "pdl";

  if ((tier1Eligible || forceT1) && (combined.property_address)) {
    const t1 = await tier1BatchData({
      match_id,
      property_address: combined.property_address,
      city: match.host_city,
      state: match.host_state,
    });
    totalCost += t1.cost;
    if (t1.data.emails.length || t1.data.phones.length) {
      combined.full_name = combined.full_name || t1.data.full_name;
      combined.emails = Array.from(new Set([...combined.emails, ...t1.data.emails]));
      combined.phones = Array.from(new Set([...combined.phones, ...t1.data.phones]));
      combined.property_zip = combined.property_zip || t1.data.property_zip;
      highestTier = "batchdata";
    }
  }

  // ---------- Tier 2: PDL ----------
  const stillUnderCap = (await getDailySpend()) < DAILY_SPEND_CAP_USD;
  const tier2Eligible = stillUnderCap && !listingCapHit && priority && confidence >= 85 && revenue.score >= 50 && !!(match.host_first_name && match.host_city);
  const forceT2 = opts?.force_tier === "pdl";

  if ((tier2Eligible || forceT2) && match.host_first_name && match.host_city) {
    const t2 = await tier2Pdl({
      match_id,
      first_name: match.host_first_name,
      city: match.host_city,
      state: match.host_state,
      existing_email: combined.emails[0] || match.candidate_email,
    });
    totalCost += t2.cost;
    if (t2.data.emails.length || t2.data.phones.length || t2.data.social_profiles.length) {
      combined.full_name = combined.full_name || t2.data.full_name;
      combined.emails = Array.from(new Set([...combined.emails, ...t2.data.emails]));
      combined.phones = Array.from(new Set([...combined.phones, ...t2.data.phones]));
      combined.social_profiles = Array.from(new Set([...combined.social_profiles, ...t2.data.social_profiles]));
      highestTier = "pdl";
    }
  }

  // Final sanitize before persisting/caching — never write garbage to the DB.
  combined = sanitizeShape(combined, match.host_first_name);
  if (cacheKey) {
    await writeCache(cacheKey, highestTier, combined, { revenue, listingMd: !!listingMd }, totalCost);
  }

  await sb().from("competitor_host_matches").update({
    enriched_at: new Date().toISOString(),
    enriched_tier: highestTier,
    enriched_emails: combined.emails,
    enriched_phones: combined.phones,
    enriched_socials: combined.social_profiles,
    property_address: combined.property_address,
    revenue_signal_score: revenue.score,
    revenue_signal_notes: revenue.notes,
    enrichment_cost_usd: totalCost,
  }).eq("id", match_id);

  return {
    ok: true,
    match_id,
    tier_reached: highestTier,
    cost_usd: totalCost,
    emails_found: combined.emails.length,
    phones_found: combined.phones.length,
    reason: listingCapHit ? "30-day per-listing cap hit, paid tiers skipped" : (overCap ? "daily cap reached, paid tiers skipped" : undefined),
  };
}

export async function enrichManyHostMatches(match_ids: string[]): Promise<{ processed: number; total_cost: number; cap_hit: boolean }> {
  let total_cost = 0;
  let processed = 0;
  let cap_hit = false;
  for (const id of match_ids) {
    const spent = await getDailySpend();
    if (spent >= DAILY_SPEND_CAP_USD) {
      cap_hit = true;
      // still run Tier 0 (free) for remaining
      await enrichHostMatch(id).catch(() => null);
      processed++;
      continue;
    }
    const r = await enrichHostMatch(id).catch(() => null);
    if (r) {
      total_cost += r.cost_usd;
      processed++;
    }
  }
  return { processed, total_cost, cap_hit };
}
