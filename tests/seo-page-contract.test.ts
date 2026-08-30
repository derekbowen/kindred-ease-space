/**
 * THE PUBLISHED-PAGE CONTRACT, asserted.
 *
 * The property that matters most here is the LOCKSTEP one: if the renderer
 * would ship a page with `noindex`, the publish gate must refuse it. A
 * customer must never spend a paid capacity slot on a page that cannot rank.
 *
 * Run: bun tests/seo-page-contract.test.ts
 */
import {
  validatePageContract, wouldBeNoindexed, normalizeForCompare, proseLength,
  THIN_BODY_CHARS, type PageForValidation, type ValidationContext,
} from "../src/lib/seo/page-contract";

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

const emptyCtx = (): ValidationContext => ({
  siblingTitles: new Set(), siblingDescriptions: new Set(), siblingH1s: new Set(),
});

const good = (over: Partial<PageForValidation> = {}): PageForValidation => ({
  slug: "pool-rentals-austin",
  title: "Pool Rentals in Austin, TX",
  metaDescription:
    "Browse private pools available to rent by the hour in Austin, with prices, photos and availability from local hosts.",
  h1: "Pool rentals in Austin",
  bodyMarkdown: "x".repeat(400),
  listingCount: 12,
  internalLinkCount: 5,
  ...over,
});

const codes = (p: PageForValidation, c: ValidationContext = emptyCtx()) =>
  validatePageContract(p, c).violations.map((v) => v.code);

console.log("\n=== A good page passes ===");
{
  const r = validatePageContract(good(), emptyCtx());
  t("well-formed page is publishable", r.ok, JSON.stringify(r.violations));
  t("well-formed page has no violations at all", r.violations.length === 0,
    JSON.stringify(r.violations));
}

console.log("\n=== Thin pages cannot be published (the money rule) ===");
{
  // The exact case the renderer would noindex.
  const thin = good({ listingCount: 0, bodyMarkdown: "Short intro." });
  t("renderer would noindex this page", wouldBeNoindexed(thin));
  const r = validatePageContract(thin, emptyCtx());
  t("gate BLOCKS the page the renderer would noindex", !r.ok);
  t("violation names the real consequence",
    r.violations.some((v) => v.code === "thin_would_noindex"), codes(thin).join(","));

  // Lockstep: any page the renderer noindexes must be blocked. Sweep the
  // boundary rather than trusting one example.
  let drift = 0;
  for (let len = 0; len < 400; len += 7) {
    for (const listings of [0, 1]) {
      const p = good({ listingCount: listings, bodyMarkdown: "x".repeat(len) });
      const noindexed = wouldBeNoindexed(p);
      const blocked = !validatePageContract(p, emptyCtx()).ok;
      if (noindexed && !blocked) drift++;
    }
  }
  t("NO page the renderer noindexes can slip past the gate", drift === 0, `${drift} leaks`);

  // Markdown syntax must not count as content.
  const syntaxOnly = good({ listingCount: 0, bodyMarkdown: "#### ** __ ".repeat(40) });
  t("markdown punctuation does not count as prose",
    !validatePageContract(syntaxOnly, emptyCtx()).ok, codes(syntaxOnly).join(","));

  // A page with listings and no body is fine — the listings ARE the content.
  const listingsNoBody = good({ listingCount: 24, bodyMarkdown: "" });
  t("a page carrying real inventory is publishable without body copy",
    validatePageContract(listingsNoBody, emptyCtx()).ok,
    codes(listingsNoBody).join(","));
}

console.log("\n=== Titles ===");
{
  t("missing title blocks", codes(good({ title: null })).includes("title_missing"));
  t("very short title blocks", codes(good({ title: "Austin" })).includes("title_too_short"));
  const long = good({ title: "Pool ".repeat(30) });
  t("over-long title warns but does not block", validatePageContract(long, emptyCtx()).ok);
}

console.log("\n=== Meta descriptions ===");
{
  t("missing description blocks (renderer would echo the title)",
    codes(good({ metaDescription: null })).includes("description_missing"));
  t("stub description blocks",
    codes(good({ metaDescription: "Pools in Austin." })).includes("description_too_short"));
  const echo = good({ title: "Pool Rentals in Austin TX", metaDescription: "Pool rentals in Austin, TX!" });
  t("description that merely restates the title blocks",
    codes(echo).includes("description_equals_title"), codes(echo).join(","));
  const shortish = good({ metaDescription: "x".repeat(55) });
  t("slightly short description warns but publishes",
    validatePageContract(shortish, emptyCtx()).ok);
}

console.log("\n=== Duplicates across the workspace ===");
{
  const ctx: ValidationContext = {
    siblingTitles: new Set([normalizeForCompare("Pool Rentals in Austin, TX")]),
    siblingDescriptions: new Set([normalizeForCompare("Browse private pools available to rent by the hour in Austin, with prices, photos and availability from local hosts.")]),
    siblingH1s: new Set([normalizeForCompare("Pool rentals in Austin")]),
  };
  const r = validatePageContract(good(), ctx);
  t("duplicate title blocks", r.violations.some((v) => v.code === "duplicate_title"));
  t("duplicate description blocks", r.violations.some((v) => v.code === "duplicate_description"));
  t("duplicate H1 only warns", r.violations.find((v) => v.code === "duplicate_h1")?.severity === "WARNING");
  t("a duplicate page cannot publish", !r.ok);

  // Punctuation and case must not defeat duplicate detection.
  const sneaky = good({ title: "pool rentals in austin  tx!!" });
  t("case and punctuation do not evade duplicate detection",
    validatePageContract(sneaky, ctx).violations.some((v) => v.code === "duplicate_title"));
}

console.log("\n=== Orphans ===");
{
  const firstPage = good({ internalLinkCount: 0 });
  t("the FIRST page in a workspace is not called an orphan",
    !codes(firstPage).includes("orphan_page"));

  const ctx = { ...emptyCtx(), siblingTitles: new Set(["something else"]) };
  const orphan = validatePageContract(good({ internalLinkCount: 0 }), ctx);
  t("a later unlinked page warns", orphan.violations.some((v) => v.code === "orphan_page"));
  t("orphan status does not block publishing", orphan.ok);
}

console.log("\n=== Helpers ===");
{
  t("normalizeForCompare folds case, punctuation and smart quotes",
    normalizeForCompare("Austin’s  Pools!") === normalizeForCompare("austin s pools"));
  t("proseLength discounts markdown", proseLength("# Hi\n\n**bold**") < 12);
  t("proseLength ignores link targets but keeps link text",
    proseLength("[Austin pools](https://example.com/very/long/url)") === "Austin pools".length);
  t("THIN_BODY_CHARS is the documented threshold", THIN_BODY_CHARS === 300);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) console.log("FAILED:\n  " + failed.join("\n  ") + "\n");
process.exit(fail ? 1 : 0);
