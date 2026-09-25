/**
 * HELP ARTICLES RENDER. Run: bun tests/help-routes.test.ts
 *
 * /help/<category>/<article> used to be a CHILD of /help/$category in
 * TanStack's file routing. The category component renders no <Outlet/>, so
 * every article URL showed the category page with only the article's <title>
 * (and two canonicals: the category's and the article's). The article route
 * is now non-nested (`help.$category_.$article.tsx`): its parent is the /help
 * layout, which does render an <Outlet/>.
 *
 * Offline: parses the generated route tree and the route sources.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatHelpDate,
  helpArticlePath,
  stripLeadingTitle,
} from "../src/components/help-article-content";

let pass = 0,
  fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failed.push(name);
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const collapse = (s: string) => s.replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
console.log("\nrouteTree.gen.ts: the article route hangs off the /help layout");

const tree = read("src/routeTree.gen.ts");

/** The `.update({...})` block for one generated route constant. */
function updateBlock(constName: string): string {
  const at = tree.indexOf(`const ${constName} = `);
  if (at < 0) return "";
  return tree.slice(at, tree.indexOf("} as any)", at));
}

// Which generated constant imports the article file?
const importLine = tree
  .split("\n")
  .find((l) => /from '\.\/routes\/help\.\$category_?\.\$article'/.test(l));
const articleImport = importLine?.match(/import \{ Route as (\w+)RouteImport \}/)?.[1] ?? "";
t(
  "the article route is generated from help.$category_.$article.tsx (non-nested file name)",
  !!importLine && importLine.includes("./routes/help.$category_.$article'"),
  importLine ?? "no import",
);
const articleBlock = updateBlock(`${articleImport}Route`);
const parent = articleBlock.match(/getParentRoute: \(\) => (\w+)/)?.[1];
t("the article route has a generated update block", articleBlock.length > 0, articleImport);
t("its parent is the /help layout (HelpRoute)", parent === "HelpRoute", `parent=${parent}`);
t("its parent is NOT /help/$category", parent !== "HelpCategoryRoute", `parent=${parent}`);
t(
  "its path under /help is /$category/$article",
  /path: '\/\$category\/\$article'/.test(articleBlock),
  articleBlock,
);
t(
  "the public full path is unchanged: /help/$category/$article",
  new RegExp(`'/help/\\$category/\\$article': typeof ${articleImport}Route\\b`).test(tree),
);
const byPath = tree.slice(tree.indexOf("'/help/$category_/$article': {"));
t(
  "FileRoutesByPath declares parentRoute: typeof HelpRoute",
  /'\/help\/\$category_\/\$article': \{[^}]*parentRoute: typeof HelpRoute\s*\n/.test(byPath),
);
t(
  "the category route has no children any more",
  !/HelpCategoryRouteWithChildren/.test(tree),
);
t(
  "/help's children include the article route",
  new RegExp(`interface HelpRouteChildren \\{[^}]*${articleImport}Route:`).test(tree),
);

// ---------------------------------------------------------------------------
console.log("\nroute files");

t("the nested file is gone", !existsSync(join(ROOT, "src/routes/help.$category.$article.tsx")));
const nestedUnderCategory = readdirSync(join(ROOT, "src/routes")).filter(
  (f) => f.startsWith("help.$category.") && f !== "help.$category.tsx",
);
t(
  "nothing else is nested under help.$category (it renders no <Outlet/>)",
  nestedUnderCategory.length === 0,
  nestedUnderCategory.join(", "),
);
t("the /help layout renders an <Outlet />", /<Outlet \/>/.test(read("src/routes/help.tsx")));

const article = read("src/routes/help.$category_.$article.tsx");
const head = article.slice(article.indexOf("head:"), article.indexOf("component: ArticlePage"));
t(
  'createFileRoute id is "/help/$category_/$article"',
  article.includes('createFileRoute("/help/$category_/$article")'),
);
t(
  "canonical and og:url are the article's own URL, built from the row",
  /const url = canonicalUrl\(helpArticlePath\(a\.category_slug, a\.slug\)\)/.test(head) &&
    /\{ rel: "canonical", href: url \}/.test(head) &&
    /\{ property: "og:url", content: url \}/.test(head),
);
t("head no longer builds URLs from request params", !/params\./.test(head));
t(
  "exactly one canonical link in the article head",
  (head.match(/rel: "canonical"/g) ?? []).length === 1,
);
t(
  "the article title is the page's <h1>",
  /<h1[^>]*>\{article\.title\}<\/h1>/.test(collapse(article)),
);
t(
  "the markdown's own leading # title is dropped (one <h1> per page)",
  article.includes("<MarkdownRenderer content={stripLeadingTitle(article.content)} />"),
);
t(
  "the Updated date is formatted in a fixed zone (no server/client mismatch)",
  article.includes("formatHelpDate(article.updated_at)") && !/toLocaleDateString/.test(article),
);
t(
  "a missing article says so and is noindex",
  /Article not found — founders\.click Help/.test(head) && /content: "noindex"/.test(head),
);

// ---------------------------------------------------------------------------
console.log("\nhelpers");

t(
  "helpArticlePath",
  helpArticlePath("start-here", "welcome-to-founders-click") ===
    "/help/start-here/welcome-to-founders-click",
);
t(
  "stripLeadingTitle drops a leading # heading",
  stripLeadingTitle("# Title\n\nBody text.\n\n## Section") === "Body text.\n\n## Section",
  JSON.stringify(stripLeadingTitle("# Title\n\nBody text.\n\n## Section")),
);
t(
  "stripLeadingTitle tolerates leading blank lines",
  stripLeadingTitle("\n\n# Title\nBody") === "Body",
  JSON.stringify(stripLeadingTitle("\n\n# Title\nBody")),
);
t("stripLeadingTitle keeps a leading ## heading", stripLeadingTitle("## Sub\nBody") === "## Sub\nBody");
t("stripLeadingTitle keeps text with no heading", stripLeadingTitle("Just text") === "Just text");
t(
  "stripLeadingTitle keeps a later # heading",
  stripLeadingTitle("Intro\n\n# Later") === "Intro\n\n# Later",
);
t("stripLeadingTitle handles empty input", stripLeadingTitle("") === "");
t(
  "formatHelpDate prints the UTC day, whatever the host zone",
  formatHelpDate("2026-09-24T23:30:00.000Z") === "Sep 24, 2026" &&
    formatHelpDate("2026-09-25T00:30:00.000Z") === "Sep 25, 2026",
  `${formatHelpDate("2026-09-24T23:30:00.000Z")} / ${formatHelpDate("2026-09-25T00:30:00.000Z")}`,
);
t("formatHelpDate is empty for junk", formatHelpDate("not a date") === "" && formatHelpDate(null) === "");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
