/**
 * HELP CENTER CLAIMS FIX (migration 20260925000910). Run: bun tests/help-claims-migration.test.ts
 * Static checks over the SQL text: platform rows only, guarded rewrites, a verbatim rollback, and
 * facts that match the code (plan sizes from src/lib/plan-catalog.ts). Offline.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PAGE_PLANS as PLANS } from "../src/lib/plan-catalog";

let pass = 0,
  fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}
const ROOT = join(import.meta.dir, "..");
const mig = readFileSync(join(ROOT, "supabase/migrations/20260925000910_help_center_claims_fix.sql"), "utf8");
const rb = readFileSync(join(ROOT, "supabase/rollback/20260925000910_help_center_claims_fix_rollback.sql"), "utf8");
const readme = readFileSync(join(ROOT, "supabase/rollback/README.md"), "utf8");

// Every write statement (UPDATE/INSERT/DELETE up to its terminating semicolon) must be platform-scoped.
function writes(sql: string): string[] {
  const stripped = sql.replace(/\$md\$[\s\S]*?\$md\$/g, "'…'").replace(/--[^\n]*/g, "");
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => /^(UPDATE|INSERT|DELETE)\b/i.test(s));
}
for (const [label, sql] of [["migration", mig], ["rollback", rb]] as const) {
  const ws = writes(sql);
  t(`${label}: has write statements`, ws.length > 0, String(ws.length));
  t(`${label}: every write is scoped to workspace_id IS NULL`, ws.every((s) => /workspace_id IS NULL/i.test(s)), ws.find((s) => !/workspace_id IS NULL/i.test(s))?.slice(0, 80) ?? "");
  t(`${label}: no DELETE and no INSERT`, ws.every((s) => /^UPDATE\b/i.test(s)));
  t(`${label}: no statement names a workspace id`, !/workspace_id\s*=\s*'/i.test(sql));
}

// Content rewrites are guarded by the exact old text, and the rollback carries the old text verbatim.
const rewrites = ["understanding-page-limits", "submitting-your-sitemap", "handling-multiple-marketplaces", "creating-your-first-seo-page"];
const blocks = (sql: string) => sql.split(/;\s*\n/);
for (const slug of rewrites) {
  const m = blocks(mig).find((b) => b.includes(`slug = '${slug}'`)) ?? "";
  const r = blocks(rb).find((b) => b.includes(`slug = '${slug}'`)) ?? "";
  const md = (s: string) => [...s.matchAll(/\$md\$([\s\S]*?)\$md\$/g)].map((x) => x[1]);
  const [mNew, mOld] = md(m);
  const [rOld, rNew] = md(r);
  t(`${slug}: migration sets new text only while the old text is present`, Boolean(mNew && mOld) && /AND content = \$md\$/.test(m));
  t(`${slug}: rollback restores the migration's old text verbatim`, rOld === mOld, "");
  t(`${slug}: rollback applies only while the migration's text is present`, rNew === mNew);
}

// Facts match the code.
const pages = mig.match(/\| (\w+) \| \$(\d+)\/month \| ([\d,]+) \|/g) ?? [];
t("page limits table lists every plan in the catalog", pages.length === PLANS.length, `${pages.length} vs ${PLANS.length}`);
for (const plan of PLANS) {
  const row = new RegExp(`\\| ${plan.name} \\| \\$${plan.monthlyPrice}/month \\| ${plan.includedPages.toLocaleString("en-US").replace(/,/g, ",")} \\|`);
  t(`page limits: ${plan.name} $${plan.monthlyPrice} ${plan.includedPages} pages`, row.test(mig));
}
t("sitemap article points at /a/sitemap.xml", /https:\/\/your-domain\.com\/a\/sitemap\.xml/.test(mig));
t("multiple-marketplaces article says one per workspace", /connects to \*\*one\*\* Sharetribe marketplace/.test(mig));
t("first-page article uses the Quick Page Builder's real button", /\*\*Generate & publish\*\*/.test(mig));

// Unpublished articles and the emptied category.
for (const slug of ["mapping-custom-fields-to-page-variables", "using-the-matrix-builder", "writing-seo-content-with-ai", "understanding-page-templates"]) {
  t(`${slug}: unpublished by the migration, republished by the rollback`, mig.includes(`'${slug}'`) && rb.includes(`'${slug}'`));
}
t("page-builder category unpublished only when no published platform article remains", /slug = 'page-builder'[\s\S]*NOT EXISTS[\s\S]*a\.is_published/.test(mig));
t("rollback README documents 000910", /## 20260925000910/.test(readme) && readme.includes("20260925000910_help_center_claims_fix_rollback.sql"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
