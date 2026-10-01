// ─────────────────────────────────────────────────────────────────────────────
// Sharetribe template store — display catalog (client + server).
//
// Prices are mirrored from supabase/functions/_shared/template-catalog.ts, the
// authority template-checkout charges from. tests/template-store.test.ts fails
// if slug, name or price drift between the two.
//
// Each template's live preview is a static build served from
// public/template-previews/<slug>/ (hash-routed, so every page works as a plain
// static file). The paid download is the full source project.
// ─────────────────────────────────────────────────────────────────────────────

export type TemplateFlow = "booking-hourly" | "booking-daily" | "booking-timeslot" | "purchase";

export type StoreTemplate = {
  slug: string;
  name: string;
  tagline: string;
  niche: string;
  description: string;
  flow: TemplateFlow;
  priceCents: number;
  accent: string;
  bestFor: string[];
  highlights: string[];
};

export const TEMPLATE_FLOW_LABEL: Record<TemplateFlow, string> = {
  "booking-hourly": "Hourly booking",
  "booking-daily": "Daily booking",
  "booking-timeslot": "Time-slot booking",
  purchase: "Product purchase",
};

/** Pages every template ships with, mapped to their Sharetribe Web Template equivalents. */
export const TEMPLATE_PAGES: { name: string; sharetribe: string }[] = [
  { name: "Landing page", sharetribe: "LandingPage" },
  { name: "Search with map", sharetribe: "SearchPage" },
  { name: "Listing page + booking panel", sharetribe: "ListingPage" },
  { name: "Checkout", sharetribe: "CheckoutPage" },
  { name: "Inbox & transaction view", sharetribe: "InboxPage / TransactionPage" },
  { name: "User profile", sharetribe: "ProfilePage" },
  { name: "Create listing wizard", sharetribe: "EditListingPage" },
  { name: "Sign up / Log in", sharetribe: "AuthenticationPage" },
  { name: "Account settings", sharetribe: "ContactDetails / Password / Payouts" },
  { name: "About, Terms, Privacy", sharetribe: "CMS pages" },
];

export const STORE_TEMPLATES: StoreTemplate[] = [
  {
    slug: "poolshare",
    name: "PoolShare",
    tagline: "Rent private pools by the hour",
    niche: "Space rental",
    description:
      "A bright, aqua-toned marketplace for hourly rental of private pools and backyard spaces — the Swimply model, ready for Sharetribe.",
    flow: "booking-hourly",
    priceCents: 24900,
    accent: "#0EA5E9",
    bestFor: ["Pool rentals", "Backyards", "Sports courts", "Hot tubs"],
    highlights: [
      "Hourly time-slot booking panel with price breakdown",
      "Amenity filters: heated, hot tub, restroom, pet friendly",
      "Host earnings call-to-action and popular-cities grid",
    ],
  },
  {
    slug: "gearloop",
    name: "GearLoop",
    tagline: "Peer-to-peer outdoor gear rental",
    niche: "Equipment rental",
    description:
      "A bold, outdoorsy rental marketplace for bikes, kayaks, camping and ski gear with deposits, pickup or delivery, and damage protection.",
    flow: "booking-daily",
    priceCents: 24900,
    accent: "#16A34A",
    bestFor: ["Bikes & e-bikes", "Camping", "Cameras", "Tools"],
    highlights: [
      "Date-range calendar with a security-deposit line item",
      "Pickup or delivery choice at checkout",
      "Specs table, condition badge and a trust & insurance section",
    ],
  },
  {
    slug: "probook",
    name: "ProBook",
    tagline: "Book trusted local pros",
    niche: "Services marketplace",
    description:
      "A clean, professional services marketplace with session packages and weekly availability — trainers, tutors, cleaners, photographers.",
    flow: "booking-timeslot",
    priceCents: 29900,
    accent: "#7C3AED",
    bestFor: ["Coaches & tutors", "Home services", "Wellness", "Photographers"],
    highlights: [
      "30/60/90-minute packages with a time-slot picker",
      "Weekly availability editor for providers",
      "Credentials, portfolio gallery and a review modal",
    ],
  },
  {
    slug: "thrifted",
    name: "Thrifted",
    tagline: "Buy and sell pre-loved goods",
    niche: "Product marketplace",
    description:
      "An editorial resale marketplace for fashion, vintage furniture and collectibles, with stock, shipping and order tracking.",
    flow: "purchase",
    priceCents: 29900,
    accent: "#C2410C",
    bestFor: ["Fashion resale", "Vintage", "Collectibles", "Handmade"],
    highlights: [
      "Stock-aware Buy Now flow with shipping or local pickup",
      "Seller shop profiles, favorites and a cart drawer",
      "Order tracking, 'Mark as received' and disputes",
    ],
  },
  {
    slug: "venuely",
    name: "Venuely",
    tagline: "Book unique spaces for any event",
    niche: "Venue booking",
    description:
      "A premium dark-and-gold venue marketplace for lofts, rooftops and studios, with hourly or full-day pricing and paid add-ons.",
    flow: "booking-hourly",
    priceCents: 29900,
    accent: "#B45309",
    bestFor: ["Event venues", "Photo studios", "Meeting rooms", "Weddings"],
    highlights: [
      "Hourly or full-day pricing with minimum hours",
      "Paid add-ons: cleaning, AV, catering",
      "Capacity, size and event-type filters",
    ],
  },
];

export function getStoreTemplate(slug: string): StoreTemplate | undefined {
  return STORE_TEMPLATES.find((t) => t.slug === slug);
}

export function templatePreviewPath(slug: string): string {
  return `/template-previews/${slug}/index.html`;
}

export function formatTemplatePrice(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
