/**
 * THE ONE PAGE TARGET / INVENTORY FILTER.
 *
 * A generated page is about a slice of the marketplace's published inventory:
 * a place (country, region, city), a category, or both. Every step that asks
 * "which listings is this page about?" answers through this module —
 * coverage detection, duplicate prevention, AI grounding, the builder
 * preview, publish validation, the public renderer and sitemap eligibility —
 * so no two of them can disagree about what a page covers.
 *
 * Identity is exact and explicit:
 *  - every field is reduced to a comparison key (countryKeyOf, regionKeyOf,
 *    cityKeyOf, categoryKeyOf). The sync stores the listing's keys on
 *    tenant_listings (country_key, region_key, city_key, category_key); a page
 *    stores its filter in tenant_pages.listing_filter (v2 below);
 *  - a field in the filter's `scope` is matched exactly, and a null key there
 *    means "has no value": Portland with no region is not Portland, OR, and
 *    Springfield, US-IL is not Springfield, US-MO;
 *  - a field outside the scope is unconstrained (a marketplace-wide category
 *    page does not care about cities).
 *
 * Legacy (v1) filters — { city, state, category, limit, sort } written before
 * this module — keep their old meaning: each present field constrains, an
 * absent one does not (a page with no state covered the city in any state).
 */
import { z } from "zod";
import { slugify } from "@/lib/opportunity/intent";

export const PAGE_KINDS = ["city_hub", "category_page", "resource_article"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export const TARGET_FIELDS = ["country", "region", "city", "category"] as const;
export type TargetField = (typeof TARGET_FIELDS)[number];

/** The comparison keys of one listing or one target. null = no value. */
export type TargetKeys = {
  countryKey: string | null;
  regionKey: string | null;
  cityKey: string | null;
  categoryKey: string | null;
};

/** Display values that ride along with the keys (copy, prompts, titles). */
export type TargetLabels = {
  country: string | null;
  region: string | null;
  city: string | null;
  category: string | null;
};

/** Listings shown on a page, at most. */
export const PAGE_LISTING_LIMIT_DEFAULT = 24;
export const PAGE_LISTING_LIMIT_MAX = 60;
/** Fewer matching published listings than this is "insufficient inventory". */
export const MIN_LISTINGS_FOR_PAGE = 3;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Trimmed, NFKC, single-spaced display text; empty → null. */
export function cleanText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).normalize("NFKC").replace(/\s+/g, " ").trim();
  return s ? s : null;
}

/**
 * Key for text with no ASCII letter (東京, Москва, Αθήνα): NFKC, lowercase, any
 * run of characters that are not letters, marks or digits to one dash. Marks
 * are kept, not folded: in many scripts they distinguish words.
 */
function unicodeKey(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Comparison key: lowercase, accents folded, punctuation to single dashes.
 * A name the ASCII fold leaves without a single letter (a non-Latin script)
 * keys by its own letters instead — it would otherwise get no key, or a bare
 * number, and never match anything. Every ASCII-bearing key is unchanged.
 */
export function textKey(raw: unknown): string | null {
  const s = cleanText(raw);
  if (!s) return null;
  const k = slugify(s);
  if (/[a-z]/.test(k)) return k;
  const u = unicodeKey(s);
  if (/\p{L}/u.test(u)) return u;
  return k ? k : null;
}

/** FNV-1a, 32-bit, as 7 base-36 characters: a stable ASCII stand-in. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}

/** A key as a URL-safe slug part: itself when ASCII, else a stable stand-in. */
function slugPart(key: string | null | undefined): string | null {
  if (!key) return null;
  return /^[a-z0-9-]+$/.test(key) ? key : `x${shortHash(key)}`;
}

const COUNTRY_ALIASES: Record<string, string> = {
  us: "us",
  usa: "us",
  "u-s": "us",
  "u-s-a": "us",
  "united-states": "us",
  "united-states-of-america": "us",
  america: "us",
  gb: "gb",
  uk: "gb",
  "u-k": "gb",
  "united-kingdom": "gb",
  "great-britain": "gb",
  england: "gb",
  scotland: "gb",
  wales: "gb",
  "northern-ireland": "gb",
  ca: "ca",
  canada: "ca",
  au: "au",
  australia: "au",
  nz: "nz",
  "new-zealand": "nz",
  ie: "ie",
  ireland: "ie",
  de: "de",
  germany: "de",
  deutschland: "de",
  fr: "fr",
  france: "fr",
  es: "es",
  spain: "es",
  espana: "es",
  it: "it",
  italy: "it",
  italia: "it",
  nl: "nl",
  netherlands: "nl",
  "the-netherlands": "nl",
  holland: "nl",
  pt: "pt",
  portugal: "pt",
  mx: "mx",
  mexico: "mx",
  br: "br",
  brazil: "br",
  brasil: "br",
  in: "in",
  india: "in",
  za: "za",
  "south-africa": "za",
  ae: "ae",
  "united-arab-emirates": "ae",
  uae: "ae",
  sg: "sg",
  singapore: "sg",
  jp: "jp",
  japan: "jp",
  se: "se",
  sweden: "se",
  no: "no",
  norway: "no",
  dk: "dk",
  denmark: "dk",
  fi: "fi",
  finland: "fi",
  ch: "ch",
  switzerland: "ch",
  at: "at",
  austria: "at",
  be: "be",
  belgium: "be",
  pl: "pl",
  poland: "pl",
  gr: "gr",
  greece: "gr",
  tr: "tr",
  turkey: "tr",
  turkiye: "tr",
  il: "il",
  israel: "il",
  ar: "ar",
  argentina: "ar",
  cl: "cl",
  chile: "cl",
  co: "co",
  colombia: "co",
  ph: "ph",
  philippines: "ph",
  th: "th",
  thailand: "th",
  id: "id",
  indonesia: "id",
  my: "my",
  malaysia: "my",
  vn: "vn",
  vietnam: "vn",
  "viet-nam": "vn",
  kr: "kr",
  "south-korea": "kr",
  korea: "kr",
  cn: "cn",
  china: "cn",
  hk: "hk",
  "hong-kong": "hk",
  tw: "tw",
  taiwan: "tw",
};

/** Country key: ISO 3166-1 alpha-2 (lowercase) for known names and codes,
 *  otherwise the text key — never guessed. */
export function countryKeyOf(raw: unknown): string | null {
  const k = textKey(raw);
  if (!k) return null;
  return COUNTRY_ALIASES[k] ?? k;
}

const US_STATES: Record<string, string> = {
  alabama: "al",
  alaska: "ak",
  arizona: "az",
  arkansas: "ar",
  california: "ca",
  colorado: "co",
  connecticut: "ct",
  delaware: "de",
  "district-of-columbia": "dc",
  florida: "fl",
  georgia: "ga",
  hawaii: "hi",
  idaho: "id",
  illinois: "il",
  indiana: "in",
  iowa: "ia",
  kansas: "ks",
  kentucky: "ky",
  louisiana: "la",
  maine: "me",
  maryland: "md",
  massachusetts: "ma",
  michigan: "mi",
  minnesota: "mn",
  mississippi: "ms",
  missouri: "mo",
  montana: "mt",
  nebraska: "ne",
  nevada: "nv",
  "new-hampshire": "nh",
  "new-jersey": "nj",
  "new-mexico": "nm",
  "new-york": "ny",
  "north-carolina": "nc",
  "north-dakota": "nd",
  ohio: "oh",
  oklahoma: "ok",
  oregon: "or",
  pennsylvania: "pa",
  "rhode-island": "ri",
  "south-carolina": "sc",
  "south-dakota": "sd",
  tennessee: "tn",
  texas: "tx",
  utah: "ut",
  vermont: "vt",
  virginia: "va",
  washington: "wa",
  "west-virginia": "wv",
  wisconsin: "wi",
  wyoming: "wy",
  "puerto-rico": "pr",
};
const US_STATE_CODES = new Set(Object.values(US_STATES));

/** Region key. US state names fold to their postal code — but only when the
 *  country is the US or unknown (Georgia the state, not the country). */
export function regionKeyOf(raw: unknown, countryKey: string | null): string | null {
  const k = textKey(raw);
  if (!k) return null;
  if (countryKey === null || countryKey === "us") {
    if (US_STATES[k]) return US_STATES[k]!;
    if (k.length === 2 && US_STATE_CODES.has(k)) return k;
  }
  return k;
}

export const cityKeyOf = (raw: unknown): string | null => textKey(raw);
/** Category key: exact (no synonym folding) — two categories stay two. */
export const categoryKeyOf = (raw: unknown): string | null => textKey(raw);

/** The keys of one listing, from its raw public fields. */
export function listingKeys(row: {
  country?: unknown;
  state?: unknown;
  city?: unknown;
  category?: unknown;
}): TargetKeys {
  const countryKey = countryKeyOf(row.country);
  return {
    countryKey,
    regionKey: regionKeyOf(row.state, countryKey),
    cityKey: cityKeyOf(row.city),
    categoryKey: categoryKeyOf(row.category),
  };
}

// ---------------------------------------------------------------------------
// The stored filter (tenant_pages.listing_filter)
// ---------------------------------------------------------------------------

const keyField = z.string().trim().min(1).max(120).nullable();
const labelField = z.string().trim().max(160).nullable();

export const InventoryFilterV2Schema = z
  .object({
    v: z.literal(2),
    scope: z.array(z.enum(TARGET_FIELDS)).max(4),
    countryKey: keyField,
    regionKey: keyField,
    cityKey: keyField,
    categoryKey: keyField,
    country: labelField,
    region: labelField,
    city: labelField,
    category: labelField,
    limit: z.number().int().min(1).max(PAGE_LISTING_LIMIT_MAX),
    sort: z.literal("newest"),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (new Set(f.scope).size !== f.scope.length) {
      ctx.addIssue({ code: "custom", message: "scope repeats a field" });
    }
  });

export type InventoryFilterV2 = z.infer<typeof InventoryFilterV2Schema>;

/** A filter as every reader sees it, v1 or v2: which keys constrain, exactly. */
export type ResolvedFilter = {
  version: 1 | 2;
  /** Field → required key (null = must have no value). Absent = unconstrained. */
  constraints: Partial<Record<TargetField, string | null>>;
  labels: TargetLabels;
  limit: number;
};

const KEY_OF: Record<TargetField, keyof TargetKeys> = {
  country: "countryKey",
  region: "regionKey",
  city: "cityKey",
  category: "categoryKey",
};

/** Build a v2 filter from a target's keys and labels. */
export function makeFilter(
  scope: readonly TargetField[],
  keys: TargetKeys,
  labels: Partial<TargetLabels> = {},
  limit = PAGE_LISTING_LIMIT_DEFAULT,
): InventoryFilterV2 {
  const ordered = TARGET_FIELDS.filter((f) => scope.includes(f));
  return {
    v: 2,
    scope: ordered,
    countryKey: keys.countryKey,
    regionKey: keys.regionKey,
    cityKey: keys.cityKey,
    categoryKey: keys.categoryKey,
    country: cleanText(labels.country),
    region: cleanText(labels.region),
    city: cleanText(labels.city),
    category: cleanText(labels.category),
    limit: Math.min(Math.max(1, Math.floor(limit)), PAGE_LISTING_LIMIT_MAX),
    sort: "newest",
  };
}

/**
 * Read any stored listing_filter. v2 is validated strictly (an invalid v2 is
 * null — the caller refuses it rather than guessing); a legacy object is
 * mapped to its old meaning; anything else is null.
 */
export function resolveFilter(raw: unknown): ResolvedFilter | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.v === 2) {
    const r = InventoryFilterV2Schema.safeParse(obj);
    if (!r.success) return null;
    const f = r.data;
    const constraints: ResolvedFilter["constraints"] = {};
    for (const field of f.scope) constraints[field] = f[KEY_OF[field]];
    return {
      version: 2,
      constraints,
      labels: { country: f.country, region: f.region, city: f.city, category: f.category },
      limit: f.limit,
    };
  }
  if (obj.v !== undefined) return null;
  // v1: { city?, state?, category?, limit?, sort? } — each present value constrains.
  const city = cleanText(obj.city);
  const state = cleanText(obj.state);
  const category = cleanText(obj.category);
  const constraints: ResolvedFilter["constraints"] = {};
  if (city) constraints.city = cityKeyOf(city);
  if (state) constraints.region = regionKeyOf(state, null);
  if (category) constraints.category = categoryKeyOf(category);
  const limitRaw = Number(obj.limit);
  return {
    version: 1,
    constraints,
    labels: { country: null, region: state, city, category },
    limit:
      Number.isFinite(limitRaw) && limitRaw >= 1
        ? Math.min(Math.floor(limitRaw), PAGE_LISTING_LIMIT_MAX)
        : PAGE_LISTING_LIMIT_DEFAULT,
  };
}

/** Does one listing (by its keys) belong to the filter? */
export function listingMatches(keys: TargetKeys, filter: ResolvedFilter): boolean {
  for (const field of TARGET_FIELDS) {
    if (!(field in filter.constraints)) continue;
    if ((keys[KEY_OF[field]] ?? null) !== (filter.constraints[field] ?? null)) return false;
  }
  return true;
}

/** Minimal query surface of a supabase-js filter builder. */
export type FilterableQuery<Q> = {
  eq(column: string, value: string): Q;
  is(column: string, value: null): Q;
};

export const LISTING_KEY_COLUMN: Record<TargetField, string> = {
  country: "country_key",
  region: "region_key",
  city: "city_key",
  category: "category_key",
};

/**
 * Apply the filter to a tenant_listings query — the ONE translation to SQL.
 * Callers add workspace_id and state_published themselves (see
 * publishedListingsQuery in inventory.server.ts).
 */
export function applyFilter<Q extends FilterableQuery<Q>>(q: Q, filter: ResolvedFilter): Q {
  let out = q;
  for (const field of TARGET_FIELDS) {
    if (!(field in filter.constraints)) continue;
    const key = filter.constraints[field] ?? null;
    out =
      key === null
        ? out.is(LISTING_KEY_COLUMN[field], null)
        : out.eq(LISTING_KEY_COLUMN[field], key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Targets and coverage identity
// ---------------------------------------------------------------------------

/** The scope each page kind is about, for inventory targets. */
export function scopeFor(kind: PageKind, withCategory: boolean): TargetField[] {
  if (kind === "city_hub")
    return withCategory ? ["country", "region", "city", "category"] : ["country", "region", "city"];
  if (kind === "category_page") return ["category"];
  return [];
}

/**
 * The coverage identity of a page or an opportunity: its kind plus every
 * constrained field's key. Two pages with the same target key are the same
 * intended page — the unique index on tenant_pages (workspace_id,
 * target_key) for live pages is what stops a second one being generated.
 * Resource articles have no inventory identity (null): they are editorial.
 */
export function targetKey(kind: PageKind, filter: ResolvedFilter): string | null {
  if (kind === "resource_article") return null;
  const parts: string[] = [];
  for (const field of TARGET_FIELDS) {
    if (!(field in filter.constraints)) continue;
    parts.push(`${field}=${filter.constraints[field] ?? "-"}`);
  }
  if (parts.length === 0) return null;
  return `${kind}::${parts.join("|")}`;
}

/**
 * Does an existing page (kind + filter) cover a target? Same kind, and every
 * field the page constrains equals the target's key for that field, and the
 * page constrains nothing the target leaves open. A legacy (v1) page that
 * named no region covers the city in every region — the conservative old
 * rule, so an old page is never duplicated.
 */
export function pageCoversTarget(
  page: { kind: PageKind; filter: ResolvedFilter },
  target: { kind: PageKind; filter: ResolvedFilter },
): boolean {
  if (page.kind !== target.kind || page.kind === "resource_article") return false;
  const pc = page.filter.constraints;
  const tc = target.filter.constraints;
  if (Object.keys(pc).length === 0) return false;
  for (const field of TARGET_FIELDS) {
    const inPage = field in pc;
    const inTarget = field in tc;
    if (inPage) {
      if (!inTarget) return false; // the page is narrower than the target
      if ((pc[field] ?? null) !== (tc[field] ?? null)) return false;
    } else if (inTarget) {
      // The page leaves a field open that the target pins. Only a legacy
      // page's missing region/country is read as "any" (the old rule).
      if (page.filter.version !== 1 || (field !== "region" && field !== "country")) return false;
    }
  }
  return true;
}

/** "Austin, TX, US" — for titles and copy; unknown parts are left out. */
export function placeLabel(labels: Pick<TargetLabels, "city" | "region" | "country">): string {
  return [labels.city, labels.region, labels.country].filter(Boolean).join(", ");
}

/** A slug that carries the target's identity, so different regions of the
 *  same city name never collide into slug-2 (austin-tx vs austin-mn). */
export function slugForTarget(kind: PageKind, labels: TargetLabels, keys: TargetKeys): string {
  // A non-Latin key (textKey) becomes a stable ASCII stand-in: public slugs
  // are ASCII, and dropping the part would merge different places.
  const cat = slugPart(keys.categoryKey) ?? "";
  if (kind === "category_page") return slugify([cat].filter(Boolean).join("-"));
  const place = [
    slugPart(keys.cityKey),
    slugPart(keys.regionKey),
    keys.countryKey && keys.countryKey !== "us" ? slugPart(keys.countryKey) : null,
  ]
    .filter(Boolean)
    .join("-");
  return slugify([cat, place].filter(Boolean).join("-")) || slugify(placeLabel(labels));
}
