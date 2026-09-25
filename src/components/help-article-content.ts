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

/**
 * Typography for the article body. MarkdownRenderer's `prose` classes need
 * @tailwindcss/typography, which is not installed, so they do nothing: under
 * Tailwind's reset every heading, list and link rendered as plain body text.
 * These descendant rules give the markdown its structure without a new
 * dependency.
 */
export const ARTICLE_BODY_CLASS = [
  "text-base leading-7 text-foreground",
  "[&_h1]:mt-10 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:tracking-tight",
  "[&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight",
  "[&_h3]:mt-8 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold",
  "[&_p]:my-4",
  "[&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6",
  "[&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6",
  "[&_li]:my-1.5 [&_li]:pl-1",
  "[&_a]:text-orange-600 [&_a]:underline [&_a]:underline-offset-4",
  "[&_strong]:font-semibold",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-sm",
  "[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-4",
  "[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground",
  "[&_hr]:my-8 [&_hr]:border-border",
  "[&_table]:my-4 [&_table]:w-full [&_th]:border-b [&_th]:py-2 [&_th]:text-left [&_td]:border-b [&_td]:py-2",
].join(" ");

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
