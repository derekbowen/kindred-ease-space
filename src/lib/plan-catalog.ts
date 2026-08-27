/**
 * App-side mirror of the plan catalog in
 * supabase/functions/_shared/stripe-catalog.ts — keep the two in sync.
 *
 * THE PRODUCT IS PUBLISHED-PAGE CAPACITY. A plan buys a number of live pages
 * hosted and maintained by founders.click; AI credits are an internal metering
 * system (every plan includes a monthly generation allowance), never the
 * customer-facing unit. Homepage, pricing, dashboard and checkout must all
 * read from this one catalog — no scattered pricing constants.
 */

export type PlanKey = "starter" | "growth" | "scale" | "pro" | "agency";

export type PagePlan = {
  key: PlanKey;
  name: string;
  monthlyPrice: number; // dollars
  includedPages: number;
  includedAiCredits: number;
  /** Connected custom domains this plan may publish through. */
  includedDomains: number;
  blurb: string;
  featured?: boolean;
};

export const PAGE_PLANS: PagePlan[] = [
  {
    key: "starter",
    name: "Starter",
    monthlyPrice: 29,
    includedPages: 100,
    includedAiCredits: 500,
    includedDomains: 1,
    blurb: "For a marketplace publishing its first city pages.",
  },
  {
    key: "growth",
    name: "Growth",
    monthlyPrice: 59,
    includedPages: 500,
    includedAiCredits: 2500,
    includedDomains: 1,
    blurb: "For operators covering every city they serve.",
  },
  {
    key: "scale",
    name: "Scale",
    monthlyPrice: 99,
    includedPages: 1000,
    includedAiCredits: 5000,
    includedDomains: 1,
    blurb: "Serious coverage: every city × every category.",
    featured: true,
  },
  {
    key: "pro",
    name: "Pro",
    monthlyPrice: 199,
    includedPages: 3000,
    includedAiCredits: 12000,
    includedDomains: 3,
    blurb: "National footprints and aggressive expansion.",
  },
  {
    key: "agency",
    name: "Agency",
    monthlyPrice: 299,
    includedPages: 5000,
    includedAiCredits: 20000,
    includedDomains: 10,
    blurb: "Maximum capacity for the biggest marketplaces.",
  },
];

export const PAGE_ADDON = {
  monthlyPrice: 50,
  pagesPerUnit: 1000,
};

/** Published-page allowance during the free trial (no card required). */
export const TRIAL_PAGE_LIMIT = 25;

/** Connected-domain allowance during the free trial. */
export const TRIAL_DOMAIN_LIMIT = 1;

export function domainLimitForPlan(key: string | null | undefined): number {
  return planByKey(key)?.includedDomains ?? TRIAL_DOMAIN_LIMIT;
}

export function planByKey(key: string | null | undefined): PagePlan | undefined {
  return PAGE_PLANS.find((p) => p.key === key);
}

export const EVERY_PLAN_INCLUDES = [
  "AI page generation",
  "Hosting on your domain",
  "Automatic sitemaps",
  "Schema / structured data",
  "Internal linking",
  "Sharetribe listing sync",
];
