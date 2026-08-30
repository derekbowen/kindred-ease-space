/**
 * THE PUBLISHED-PAGE CONTRACT.
 *
 * Every page founders.click publishes on a customer's domain is a promise:
 * it is indexable, it is distinct from their other pages, and it is worth a
 * crawl. A page that fails those tests does not just underperform — it drags
 * down the domain it sits on, because Google judges scaled content by the
 * whole set, not page by page.
 *
 * Two rules shape this file:
 *
 *   1. DETERMINISTIC. No AI judgement, no network. The same page record always
 *      produces the same verdict, so a customer can be told exactly what is
 *      wrong and exactly what to change.
 *
 *   2. NO FAKE SUCCESS. A page that would ship with `noindex`, or that
 *      duplicates a page already live, must not be reported as published. It
 *      would also consume a paid capacity slot while being incapable of
 *      ranking — the customer pays for a page that cannot work.
 *
 * BLOCKING violations stop a publish. WARNINGs are surfaced and do not.
 */

export type Severity = "BLOCKING" | "WARNING";

export type Violation = {
  code: string;
  severity: Severity;
  message: string;
  /** What the customer should actually do. Never "fix SEO". */
  fix: string;
};

export type PageForValidation = {
  slug: string;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  bodyMarkdown: string | null;
  /** Number of marketplace listings this page will render. */
  listingCount: number;
  /** Internal links to sibling pages this page will render. */
  internalLinkCount: number;
};

export type ValidationContext = {
  /** Normalized titles of the workspace's OTHER published pages. */
  siblingTitles: Set<string>;
  /** Normalized meta descriptions of the workspace's OTHER published pages. */
  siblingDescriptions: Set<string>;
  /** Normalized H1s of the workspace's OTHER published pages. */
  siblingH1s: Set<string>;
};

// Mirrors the thin-page rule in src/routes/a.$slug.tsx. Kept as an exported
// constant because the two MUST agree: if the renderer would emit noindex, the
// publish gate has to refuse, or we sell a slot for an unindexable page.
export const THIN_BODY_CHARS = 300;

export const TITLE_MIN = 10;
export const TITLE_MAX_RECOMMENDED = 60;
export const DESC_MIN = 50;
export const DESC_MIN_RECOMMENDED = 70;
export const DESC_MAX_RECOMMENDED = 160;
export const DESC_MAX = 320;

/** Case/space/punctuation-insensitive key for duplicate comparison. */
export function normalizeForCompare(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Strip markdown syntax so length reflects readable prose, not punctuation.
 *  A body of `### ## **` is not 9 characters of content. */
export function proseLength(markdown: string | null | undefined): number {
  const raw = markdown ?? "";
  const stripped = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[*_~`>|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length;
}

/**
 * Would the renderer mark this page noindex? Must stay in lockstep with
 * a.$slug.tsx. Exported so the renderer and the gate cannot drift apart
 * silently — see tests/seo-page-contract.test.ts.
 */
export function wouldBeNoindexed(page: Pick<PageForValidation, "listingCount" | "bodyMarkdown">): boolean {
  return page.listingCount === 0 && (page.bodyMarkdown ?? "").trim().length < THIN_BODY_CHARS;
}

export function validatePageContract(
  page: PageForValidation,
  ctx: ValidationContext,
): { ok: boolean; violations: Violation[] } {
  const v: Violation[] = [];
  const title = (page.title ?? "").trim();
  const desc = (page.metaDescription ?? "").trim();
  const h1 = (page.h1 ?? "").trim();

  // ---- Title ----
  if (!title) {
    v.push({
      code: "title_missing",
      severity: "BLOCKING",
      message: "The page has no title.",
      fix: "Add a title describing what someone would search for, e.g. \"Pool Rentals in Austin, TX\".",
    });
  } else if (title.length < TITLE_MIN) {
    v.push({
      code: "title_too_short",
      severity: "BLOCKING",
      message: `The title is ${title.length} characters — too short to describe a search intent.`,
      fix: `Write at least ${TITLE_MIN} characters, including the thing being offered and where.`,
    });
  } else if (title.length > TITLE_MAX_RECOMMENDED) {
    v.push({
      code: "title_long",
      severity: "WARNING",
      message: `The title is ${title.length} characters and will be truncated in search results.`,
      fix: `Trim to about ${TITLE_MAX_RECOMMENDED} characters so the whole title shows.`,
    });
  }

  // ---- Meta description ----
  //
  // BLOCKING rather than a warning, deliberately. The renderer falls back to
  // the title when the description is empty, which produces a page whose
  // description and title are identical — a duplicate signal on every page in
  // the set, and invisible to anyone reading the dashboard.
  if (!desc) {
    v.push({
      code: "description_missing",
      severity: "BLOCKING",
      message: "The page has no meta description, so search results would repeat the title instead.",
      fix: `Write ${DESC_MIN_RECOMMENDED}–${DESC_MAX_RECOMMENDED} characters saying what a visitor will find on this page.`,
    });
  } else if (desc.length < DESC_MIN) {
    v.push({
      code: "description_too_short",
      severity: "BLOCKING",
      message: `The meta description is ${desc.length} characters — too short to be useful in a search result.`,
      fix: `Write at least ${DESC_MIN_RECOMMENDED} characters.`,
    });
  } else if (desc.length < DESC_MIN_RECOMMENDED || desc.length > DESC_MAX_RECOMMENDED) {
    v.push({
      code: "description_length",
      severity: "WARNING",
      message: `The meta description is ${desc.length} characters; search results show roughly ${DESC_MIN_RECOMMENDED}–${DESC_MAX_RECOMMENDED}.`,
      fix: `Aim for ${DESC_MIN_RECOMMENDED}–${DESC_MAX_RECOMMENDED} characters.`,
    });
  }
  if (desc && normalizeForCompare(desc) === normalizeForCompare(title)) {
    v.push({
      code: "description_equals_title",
      severity: "BLOCKING",
      message: "The meta description is identical to the title.",
      fix: "Write a description that adds information the title does not already give.",
    });
  }

  // ---- Thin / unindexable ----
  //
  // This is the one that protects the customer's money. A page with no
  // listings and no real copy ships with noindex, so it can never rank — but
  // it still consumes a published-page slot they are paying for.
  if (wouldBeNoindexed(page)) {
    v.push({
      code: "thin_would_noindex",
      severity: "BLOCKING",
      message:
        "This page has no listings and almost no text, so it would publish with `noindex` and could never appear in search.",
      fix: `Either widen the page's listing filter so it shows real inventory, or write at least ${THIN_BODY_CHARS} characters of genuinely page-specific copy.`,
    });
  } else if (page.listingCount === 0 && proseLength(page.bodyMarkdown) < THIN_BODY_CHARS) {
    // Passed the raw-length check but only because of markdown syntax.
    v.push({
      code: "thin_prose",
      severity: "BLOCKING",
      message:
        "Once markdown formatting is discounted, this page has very little actual text and no listings.",
      fix: `Write at least ${THIN_BODY_CHARS} characters of prose, or point the page at inventory that exists.`,
    });
  }

  // ---- Duplicates against already-published siblings ----
  const nTitle = normalizeForCompare(title);
  if (nTitle && ctx.siblingTitles.has(nTitle)) {
    v.push({
      code: "duplicate_title",
      severity: "BLOCKING",
      message: "Another published page in this workspace already uses this title.",
      fix: "Make the title specific to this page's city, category or audience.",
    });
  }
  const nDesc = normalizeForCompare(desc);
  if (nDesc && ctx.siblingDescriptions.has(nDesc)) {
    v.push({
      code: "duplicate_description",
      severity: "BLOCKING",
      message: "Another published page in this workspace already uses this meta description.",
      fix: "Rewrite the description so it describes this page specifically.",
    });
  }
  const nH1 = normalizeForCompare(h1);
  if (nH1 && ctx.siblingH1s.has(nH1)) {
    v.push({
      code: "duplicate_h1",
      severity: "WARNING",
      message: "Another published page uses the same H1 heading.",
      fix: "Vary the heading so the two pages read as different pages.",
    });
  }

  // ---- Orphan ----
  //
  // A warning, not blocking. Relevance beats an arbitrary link count, and the
  // very first page in a workspace has nothing to link to yet — blocking it
  // would make the product impossible to start using.
  if (page.internalLinkCount === 0 && ctx.siblingTitles.size > 0) {
    v.push({
      code: "orphan_page",
      severity: "WARNING",
      message: "This page has no internal links to or from your other pages.",
      fix: "Link it from a related city or category page so crawlers can reach it without the sitemap.",
    });
  }

  return { ok: !v.some((x) => x.severity === "BLOCKING"), violations: v };
}

/** One-line summary for logs and API responses. */
export function summarizeViolations(violations: Violation[]): string {
  const blocking = violations.filter((v) => v.severity === "BLOCKING");
  if (blocking.length === 0) return "passes the published-page contract";
  return blocking.map((v) => v.message).join(" ");
}
