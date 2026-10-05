// ─────────────────────────────────────────────────────────────────────────────
// Magic Designs by founders.click — shared (client + server) definitions.
//
// A customer picks one of the store's Sharetribe templates as a starting
// point, describes their marketplace, and gets a custom design they can
// refine with Sharetribe-aware change requests and download as a project a
// developer can drop into a Sharetribe Web Template build.
//
// Token packs mirror supabase/functions/_shared/design-tokens.ts (the price
// authority); tests/magic-designs.test.ts keeps them in sync.
// ─────────────────────────────────────────────────────────────────────────────

import { STORE_TEMPLATES } from "@/lib/template-store";

export const DESIGN_TOKEN_PACKS = [
  { key: "starter", tokens: 100, priceCents: 2900, label: "Starter" },
  { key: "studio", tokens: 400, priceCents: 9900, label: "Studio" },
] as const;

export type DesignTokenPackKey = (typeof DESIGN_TOKEN_PACKS)[number]["key"];

/** Tokens charged per action. Downloads are free. */
export const DESIGN_TOKEN_COSTS = {
  create: 20,
  change: 5,
} as const;

export const MAGIC_DESIGN_BASES = STORE_TEMPLATES.map((t) => ({
  slug: t.slug,
  name: t.name,
  tagline: t.tagline,
  niche: t.niche,
}));

// ── The brief ────────────────────────────────────────────────────────────────

/**
 * Sharetribe transaction setups the template supports out of the box: the
 * default-booking process with its four unit types, default-purchase,
 * default-inquiry and default-negotiation (Sharetribe docs: "Change
 * transaction process in Sharetribe Web Template").
 */
export const TRANSACTION_TYPES = {
  "booking-day": {
    label: "Calendar booking — by the day",
    process: "default-booking",
    unitType: "day",
  },
  "booking-night": {
    label: "Calendar booking — by the night",
    process: "default-booking",
    unitType: "night",
  },
  "booking-hour": {
    label: "Calendar booking — by the hour",
    process: "default-booking",
    unitType: "hour",
  },
  "booking-fixed": {
    label: "Calendar booking — fixed-length sessions",
    process: "default-booking",
    unitType: "fixed",
  },
  purchase: { label: "Buy products (with stock)", process: "default-purchase", unitType: "item" },
  inquiry: {
    label: "Inquiry only (no online payment)",
    process: "default-inquiry",
    unitType: "inquiry",
  },
  negotiation: {
    label: "Price negotiation (quotes and offers)",
    process: "default-negotiation",
    unitType: "offer",
  },
} as const;

export type TransactionTypeKey = keyof typeof TRANSACTION_TYPES;

export type MagicDesignBrief = {
  marketplaceName: string;
  whatIsListed: string;
  providers: string;
  customers: string;
  transactionType: TransactionTypeKey;
  /** Calendar bookings only: can several customers book the same slot? */
  multipleSeats: boolean;
  /** Sharetribe "price variations" (packages / tiers on one listing). */
  priceVariations: boolean;
  searchLayout: "map" | "grid";
  listingLayout: "carousel" | "coverPhoto";
  brandColor: string;
  vibe: string;
  /** Comma-separated listing fields; each becomes a field and a search filter. */
  listingFields: string;
  notes: string;
};

export const BRIEF_LIMITS = {
  short: 80,
  medium: 300,
  long: 1500,
} as const;

export function isBookingType(t: TransactionTypeKey): boolean {
  return t.startsWith("booking-");
}

export function parseListingFields(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);
}

// ── Sharetribe-aware change presets ─────────────────────────────────────────

/**
 * One-click changes, each phrased against what the Sharetribe Web Template
 * actually supports, so the design never drifts somewhere a developer cannot
 * follow. Free-text changes are always allowed too.
 */
export const CHANGE_PRESETS = [
  {
    key: "search-grid",
    label: "Search page: grid with filter sidebar",
    prompt:
      "Change the search page to the Sharetribe 'grid' layout (SearchPageWithGrid): a left filter column (primary filters first, then default filters, then secondary filters) and a grid of listing cards, with no map.",
  },
  {
    key: "search-map",
    label: "Search page: results + map",
    prompt:
      "Change the search page to the Sharetribe 'map' layout (SearchPageWithMap): filters above the results (1–3 primary filters as dropdowns plus a 'More filters' button), listing cards on the left and a map with price pins on the right.",
  },
  {
    key: "listing-cover",
    label: "Listing page: full-width cover photo",
    prompt:
      "Change the listing page image layout to Sharetribe's 'coverPhoto' variant: a full-width, cropped hero image at the top of the listing page.",
  },
  {
    key: "listing-carousel",
    label: "Listing page: image carousel",
    prompt:
      "Change the listing page image layout to Sharetribe's 'carousel' variant: an image carousel with thumbnails that keeps each image's original aspect ratio.",
  },
  {
    key: "price-variations",
    label: "Add price variations (packages)",
    prompt:
      "Add Sharetribe price variations: a listing can offer several named packages or tiers, each with its own price (and, for fixed bookings, its own duration). Show a package selector in the order panel and in the listing creation wizard's pricing step.",
  },
  {
    key: "seats",
    label: "Multiple seats per time slot",
    prompt:
      "Add Sharetribe 'seats' to bookings: providers set how many seats each time slot has, customers choose how many seats to book, and the order panel shows seats left.",
  },
  {
    key: "categories",
    label: "Add listing categories",
    prompt:
      "Add Sharetribe listing categories (up to three nested levels): a category picker as the first step of the listing creation wizard, a category filter at the top of the search page, and the category shown on listing cards and the listing page.",
  },
  {
    key: "user-types",
    label: "Separate provider and customer sign-up",
    prompt:
      "Add Sharetribe user types: the sign-up page asks whether the person is a provider or a customer, only providers see 'Post a new listing' in the top bar, and the profile page shows user fields relevant to each type.",
  },
  {
    key: "stock",
    label: "Show stock / quantity",
    prompt:
      "For product listings, show available stock on the listing page and let buyers choose a quantity up to the stock in the order panel; add a stock field to the listing creation wizard's pricing step.",
  },
  {
    key: "negotiation",
    label: "Request a quote instead of instant price",
    prompt:
      "Switch the transaction flow to Sharetribe's default-negotiation process: customers send a quote request with details from the listing page, providers reply with an offer, and the transaction page shows the request, offer and counter-offer steps.",
  },
  {
    key: "keyword-search",
    label: "Keyword search instead of location",
    prompt:
      "Make keyword search the main search type (Sharetribe mainSearchType 'keywords'): the top bar search field takes keywords, not a location, and the landing page hero search matches.",
  },
] as const;

export type ChangePresetKey = (typeof CHANGE_PRESETS)[number]["key"];

// ── Prompts ──────────────────────────────────────────────────────────────────

const SHARETRIBE_RULES = `Keep the structure of the Sharetribe Web Template so a developer can port it page for page:
- Pages: LandingPage, SearchPage, ListingPage (with OrderPanel), CheckoutPage, InboxPage + TransactionPage, ProfilePage, EditListingPage (multi-step wizard), AuthenticationPage, account settings (ContactDetails, Password, Payouts), and CMS pages (About, Terms, Privacy).
- Keep brand name and colors in ONE theme/brand file under src/ so they can be changed in one place, and keep all sample content as mock data under src/data/.
- Use React + Tailwind and react-router with BrowserRouter. Keep every page reachable from the top bar.`;

export function buildCreatePrompt(brief: MagicDesignBrief, baseName: string): string {
  const tx = TRANSACTION_TYPES[brief.transactionType];
  const fields = parseListingFields(brief.listingFields);
  const lines = [
    `Rework this ${baseName} marketplace template into a new, fully rebranded marketplace called "${brief.marketplaceName}". Replace every product name, copy, data and image subject; nothing of ${baseName} should remain.`,
    "",
    `What is listed: ${brief.whatIsListed}`,
    `Who lists (providers): ${brief.providers}`,
    `Who buys or books (customers): ${brief.customers}`,
    "",
    `Transaction flow: ${tx.label} — Sharetribe process "${tx.process}", unit type "${tx.unitType}". The order panel, checkout, inbox statuses and listing wizard pricing step must match this flow.`,
  ];
  if (isBookingType(brief.transactionType)) {
    lines.push(
      brief.multipleSeats
        ? "Bookings use multiple seats per time slot: customers choose a number of seats and see seats left."
        : "Bookings use one seat: once a slot is booked nobody else can book it.",
    );
  }
  if (brief.priceVariations) {
    lines.push(
      "Listings support price variations: several named packages/tiers with their own prices.",
    );
  }
  lines.push(
    `Search page layout: Sharetribe '${brief.searchLayout}' variant${brief.searchLayout === "map" ? " (results + map with price pins)" : " (filter sidebar + grid, no map)"}.`,
    `Listing page image layout: Sharetribe '${brief.listingLayout}' variant${brief.listingLayout === "coverPhoto" ? " (full-width cropped hero image)" : " (carousel with thumbnails)"}.`,
  );
  if (fields.length) {
    lines.push(
      `Listing fields (each shown on the listing page, collected in the listing wizard and offered as a search filter): ${fields.join(", ")}.`,
    );
  }
  lines.push(`Primary brand color: ${brief.brandColor}.`);
  if (brief.vibe.trim()) lines.push(`Visual style and tone: ${brief.vibe.trim()}.`);
  if (brief.notes.trim()) lines.push(`Additional requirements: ${brief.notes.trim()}`);
  lines.push("", SHARETRIBE_RULES);
  return lines.join("\n");
}

export function buildChangePrompt(change: string, presetKey?: ChangePresetKey | null): string {
  const preset = presetKey ? CHANGE_PRESETS.find((p) => p.key === presetKey) : undefined;
  const ask = [preset?.prompt, change.trim()].filter(Boolean).join("\n\nAlso: ");
  return `${ask}\n\nKeep everything else as it is. ${SHARETRIBE_RULES}`;
}

// ── Developer handoff ────────────────────────────────────────────────────────

/** SHARETRIBE_SETUP.md: the Console settings that match this design. */
export function buildSharetribeSetup(brief: MagicDesignBrief): string {
  const tx = TRANSACTION_TYPES[brief.transactionType];
  const fields = parseListingFields(brief.listingFields);
  const booking = isBookingType(brief.transactionType);
  const out = [
    `# ${brief.marketplaceName} — Sharetribe setup`,
    "",
    "This design was made to match these Sharetribe settings. Set them in Sharetribe Console",
    "(or in the Sharetribe Web Template's `src/config/` files) so the marketplace behaves the way",
    "the design shows.",
    "",
    "## Listing type (Console → Listings → Listing types)",
    "",
    `- Transaction process: **${tx.process}** (${tx.label})`,
    `- Unit type: **${tx.unitType}**`,
  ];
  if (booking) {
    out.push(`- Seats: **${brief.multipleSeats ? "multiple seats per slot" : "one seat"}**`);
  }
  out.push(`- Price variations: **${brief.priceVariations ? "enabled" : "disabled"}**`);
  out.push(
    "",
    "In code this is a `listingTypes` entry in `src/config/configListing.js`, e.g.:",
    "",
    "```js",
    "{",
    `  listingType: '${brief.transactionType}',`,
    `  label: '${tx.label.replace(/'/g, "\\'")}',`,
    "  transactionType: {",
    `    process: '${tx.process}',`,
    `    alias: '${tx.process}/release-1',`,
    `    unitType: '${tx.unitType}',`,
    "  },",
    "}",
    "```",
    "",
    "## Layout (Console → Design → Layout, or `src/config/configLayout.js`)",
    "",
    `- Search page: **${brief.searchLayout}**`,
    `- Listing page: **${brief.listingLayout}**`,
    "",
    "## Branding (Console → Design → Branding, or `src/config/configBranding.js`)",
    "",
    `- Marketplace color: **${brief.brandColor}**`,
    "- Upload your logo, favicon, app icon and social image there too.",
  );
  if (fields.length) {
    out.push(
      "",
      "## Listing fields (Console → Listings → Listing fields)",
      "",
      "Create one field per item; make select fields searchable filters.",
      "",
      ...fields.map((f) => `- ${f}`),
    );
  }
  out.push(
    "",
    "## Pages",
    "",
    "The design's pages map one to one onto the template's containers: Landing → LandingPage,",
    "Search → SearchPage, Listing → ListingPage, Checkout → CheckoutPage, Inbox → InboxPage /",
    "TransactionPage, Profile → ProfilePage, Create listing → EditListingPage, Auth →",
    "AuthenticationPage, Account → ContactDetailsPage / PasswordChangePage / StripePayoutPage.",
    "",
    "Docs: https://www.sharetribe.com/docs/template/configuration/variables/",
    "",
  );
  return out.join("\n");
}

export function formatTokenPackPrice(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}
