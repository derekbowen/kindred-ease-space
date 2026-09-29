/**
 * LAUNCH FOLLOW-UPS from the 2026-09-25 browser check. Run: bun tests/launch-followups.test.ts
 *
 *  1. Settings tabs: AI Providers and API Keys were `launch: false` in the
 *     sidebar yet listed in the Settings tab strip for every customer. Since
 *     the MVP scope (2026-09-28) they are deferred outright: the strip is
 *     Workspace, Domains, Sharetribe and Billing for everyone, with no flag
 *     that adds a tab.
 *  2. Site-wide and /login meta descriptions promised a "lead inbox", a
 *     feature that is not in this launch.
 * Offline.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_TABS, isSettingsTabActive } from "../src/components/settings/settings-tabs";

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
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

console.log("\nsettings tabs: the same four for everyone");
const tabs = SETTINGS_TABS.map((tab) => tab.to as string);
t("Workspace tab shows", tabs.includes("/app/settings"));
t("Domains tab shows", tabs.includes("/app/settings/domains"));
t("Sharetribe tab shows", tabs.includes("/app/settings/integrations/sharetribe"));
t("Billing tab shows (it opens /app/billing)", tabs.includes("/app/billing"));
t("AI Providers tab is gone", !tabs.includes("/app/settings/ai"), tabs.join(","));
t("API Keys tab is gone", !tabs.includes("/app/settings/api-keys"), tabs.join(","));
t("exactly four tabs", tabs.length === 4, tabs.join(","));
const workspaceTab = SETTINGS_TABS[0];
t(
  "Workspace is active only on /app/settings itself; Domains on its own path and below",
  isSettingsTabActive(workspaceTab, "/app/settings") &&
    !isSettingsTabActive(workspaceTab, "/app/settings/domains") &&
    isSettingsTabActive(SETTINGS_TABS[1], "/app/settings/domains/") &&
    !isSettingsTabActive(SETTINGS_TABS[1], "/app/settings/domainsx"),
);

const nav = read("src/components/settings/SettingsNav.tsx");
t(
  "SettingsNav renders every tab: no showStubs, no founder flag, no filter",
  /SETTINGS_TABS\.map\(/.test(nav) && !/showStubs|revealLaunchHidden|useInternalAccess|\.filter\(/.test(nav),
);
t("SettingsNav keeps no private copy of the tab list", !/const LINKS = \[/.test(nav));

console.log("\nno unlaunched feature in the site's own descriptions");
for (const file of ["src/routes/__root.tsx", "src/routes/login.tsx", "src/routes/signup.tsx", "src/routes/index.tsx"]) {
  t(`${file}: no "lead inbox"`, !/lead inbox/i.test(read(file)));
}

console.log("\none AI allowance figure on every screen");
const dash = read("src/routes/_authenticated/app.index.tsx");
const billing = read("src/routes/_authenticated/app.billing.tsx");
// The AI Providers page is deferred (its route redirects to /app); its code is
// kept, still on the one allowance endpoint.
const aiPage = read("src/routes/_authenticated/app.settings.ai.tsx");
for (const [name, src, count] of [
  ["Dashboard", dash, /formatAllowanceCount\(allowance\)/],
  ["Billing", billing, /formatAiToday\(aiToday\)/],
] as const) {
  t(`${name}: reads the one allowance (useAiAllowance)`, /useAiAllowance\(workspaceId\)/.test(src));
  t(`${name}: shows pages today against the cap`, count.test(src));
  t(`${name}: no credit balance on screen`, !/aiBalance|balance\?\.balance|generation credits (available|remaining)|AI generation credits/.test(src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")));
}
t("AI page: uses the same allowance endpoint", /getAiAllowance/.test(aiPage));
const hook = read("src/components/ai/use-ai-allowance.ts");
t("allowance hook: a load failure is a plain sentence via userMessage", /setError\(userMessage\(e, AI_ALLOWANCE_LOAD_FAILED\)\)/.test(hook));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
