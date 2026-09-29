/**
 * Display strings shared by the templates and the page head — pure, and the
 * same on the server and in a browser (dates are formatted in UTC).
 */
import type { TemplateBranding, TemplatePage, TemplatePlace, TemplateRelatedPage } from "./types";

/** "Portland, OR" — city and region; the country only when there is no region. */
export function placeText(place: TemplatePlace | null | undefined): string | null {
  if (!place) return null;
  const parts = [place.city, place.region ?? place.country].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  return parts.length ? parts.join(", ") : null;
}

const DATE = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "September 28, 2026", or null for a missing / unparseable date. */
export function formatPageDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE.format(new Date(t)) : null;
}

/** An ISO timestamp as given, or null when it does not parse. */
export function isoOrNull(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return Number.isFinite(Date.parse(iso)) ? new Date(Date.parse(iso)).toISOString() : null;
}

/** "1 listing" / "24 listings" / "24 pool rentals". */
export function listingCountText(count: number, noun: string | null | undefined): string {
  const n = Math.max(0, Math.trunc(count));
  const word = noun && noun.trim() ? noun.trim() : n === 1 ? "listing" : "listings";
  return `${n.toLocaleString("en-US")} ${word}`;
}

/** Drop a leading level-1 heading: the page already shows its heading as the <h1>. */
export function stripLeadingH1(markdown: string | null | undefined): string {
  const text = (markdown ?? "").replace(/^\uFEFF/, "");
  const m = text.match(/^\s*#(?!#)[ \t]+[^\n]*(?:\n|$)/);
  if (!m) return text;
  return text.slice(m[0].length).replace(/^\s*\n/, "");
}

/** Markdown reduced to readable text, for descriptions. */
export function plainText(markdown: string | null | undefined): string {
  return (markdown ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~`|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** At most `max` characters, cut at a word boundary with an ellipsis. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:–—-]+$/, "")}…`;
}

/** The page's description: its meta description, else its lede, else the start of its body. */
export function pageDescription(page: TemplatePage): string {
  const direct = page.metaDescription?.trim() || page.intro?.trim();
  if (direct) return direct;
  const body = plainText(stripLeadingH1(page.bodyMarkdown));
  return body ? truncateText(body, 160) : page.h1 || page.title;
}

/** The <title>: the writer's SEO title, else the page title. */
export function pageTitleTag(page: TemplatePage): string {
  return page.seoTitle?.trim() || page.title.trim() || page.h1;
}

/** A slug-looking label ("pool_rental", "hot-tubs") as words ("Pool rental"); anything else as given. */
export function humanizeLabel(label: string | null | undefined): string | null {
  const s = label?.trim();
  if (!s) return null;
  if (/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(s)) {
    const words = s.replace(/[_-]+/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return s;
}

/** First letter upper-cased. */
export function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** The brand's name as the page states it. */
export function brandLabel(branding: TemplateBranding): string {
  return branding.name.trim() || "this marketplace";
}

/** Split related pages into a primary group (the ones matching `primary`) and the rest. */
export function splitRelated(
  related: TemplateRelatedPage[],
  primary: (r: TemplateRelatedPage) => boolean,
): [TemplateRelatedPage[], TemplateRelatedPage[]] {
  const a: TemplateRelatedPage[] = [];
  const b: TemplateRelatedPage[] = [];
  for (const r of related) (primary(r) ? a : b).push(r);
  return [a, b];
}
