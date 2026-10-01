// ─────────────────────────────────────────────────────────────────────────────
// Magic Designs — design-token packs and costs. The price authority.
//
// design-token-checkout charges what THIS file says; src/lib/magic-designs.ts
// mirrors it for display and for the server functions that spend tokens.
// tests/magic-designs.test.ts fails if the two disagree.
//
// Design tokens are a Magic Designs product of their own. They are NOT the
// SaaS's internal AI credits (credit_balances / credit_ledger), which stay
// internal metering only (docs/SOURCE_OF_TRUTH.md).
// ─────────────────────────────────────────────────────────────────────────────

export type DesignTokenPack = {
  key: string;
  tokens: number;
  priceCents: number;
};

export const DESIGN_TOKEN_PACKS: readonly DesignTokenPack[] = [
  { key: "starter", tokens: 100, priceCents: 2900 },
  { key: "studio", tokens: 400, priceCents: 9900 },
];

/** Stripe Checkout metadata `kind` that marks a design-token purchase. */
export const DESIGN_TOKENS_KIND = "design_tokens";

export function findDesignTokenPack(key: unknown): DesignTokenPack | undefined {
  if (typeof key !== "string") return undefined;
  return DESIGN_TOKEN_PACKS.find((p) => p.key === key);
}
