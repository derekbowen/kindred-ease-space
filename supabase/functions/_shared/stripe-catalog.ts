import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

// ---------------------------------------------------------------------------
// PAGE-ENTITLEMENT PLANS — the product is published-page capacity, not credits.
// This catalog is the single source of truth for plan → price → pages → AI
// allowance. The app-side mirror lives in src/lib/plan-catalog.ts; keep in sync.
// AI credits remain an INTERNAL metering system (generation cost, abuse
// control); every plan includes a monthly generation allowance sized to cover
// its page capacity with regeneration headroom.
// ---------------------------------------------------------------------------
export type PlanTier = "starter" | "growth" | "scale" | "pro" | "agency";

export const PAGE_PLANS: Record<
  PlanTier,
  {
    catalogKey: string;
    name: string;
    monthlyPriceCents: number;
    includedPages: number;
    includedAiCredits: number;
    description: string;
  }
> = {
  starter: {
    catalogKey: "pages-starter-monthly",
    name: "Founders Starter",
    monthlyPriceCents: 2900,
    includedPages: 100,
    includedAiCredits: 500,
    description: "Up to 100 published SEO pages. AI generation, hosting and sitemaps included.",
  },
  growth: {
    catalogKey: "pages-growth-monthly",
    name: "Founders Growth",
    monthlyPriceCents: 5900,
    includedPages: 500,
    includedAiCredits: 2500,
    description: "Up to 500 published SEO pages. AI generation, hosting and sitemaps included.",
  },
  scale: {
    catalogKey: "pages-scale-monthly",
    name: "Founders Scale",
    monthlyPriceCents: 9900,
    includedPages: 1000,
    includedAiCredits: 5000,
    description: "Up to 1,000 published SEO pages. AI generation, hosting and sitemaps included.",
  },
  pro: {
    catalogKey: "pages-pro-monthly",
    name: "Founders Pro",
    monthlyPriceCents: 19900,
    includedPages: 3000,
    includedAiCredits: 12000,
    description: "Up to 3,000 published SEO pages. AI generation, hosting and sitemaps included.",
  },
  agency: {
    catalogKey: "pages-agency-monthly",
    name: "Founders Agency",
    monthlyPriceCents: 29900,
    includedPages: 5000,
    includedAiCredits: 20000,
    description: "Up to 5,000 published SEO pages. AI generation, hosting and sitemaps included.",
  },
};

// Recurring extra page capacity on top of any plan (kept as its own recurring
// subscription — hosted capacity is recurring revenue, never a one-time sale).
export const PAGE_ADDON = {
  catalogKey: "page-capacity-1000",
  name: "Additional Page Capacity",
  monthlyPriceCents: 5000,
  pagesPerUnit: 1000,
  description: "+1,000 published pages per unit, per month.",
};

export function isPlanTier(k: unknown): k is PlanTier {
  return typeof k === "string" && k in PAGE_PLANS;
}

// Pre-rebuild credit-first tiers (old $99/$249/$599). No real customers bought
// them, but any stray legacy subscription keeps its old monthly credit grant
// and maps to a generous page limit rather than breaking.
export const LEGACY_TIER_CREDITS: Record<string, number> = {
  starter: 500,
  pro: 2500,
  scale: 10000,
};
export const LEGACY_TIER_PAGES: Record<string, number> = {
  starter: 1000,
  pro: 3000,
  scale: 5000,
};

// Stripe product tax codes. Managed Payments (on by default for new accounts)
// rejects any line item whose product has no tax_code, so every product we
// create must carry one. founders.click sells to marketplace operators, i.e.
// commercial buyers — hence the "business use" variants.
//   txcd_10103001 = Software as a service (SaaS) - business use
//   txcd_10105002 = AI as a Service (AIaaS), cloud based - business use
export const TAX_CODE_SAAS = "txcd_10103001";
export const TAX_CODE_AI = "txcd_10105002";

export const CREDIT_PACK = {
  catalogKey: "credit-pack-1000",
  credits: 1000,
  name: "Credit Pack",
  unitAmountCents: 1000,
  description: "One-time purchase of 1,000 AI credits.",
};

// Resellable monthly add-ons. DM Champ is white-glove (managed setup); the
// affiliate tiers are self-serve (entitlement is flipped on by the webhook).
export type AddonKey = "dmchamp" | "affiliate-lite" | "affiliate-standard" | "affiliate-pro";

type AddonDefinition = {
  catalogKey: string;
  name: string;
  description: string;
  priceCents: number;
  tier?: string;
};

export const ADDON_CATALOG: Record<AddonKey, AddonDefinition> = {
  dmchamp: {
    catalogKey: "addon-dmchamp",
    name: "DM Champ — AI Sales Agent",
    description: "White-label AI agent for WhatsApp/Instagram/Messenger. Done-for-you setup.",
    priceCents: 9900,
  },
  "affiliate-lite": {
    catalogKey: "addon-affiliate-lite",
    name: "Affiliate Programs (Lite)",
    description: "Referral/affiliate programs for your Sharetribe marketplace.",
    priceCents: 1500,
    tier: "lite",
  },
  "affiliate-standard": {
    catalogKey: "addon-affiliate-standard",
    name: "Affiliate Programs (Standard)",
    description: "Referral/affiliate programs for your Sharetribe marketplace.",
    priceCents: 3000,
    tier: "standard",
  },
  "affiliate-pro": {
    catalogKey: "addon-affiliate-pro",
    name: "Affiliate Programs (Pro)",
    description: "Referral/affiliate programs for your Sharetribe marketplace.",
    priceCents: 4500,
    tier: "pro",
  },
};

export function isAddonKey(k: unknown): k is AddonKey {
  return typeof k === "string" && k in ADDON_CATALOG;
}

export async function ensureAddonPrice(stripe: Stripe, addonKey: AddonKey) {
  const def = ADDON_CATALOG[addonKey];
  const meta = {
    kind: "addon",
    addon_key: addonKey,
    ...(def.tier ? { addon_tier: def.tier } : {}),
  };
  const product = await ensureProduct(stripe, {
    catalogKey: def.catalogKey,
    name: def.name,
    description: def.description,
    taxCode: TAX_CODE_SAAS,
    metadata: meta,
  });
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const existing = prices.data.find(
    (p) =>
      p.currency === "usd" && p.unit_amount === def.priceCents && p.recurring?.interval === "month",
  );
  if (existing) return existing;
  return stripe.prices.create({
    currency: "usd",
    product: product.id,
    recurring: { interval: "month" },
    unit_amount: def.priceCents,
    metadata: meta,
  });
}

async function ensureProduct(
  stripe: Stripe,
  params: {
    catalogKey: string;
    name: string;
    description: string;
    taxCode: string;
    metadata?: Record<string, string>;
  },
) {
  const products = await stripe.products.list({ active: true, limit: 100 });
  const existing = products.data.find(
    (product) => product.metadata?.catalog_key === params.catalogKey,
  );

  if (existing) {
    // Back-fill the tax code on products created before it was required —
    // otherwise checkout keeps failing with "the product tax code is missing".
    if (!existing.tax_code) {
      return stripe.products.update(existing.id, { tax_code: params.taxCode });
    }
    return existing;
  }

  return stripe.products.create({
    name: params.name,
    description: params.description,
    tax_code: params.taxCode,
    metadata: {
      catalog_key: params.catalogKey,
      ...(params.metadata ?? {}),
    },
  });
}

export async function ensureSubscriptionPrice(stripe: Stripe, tier: PlanTier) {
  const plan = PAGE_PLANS[tier];
  const meta = {
    kind: "subscription",
    product_kind: "page_plan",
    plan_tier: tier,
    included_pages: String(plan.includedPages),
    included_ai_credits: String(plan.includedAiCredits),
  };
  const product = await ensureProduct(stripe, {
    catalogKey: plan.catalogKey,
    name: plan.name,
    description: plan.description,
    taxCode: TAX_CODE_SAAS,
    metadata: meta,
  });

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const existing = prices.data.find(
    (price) =>
      price.currency === "usd" &&
      price.unit_amount === plan.monthlyPriceCents &&
      price.recurring?.interval === "month",
  );

  if (existing) return existing;

  return stripe.prices.create({
    currency: "usd",
    product: product.id,
    recurring: { interval: "month" },
    unit_amount: plan.monthlyPriceCents,
    metadata: meta,
  });
}

export async function ensurePageAddonPrice(stripe: Stripe) {
  const meta = {
    kind: "page_addon",
    product_kind: "page_addon",
    pages_per_unit: String(PAGE_ADDON.pagesPerUnit),
  };
  const product = await ensureProduct(stripe, {
    catalogKey: PAGE_ADDON.catalogKey,
    name: PAGE_ADDON.name,
    description: PAGE_ADDON.description,
    taxCode: TAX_CODE_SAAS,
    metadata: meta,
  });
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const existing = prices.data.find(
    (p) =>
      p.currency === "usd" &&
      p.unit_amount === PAGE_ADDON.monthlyPriceCents &&
      p.recurring?.interval === "month",
  );
  if (existing) return existing;
  return stripe.prices.create({
    currency: "usd",
    product: product.id,
    recurring: { interval: "month" },
    unit_amount: PAGE_ADDON.monthlyPriceCents,
    metadata: meta,
  });
}

export async function ensureCreditPackPrice(stripe: Stripe) {
  const product = await ensureProduct(stripe, {
    catalogKey: CREDIT_PACK.catalogKey,
    name: CREDIT_PACK.name,
    description: CREDIT_PACK.description,
    taxCode: TAX_CODE_AI,
    metadata: {
      kind: "credits",
      credits: String(CREDIT_PACK.credits),
    },
  });

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const existing = prices.data.find(
    (price) =>
      price.currency === "usd" &&
      price.unit_amount === CREDIT_PACK.unitAmountCents &&
      !price.recurring,
  );

  if (existing) return existing;

  return stripe.prices.create({
    currency: "usd",
    product: product.id,
    unit_amount: CREDIT_PACK.unitAmountCents,
    metadata: {
      kind: "credits",
      credits: String(CREDIT_PACK.credits),
    },
  });
}

/**
 * Monthly internal AI allowance for a subscription. New page plans grant their
 * includedAiCredits; stray legacy credit-tier subscriptions keep their old
 * grant so nothing a customer paid for silently shrinks.
 */
export function creditsForTier(tier: string | null | undefined, productKind?: string | null) {
  if (!tier) return 0;
  if (productKind === "page_plan" || isPlanTier(tier)) {
    // "starter"/"scale" exist in both catalogs; product_kind disambiguates.
    if (productKind !== "page_plan" && LEGACY_TIER_CREDITS[tier] && !PAGE_PLANS[tier as PlanTier]) {
      return LEGACY_TIER_CREDITS[tier];
    }
    return PAGE_PLANS[tier as PlanTier]?.includedAiCredits ?? LEGACY_TIER_CREDITS[tier] ?? 0;
  }
  return LEGACY_TIER_CREDITS[tier] ?? 0;
}

/** Published-page capacity a plan tier grants (legacy tiers map generously). */
export function pagesForTier(tier: string | null | undefined): number {
  if (!tier) return 0;
  return PAGE_PLANS[tier as PlanTier]?.includedPages ?? LEGACY_TIER_PAGES[tier] ?? 0;
}

export async function resolvePlanTierFromPrice(stripe: Stripe, priceId: string | null) {
  if (!priceId) return "unknown";
  const price = await stripe.prices.retrieve(priceId);
  return price.metadata?.plan_tier ?? "unknown";
}
