/**
 * NO DEVELOPER TEXT ON LAUNCH PAGES. Run: bun tests/data-export-copy.test.ts
 *
 * Data Export printed raw table names (tenant_pages, content_plan, …) beside
 * each card and "(legacy)" labels; the Pages list and editor printed the
 * stored page status ("billing_suspended"); Pages and Workspace Settings
 * showed template syntax ("/a/{slug}"); Settings promised API keys that are
 * hidden at launch. What is exported, and every table key sent to the server,
 * is unchanged. Offline: source assertions plus the pure label helper.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pageStatusLabel } from "../src/components/pages/page-status";

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
const TABLES = ["tenant_pages", "tenant_listings", "content_plan", "content_pages"];

// ---------------------------------------------------------------------------
console.log("\nData Export: customer words, same export");

const exp = read("src/routes/_authenticated/app.content.data-export.tsx");
const copyBlock = exp.slice(exp.indexOf("const TABLE_COPY"), exp.indexOf("export const Route"));
const shown = [...copyBlock.matchAll(/(title|description):\s*"([^"]*)"/g)].map((m) => m[2]);
t("four export cards are described", shown.length === 8, shown.join(" | "));
t(
  'titles are "Your pages" and "Your synced listings"',
  shown.includes("Your pages") && shown.includes("Your synced listings"),
);
t(
  "no customer-visible title or description contains a table name, an underscore or \"legacy\"",
  shown.every((s) => !TABLES.some((tb) => s.includes(tb)) && !s.includes("_") && !/legacy/i.test(s)),
  shown.join(" | "),
);
t("the raw table name is no longer rendered", !/\{table\}/.test(exp.replace(/data: \{ workspaceId, table \}/, "")));
t("no monospace table-name label", !/font-mono/.test(exp));
t(
  "the download is named in customer words",
  /a\.download = `\$\{TABLE_COPY\[table\]\.file\}-\$\{ts\}\.csv`/.test(exp) &&
    [...copyBlock.matchAll(/file: "([^"]*)"/g)].every((m) => /^[a-z-]+$/.test(m[1])),
);
t(
  'the result line counts items, not "rows"',
  !/Exported \$\{res\.rowCount\} rows/.test(exp) && /Downloaded \$\{res\.rowCount\.toLocaleString\(\)\}/.test(exp),
);
// What is exported did not change.
for (const tb of TABLES) {
  t(`still exports ${tb}`, exp.includes(`table="${tb}"`));
}
t("the server call is unchanged", /run\(\{ data: \{ workspaceId, table \} \}\)/.test(exp));
const io = read("src/lib/admin-data-io.functions.ts");
t("the export allowlist is unchanged", /EXPORT_TABLES = \[\.\.\.TABLES, "tenant_listings"\]/.test(io));

// ---------------------------------------------------------------------------
console.log("\npage status badges");

t('published → "Published"', pageStatusLabel("published") === "Published");
t('draft → "Draft"', pageStatusLabel("draft") === "Draft");
t('billing_suspended → "Paused (billing)"', pageStatusLabel("billing_suspended") === "Paused (billing)");
t('archived → "Archived"', pageStatusLabel("archived") === "Archived");
t("an unknown status loses its underscores", pageStatusLabel("some_new_state") === "Some new state");
t("an empty status reads Draft", pageStatusLabel(null) === "Draft");
const pages = read("src/routes/_authenticated/app.pages.tsx");
const editor = read("src/routes/_authenticated/app.pages.$id.edit.tsx");
t("the Pages list badge uses pageStatusLabel", /\{pageStatusLabel\(r\.status\)\}/.test(pages) && !/>\s*\{r\.status\}\s*</.test(pages));
t("the editor badge uses pageStatusLabel", /\{pageStatusLabel\(status\)\}/.test(editor) && !/>\{status\}<\/Badge>/.test(editor));

// ---------------------------------------------------------------------------
console.log("\ntemplate syntax and stale promises");

t('Pages no longer shows "/a/{slug}"', !pages.includes('/a/{"{slug}"}'));
const settings = read("src/routes/_authenticated/app.settings.tsx");
t('Workspace Settings no longer shows "/a/{slug}"', !settings.includes('/a/{"{slug}"}'));
t(
  "Workspace Settings no longer promises API keys in its subtitle",
  !/Workspace profile, integrations, and API keys\./.test(settings),
);
t("the role reads in words (Owner, not owner)", /\{roleLabel\(ctx\?\.role \?\? me\?\.memberships\?\.\[0\]\?\.role\)\}/.test(settings));
t("the editor still says where a page renders", /Renders at .*\/a\//.test(editor));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
