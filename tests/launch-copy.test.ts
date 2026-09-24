/**
 * LAUNCH SCOPE AND PUBLIC CLAIMS. Run: bun tests/launch-copy.test.ts
 *
 * The sidebar, the homepage and the beta page all make promises. This suite
 * pins the ones that were wrong at the launch audit so they cannot quietly
 * come back: a stub advertised as a feature, a stub shown in the launch nav,
 * a support ticket that reaches nobody, an editor pointing at the wrong
 * public path, and the independence statement going missing.
 *
 * Offline: it reads source files and the nav catalog, nothing else.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_SECTIONS, isNavItemVisible } from "../src/lib/app-nav";
import { PAGE_PLANS, PAGE_ADDON } from "../src/lib/plan-catalog";

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

const items = NAV_SECTIONS.flatMap((s) => s.items.map((i) => ({ ...i, section: s.label })));
const byLabel = (label: string) => items.find((i) => i.label === label);

// ---------------------------------------------------------------------------
console.log("\nnav: launch items are real");

for (const i of items.filter((i) => i.launch)) {
  t(`launch item "${i.label}" is not a stub`, !i.stub);
}
t(
  "at least one launch item exists",
  items.some((i) => i.launch),
);

const gen = byLabel("Generate Content");
t("Generate Content is a launch item", Boolean(gen?.launch));
t("Generate Content is not a stub", Boolean(gen) && !gen!.stub);

for (const label of [
  "Dashboard",
  "Pages",
  "Quick Page Builder",
  "Data Export",
  "Billing & Plans",
  "Workspace Settings",
  "Sharetribe",
  "Help & feedback",
  "Add-ons",
]) {
  const i = byLabel(label);
  t(`"${label}" is a launch item`, Boolean(i?.launch), i ? "" : "(missing)");
}
t("Help & feedback points at the contact form", byLabel("Help & feedback")?.to === "/help/contact");
t(
  "Affiliates live under the Add-ons section",
  byLabel("Affiliate Dashboard")?.section === "Add-ons",
);

for (const label of [
  "Coach",
  "SEO Coach",
  "AI Providers",
  "API Keys",
  "Lead Inbox",
  "Competitor Radar",
]) {
  const i = byLabel(label);
  t(`"${label}" is not a launch item`, Boolean(i) && !i!.launch, i ? "" : "(missing)");
}
t(
  "no SEO tool is a launch item for customers",
  items.filter((i) => i.section === "SEO" && !i.internalOnly).every((i) => !i.launch),
);
t(
  "no customer-facing ops item is a launch item",
  items.filter((i) => i.section === "Users & Ops" && !i.internalOnly).every((i) => !i.launch),
);

// ---------------------------------------------------------------------------
console.log("\nnav: the shell's visibility rule");

const customer = { showStubs: false, isInternal: false };
const visible = items.filter((i) => isNavItemVisible(i, customer));
t(
  "customers see only launch items",
  visible.every((i) => i.launch),
);
t(
  "customers never see a stub",
  visible.every((i) => !i.stub),
);
t(
  "customers never see an internal tool",
  visible.every((i) => !i.internalOnly),
);
t(
  "customers see Generate Content",
  visible.some((i) => i.label === "Generate Content"),
);
t("customers do not see Coach", !visible.some((i) => i.label === "Coach"));
t(
  "?showStubs=1 reveals hidden and stubbed routes",
  items.filter((i) => isNavItemVisible(i, { ...customer, showStubs: true })).length >
    visible.length,
);
t(
  "?showStubs=1 still hides internal tools from customers",
  items
    .filter((i) => isNavItemVisible(i, { ...customer, showStubs: true }))
    .every((i) => !i.internalOnly),
);

// ---------------------------------------------------------------------------
console.log("\nhomepage: no stub is advertised");

const home = read("src/routes/index.tsx");
t('homepage does not mention "Lead Inbox"', !home.includes("Lead Inbox"));
t('homepage does not mention "lead inbox"', !/lead inbox/i.test(home));
t('homepage does not mention "Competitor Radar"', !/competitor radar/i.test(home));
const stubLabels = items.filter((i) => i.stub).map((i) => i.label);
for (const label of stubLabels) {
  t(`homepage does not advertise stub "${label}"`, !home.includes(label));
}
t("homepage keeps pricing", home.includes("PAGE_PLANS") && home.includes('id="pricing"'));
t("homepage keeps the trial line", home.includes("14-day free trial"));
t(
  "homepage mentions the free beta and links /beta",
  /free beta/i.test(home) && home.includes('to="/beta"'),
);

// ---------------------------------------------------------------------------
console.log("\nindependence statement");

const INDEPENDENCE =
  "founders.click is an independent product and is not affiliated with or endorsed by";
const collapse = (s: string) => s.replace(/\s+/g, " ");
t(
  "SiteFooter carries the independence sentence",
  collapse(read("src/components/site/SiteFooter.tsx")).includes(INDEPENDENCE),
);
t(
  "/beta carries the independence sentence",
  collapse(read("src/routes/beta.tsx")).includes(INDEPENDENCE),
);
t("homepage hero carries the independence sentence", collapse(home).includes(INDEPENDENCE));
t("SiteFooter links /beta", read("src/components/site/SiteFooter.tsx").includes('to="/beta"'));

// ---------------------------------------------------------------------------
console.log("\nbeta page");

const beta = read("src/routes/beta.tsx");
t("/beta is indexable", beta.includes('"index, follow"'));
t("/beta lists plans from the catalog", beta.includes("PAGE_PLANS.map"));
t("/beta says pages pause and drafts are kept", /pause/i.test(beta) && /drafts/i.test(beta));
t(
  "/beta explains the Marketplace API client ID is read-only public data",
  /read-only/i.test(beta) && /public/i.test(beta),
);
t(
  "/beta says the Integration API secret is optional and encrypted",
  /Integration API secret/.test(beta) && /encrypted/i.test(beta),
);
t("/beta gives the deletion path", beta.includes("support@founders.click"));
t("/beta makes no ranking promise", /no promise about rankings/i.test(collapse(beta)));
t("/beta links the contact form", beta.includes('to="/help/contact"'));

// ---------------------------------------------------------------------------
console.log("\nsupport path");

const help = read("src/lib/help.server.ts");
const ticketFn = help.slice(help.indexOf("export async function submitTicket"));
t("submitTicket exists", help.includes("export async function submitTicket"));
t("submitTicket notifies SUPPORT_INBOX_EMAIL", ticketFn.includes("to: SUPPORT_INBOX_EMAIL"));
t(
  "inbox notification is keyed ticket-<id>",
  ticketFn.includes("idempotencyKey: `ticket-${ticketId}`"),
);
t(
  "inbox notification carries the category, requester and message",
  /Category:/.test(ticketFn) && /From:/.test(ticketFn) && ticketFn.includes("params.message"),
);
t(
  "email failure cannot fail the ticket",
  ticketFn.includes("Promise.allSettled") && ticketFn.includes("catch (e)"),
);
const helpFns = read("src/lib/help.functions.ts");
t("support tickets stay rate limited", /rateLimit\("support-ticket"/.test(helpFns));

// ---------------------------------------------------------------------------
console.log("\neditor copy");

const editor = read("src/routes/_authenticated/app.pages.$id.edit.tsx");
t('editor no longer says "/p/"', !editor.includes("/p/"));
t('editor says "Renders at /a/"', /Renders at .*\/a\//.test(editor));

// ---------------------------------------------------------------------------
console.log("\ndashboard and shell honesty");

const dash = read("src/routes/_authenticated/app.index.tsx");
t("dashboard has a beta card", /Free beta/.test(dash));
t(
  "dashboard trial copy says pages pause and drafts are kept",
  /pages pause/.test(dash) && /drafts are/.test(dash),
);
t("dashboard no longer links the click-report stub", !dash.includes("/app/seo/click-report"));
const shell = read("src/routes/_authenticated/app.tsx");
t("shell uses the shared visibility rule", shell.includes("isNavItemVisible"));
t("shell shows the beta banner", /Free beta/.test(shell) && shell.includes('to="/beta"'));

// ---------------------------------------------------------------------------
console.log("\npreview links stay inside the preview");

const cityHub = read("src/components/templates/CityHub.tsx");
t("CityHub related links use basePath, not a hardcoded /a/", cityHub.includes("`${basePath}/${r.slug}`") && !cityHub.includes("`/a/${r.slug}`"));
t("CityHub defaults basePath to /a for tenant hosts", /basePath = "\/a"/.test(cityHub));
t("CityHub can render the breadcrumb root as plain text", /homeHref \? \(/.test(cityHub));
const preview = read("src/routes/s.$ws.$slug.tsx");
t("preview passes /s/{ws} as basePath", preview.includes("basePath={`/s/${ws}`}"));
t("preview has no workspace home link on the platform host", preview.includes("homeHref={null}"));

// ---------------------------------------------------------------------------
console.log("\nrelease path and welcome email honesty");

const wf = read(".github/workflows/deploy-app.yml");
t("deploy job only runs on main", /if: github\.ref == 'refs\/heads\/main'/.test(wf));
const wsFns = read("src/lib/workspace.functions.ts");
t("every welcome email replies to the support inbox", (wsFns.match(/replyTo: SUPPORT_INBOX_EMAIL/g) || []).length === (wsFns.match(/idempotencyKey: `welcome-/g) || []).length && (wsFns.match(/replyTo: SUPPORT_INBOX_EMAIL/g) || []).length >= 1);
const emailSrv = read("src/lib/email.server.ts");
t("welcome email no longer promises a 30-minute sync", !/every 30 min/.test(emailSrv));

// ---------------------------------------------------------------------------
console.log("\nreview follow-ups: copy matches code");

const dataExport = read("src/routes/_authenticated/app.content.data-export.tsx");
t("Data Export offers the live page model", dataExport.includes('table="tenant_pages"'));
t("Data Export offers the imported listings", dataExport.includes('table="tenant_listings"'));
const dataIo = read("src/lib/admin-data-io.functions.ts");
t("export allowlist includes tenant_listings", /EXPORT_TABLES = \[\.\.\.TABLES, "tenant_listings"\]/.test(dataIo));
t("import allowlist did not widen to listings", /const TABLES = \["content_plan", "content_pages", "tenant_pages"\] as const;/.test(dataIo));

const billing = read("src/routes/_authenticated/app.billing.tsx");
const betaPage = read("src/routes/beta.tsx");
const homeSrc = read("src/routes/index.tsx");
t("billing discloses add-ons as separately priced", /add-ons \(Affiliate Programs, DM Champ\) are priced separately/i.test(billing));
t("/beta discloses add-ons as separately priced", /<strong>Add-ons<\/strong>/.test(betaPage) && /priced separately/.test(betaPage));
t("billing discloses the daily generation cap", billing.includes("GENERATION_DAILY_CAP") && /fair-use cap/.test(billing));
t("/beta discloses the daily generation cap", betaPage.includes("GENERATION_DAILY_CAP") && /fair-use cap/.test(betaPage));
t("no page still promises a monthly AI allowance on the beta", !/metered by a monthly\s+allowance/.test(billing) && !/metered by a monthly allowance/.test(betaPage));
t("homepage no longer claims every feature", !homeSrc.includes("Every feature unlocked") && homeSrc.includes("Every core feature unlocked"));
t("homepage FAQ no longer claims audits are included", !/rewrites and audits/.test(homeSrc));
t("/beta no longer promises a notice we do not send", !/We will tell you before a beta grant ends/.test(betaPage));
t("/beta says the grant end date is shown in the app", /end date is shown on your dashboard/.test(betaPage));
t('"Free beta" on billing requires the grant to be the entitlement', /inBeta = Boolean\(beta\?\.beta && ent && ent\.billingState === "granted"\)/.test(billing));
const ent = read("src/lib/entitlements.functions.ts");
t("readBetaStatus consults the billing state", /decision\.state !== "granted"\) return none/.test(ent));

console.log("\nreview follow-ups: public path is /a/, stubs are unreachable");
for (const f of [
  "src/components/pages/PageLivePreview.tsx",
  "src/routes/_authenticated/app.settings.tsx",
  "src/routes/_authenticated/app.pages.tsx",
  "src/routes/_authenticated/app.pages.bulk.tsx",
  "src/routes/_authenticated/app.content.migration.tsx",
]) {
  t(`${f} does not advertise /p/`, !/\/p\/\{|\/p\/\$\{|\/p\/slug|\/p\/\{"/.test(read(f)));
}
const stub = read("src/components/StubToolPage.tsx");
t("stub pages send customers to the dashboard", /navigate\(\{ to: "\/app", replace: true \}\)/.test(stub) && /showStubs/.test(stub));
const settings = read("src/routes/_authenticated/app.settings.tsx");
t("settings hides the AI-provider and API-key cards at launch", /showAdvanced &&/.test(settings) && settings.indexOf("const showAdvanced") < settings.indexOf('title="AI providers"'));
const deployDoc = read("docs/DEPLOYMENT.md");
t("deploy doc's secret loop skips section headers", /\^\\\[/.test(deployDoc));

// ---------------------------------------------------------------------------
console.log("\nadversarial review: allowance, add-on, cap and catalog claims");

// C3 — nothing resets monthly: the trial seeds credits once, beta tenants are
// unmetered, paid plans receive additive grants on invoice.paid. The FAQ
// answer is also emitted into the FAQPage JSON-LD, so search engines quoted
// the same claim.
const faqAt = homeSrc.indexOf('question: "Is AI generation extra?"');
const faqAnswer = faqAt > 0 ? homeSrc.slice(faqAt, homeSrc.indexOf("},", faqAt)) : "";
t('homepage FAQ "Is AI generation extra?" exists', faqAt > 0);
t("FAQ answer claims no monthly allowance", faqAnswer.length > 0 && !/monthly|allowance|this month/i.test(faqAnswer), faqAnswer);
t("FAQ answer quotes the fair-use cap as the current value", /fair-use cap \(currently \$\{GENERATION_DAILY_CAP\} generated pages per workspace per day\)/.test(faqAnswer));
t("FAQ answer still says you buy published pages, not generation", /You buy published pages, not generation/.test(faqAnswer));
t("homepage imports the cap it quotes", /import \{ GENERATION_DAILY_CAP \} from "@\/lib\/generation-limits";/.test(homeSrc));

const aiCardAt = billing.indexOf("<CardTitle>AI generation</CardTitle>");
const aiCard = aiCardAt > 0 ? billing.slice(aiCardAt, billing.indexOf("</Card>", aiCardAt)) : "";
t("billing AI generation card exists", aiCardAt > 0);
t('billing AI card never says "this month", "monthly" or "allowance"', aiCard.length > 0 && !/this month|monthly|allowance/i.test(aiCard), aiCard);
t('billing AI card shows the balance as "generation credits available"', aiCard.includes("generation credits available"));
t("billing AI card tells a beta tenant generation is in the grant, not a credit count", /inBeta \? "Included in your beta grant"/.test(aiCard) && /inBeta \? \(/.test(aiCard) && /part of your beta grant/.test(aiCard));
t("billing AI card quotes the fair-use cap as the current value", /fair-use cap \(currently\{" "\}\s*\{GENERATION_DAILY_CAP\}/.test(aiCard));

// C4 — nothing sends a grant-end notice, so the dashboard must not promise one.
t("dashboard beta card no longer promises a notice nothing sends", !/tell you (well )?before/i.test(dash) && !/We'll tell you|We will tell you/.test(dash));

// C6 — the feature grid includes an add-on, so nothing above it may claim
// everything is included, and the pricing intro claims core features only.
t('features eyebrow no longer says "Everything included"', !/Everything included/.test(homeSrc));
t("features eyebrow says what is included, not everything", /What(&apos;|')s included/.test(homeSrc));
t("pricing intro claims every core feature, not every feature", !/Every plan unlocks every feature\b/.test(collapse(homeSrc)) && /Every plan unlocks every core feature/.test(collapse(homeSrc)));
t("affiliate card is labelled an optional add-on", /Available as an add-on/.test(homeSrc) && /badge: "Optional add-on"/.test(homeSrc) && /\{badge && \(/.test(homeSrc));

// C7 — the enforced cap is a platform_settings knob, so copy says "currently".
t("/beta quotes the cap as the current value", /fair-use cap \(currently \{GENERATION_DAILY_CAP\} generated pages per workspace per day\)/.test(collapse(betaPage)));
t("/beta scopes included generation to a beta grant and gives trials a starter allowance", /Included with a beta grant/.test(collapse(betaPage)) && /Trial workspaces get a starter allowance/.test(collapse(betaPage)));
t("billing quotes the cap as the current value in both branches", (billing.match(/fair-use cap \(currently \$\{GENERATION_DAILY_CAP\} generated pages per workspace per day\)/g) || []).length === 2);
t("no page quotes the cap flatly", !/fair-use cap of/.test(betaPage) && !/fair-use cap of/.test(billing) && !/fair-use cap of/.test(homeSrc));
const limits = read("src/lib/generation-limits.ts");
t("generation-limits says where the live value is shown", /overview\.dailyCap/.test(limits) && /app\.content\.generate\.tsx/.test(limits));
const generate = read("src/routes/_authenticated/app.content.generate.tsx");
t("the generate page shows the live cap, not the constant", /overview\.dailyCap/.test(generate) && !generate.includes("GENERATION_DAILY_CAP"));

// C8 — structured-data prices and the add-on block size come from the catalog.
// The derivation expressions are evaluated against the real catalog, so this
// checks what the page renders, not just that a literal is gone.
const evalWithCatalog = (expr: string): unknown =>
  new Function("PAGE_PLANS", "PAGE_ADDON", `return (${expr});`)(PAGE_PLANS, PAGE_ADDON);
const lowExpr = homeSrc.match(/const PRICE_LOW = (.+);/)?.[1];
const highExpr = homeSrc.match(/const PRICE_HIGH = (.+);/)?.[1];
const catalogLow = Math.min(...PAGE_PLANS.map((p) => p.monthlyPrice));
const catalogHigh = Math.max(...PAGE_PLANS.map((p) => p.monthlyPrice));
t("JSON-LD lowPrice renders the catalog's cheapest plan", !!lowExpr && String(evalWithCatalog(lowExpr)) === String(catalogLow) && homeSrc.includes("lowPrice: String(PRICE_LOW)"), lowExpr ?? "no PRICE_LOW");
t("JSON-LD highPrice renders the catalog's dearest plan", !!highExpr && String(evalWithCatalog(highExpr)) === String(catalogHigh) && homeSrc.includes("highPrice: String(PRICE_HIGH)"), highExpr ?? "no PRICE_HIGH");
t("no price literal remains in the structured data", !/(lowPrice|highPrice): "\d/.test(homeSrc));
t("the catalog bounds are the first and last plans, as /beta and billing assume", catalogLow === PAGE_PLANS[0]!.monthlyPrice && catalogHigh === PAGE_PLANS[PAGE_PLANS.length - 1]!.monthlyPrice);
const blockExpr = homeSrc.match(/blocks of\{" "\}\s*\{(PAGE_ADDON\.pagesPerUnit\.toLocaleString\(\))\}/)?.[1];
t("add-on block size renders the catalog's pagesPerUnit", !!blockExpr && evalWithCatalog(blockExpr) === PAGE_ADDON.pagesPerUnit.toLocaleString() && !/blocks of 1,000/.test(homeSrc), blockExpr ?? "no PAGE_ADDON expression");

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
