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
  {
    slug: "driveshare",
    name: "DriveShare",
    tagline: "Peer-to-peer car rental",
    niche: "Car rental",
    description:
      "A confident, electric-blue car-sharing marketplace in the Turo model: trips by the day, airport delivery, protection plans and check-in photos.",
    flow: "booking-daily",
    priceCents: 29900,
    accent: "#2563EB",
    bestFor: ["Car sharing", "EV rentals", "Vans & trucks", "Airport delivery"],
    highlights: [
      "Trip start/end with pickup or delivery and a protection-plan picker",
      "Driver's license verification step at checkout",
      "Check-in and check-out photos with odometer in the trip view",
    ],
  },
  {
    slug: "staybnb",
    name: "Staybnb",
    tagline: "Vacation rentals by the night",
    niche: "Vacation rentals",
    description:
      "A warm, rounded short-term rental marketplace in the Airbnb model: category bar, photo mosaic, nightly pricing with cleaning fees, and Superhost profiles.",
    flow: "booking-daily",
    priceCents: 29900,
    accent: "#E11D48",
    bestFor: ["Vacation homes", "Cabins", "City apartments", "Unique stays"],
    highlights: [
      "Where/when/who search pill and a category icon bar",
      "Five-photo mosaic, category ratings and a nightly price breakdown",
      "Eight-step host listing wizard with calendar and house rules",
    ],
  },
  {
    slug: "loanable",
    name: "Loanable",
    tagline: "Rent premium digital assets",
    niche: "Digital rentals",
    description:
      "A dark, gradient-lit marketplace for renting creative assets — presets, templates, sample packs, 3D models, fonts and courses — by the week or for life.",
    flow: "purchase",
    priceCents: 24900,
    accent: "#7C3AED",
    bestFor: ["Presets & LUTs", "Templates", "Sample packs", "Fonts & 3D"],
    highlights: [
      "7/30/90-day or lifetime license selector with seats",
      "Library with license keys, expiry countdowns and downloads",
      "Previews by asset type: audio, before/after, type tester, 3D",
    ],
  },
  {
    slug: "trackroom",
    name: "Trackroom",
    tagline: "Book recording studios by the hour",
    niche: "Studio booking",
    description:
      "A moody, magenta-lit marketplace for recording, rehearsal and podcast studios, booked by the hour with an optional engineer and paid add-ons.",
    flow: "booking-hourly",
    priceCents: 24900,
    accent: "#DB2777",
    bestFor: ["Recording studios", "Rehearsal rooms", "Podcast studios", "Engineers"],
    highlights: [
      "Hourly booking with engineer toggle and mixing/mastering add-ons",
      "Grouped gear lists, engineer credits and a waveform player",
      "File delivery for stems in the session view",
    ],
  },
  {
    slug: "flowspace",
    name: "Flowspace",
    tagline: "Book yoga classes and teachers",
    niche: "Yoga & wellness",
    description:
      "A calm, sage-green yoga marketplace where independent teachers list drop-in, private, online and retreat classes, with class packs and waitlists.",
    flow: "booking-timeslot",
    priceCents: 24900,
    accent: "#4D7C5A",
    bestFor: ["Yoga teachers", "Studios", "Online classes", "Retreats"],
    highlights: [
      "Session picker with spots left and 5- or 10-class packs",
      "Recurring schedule builder for teachers",
      "Health-waiver step at checkout and pack credits in the inbox",
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
