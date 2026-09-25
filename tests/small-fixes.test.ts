/**
 * SMALL LABEL AND HEADING FIXES. Run: bun tests/small-fixes.test.ts
 *
 *  - /login and /signup had no <h1>; they now have one each and stay noindex.
 *  - The Branding card's logo placeholder showed a fixed "W" while the
 *    sidebar showed the workspace's initial; both use workspaceInitial().
 *  - A connected domain's row said "Subdomain (seo.yourdomain.com)" — the
 *    picker's generic example — whatever its real mode and hostname; the row
 *    now describes its own mode with its own hostname.
 * Offline.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceInitial } from "../src/components/workspace-initial";
import { DOMAIN_MODE_NAME, domainModeLabel } from "../src/components/settings/domain-status";

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

// ---------------------------------------------------------------------------
console.log("\n/login and /signup headings");

for (const [rel, h1] of [
  ["src/routes/login.tsx", /<h1 className="[^"]*">Sign in<\/h1>/],
  ["src/routes/signup.tsx", /<h1 className="[^"]*">\s*\{confirmEmail \? "Check your email" : "Start your free trial"\}\s*<\/h1>/],
] as const) {
  const src = read(rel);
  t(`${rel} has exactly one <h1>`, (src.match(/<h1\b/g) ?? []).length === 1);
  t(`${rel} heading says what the page is`, h1.test(src));
  t(`${rel} is still noindex, nofollow`, src.includes('{ name: "robots", content: "noindex, nofollow" }'));
}

// ---------------------------------------------------------------------------
console.log("\nlogo placeholder initial");

t("brand name first", workspaceInitial("Pool Rental Near Me", "Acme") === "P");
t("then the workspace name (not a fixed W)", workspaceInitial("", "acme marketplace") === "A");
t("whitespace-only brand name falls through", workspaceInitial("   ", "zeta") === "Z");
t("F when nothing is set, like the sidebar", workspaceInitial(null, null) === "F");
const card = read("src/components/WorkspaceBrandingCard.tsx");
t('the card no longer hard-codes "W"', !/\|\| "W"\)/.test(card) && /\{workspaceInitial\(brandName, workspaceName\)\}/.test(card));
t("Settings passes the workspace name to the card", /workspaceName=\{ws\.name \?\? null\}/.test(read("src/routes/_authenticated/app.settings.tsx")));
t(
  "the sidebar uses the same helper",
  /\{workspaceInitial\(activeWorkspace\?\.brand_name, activeWorkspace\?\.name\)\}/.test(read("src/routes/_authenticated/app.tsx")),
);

// ---------------------------------------------------------------------------
console.log("\na domain row's mode label matches its mode");

t('full_proxy row: "Root domain · example.com/a/…"', domainModeLabel("full_proxy", "example.com") === "Root domain · example.com/a/…");
t('subdomain row: "Subdomain · seo.example.com/a/…"', domainModeLabel("subdomain", "seo.example.com") === "Subdomain · seo.example.com/a/…");
t('customer_proxy row: "My own proxy/CDN · example.com/a/…"', domainModeLabel("customer_proxy", "example.com") === "My own proxy/CDN · example.com/a/…");
t(
  "no row label ever shows the picker's generic example",
  (["full_proxy", "subdomain", "customer_proxy"] as const).every((m) => !/yourdomain\.com/.test(domainModeLabel(m, "example.com"))),
);
t("a non-subdomain mode never reads Subdomain", !/Subdomain/.test(domainModeLabel("full_proxy", "www.example.com")) && !/Subdomain/.test(domainModeLabel("customer_proxy", "example.com")));
t("an unknown mode falls back to the database default (full_proxy)", domainModeLabel(null, "example.com").startsWith(DOMAIN_MODE_NAME.full_proxy));
const domains = read("src/routes/_authenticated/app.settings.domains.tsx");
t("the row uses its own mode and hostname", /\{domainModeLabel\(d\.connection_type, d\.hostname\)\}/.test(domains) && !/\{MODE_LABEL\[d\.connection_type\]\}/.test(domains));
t("the picker keeps its examples, built from the same names", /`\$\{DOMAIN_MODE_NAME\.subdomain\} \(seo\.yourdomain\.com\)`/.test(domains));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
