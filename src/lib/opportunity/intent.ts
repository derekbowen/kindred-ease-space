/**
 * SEARCH INTENT — an explicit first-class concept.
 *
 * Cannibalization cannot be decided by comparing slugs, and in V1 it cannot be
 * decided by embeddings either (pgvector comes later). An intent is a
 * normalized (category, geography) pair plus the query evidence that points at
 * it, and two intents collide when they mean the same thing regardless of how
 * they are worded.
 *
 * The canonical failure this must prevent:
 *     pool-rentals-riverside
 *     rent-a-private-pool-riverside
 * Different slugs, low token overlap, SAME INTENT. Both must never be
 * recommended. The normalized (category, geo) pair catches it deterministically.
 */

export type IntentCluster = {
  intentKey: string;
  label: string;
  categoryKey: string;
  geoKey: string;
  city: string;
  state: string;
  queryVariants: string[];
  rankingUrls: string[];
};

// NOTE: "hire", "book" and "rent" are deliberately NOT stopwords — they are
// the verbs that define marketplace intent and they fold into synonym families
// below. Treating them as noise made "pool hire" reduce to just "pool".
const STOPWORDS = new Set([
  "a", "an", "the", "in", "on", "at", "for", "to", "of", "and", "or", "near",
  "me", "my", "your", "best", "top", "cheap", "affordable", "local", "with",
  "by", "from", "get", "find",
]);

/** Qualifiers that narrow an intent without changing it. "private pool rental"
 *  and "pool rental" are the same search intent; the modifier must not make
 *  them look like different categories. */
const MODIFIERS = new Set([
  "private", "luxury", "budget", "small", "large", "outdoor", "indoor",
  "heated", "family", "kid", "pet", "friendly", "daily", "hourly", "weekend",
  "monthly", "short", "long", "term", "instant", "same", "day",
]);

/** Verb/noun families that mean the same thing for marketplace intent.
 *  Each family maps to a single canonical token. */
const SYNONYM_FAMILIES: Record<string, string[]> = {
  rental: ["rental", "rentals", "rent", "renting", "renter", "lease", "leasing", "hire"],
  booking: ["booking", "bookings", "book", "reserve", "reservation", "reservations"],
  pool: ["pool", "pools", "swimming"],
  house: ["house", "houses", "home", "homes"],
  car: ["car", "cars", "vehicle", "vehicles", "auto"],
  boat: ["boat", "boats", "yacht", "yachts", "vessel"],
  camera: ["camera", "cameras", "photography", "photo"],
  bike: ["bike", "bikes", "bicycle", "bicycles", "cycling"],
  venue: ["venue", "venues", "space", "spaces", "hall"],
  equipment: ["equipment", "gear", "tools", "kit"],
  service: ["service", "services", "servicing"],
  cleaning: ["cleaning", "cleaner", "cleaners", "clean"],
  storage: ["storage", "store", "storing"],
  parking: ["parking", "park"],
  tutor: ["tutor", "tutors", "tutoring", "lesson", "lessons"],
};

const SYNONYM_LOOKUP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [canonical, variants] of Object.entries(SYNONYM_FAMILIES)) {
    for (const v of variants) m[v] = canonical;
  }
  return m;
})();

const US_STATE_ABBR: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca",
  colorado: "co", connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
  kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md",
  massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms",
  missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv",
  "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny",
  "north carolina": "nc", "north dakota": "nd", ohio: "oh", oklahoma: "ok",
  oregon: "or", pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc",
  "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
  virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi",
  wyoming: "wy",
};

export function slugify(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Reduce a phrase to its meaning-bearing canonical tokens, sorted so word
 *  order cannot create a false distinction. */
export function canonicalTokens(text: string): string[] {
  const raw = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (const t of raw) {
    if (STOPWORDS.has(t)) continue;
    // crude but effective plural stemming before synonym lookup
    const stem = t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t;
    out.add(SYNONYM_LOOKUP[t] ?? SYNONYM_LOOKUP[stem] ?? stem);
  }
  return [...out].sort();
}

export function normalizeState(state: string | null | undefined): string {
  const s = (state || "").trim().toLowerCase();
  if (!s) return "";
  if (s.length === 2) return s;
  return US_STATE_ABBR[s] ?? slugify(s);
}

export function normalizeGeo(city: string | null | undefined, state?: string | null): string {
  const c = slugify(city || "");
  if (!c) return "";
  const st = normalizeState(state);
  return st ? `${c}-${st}` : c;
}

/** Category key from free text — synonym-folded so "pool rentals" and
 *  "rent a private pool" both reduce to "pool|rental". */
export function normalizeCategory(text: string | null | undefined): string {
  const toks = canonicalTokens(text || "").filter((t) => !/^\d+$/.test(t));
  return toks.join("|");
}

export function buildIntentKey(categoryKey: string, geoKey: string): string {
  return `${categoryKey || "general"}::${geoKey || "any"}`;
}

/** Strip geography tokens out of a phrase so the remainder is the category. */
export function categoryFromPhrase(phrase: string, city?: string | null, state?: string | null): string {
  const geoTokens = new Set([
    ...canonicalTokens(city || ""),
    ...canonicalTokens(state || ""),
    normalizeState(state),
  ].filter(Boolean));
  const toks = canonicalTokens(phrase).filter((t) => !geoTokens.has(t));
  return toks.join("|");
}

/** Strip qualifiers so only the meaning-defining tokens remain. */
export function coreCategoryTokens(categoryKey: string): string[] {
  return (categoryKey || "")
    .split("|")
    .filter((t) => t && !MODIFIERS.has(t))
    .sort();
}

/** 1.0 when the smaller category is entirely inside the larger — i.e. the same
 *  intent, one of them merely narrower. */
export function categoryContainment(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const [small, large] = a.length <= b.length ? [a, b] : [b, a];
  const set = new Set(large);
  let hit = 0;
  for (const t of small) if (set.has(t)) hit++;
  return hit / small.length;
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export type CollisionResult = {
  /** 0..1 — how confident we are these are the same search intent */
  similarity: number;
  /** true when this should block a new page */
  collides: boolean;
  reasons: string[];
};

export type ComparableIntent = {
  categoryKey: string;
  geoKey: string;
  titleTokens: string[];
  queries?: string[];
  rankingUrls?: string[];
};

/**
 * Multi-signal intent collision. Deliberately NOT slug comparison.
 *
 * The dominant rule: identical normalized category AND geography is a
 * collision, full stop — that is what catches differently-worded duplicates.
 * The remaining signals raise confidence and catch partial overlaps.
 */
export function detectCollision(a: ComparableIntent, b: ComparableIntent): CollisionResult {
  const reasons: string[] = [];
  let score = 0;

  const sameGeo = Boolean(a.geoKey) && a.geoKey === b.geoKey;

  // Category comparison uses CONTAINMENT, not Jaccard. "pool|rental" fully
  // inside "pool|private|rental" is the same intent with a qualifier — Jaccard
  // would score that 0.67 and let a near-duplicate through.
  const coreA = coreCategoryTokens(a.categoryKey);
  const coreB = coreCategoryTokens(b.categoryKey);
  const sameCat = coreA.length > 0 && coreA.join("|") === coreB.join("|");
  const containment = categoryContainment(coreA, coreB);

  if (sameGeo && (sameCat || containment >= 0.999)) {
    reasons.push(`same location (${a.geoKey}) and same category`);
    score = 0.95;
  } else {
    if (sameGeo) {
      score += 0.35;
      reasons.push(`same location (${a.geoKey})`);
    }
    if (containment > 0) {
      score += containment * 0.4;
      if (containment >= 0.5) reasons.push("closely related category");
    }
  }

  const titleSim = jaccard(a.titleTokens, b.titleTokens);
  if (titleSim >= 0.6) {
    score += 0.12;
    reasons.push("near-identical wording");
  }

  // GSC query overlap is the strongest real-world evidence of cannibalization:
  // two pages competing for the same queries IS the definition.
  const qOverlap = jaccard(a.queries ?? [], b.queries ?? []);
  if (qOverlap >= 0.6) {
    score = Math.max(score, 0.9);
    reasons.push(`${Math.round(qOverlap * 100)}% of search queries overlap`);
  } else if (qOverlap >= 0.3) {
    score += 0.15;
    reasons.push("some search queries overlap");
  }

  const urlOverlap = jaccard(a.rankingUrls ?? [], b.rankingUrls ?? []);
  if (urlOverlap > 0) {
    score += 0.1;
    reasons.push("the same page already ranks for these searches");
  }

  const similarity = Math.min(1, score);
  return { similarity, collides: similarity >= 0.75, reasons };
}

export function titleForIntent(categoryKey: string, city: string, state: string): string {
  const words = (categoryKey || "").split("|").filter(Boolean);
  const pretty = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const place = [city, (state || "").toUpperCase()].filter(Boolean).join(", ");
  if (!pretty) return place ? `Listings in ${place}` : "Listings";
  return place ? `${pretty} in ${place}` : pretty;
}

export function slugForIntent(categoryKey: string, city: string, state: string): string {
  return slugify([categoryKey.replace(/\|/g, "-"), city, state].filter(Boolean).join("-"));
}
