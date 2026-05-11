import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

export type PlanTier = "starter" | "pro" | "scale";

type PlanDefinition = {
  catalogKey: string;
  name: string;
  monthlyCredits: number;
  monthlyPriceCents: number;
  description: string;
};

export const PLAN_CATALOG: Record<PlanTier, PlanDefinition> = {
  starter: {
    catalogKey: "starter-monthly",
    name: "Starter",
    monthlyCredits: 500,
    monthlyPriceCents: 9900,
    description: "500 AI credits every month.",
  },
  pro: {
    catalogKey: "pro-monthly",
    name: "Pro",
    monthlyCredits: 2500,
    monthlyPriceCents: 24900,
    description: "2,500 AI credits every month.",
  },
  scale: {
    catalogKey: "scale-monthly",
    name: "Scale",
    monthlyCredits: 10000,
    monthlyPriceCents: 59900,
    description: "10,000 AI credits every month.",
  },
};

export const CREDIT_PACK = {
  catalogKey: "credit-pack-1000",
  credits: 1000,
  name: "Credit Pack",
  unitAmountCents: 1000,
  description: "One-time purchase of 1,000 AI credits.",
};

async function ensureProduct(
  stripe: Stripe,
  params: { catalogKey: string; name: string; description: string; metadata?: Record<string, string> },
) {
  const products = await stripe.products.list({ active: true, limit: 100 });
  const existing = products.data.find((product) => product.metadata?.catalog_key === params.catalogKey);

  if (existing) return existing;

  return stripe.products.create({
    name: params.name,
    description: params.description,
    metadata: {
      catalog_key: params.catalogKey,
      ...(params.metadata ?? {}),
    },
  });
}

export async function ensureSubscriptionPrice(stripe: Stripe, tier: PlanTier) {
  const plan = PLAN_CATALOG[tier];
  const product = await ensureProduct(stripe, {
    catalogKey: plan.catalogKey,
    name: plan.name,
    description: plan.description,
    metadata: {
      kind: "subscription",
      plan_tier: tier,
      monthly_credits: String(plan.monthlyCredits),
    },
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
    metadata: {
      kind: "subscription",
      plan_tier: tier,
      monthly_credits: String(plan.monthlyCredits),
    },
  });
}

export async function ensureCreditPackPrice(stripe: Stripe) {
  const product = await ensureProduct(stripe, {
    catalogKey: CREDIT_PACK.catalogKey,
    name: CREDIT_PACK.name,
    description: CREDIT_PACK.description,
    metadata: {
      kind: "credits",
      credits: String(CREDIT_PACK.credits),
    },
  });

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const existing = prices.data.find(
    (price) => price.currency === "usd" && price.unit_amount === CREDIT_PACK.unitAmountCents && !price.recurring,
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

export function creditsForTier(tier: string | null | undefined) {
  if (!tier) return 0;
  return PLAN_CATALOG[tier as PlanTier]?.monthlyCredits ?? 0;
}

export async function resolvePlanTierFromPrice(stripe: Stripe, priceId: string | null) {
  if (!priceId) return "unknown";
  const price = await stripe.prices.retrieve(priceId);
  return price.metadata?.plan_tier ?? "unknown";
}