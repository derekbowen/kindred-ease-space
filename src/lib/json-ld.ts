/**
 * Serialise structured data for an inline <script type="application/ld+json">.
 *
 * JSON.stringify does not escape "<", so a value containing "</script>" ends
 * the script element early and the remainder is parsed as HTML. Listing titles
 * come from third-party marketplace sellers and reach the customer's own
 * verified domain, so this is the one place that difference is load-bearing.
 * Escaping "<" as < is valid JSON and inert inside a script element.
 * U+2028/U+2029 are JSON-legal but are line terminators in JavaScript source.
 */
export function safeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
