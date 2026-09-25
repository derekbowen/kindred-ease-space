/**
 * LAUNCH FOLLOW-UPS from the 2026-09-25 browser check. Run: bun tests/launch-followups.test.ts
 *
 *  1. Settings tabs follow the sidebar's launch rule: AI Providers and API Keys
 *     were `launch: false` in the sidebar yet listed in the Settings tab strip
 *     for every customer. Domains (no sidebar entry) always shows.
 *  2. Site-wide and /login meta descriptions promised a "lead inbox", a
 *     feature that is not in this launch.
 * Offline.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_TABS, isSettingsTabVisible } from "../src/components/settings/settings-tabs";

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

console.log("\nsettings tabs in a launch build");
const launch = SETTINGS_TABS.filter((tab) => isSettingsTabVisible(tab.to, { showStubs: false })).map(
  (tab) => tab.to as string,
);
t("Workspace tab shows", launch.includes("/app/settings"));
t("Domains tab shows (no sidebar entry of its own)", launch.includes("/app/settings/domains"));
t("Sharetribe tab shows", launch.includes("/app/settings/integrations/sharetribe"));
t("AI Providers tab is hidden", !launch.includes("/app/settings/ai"), launch.join(","));
t("API Keys tab is hidden", !launch.includes("/app/settings/api-keys"), launch.join(","));
const stubs = SETTINGS_TABS.filter((tab) => isSettingsTabVisible(tab.to, { showStubs: true }));
t("?showStubs=1 reveals every tab for internal testing", stubs.length === SETTINGS_TABS.length);

const nav = read("src/components/settings/SettingsNav.tsx");
t("SettingsNav filters through isSettingsTabVisible", /SETTINGS_TABS\.filter\(\(tab\) => isSettingsTabVisible\(tab\.to, \{ showStubs \}\)\)/.test(nav));
t("SettingsNav decides showStubs after mount (no hydration mismatch)", /useState\(false\)/.test(nav) && /useEffect\(\(\) => \{\s*setShowStubs\(showStubsInUrl\(\)\);/.test(nav));
t("SettingsNav keeps no private copy of the tab list", !/const LINKS = \[/.test(nav));

console.log("\nno unlaunched feature in the site's own descriptions");
for (const file of ["src/routes/__root.tsx", "src/routes/login.tsx", "src/routes/signup.tsx", "src/routes/index.tsx"]) {
  t(`${file}: no "lead inbox"`, !/lead inbox/i.test(read(file)));
}

console.log("\none AI allowance figure on every screen");
const dash = read("src/routes/_authenticated/app.index.tsx");
const billing = read("src/routes/_authenticated/app.billing.tsx");
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
