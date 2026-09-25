/**
 * Pure helpers for the public help article page
 * (src/routes/help.$category_.$article.tsx). Kept out of the component so the
 * rules are testable offline (tests/help-routes.test.ts).
 */

/** The article's own public path. Built from the row, never from the request. */
export function helpArticlePath(categorySlug: string, articleSlug: string): string {
  return `/help/${categorySlug}/${articleSlug}`;
}

/**
 * The page already renders the article title as its one <h1>. Most stored
 * articles also open with a markdown `# Title` line, which rendered a second
 * <h1> below the first. Drop a leading level-1 heading (and the blank lines
 * around it); everything else, including later headings, is left alone.
 */
export function stripLeadingTitle(markdown: string): string {
  const text = (markdown ?? "").replace(/^﻿/, "");
  const m = text.match(/^\s*#(?!#)[ \t]+[^\n]*(?:\n|$)/);
  if (!m) return text;
  return text.slice(m[0].length).replace(/^\s*\n/, "");
}

const HELP_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  // Fixed zone: the server renders in UTC, and a visitor's own zone would
  // print a different day near midnight — a hydration mismatch (React #418).
  timeZone: "UTC",
});

/** "Sep 25, 2026" — the same string on the server and in every browser. */
export function formatHelpDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : HELP_DATE.format(d);
}
