// ─────────────────────────────────────────────────────────────────────────────
// Sharetribe template store — the price authority.
//
// template-checkout charges what THIS file says, never a price sent by the
// browser. src/lib/template-store.ts mirrors slug, name and price for display;
// tests/template-store.test.ts fails if the two disagree.
//
// A template is only sellable once its zip is uploaded to the private
// `template-downloads` bucket as `<slug>.zip` (Admin → Template store).
// ─────────────────────────────────────────────────────────────────────────────

export type TemplateProduct = {
  slug: string;
  name: string;
  priceCents: number;
};

export const TEMPLATE_PRODUCTS: readonly TemplateProduct[] = [
  { slug: "poolshare", name: "PoolShare", priceCents: 24900 },
  { slug: "gearloop", name: "GearLoop", priceCents: 24900 },
  { slug: "probook", name: "ProBook", priceCents: 29900 },
  { slug: "thrifted", name: "Thrifted", priceCents: 29900 },
  { slug: "venuely", name: "Venuely", priceCents: 29900 },
  { slug: "driveshare", name: "DriveShare", priceCents: 29900 },
  { slug: "staybnb", name: "Staybnb", priceCents: 29900 },
  { slug: "loanable", name: "Loanable", priceCents: 24900 },
  { slug: "trackroom", name: "Trackroom", priceCents: 24900 },
  { slug: "flowspace", name: "Flowspace", priceCents: 24900 },
  { slug: "parkspot", name: "ParkSpot", priceCents: 24900 },
  { slug: "deskhop", name: "DeskHop", priceCents: 24900 },
  { slug: "kitchenhub", name: "KitchenHub", priceCents: 29900 },
  { slug: "harborly", name: "Harborly", priceCents: 29900 },
  { slug: "campout", name: "CampOut", priceCents: 24900 },
  { slug: "gigsy", name: "Gigsy", priceCents: 29900 },
  { slug: "craftly", name: "Craftly", priceCents: 24900 },
  { slug: "vowly", name: "Vowly", priceCents: 24900 },
  { slug: "courttime", name: "CourtTime", priceCents: 24900 },
  { slug: "tutorly", name: "Tutorly", priceCents: 24900 },
  { slug: "taskpost", name: "TaskPost", priceCents: 29900 },
  { slug: "harvestly", name: "Harvestly", priceCents: 24900 },
  { slug: "stashly", name: "Stashly", priceCents: 24900 },
  { slug: "bulkly", name: "Bulkly", priceCents: 29900 },
  { slug: "dressly", name: "Dressly", priceCents: 24900 },
  { slug: "sitterly", name: "Sitterly", priceCents: 24900 },
  { slug: "roomly", name: "Roomly", priceCents: 24900 },
  { slug: "stackd", name: "Stackd", priceCents: 24900 },
];

export const TEMPLATE_BUCKET = "template-downloads";

/** Stripe Checkout metadata `kind` that marks a template sale (not SaaS billing). */
export const TEMPLATE_PURCHASE_KIND = "template_purchase";

export function findTemplateProduct(slug: unknown): TemplateProduct | undefined {
  if (typeof slug !== "string") return undefined;
  return TEMPLATE_PRODUCTS.find((t) => t.slug === slug);
}

export function templateZipPath(slug: string): string {
  return `${slug}.zip`;
}
