/**
 * PAGE BRIEF — the structured contract handed to generation.
 *
 * The generator must never receive "write pool rentals riverside". It receives
 * the evidence that justified the page, the real inventory numbers it is
 * allowed to cite, and an explicit list of claims it must not make.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadInventoryMap } from "./inventory.server";

const sb = () => supabaseAdmin as any;

export type PageBrief = {
  intentKey: string;
  targetIntent: string;
  geography: { city: string; state: string };
  category: string;
  proposedTitle: string;
  proposedSlug: string;
  searchEvidence: {
    impressions: number;
    queryVariants: string[];
    currentlyRankingUrl: string | null;
    bestPosition: number | null;
  };
  inventoryFacts: {
    listingCount: number;
    providerCount: number;
    priceMin: number | null;
    priceMax: number | null;
    priceMedian: number | null;
    currency: string | null;
    sampleTitles: string[];
  };
  businessContext: { workspaceName: string; analysisDomain: string | null };
  internalLinkTargets: Array<{ slug: string; title: string }>;
  titleConstraint: string;
  metaConstraint: string;
  forbiddenClaims: string[];
};

export async function buildPageBrief(workspaceId: string, opportunityId: string): Promise<PageBrief> {
  const { data: opp } = await sb()
    .from("seo_opportunities")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", opportunityId)
    .maybeSingle();
  if (!opp) throw new Error("opportunity not found");

  const { data: ws } = await sb()
    .from("workspaces")
    .select("name, analysis_domain")
    .eq("id", workspaceId)
    .maybeSingle();

  const inventory = await loadInventoryMap(workspaceId);
  const inv =
    inventory.get(`${opp.normalized_geo}::${opp.normalized_category}`) ??
    inventory.get(`${opp.normalized_geo}::`);

  // Real listing titles ground the copy in actual supply.
  let sampleTitles: string[] = [];
  if (opp.geo_city) {
    const { data: listings } = await sb()
      .from("tenant_listings")
      .select("title")
      .eq("workspace_id", workspaceId)
      .eq("state_published", true)
      .ilike("city", opp.geo_city)
      .limit(6);
    sampleTitles = ((listings ?? []) as Array<{ title: string }>).map((l) => l.title);
  }

  // Sibling pages for internal linking — pSEO pages that only exist in a
  // sitemap are orphans, which Google's doorway guidance penalises.
  const { data: siblings } = await sb()
    .from("tenant_pages")
    .select("slug, title")
    .eq("workspace_id", workspaceId)
    .eq("status", "published")
    .limit(8);

  const forbidden: string[] = [
    "Do not state or estimate any price not present in the inventory facts.",
    "Do not claim a listing count other than the number given.",
    "Do not invent provider names, reviews, ratings or testimonials.",
    "Do not claim availability, booking windows or delivery you were not told about.",
  ];
  if (!inv || inv.listingCount === 0) {
    forbidden.push("Do not imply inventory exists in this location — there is none on record.");
  }
  if (!inv || inv.priceMin === null) {
    forbidden.push("No price data is available; do not mention prices at all.");
  }

  return {
    intentKey: opp.intent_key,
    targetIntent: opp.intent_label,
    geography: { city: opp.geo_city ?? "", state: opp.geo_state ?? "" },
    category: (opp.normalized_category ?? "").replace(/\|/g, " "),
    proposedTitle: opp.proposed_title ?? opp.intent_label,
    proposedSlug: opp.proposed_slug ?? "",
    searchEvidence: {
      impressions: Number(
        (opp.score_breakdown && opp.score_breakdown.search_demand ? 0 : 0) || 0,
      ) || (Array.isArray(opp.query_variants) ? 0 : 0),
      queryVariants: Array.isArray(opp.query_variants) ? opp.query_variants.slice(0, 20) : [],
      currentlyRankingUrl: Array.isArray(opp.ranking_urls) ? (opp.ranking_urls[0] ?? null) : null,
      bestPosition: null,
    },
    inventoryFacts: {
      listingCount: inv?.listingCount ?? 0,
      providerCount: inv?.providerCount ?? 0,
      priceMin: inv?.priceMin ?? null,
      priceMax: inv?.priceMax ?? null,
      priceMedian: inv?.priceMedian ?? null,
      currency: inv?.currency ?? null,
      sampleTitles,
    },
    businessContext: {
      workspaceName: ws?.name ?? "",
      analysisDomain: ws?.analysis_domain ?? null,
    },
    internalLinkTargets: ((siblings ?? []) as Array<{ slug: string; title: string }>).map((s) => ({
      slug: s.slug,
      title: s.title,
    })),
    titleConstraint: "≤60 characters, must include the location",
    metaConstraint: "≤155 characters, must describe what the visitor will find",
    forbiddenClaims: forbidden,
  };
}

/** Render the brief as the generator's user prompt. Structured, not generic. */
export function briefToPrompt(brief: PageBrief): string {
  const inv = brief.inventoryFacts;
  const priceLine =
    inv.priceMin !== null && inv.priceMax !== null
      ? `- Price range: ${(inv.priceMin / 100).toFixed(0)}–${(inv.priceMax / 100).toFixed(0)} ${inv.currency ?? "USD"}`
      : "- No price data available — do not mention prices";

  return `Write a location landing page grounded ONLY in the facts below.

TARGET SEARCH INTENT
${brief.targetIntent}
Location: ${brief.geography.city}${brief.geography.state ? `, ${brief.geography.state}` : ""}
Category: ${brief.category}

WHY THIS PAGE EXISTS (real search evidence)
${brief.searchEvidence.queryVariants.length ? brief.searchEvidence.queryVariants.slice(0, 10).map((q) => `- People search: "${q}"`).join("\n") : "- Discovered from marketplace inventory coverage"}
${brief.searchEvidence.currentlyRankingUrl ? `- These searches currently land on ${brief.searchEvidence.currentlyRankingUrl}, which is not specific to this location` : ""}

VERIFIED INVENTORY FACTS — the only numbers you may cite
- ${inv.listingCount} active listings
- ${inv.providerCount} providers
${priceLine}
${inv.sampleTitles.length ? `- Real listings include:\n${inv.sampleTitles.map((t) => `  · ${t}`).join("\n")}` : ""}

BUSINESS
${brief.businessContext.workspaceName}${brief.businessContext.analysisDomain ? ` (${brief.businessContext.analysisDomain})` : ""}

INTERNAL LINKS — reference naturally where relevant
${brief.internalLinkTargets.map((l) => `- [${l.title}](/a/${l.slug})`).join("\n") || "- none yet"}

CONSTRAINTS
- seo_title: ${brief.titleConstraint}
- seo_description: ${brief.metaConstraint}
- 600–1000 words, ## for sections
${brief.forbiddenClaims.map((f) => `- ${f}`).join("\n")}

Write for someone deciding where to rent in ${brief.geography.city}. Be specific and useful. No filler.`;
}
