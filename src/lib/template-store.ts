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

export type TemplateFlow =
  | "booking-hourly"
  | "booking-daily"
  | "booking-timeslot"
  | "purchase"
  | "negotiation"
  | "inquiry"
  | "download";

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
  negotiation: "Quote & negotiation",
  inquiry: "Inquiry",
  download: "Digital download",
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
  {
    slug: "parkspot",
    name: "ParkSpot",
    tagline: "Rent parking spaces by the hour or day",
    niche: "Parking",
    description:
      "A navy-and-yellow parking marketplace where drivers book driveways, garages and lots by the hour or the day near stadiums, airports and downtown.",
    flow: "booking-hourly",
    priceCents: 24900,
    accent: "#0F2547",
    bestFor: ["Driveway owners", "Garages & lots", "Event parking", "Monthly commuters"],
    highlights: [
      "Hourly or daily toggle with a live price breakdown",
      "Spot specs: vehicle size, covered, EV charging, access hours",
      "Access-code card in the inbox once a booking is accepted",
    ],
  },
  {
    slug: "deskhop",
    name: "DeskHop",
    tagline: "Book desks and offices by the hour",
    niche: "Coworking",
    description:
      "An emerald coworking marketplace for hot desks, dedicated desks, private offices, meeting rooms and phone booths, booked by the hour or the day.",
    flow: "booking-hourly",
    priceCents: 24900,
    accent: "#059669",
    bestFor: ["Coworking spaces", "Offices with spare desks", "Meeting rooms", "Remote teams"],
    highlights: [
      "Seats per booking, using Sharetribe's seats feature",
      "Opening hours, amenities grid and map on every listing",
      "Door-access card in the inbox after acceptance",
    ],
  },
  {
    slug: "kitchenhub",
    name: "KitchenHub",
    tagline: "Rent commercial kitchens by the hour",
    niche: "Commercial kitchens",
    description:
      "A bold red marketplace where caterers, food trucks, bakers and meal-prep brands book licensed commercial kitchens by the hour, with storage add-ons.",
    flow: "booking-hourly",
    priceCents: 29900,
    accent: "#D23A22",
    bestFor: ["Commissary kitchens", "Caterers", "Food trucks", "Bakers & meal prep"],
    highlights: [
      "Equipment list and dry, cold and frozen storage pricing",
      "Certifications step in the listing wizard",
      "Cleaning checklist on every booking in the inbox",
    ],
  },
  {
    slug: "harborly",
    name: "Harborly",
    tagline: "Boat rentals and charters",
    niche: "Boat rentals",
    description:
      "A navy-and-coral boating marketplace for yachts, sailboats, pontoons, fishing boats and jet skis, rented bareboat or with a licensed captain.",
    flow: "booking-daily",
    priceCents: 29900,
    accent: "#0B2545",
    bestFor: ["Boat owners", "Charter captains", "Marinas", "Fishing guides"],
    highlights: [
      "Half-day or full-day trips with optional captain",
      "Captain card and boat specs on every listing",
      "Wizard steps for specs, captain and availability",
    ],
  },
  {
    slug: "campout",
    name: "CampOut",
    tagline: "Book campsites and glamping",
    niche: "Camping & glamping",
    description:
      "A forest-green outdoor marketplace for tent sites, RV pads, cabins, treehouses, farm stays and glamping, booked by the night.",
    flow: "booking-daily",
    priceCents: 24900,
    accent: "#2A5A3B",
    bestFor: ["Landowners", "Glamping hosts", "Farms", "RV parks"],
    highlights: [
      "Nightly booking with guests, vehicles and pets",
      "Site types and amenity filters on search",
      "Capacity, site type and calendar steps for hosts",
    ],
  },
  {
    slug: "gigsy",
    name: "Gigsy",
    tagline: "Get quotes from top freelancers",
    niche: "Freelance services",
    description:
      "A violet freelance marketplace where clients send a brief, freelancers reply with an offer, and work is delivered and reviewed in the inbox.",
    flow: "negotiation",
    priceCents: 29900,
    accent: "#5B35F5",
    bestFor: ["Freelance designers", "Developers", "Writers", "Video & marketing"],
    highlights: [
      "Request a quote, then offer and counter-offer (default-negotiation)",
      "Delivery and revision steps in the transaction view",
      "Portfolio and FAQ steps in the listing wizard",
    ],
  },
  {
    slug: "craftly",
    name: "Craftly",
    tagline: "Buy handmade goods from makers",
    niche: "Handmade goods",
    description:
      "A warm terracotta marketplace for handmade ceramics, jewelry, candles, textiles, woodwork and prints, with maker shops and gift guides.",
    flow: "purchase",
    priceCents: 24900,
    accent: "#B5532F",
    bestFor: ["Makers & artisans", "Craft collectives", "Gift shops", "Small brands"],
    highlights: [
      "Product variations (size, color) with their own stock",
      "Cart, shipping address and order tracking",
      "Maker shop pages and favorites",
    ],
  },
  {
    slug: "vowly",
    name: "Vowly",
    tagline: "Find your wedding vendors",
    niche: "Wedding vendors",
    description:
      "An elegant rose-and-ivory directory of wedding photographers, venues, florists, caterers, music and planners, where couples send an inquiry.",
    flow: "inquiry",
    priceCents: 24900,
    accent: "#8C4352",
    bestFor: ["Wedding photographers", "Venues", "Florists & caterers", "Planners"],
    highlights: [
      "Inquiry form with wedding date, guests and budget (default-inquiry)",
      "Packages list and portfolio lightbox",
      "Service-area and packages steps in the listing wizard",
    ],
  },
  {
    slug: "courttime",
    name: "CourtTime",
    tagline: "Book sports courts by the hour",
    niche: "Sports courts",
    description:
      "A sporty green marketplace for tennis, pickleball, padel, basketball, soccer and volleyball courts, with hourly slots and open-play sessions.",
    flow: "booking-timeslot",
    priceCents: 24900,
    accent: "#0E7C3A",
    bestFor: ["Clubs", "Schools & parks", "Private courts", "Coaches"],
    highlights: [
      "Hourly availability grid with open-play seats",
      "Invite players to a booking from the inbox",
      "Sport, surface and hours steps in the listing wizard",
    ],
  },
  {
    slug: "tutorly",
    name: "Tutorly",
    tagline: "Book 1-on-1 online tutors",
    niche: "Online tutoring",
    description:
      "A bright blue tutoring marketplace where students book 1-on-1 online lessons by subject and level, with intro videos and lesson notes.",
    flow: "booking-timeslot",
    priceCents: 24900,
    accent: "#0279BD",
    bestFor: ["Tutors", "Tutoring agencies", "Test prep", "Language teachers"],
    highlights: [
      "Weekly availability grid with lesson lengths",
      "Video-room dialog and lesson notes in the inbox",
      "Credentials and subjects steps for tutors",
    ],
  },
  {
    slug: "taskpost",
    name: "TaskPost",
    tagline: "Post a job, get offers from local pros",
    niche: "Local jobs",
    description:
      "An orange reverse marketplace: customers post a job, local pros send offers, and the customer accepts one and pays when it's done.",
    flow: "negotiation",
    priceCents: 29900,
    accent: "#C94A0C",
    bestFor: ["Handyman networks", "Cleaning & moving", "Local services", "Odd-job apps"],
    highlights: [
      "Customer-posted jobs with budget and timing (request-quote flow)",
      "Offer, counter-offer and accept in the inbox",
      "Job map and neighborhood filters",
    ],
  },
  {
    slug: "harvestly",
    name: "Harvestly",
    tagline: "Fresh produce from local farms",
    niche: "Farm-to-table",
    description:
      "A fresh green marketplace where local farms sell produce, eggs, meat and dairy for pickup or local delivery.",
    flow: "purchase",
    priceCents: 24900,
    accent: "#2F6B3A",
    bestFor: ["Farms", "Farmers' markets", "Food co-ops", "CSA programs"],
    highlights: [
      "Per-unit stock (lb, dozen, bunch) with a cart across farms",
      "Pickup-day slots and local-delivery options",
      "Farm profiles with growing-practice badges",
    ],
  },
  {
    slug: "stashly",
    name: "Stashly",
    tagline: "Rent storage space from neighbors",
    niche: "Peer-to-peer storage",
    description:
      "A teal storage marketplace where neighbors rent out garages, basements, attics and closets, with a size guide and earnings calculator.",
    flow: "booking-daily",
    priceCents: 24900,
    accent: "#1F766F",
    bestFor: ["Storage startups", "Property owners", "Garage sharing", "Local communities"],
    highlights: [
      "Size comparison from closet to full garage",
      "Move-in date booking with an inventory list at checkout",
      "Earnings calculator for hosts on the landing page",
    ],
  },
  {
    slug: "bulkly",
    name: "Bulkly",
    tagline: "Wholesale from independent brands",
    niche: "Wholesale B2B",
    description:
      "A navy-and-lime wholesale marketplace where retailers buy from independent brands with tiered case pricing and order minimums.",
    flow: "purchase",
    priceCents: 29900,
    accent: "#1A468F",
    bestFor: [
      "Wholesale platforms",
      "Independent brands",
      "Boutique retailers",
      "B2B distributors",
    ],
    highlights: [
      "Tiered pricing table by case quantity",
      "Brand minimums and per-brand order summaries",
      "Stock, shipping and pricing steps for brands",
    ],
  },
  {
    slug: "dressly",
    name: "Dressly",
    tagline: "Rent designer dresses",
    niche: "Fashion rental",
    description:
      "A chic black-and-dusty-rose fashion rental marketplace where lenders rent designer dresses for 4- or 8-day windows.",
    flow: "booking-daily",
    priceCents: 24900,
    accent: "#94585C",
    bestFor: ["Fashion rental", "Designer closets", "Bridal & occasion wear", "Boutiques"],
    highlights: [
      "Size check with measurements on every listing",
      "Rental calendar with shipping buffers",
      "Return label card in the inbox",
    ],
  },
  {
    slug: "sitterly",
    name: "Sitterly",
    tagline: "Book trusted babysitters by the hour",
    niche: "Childcare",
    description:
      "A friendly violet babysitting marketplace where parents book vetted sitters by the hour, with care types and service-area maps.",
    flow: "booking-hourly",
    priceCents: 24900,
    accent: "#7856DE",
    bestFor: ["Babysitting agencies", "Nanny networks", "Childcare startups", "Au pair services"],
    highlights: [
      "Hourly booking with number of children",
      "Emergency-contact card shared after acceptance",
      "Certifications and service-area steps for sitters",
    ],
  },
  {
    slug: "roomly",
    name: "Roomly",
    tagline: "Find rooms and flatshares",
    niche: "Flatshares",
    description:
      "A green-and-navy flatshare marketplace where renters browse rooms, meet the flatmates and send an inquiry to the landlord.",
    flow: "inquiry",
    priceCents: 24900,
    accent: "#149C6E",
    bestFor: ["Flatshare sites", "Student housing", "Co-living operators", "Landlords"],
    highlights: [
      "Inquiry with move-in date and a short intro (default-inquiry)",
      "Rent terms, bills and flatmate summary on every room",
      "Room, flat, rent and availability wizard steps",
    ],
  },
  {
    slug: "stackd",
    name: "Stackd",
    tagline: "Buy instant digital downloads",
    niche: "Digital products",
    description:
      "A bold orange marketplace for planners, e-books, photo packs, music loops and templates with instant download after checkout.",
    flow: "download",
    priceCents: 24900,
    accent: "#FF5A1F",
    bestFor: ["Digital creators", "Template shops", "Music producers", "Course creators"],
    highlights: [
      "Instant download library after checkout (default-download)",
      "Preview carousel and file-type badges",
      "Sales stats for creators",
    ],
  },
];

export function getStoreTemplate(slug: string): StoreTemplate | undefined {
  return STORE_TEMPLATES.find((t) => t.slug === slug);
}

/** A 960×720 screenshot of the template's landing page (catalog cards, og:image). */
export function templateThumbnailPath(slug: string): string {
  return `/template-thumbnails/${slug}.jpg`;
}

export function templatePreviewPath(slug: string): string {
  return `/template-previews/${slug}/index.html`;
}

export function formatTemplatePrice(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
