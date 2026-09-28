/**
 * THE MODEL PICKER AND THE FOUNDER / INTERNAL UNLIMITED SCREENS.
 * Run: bun tests/founder-ui.test.ts
 *
 *  1. The AI model picker lists only what getAvailableAiModels returns
 *     (OpenAI, grouped under its provider), selects the default — or the
 *     only option — by itself, offers nothing when AI is not configured or
 *     paused, and sends only a tier the server accepts. No page keeps a model
 *     list of its own, and no Gemini (or any other retired) label survives.
 *  2. The founder / internal unlimited account, and only it, reads "Founder /
 *     Internal Unlimited · No usage limits · Internal account": no trial
 *     card, no plans or checkout on Billing, no page-limit bar, no daily-cap
 *     number, the unlaunched tools visible — all from the server-computed
 *     flags. A normal customer's wording and sidebar are unchanged.
 * Offline.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { availableModelsFor, type AvailableAiModels } from "../src/lib/ai-models.functions";
import { modelOptions, pickModelTier, qualityForRequest } from "../src/components/ai/model-choice";
import { NAV_SECTIONS, isNavItemVisible, type NavItem } from "../src/lib/app-nav";
import { SETTINGS_TABS, isSettingsTabVisible } from "../src/components/settings/settings-tabs";
import {
  describePlanStatus,
  INTERNAL_PLAN_LABEL,
  INTERNAL_STATUS_LINE,
} from "../src/components/billing/plan-status";
import { allowanceSentence, formatAllowanceCount } from "../src/components/ai/use-ai-allowance";
import { INTERNAL_UNLIMITED_PLAN_LABEL } from "../src/lib/billing-capacity";
import type { AiAllowance } from "../src/lib/ai-allowance.functions";

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
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
console.log("\nthe picker's choices come only from the server's contract");

const platform = availableModelsFor({ byokConfigured: false, platformConfigured: true, platformEnabled: true });
const byok = availableModelsFor({ byokConfigured: true, platformConfigured: false, platformEnabled: false });
const none = availableModelsFor({ byokConfigured: false, platformConfigured: false, platformEnabled: true });
const paused = availableModelsFor({ byokConfigured: false, platformConfigured: true, platformEnabled: false });

t("platform key: state ok, one provider (OpenAI)", platform.state === "ok" && platform.providers.length === 1 && platform.providers[0]!.label === "OpenAI");
t(
  "every provider the server can list is OpenAI (nothing invented)",
  [platform, byok].every((a) => a.providers.every((p) => p.provider === "openai")),
);
const labels = modelOptions(platform).map((o) => o.label);
t("options name the real models", labels.join("|") === "GPT-5 nano (Standard)|GPT-5 mini (Premium)", labels.join("|"));
t("no Gemini / OpenRouter / Lovable label in any option", !/gemini|openrouter|lovable|google\//i.test(JSON.stringify([platform, byok])));
t("the default (Standard) is selected on first load", pickModelTier(platform, "") === "standard");
t("a still-offered choice is kept", pickModelTier(platform, "premium") === "premium");
t("a stale choice (a retired model string) is replaced by the default", pickModelTier(platform, "google/gemini-3.1-pro-preview") === "standard");
const single: AvailableAiModels = {
  state: "ok",
  providers: [{ ...platform.providers[0]!, models: platform.providers[0]!.models.filter((m) => m.tier === "premium").map((m) => ({ ...m, isDefault: false })) }],
};
t("exactly one option: it is selected automatically", pickModelTier(single, "") === "premium");
t("not configured: nothing selectable, Generate stays disabled", pickModelTier(none, "standard") === "" && modelOptions(none).length === 0);
t("not configured: says what to set up and where", none.state === "none_configured" && /AI Providers/.test(none.message ?? "") && none.settingsPath === "/app/settings/ai");
t("platform paused: nothing selectable", pickModelTier(paused, "standard") === "" && paused.state === "platform_paused");
t("still loading: nothing selectable", pickModelTier(undefined, "") === "" && pickModelTier(null, "premium") === "");
t("byok: the provider says whose key", byok.providers[0]!.source === "byok");
t("the request field is only ever one of the server's two tiers", qualityForRequest("premium") === "premium" && qualityForRequest("standard") === "standard" && qualityForRequest("google/gemini-3.1-pro-preview") === "standard" && qualityForRequest("") === "standard");

// ---------------------------------------------------------------------------
console.log("\nthe picker renders the server's answer, and nothing else");

async function renderPicker(data: AvailableAiModels, value: string): Promise<string> {
  const { AiModelSelect } = await import("../src/components/ai/AiModelSelect");
  const client = new QueryClient();
  client.setQueryData(["ai-models", "ws-1"], data);
  // Inside a real (memory) router, as in the app: the notice's <Link> needs one.
  const rootRoute = createRootRoute({
    component: () =>
      createElement(
        QueryClientProvider,
        { client },
        createElement(AiModelSelect, { workspaceId: "ws-1", value, onChange: () => {} }),
      ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  try {
    await router.load();
    return renderToStaticMarkup(createElement(RouterProvider, { router }));
  } catch (e) {
    return `RENDER FAILED: ${(e as Error).message}`;
  }
}
const noneHtml = await renderPicker(none, "");
t("not configured: the sentence renders", noneHtml.includes("isn&#x27;t set up for this workspace yet") || noneHtml.includes("isn't set up for this workspace yet"), noneHtml.slice(0, 300));
t("not configured: links Settings → AI Providers", /href="\/app\/settings\/ai"/.test(noneHtml), noneHtml.slice(0, 300));
t("not configured: no model is offered", !/GPT-5|Gemini/.test(noneHtml));
const pausedHtml = await renderPicker(paused, "");
t("paused: the platform sentence renders, no model offered", !pausedHtml.startsWith("RENDER FAILED") && !/GPT-5/.test(pausedHtml), pausedHtml.slice(0, 300));
const okHtml = await renderPicker(platform, "standard");
t("ok: renders a picker labelled AI model", !okHtml.startsWith("RENDER FAILED") && okHtml.includes("AI model"), okHtml.slice(0, 300));
t("ok: the chosen option's hint shows", okHtml.includes("Fast and economical"), okHtml.slice(0, 400));

// ---------------------------------------------------------------------------
console.log("\nno page keeps a model list of its own");

const qpb = read("src/routes/_authenticated/app.content.quick-page-builder.tsx");
const gen = read("src/routes/_authenticated/app.content.generate.tsx");
const picker = read("src/components/ai/AiModelSelect.tsx");
for (const [name, src] of [
  ["Quick Page Builder", qpb],
  ["Generate Content", gen],
] as const) {
  t(`${name}: uses the shared picker`, /<AiModelSelect\b/.test(src));
  t(`${name}: sends the tier through qualityForRequest`, /quality: qualityForRequest\(quality\)/.test(src));
  t(`${name}: no hard-coded model or provider string`, !/gemini|gpt-5|openai|google\/|anthropic|claude-/i.test(src));
  t(`${name}: no <SelectItem> list of its own`, !/<SelectItem\b/.test(src));
}
t("the picker reads getAvailableAiModels", /getAvailableAiModels/.test(picker));
t("the picker hard-codes no model or provider name", !/gemini|gpt-5|"openai"|OpenAI|google\/|anthropic/i.test(picker));
t("the picker groups options under their provider", /<SelectGroup\b/.test(picker) && /<SelectLabel>/.test(picker));
const uiFiles = [...walk(join(ROOT, "src/routes")), ...walk(join(ROOT, "src/components"))];
const gemini = uiFiles.filter((f) => /gemini/i.test(readFileSync(f, "utf8")));
t("no Gemini anywhere in the app's routes or components", gemini.length === 0, gemini.join(", "));

// ---------------------------------------------------------------------------
console.log("\nfounder reveal: the unlaunched tools, never a stub, never an ops tool");

const items: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);
const customer = { showStubs: false, isInternal: false };
const founder = { showStubs: false, isInternal: false, revealLaunchHidden: true };
const byTo = (to: string) => items.find((i) => i.to === to)!;
const visibleTo = (opts: Parameters<typeof isNavItemVisible>[1]) => items.filter((i) => isNavItemVisible(i, opts)).map((i) => i.to);
const cust = visibleTo(customer);
const fnd = visibleTo(founder);
t("a customer still sees only launch items", items.filter((i) => isNavItemVisible(i, customer)).every((i) => i.launch && !i.stub));
t("revealLaunchHidden:false is exactly the customer view", visibleTo({ ...customer, revealLaunchHidden: false }).join() === cust.join());
for (const to of [
  "/app/seo/keyword-opportunities",
  "/app/seo/competitor-tracker",
  "/app/seo/internal-links",
  "/app/seo/link-checker",
  "/app/seo/missing-pages",
  "/app/seo/gsc-import",
  "/app/content/data-import",
  "/app/settings/ai",
  "/app/settings/api-keys",
]) {
  t(`founder sees ${to}; a customer does not`, fnd.includes(to) && !cust.includes(to) && !byTo(to).stub);
}
t("founder never sees a stub", items.filter((i) => isNavItemVisible(i, founder)).every((i) => !i.stub));
t("founder reveal never shows an internalOnly ops tool", items.filter((i) => isNavItemVisible(i, founder)).every((i) => !i.internalOnly));
t("the Coach (a static notice) is not revealed", !fnd.includes("/app/coach"));
t("every launch item a customer sees, the founder sees too", cust.every((to) => fnd.includes(to)));
const tabsFounder = SETTINGS_TABS.filter((tab) => isSettingsTabVisible(tab.to, { showStubs: false, revealLaunchHidden: true })).map((x) => x.to as string);
const tabsCustomer = SETTINGS_TABS.filter((tab) => isSettingsTabVisible(tab.to, { showStubs: false })).map((x) => x.to as string);
t("Settings: the founder sees AI Providers and API Keys", tabsFounder.includes("/app/settings/ai") && tabsFounder.includes("/app/settings/api-keys"));
t("Settings: a customer still does not", !tabsCustomer.includes("/app/settings/ai") && !tabsCustomer.includes("/app/settings/api-keys"));

const shell = read("src/routes/_authenticated/app.tsx");
t("the shell reveals only from the server's flag", /const revealLaunchHidden = beta\?\.revealLaunchHiddenFeatures === true;/.test(shell) && /isNavItemVisible\(i, \{ showStubs, isInternal, revealLaunchHidden \}\)/.test(shell));
t("the shell never compares an email", !/@gmail|derekbowen|\.email ===|email\)\s*===/.test(shell));
const hook = read("src/components/billing/use-internal-access.ts");
t("SettingsNav's flag is the server's (getBetaStatus), not a guess", /getBetaStatus/.test(hook) && /data\?\.revealLaunchHiddenFeatures === true/.test(hook));

// ---------------------------------------------------------------------------
console.log("\nplan wording: internal only from the server's flag");

const NOW = Date.parse("2026-09-25T12:00:00Z");
const UTC = { now: NOW, timeZone: "UTC" };
const expiredTrial = { subscriptionStatus: "trialing", trialEndsAt: "2026-07-03T23:36:15Z", planKey: "starter" };
const internalStatus = describePlanStatus({ ...expiredTrial, internalUnlimited: true }, UTC);
t("the label is the server's (one constant)", INTERNAL_PLAN_LABEL === INTERNAL_UNLIMITED_PLAN_LABEL && INTERNAL_PLAN_LABEL === "Founder / Internal Unlimited");
t("internal: plan label and badge", internalStatus.kind === "internal" && internalStatus.planLabel === "Founder / Internal Unlimited" && internalStatus.badge === "Founder / Internal Unlimited");
t("internal: says no usage limits, internal account", internalStatus.statusLine === "No usage limits · Internal account" && INTERNAL_STATUS_LINE === internalStatus.statusLine);
t("internal: no trial headline, countdown or date", internalStatus.trialHeadline === null && internalStatus.daysLeft === null && internalStatus.dateLine === null);
t("internal wins over an expired trial (the founder's real state)", describePlanStatus(expiredTrial, UTC).kind === "trial_ended" && internalStatus.kind === "internal");
t("billingState 'internal' reads internal too", describePlanStatus({ ...expiredTrial, billingState: "internal" }, UTC).kind === "internal");
t("internalUnlimited:false changes nothing", JSON.stringify(describePlanStatus({ ...expiredTrial, internalUnlimited: false }, UTC)) === JSON.stringify(describePlanStatus(expiredTrial, UTC)));
const runningTrial = { subscriptionStatus: "trialing", trialEndsAt: "2026-10-01T00:00:00Z", planKey: "starter" };
t("a normal running trial still counts down", describePlanStatus(runningTrial, UTC).kind === "trial" && describePlanStatus(runningTrial, UTC).daysLeft === 6);
t("a normal paid plan still reads its plan", describePlanStatus({ subscriptionStatus: "active", trialEndsAt: null, planKey: "growth" }, UTC).badge === "Growth");

// ---------------------------------------------------------------------------
console.log("\nthe AI figure: no sentinel number for the internal account");

const base = { generationsUsedToday: 7, generationPaused: false, summary: "AI features are ready to use for this workspace.", state: "ok" as const };
const internalAllowance = { ...base, dailyCap: 2_147_483_647, internalUnlimited: true, planLabel: INTERNAL_PLAN_LABEL, revealLaunchHiddenFeatures: true, generationSummary: "No daily limit on AI-generated pages for this internal account. 7 generated in the last 24 hours." } as AiAllowance;
const normalAllowance = { ...base, dailyCap: 50, internalUnlimited: false, planLabel: null, revealLaunchHiddenFeatures: false, generationSummary: "7 of 50 AI-generated pages used in the last 24 hours." } as AiAllowance;
t("internal: '7 / Unlimited'", formatAllowanceCount(internalAllowance) === "7 / Unlimited");
t("internal: never prints 2,147,483,647", !formatAllowanceCount(internalAllowance).includes("2,147"));
t("normal: '7 / 50' as before", formatAllowanceCount(normalAllowance) === "7 / 50");
t("internal ok: says there's no daily limit", allowanceSentence(internalAllowance).startsWith("No daily limit"));
t("internal but paused: the pause is said as is", allowanceSentence({ ...internalAllowance, state: "platform_paused", summary: "AI is paused" }) === "AI is paused");
t("normal: the state sentence as before", allowanceSentence(normalAllowance) === normalAllowance.summary);

// ---------------------------------------------------------------------------
console.log("\nBilling & Plans for the internal account");

const billing = read("src/routes/_authenticated/app.billing.tsx");
t("internal comes only from the server's entitlement", /const internal = Boolean\(ent && \(ent\.internalUnlimited \|\| ent\.billingState === "internal"\)\);/.test(billing));
t("no plan grid for the internal account", /\{!internal && \(\s*<div>\s*<h2 className="text-lg font-semibold mb-1">Plans<\/h2>/.test(billing));
t("no 'what costs money' card for the internal account", /\{!internal && \(\s*<Card>[\s\S]{0,400}What's free, what costs money/.test(billing));
t("no Manage billing button for the internal account", /\{!internal && \(\s*<Button[\s\S]{0,200}onClick=\{openPortal\}/.test(billing));
t("no 'Upgrade below' line for the internal account", /\{!internal && \([\s\S]{0,200}Need more pages\? Upgrade below\./.test(billing));
t("hasPlan is false for the internal account (no extra-capacity checkout)", /const hasPlan = Boolean\(ent && !internal && !ent\.isTrial && ent\.planKey\);/.test(billing));
t("the internal card names the entitlement", /\{internal && \([\s\S]{0,200}INTERNAL_PLAN_LABEL[\s\S]{0,120}INTERNAL_STATUS_LINE/.test(billing));
t("no page-limit number for the internal account", /No page limit/.test(billing));
t("Billing never compares an email", !/@gmail|derekbowen|email ===/.test(billing));
const dash = read("src/routes/_authenticated/app.index.tsx");
t("Dashboard: the internal card comes before the beta/trial cards", /planStatus\.kind === "internal" \? \([\s\S]{0,600}\) : beta\?\.beta \?/.test(dash));
t("Dashboard: the flag is the server's", /internalUnlimited: beta\?\.internalUnlimited === true,/.test(dash));

// ---------------------------------------------------------------------------
console.log("\nadd-ons: included for the internal account, checkout for everyone else");

const addonsSrv = read("src/lib/addons.functions.ts");
const addonsUi = read("src/routes/_authenticated/app.addons.tsx");
const affSrv = read("src/lib/affiliates.functions.ts");
t("getAddons reads the entitlement on the server", /const internalUnlimited = await isInternalUnlimitedOrFalse\(data\.workspaceId\);/.test(addonsSrv));
t("only self-serve add-ons are 'included'", /includedInternal: internalUnlimited && a\.fulfilment === "self_serve"/.test(addonsSrv));
t("the Add-ons page shows 'Included' instead of a price and checkout", /included \? \(\s*<Button disabled[\s\S]{0,120}Included with your internal account/.test(addonsUi));
t("a customer still gets the price and the checkout", /onClick=\{\(\) => checkout\(a\.key\)\}/.test(addonsUi));
t("the affiliate dashboard is active for the internal account (server-side read)", /status: internal \? "active" : \(settings\.addon_status as string\)/.test(affSrv));
t("no program limit for the internal account (server-side, from assertAddon)", /internal_unlimited === true\s*\? Number\.POSITIVE_INFINITY/.test(affSrv));
t("a customer's program limit is unchanged", /: \(PROGRAM_LIMIT\[settings\.addon_tier \?\? "lite"\] \?\? 1\)/.test(affSrv));

const gen2 = gen;
t("Generate Content: no sentinel daily cap printed for the internal account", /overview\.internalUnlimited \? \(/.test(gen2) && /No daily page limit/.test(gen2));
const domains = read("src/routes/_authenticated/app.settings.domains.tsx");
t("Domains: no sentinel domain count printed", /domainLimit >= INTERNAL_UNLIMITED_COUNT/.test(domains));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
