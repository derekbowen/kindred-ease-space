/**
 * THE MVP SURFACE, AND NOTHING ELSE. Run: bun tests/mvp-surface.test.ts
 * (also runs under the Deno preload: bun --preload ./tests/_preload/deno-edge-function.ts)
 *
 * The owner narrowed the product to one journey (2026-09-28): connect
 * Sharetribe → sync listings → coverage opportunities → template → draft →
 * edit and preview → publish on the verified domain → sitemap. Everything
 * else is DEFERRED — hidden AND refused on the server, for every workspace,
 * the founder / internal unlimited one and platform admins included, whatever
 * a billing entitlement, an add-on row or ?showStubs=1 says. Pinned here,
 * behaviourally where the code can be driven offline:
 *
 *   1. the sidebar is the MVP list, item for item — for an ordinary
 *      workspace, the founder's, and with ?showStubs=1; platform admins see
 *      the MVP plus the assertAdmin ops tools, nothing else;
 *   2. the Settings tabs are Workspace, Domains, Sharetribe, Billing;
 *   3. assertFeatureAvailable refuses every deferred feature by default,
 *      re-enables only through platform_settings, and FAILS CLOSED;
 *   4. every handler of every deferred server-function file asks the gate
 *      first — driven for real against a fake PostgREST: the one request a
 *      refused call makes is the settings read (no write, no paid API, no AI
 *      call), for an ordinary and for the founder's workspace alike;
 *   5. every deferred route redirects to /app before it loads; the public
 *      affiliate sign-up page is a 404; the MVP routes are not guarded;
 *   6. the dashboard has no Coach: setup checklist, sync health,
 *      Opportunities, pages, plan and AI cards;
 *   7. create-checkout refuses mode "addon" with 410 before any read or
 *      Stripe call (driven with recording fakes);
 *   8. migration 000300 deactivates coach-briefing-nightly only, reversibly
 *      (PGlite with a pg_cron stand-in); PRNM's jobs are never touched;
 *   9. migration 000310 rewrites exactly the help copy it names, only on
 *      platform rows, idempotently, with a verbatim rollback (PGlite, on the
 *      repo's own seed → 000900 → 000910 chain);
 *  10. the homepage and /beta describe the MVP only.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  isNotFound,
  isRedirect,
  RouterProvider,
} from "@tanstack/react-router";
import { PGlite } from "@electric-sql/pglite";
import { FakeBackend, SUPABASE_URL } from "./_support/fake-backend";

process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";

const { NAV_SECTIONS, visibleNavSections, activeNavItem } = await import("../src/lib/app-nav");
const { SETTINGS_TABS } = await import("../src/components/settings/settings-tabs");
const features = await import("../src/lib/features.server");
const { setupSteps, describeSyncHealth, formatSyncTime, pagesLine } = await import(
  "../src/components/dashboard/overview-status"
);
const { SetupChecklist } = await import("../src/components/dashboard/SetupChecklist");

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
/** Source without comments: what runs, not what the prose mentions. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
/** Run `fn` with a browser-like window whose URL query is `search`. */
async function withUrl<T>(search: string, fn: () => T | Promise<T>): Promise<T> {
  const g = globalThis as { window?: unknown };
  const had = "window" in g;
  const prev = g.window;
  g.window = { location: { search, pathname: "/app" } };
  try {
    return await fn();
  } finally {
    if (had) g.window = prev;
    else delete g.window;
  }
}
const REFUSED = "This part of Founders.click isn't available right now.";
const WS = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

// ===========================================================================
console.log("\n1. the sidebar is the MVP, item for item");
// ===========================================================================

const MVP_NAV: Array<[string, string]> = [
  ["/app", "Overview"],
  ["/app/settings/integrations/sharetribe", "Sharetribe & inventory"],
  ["/app/opportunities", "Opportunities"],
  ["/app/pages/new", "Page Builder"],
  ["/app/pages", "My Pages"],
  ["/app/seo/sitemap", "Sitemap"],
  ["/app/settings", "Settings"],
  ["/help/contact", "Help & feedback"],
];
const ADMIN_NAV = [
  "/app/ops/plan-requests",
  "/app/admin/help/articles",
  "/app/admin/help/categories",
  "/app/admin/help/feedback",
  "/app/admin/help/tickets",
  "/app/admin/email-templates",
  "/app/seo/canonical-audit",
];
const flat = (sections: Array<{ items: Array<{ to: string; label: string }> }>) =>
  sections.flatMap((s) => s.items.map((i) => `${i.to} ${i.label}`)).join(" | ");
const mvp = MVP_NAV.map(([to, label]) => `${to} ${label}`).join(" | ");

const ordinary = visibleNavSections({ platformAdmin: false });
t("an ordinary workspace sees exactly the MVP list, in order", flat(ordinary) === mvp, flat(ordinary));
// The founder / internal unlimited workspace: the visibility rule takes no
// entitlement at all. Whatever else a caller passes — every old reveal flag —
// the answer is the ordinary one.
const founder = visibleNavSections({
  platformAdmin: false,
  internalUnlimited: true,
  revealLaunchHidden: true,
  revealLaunchHiddenFeatures: true,
  showStubs: true,
  isInternal: true,
} as unknown as { platformAdmin: boolean });
t("the founder / internal unlimited workspace sees exactly the MVP list", flat(founder) === mvp, flat(founder));
const stubsUrl = await withUrl("?showStubs=1", () => visibleNavSections({ platformAdmin: false }));
t("?showStubs=1 in the URL changes nothing", flat(stubsUrl) === mvp, flat(stubsUrl));
const admin = visibleNavSections({ platformAdmin: true });
const adminItems = admin.flatMap((s) => s.items);
t(
  "the platform-admin workspace sees the MVP list plus the assertAdmin ops tools, nothing else",
  adminItems.filter((i) => !i.internalOnly).map((i) => `${i.to} ${i.label}`).join(" | ") === mvp &&
    adminItems.filter((i) => i.internalOnly).map((i) => i.to).join() === ADMIN_NAV.join(),
  adminItems.map((i) => i.to).join(","),
);
const catalog = NAV_SECTIONS.flatMap((s) => s.items);
t(
  "the nav catalog holds nothing else (no stub, no launch flag, no hidden item)",
  catalog.length === MVP_NAV.length + ADMIN_NAV.length &&
    catalog.every((i) => !("stub" in i) && !("launch" in i)),
);
for (const [path, label] of [
  ["/app", "Overview"],
  ["/app/", "Overview"],
  ["/app/opportunities", "Opportunities"],
  ["/app/pages/new", "Page Builder"],
  ["/app/pages", "My Pages"],
  ["/app/pages/abc/edit", "My Pages"],
  ["/app/pages/bulk", "My Pages"],
  ["/app/seo/sitemap", "Sitemap"],
  ["/app/settings", "Settings"],
  ["/app/settings/domains", "Settings"],
  ["/app/billing", "Settings"],
  ["/app/settings/integrations/sharetribe", "Sharetribe & inventory"],
] as const) {
  t(`the active item on ${path} is ${label}`, activeNavItem(path, catalog)?.label === label, activeNavItem(path, catalog)?.label);
}
t("no item claims a deferred path", activeNavItem("/app/affiliates", catalog) === undefined && activeNavItem("/app/seo/rank-tracker", catalog) === undefined);

const shell = read("src/routes/_authenticated/app.tsx");
t(
  "the shell builds the sidebar from visibleNavSections, keyed on the workspace's is_internal flag only",
  /const navSections = visibleNavSections\(\{ platformAdmin \}\);/.test(shell) &&
    /const platformAdmin = Boolean\(\s*\(activeWorkspace as \{ is_internal\?: boolean \} \| undefined\)\?\.is_internal,?\s*\);/.test(shell),
);
t(
  "the shell reads no URL switch, no reveal flag and mounts no Coach",
  !/showStubs|revealLaunchHidden|isNavItemVisible|CoachLauncher|components\/coach/.test(code(shell)),
);
const srcFiles = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${name.name}`;
    if (name.isDirectory()) srcFiles(rel, out);
    else if (/\.(ts|tsx)$/.test(name.name)) out.push(rel);
  }
  return out;
};
const allSrc = srcFiles("src");
const reveal = allSrc.filter((f) => /showStubs|revealLaunchHidden|isNavItemVisible|isSettingsTabVisible|useCoachEnabled/.test(code(read(f))));
t("no source anywhere keeps a reveal switch", reveal.length === 0, reveal.join(", "));

// ===========================================================================
console.log("\n2. the Settings tabs");
// ===========================================================================

t(
  "Workspace, Domains, Sharetribe, Billing — nothing else",
  SETTINGS_TABS.map((x) => `${x.to} ${x.label}`).join(" | ") ===
    "/app/settings Workspace | /app/settings/domains Domains | /app/settings/integrations/sharetribe Sharetribe | /app/billing Billing",
);
const settingsNav = read("src/components/settings/SettingsNav.tsx");
t("SettingsNav renders every tab, with no filter", /SETTINGS_TABS\.map\(/.test(settingsNav) && !/\.filter\(/.test(settingsNav));
const settingsPage = read("src/routes/_authenticated/app.settings.tsx");
t(
  "Workspace Settings has no AI-provider or API-key card and no link to them",
  !/\/app\/settings\/ai|\/app\/settings\/api-keys|showAdvanced|configuredAiProviders|configuredSecretKeys/.test(code(settingsPage)),
);

// ===========================================================================
console.log("\n3. assertFeatureAvailable: off by default, ops re-enable, fails closed");
// ===========================================================================

const EXPECTED_FEATURES = [
  "affiliates",
  "addons",
  "coach",
  "briefing",
  "seo_tools",
  "rank_tracker",
  "competitor_tools",
  "audits",
  "lead_tools",
  "bulk_editor",
  "data_import",
  "byok_settings",
  "workspace_api_keys",
  "legacy_opportunity_engine",
] as const;
t("the deferred features are exactly the brief's fourteen", [...features.DEFERRED_FEATURES].join() === EXPECTED_FEATURES.join());
t("the refusal is the customer sentence", features.FEATURE_UNAVAILABLE_MESSAGE === REFUSED);

type Recorded = { table?: string; cols?: string; eq?: [string, unknown]; single?: boolean };
/** A fake reader answering the settings read with `answer` (or throwing). */
function reader(answer: () => Promise<{ data: unknown; error: unknown }> | { data: unknown; error: unknown }, log: Recorded[] = []) {
  return {
    log,
    from(table: string) {
      const rec: Recorded = { table };
      log.push(rec);
      const q = {
        select(cols: string) {
          rec.cols = cols;
          return q;
        },
        eq(col: string, v: unknown) {
          rec.eq = [col, v];
          return q;
        },
        async maybeSingle() {
          rec.single = true;
          return answer();
        },
      };
      return q;
    },
  };
}
const refusal = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
};
const origError = console.error;
const errors: string[] = [];
console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
try {
  for (const f of EXPECTED_FEATURES) {
    const e = await refusal(features.assertFeatureAvailable(f, reader(() => ({ data: null, error: null }))));
    t(
      `${f}: refused by default (no settings row)`,
      e instanceof features.FeatureUnavailableError && (e as Error).message === REFUSED && (e as { feature?: string }).feature === f,
      String(e),
    );
  }
  const log: Recorded[] = [];
  await features.isFeatureAvailable("affiliates", reader(() => ({ data: null, error: null }), log));
  t(
    "the gate reads platform_settings.value where key = 'enabled_deferred_features', one row",
    log.length === 1 &&
      log[0]!.table === "platform_settings" &&
      log[0]!.cols === "value" &&
      log[0]!.eq?.[0] === "key" &&
      log[0]!.eq?.[1] === "enabled_deferred_features" &&
      log[0]!.single === true,
    JSON.stringify(log),
  );
  const onlyAffiliates = reader(() => ({ data: { value: ["affiliates"] }, error: null }));
  t("ops re-enable: a listed feature is available", (await features.isFeatureAvailable("affiliates", onlyAffiliates)) === true);
  const others = EXPECTED_FEATURES.filter((f) => f !== "affiliates");
  let allOthersOff = true;
  for (const f of others) allOthersOff &&= (await features.isFeatureAvailable(f, onlyAffiliates)) === false;
  t("…and only that one", allOthersOff);
  for (const [label, value] of [
    ["an empty list", []],
    ["a bare string", "affiliates"],
    ["an object", { affiliates: true }],
    ["true", true],
    ["an unknown id", ["everything"]],
    ["the wrong case", ["AFFILIATES"]],
  ] as const) {
    t(
      `a malformed value (${label}) enables nothing`,
      (await features.isFeatureAvailable("affiliates", reader(() => ({ data: { value }, error: null })))) === false,
    );
  }
  const failedRead = await refusal(
    features.assertFeatureAvailable("affiliates", reader(() => ({ data: { value: ["affiliates"] }, error: { message: "boom" } }))),
  );
  t("FAILS CLOSED: a read error refuses, even with the feature listed", (failedRead as Error)?.message === REFUSED);
  const threw = await refusal(
    features.assertFeatureAvailable("affiliates", {
      from() {
        throw new Error("client exploded");
      },
    }),
  );
  t("FAILS CLOSED: a client that throws refuses", (threw as Error)?.message === REFUSED);
  const rejected = await refusal(
    features.assertFeatureAvailable("affiliates", reader(() => Promise.reject(new Error("network down")))),
  );
  t("FAILS CLOSED: a rejected read refuses", (rejected as Error)?.message === REFUSED);
  t("an id outside the list is never available", (await features.isFeatureAvailable("dashboard" as never, onlyAffiliates)) === false);
  t("read failures are logged (message only)", errors.some((l) => /enabled_deferred_features read (failed|threw)/.test(l)));
} finally {
  console.error = origError;
}
{
  // The two functions, without comments and string literals: what they read.
  const src = code(read("src/lib/features.server.ts")).replace(/"[^"\n]*"/g, '""');
  const fnBody = (name: string) => src.slice(src.indexOf(`export async function ${name}(`), src.indexOf("\n}", src.indexOf(`export async function ${name}(`)));
  const both = fnBody("isFeatureAvailable") + fnBody("assertFeatureAvailable");
  t(
    "the gate's only inputs are the feature and the settings reader — no workspace, entitlement, role or billing fact, so it cannot differ for the founder or an admin",
    /export async function isFeatureAvailable\(\s*feature: DeferredFeature,\s*db\?: FeatureSettingsReader,\s*\)/.test(src) &&
      /export async function assertFeatureAvailable\(\s*feature: DeferredFeature,\s*db\?: FeatureSettingsReader,\s*\)/.test(src) &&
      !/workspace|internal|entitlement|role|billing|addon_status|isInternalUnlimited/i.test(both.replace(/supabaseAdmin/g, "")),
  );
}
t("the user message passes as a customer sentence", (await import("../src/lib/user-message")).isCustomerSentence(REFUSED));

// ===========================================================================
console.log("\n4. every deferred server function asks the gate first (driven against a fake PostgREST)");
// ===========================================================================

type Plan = { file: string; feature: Record<string, string | null>; all?: string };
const PLANS: Plan[] = [
  { file: "src/lib/affiliates.functions.ts", feature: {}, all: "affiliates" },
  { file: "src/lib/affiliate-sync.functions.ts", feature: {}, all: "affiliates" },
  { file: "src/lib/affiliate-public.functions.ts", feature: {}, all: "affiliates" },
  { file: "src/lib/addons.functions.ts", feature: {}, all: "addons" },
  {
    file: "src/lib/coach.functions.ts",
    feature: { getTodayBriefing: "briefing", generateBriefingNow: "briefing", dismissInsight: "briefing" },
    all: "coach",
  },
  { file: "src/lib/coach-actions.functions.ts", feature: {}, all: "coach" },
  { file: "src/lib/admin-seo-coach.functions.ts", feature: {}, all: "coach" },
  {
    file: "src/lib/admin-seo-tools.functions.ts",
    feature: { listCompetitorPages: "competitor_tools", scrapeCompetitorUrl: "competitor_tools", deleteCompetitor: "competitor_tools" },
    all: "seo_tools",
  },
  { file: "src/lib/admin-rank-tracker.functions.ts", feature: {}, all: "rank_tracker" },
  { file: "src/lib/admin-link-checker.functions.ts", feature: {}, all: "audits" },
  { file: "src/lib/admin-content-health.functions.ts", feature: {}, all: "audits" },
  { file: "src/lib/admin-404-log.functions.ts", feature: {}, all: "seo_tools" },
  { file: "src/lib/click-report.functions.ts", feature: {}, all: "seo_tools" },
  { file: "src/lib/admin-page-auditor.functions.ts", feature: {}, all: "audits" },
  { file: "src/lib/admin-content-pages.functions.ts", feature: {}, all: "bulk_editor" },
  // exportTable stays: a member-only read of the workspace's own rows.
  { file: "src/lib/admin-data-io.functions.ts", feature: { exportTable: null }, all: "data_import" },
  // The two BYOK reads write and spend nothing; the generation path never uses this file.
  {
    file: "src/lib/ai-byok.functions.ts",
    feature: { listAiCredentials: null, getAiUsageSummary: null },
    all: "byok_settings",
  },
  { file: "src/lib/admin-workspace-secrets.functions.ts", feature: {}, all: "workspace_api_keys" },
  { file: "src/lib/opportunities.functions.ts", feature: {}, all: "legacy_opportunity_engine" },
];
const expected = (p: Plan, name: string) => (name in p.feature ? p.feature[name]! : p.all!) ?? null;

console.log("\n  4a. source: the first statement of every handler");
let gatedCount = 0;
for (const p of PLANS) {
  const src = read(p.file);
  const names = [...src.matchAll(/^export const (\w+) = createServerFn\(/gm)].map((m) => m[1]!);
  t(`${p.file}: has handlers`, names.length > 0);
  for (const name of names) {
    const at = src.indexOf(`export const ${name} = createServerFn(`);
    const next = src.indexOf("\nexport ", at + 1);
    const block = src.slice(at, next < 0 ? undefined : next);
    const want = expected(p, name);
    const first = block.match(/\.handler\(\s*async \([\s\S]*?\)(?:: [^=]*?)?\s*=> \{\s*([^\n]*)/)?.[1] ?? "";
    if (want) {
      gatedCount++;
      t(`${name}: first statement is assertFeatureAvailable("${want}")`, first.trim() === `await assertFeatureAvailable("${want}");`, first);
      t(`${want} is one of the deferred features`, (features.DEFERRED_FEATURES as readonly string[]).includes(want));
    } else {
      t(`${name}: stays available (a read that writes and spends nothing)`, !/assertFeatureAvailable/.test(block));
    }
  }
}
t("every gated handler is counted (69)", gatedCount === 69, String(gatedCount));
const briefingSrc = read("src/lib/coach-briefing.server.ts");
for (const fn of ["refreshBriefing", "requestBriefing"]) {
  const at = briefingSrc.indexOf(`export async function ${fn}(`);
  t(
    `coach-briefing.server.ts ${fn}: asks the gate before anything else`,
    at > 0 && /\): Promise<BriefingRequestResult> \{\s*await assertFeatureAvailable\("briefing", deps\.features\);/.test(briefingSrc.slice(at, at + 400)),
  );
}
for (const f of ["src/lib/ai-models.functions.ts", "src/lib/generation.server.ts", "src/lib/ai/spend.server.ts", "src/lib/workspace-secrets.server.ts"]) {
  t(`${f}: the generation path is not gated (no features.server import)`, !/features\.server/.test(read(f)));
}

console.log("\n  4b. behaviour: a refused call makes exactly one request, the settings read");
const backend = new FakeBackend();
const origFetch = globalThis.fetch;
backend.install();
const world = (o: { founder: boolean; settings?: unknown }) => {
  backend.reset();
  // The founder / internal unlimited workspace, owned by a platform admin —
  // the gate must not care.
  backend.rpc.workspace_is_internal_unlimited = () => o.founder;
  backend.rpc.has_role = () => o.founder;
  backend.rest["GET user_roles"] = () => (o.founder ? [{ role: "admin" }] : []);
  backend.rest["GET platform_settings"] = () =>
    o.settings === undefined ? [] : (o.settings as unknown[] | { status: number; body: unknown });
};
const INPUT = {
  workspaceId: WS,
  id: ID,
  programId: ID,
  pageId: ID,
  conversationId: ID,
  briefingId: ID,
  insightIndex: 0,
  slug: "a-slug",
  name: "Someone",
  email: "someone@example.test",
  table: "content_pages",
  csv: "a\n1",
  actionType: "fix_thin_page",
  payload: { page_id: ID },
  messages: [{ role: "user", content: "hi" }],
  url: "https://example.test/",
  keyword: "boats",
  url_path: "/a/boats",
  domain: "example.test",
  provider: "openai",
  apiKey: "sk-test-123456789",
  addonKey: "affiliate-standard",
  status: "active",
  rows: [{ url_path: "/a", query: "q", clicks: 1, impressions: 1 }],
};
errors.length = 0;
console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
try {
  for (const founderWorld of [false, true]) {
    const who = founderWorld ? "founder / internal unlimited + admin" : "ordinary workspace";
    let refusedAll = true;
    let onlySettingsRead = true;
    let noEntitlementRead = true;
    const bad: string[] = [];
    for (const p of PLANS) {
      const mod = await import(`../${p.file}`);
      for (const [name, fn] of Object.entries(mod)) {
        if (typeof fn !== "function" || !("__executeServer" in (fn as object))) continue;
        if (!expected(p, name)) continue;
        world({ founder: founderWorld });
        const e = await refusal((fn as (o: unknown) => Promise<unknown>)({ data: INPUT }));
        const hits = backend.hits.map((h) => `${h.kind} ${h.method} ${h.name}`);
        if ((e as Error | null)?.message !== REFUSED) {
          refusedAll = false;
          bad.push(`${name}: ${String(e)}`);
        }
        if (hits.join() !== "rest GET platform_settings") {
          onlySettingsRead = false;
          bad.push(`${name}: ${hits.join(",")}`);
        }
        if (backend.rpcHits("workspace_is_internal_unlimited").length || backend.hits.some((h) => h.name === "user_roles")) {
          noEntitlementRead = false;
        }
      }
    }
    t(`${who}: every gated handler refuses with the customer sentence`, refusedAll, bad.join(" ; "));
    t(`${who}: …after exactly one request, the settings read — no write, no paid API, no AI call`, onlySettingsRead, bad.join(" ; "));
    t(`${who}: …and the gate never asked who the workspace is`, noEntitlementRead);
  }

  // Fails closed through the real service-role client too.
  {
    const mod = await import("../src/lib/affiliates.functions");
    world({ founder: true, settings: { status: 500, body: { message: "boom" } } });
    const e = await refusal((mod.createAffiliate as unknown as (o: unknown) => Promise<unknown>)({ data: INPUT }));
    t(
      "a 500 on the settings read refuses (fails closed), still with nothing else sent",
      (e as Error)?.message === REFUSED && backend.hits.map((h) => h.name).join() === "platform_settings",
    );
  }
  // Ops re-enable is per feature, through the same read.
  {
    const addons = await import("../src/lib/addons.functions");
    const aff = await import("../src/lib/affiliates.functions");
    world({ founder: false, settings: [{ value: ["addons"] }] });
    await refusal((addons.getAddons as unknown as (o: unknown) => Promise<unknown>)({ data: INPUT }));
    const addonsHits = backend.hits.map((h) => h.name);
    t(
      "with enabled_deferred_features = [\"addons\"], getAddons goes past the gate (its membership read follows)",
      addonsHits[0] === "platform_settings" && addonsHits.length > 1 && addonsHits.includes("workspace_members"),
      addonsHits.join(","),
    );
    world({ founder: false, settings: [{ value: ["addons"] }] });
    const e = await refusal((aff.getAffiliateSettings as unknown as (o: unknown) => Promise<unknown>)({ data: INPUT }));
    t("…while affiliates stay refused", (e as Error)?.message === REFUSED && backend.hits.length === 1);
  }
  // The allowed reads are not gated.
  for (const [file, name] of [
    ["src/lib/admin-data-io.functions.ts", "exportTable"],
    ["src/lib/ai-byok.functions.ts", "listAiCredentials"],
    ["src/lib/ai-byok.functions.ts", "getAiUsageSummary"],
  ] as const) {
    const mod = await import(`../${file}`);
    world({ founder: false });
    await refusal((mod[name] as (o: unknown) => Promise<unknown>)({ data: INPUT }));
    t(`${name} stays available: no settings read`, !backend.hits.some((h) => h.name === "platform_settings"));
  }
  // The on-demand briefing (what the Worker would call): refused, nothing sent.
  {
    const { refreshBriefing, requestBriefing } = await import("../src/lib/coach-briefing.server");
    process.env.CRON_SECRET = "cron-secret-for-tests";
    for (const [label, run] of [
      ["refreshBriefing", () => refreshBriefing(WS)],
      ["requestBriefing", () => requestBriefing(WS)],
    ] as const) {
      world({ founder: true });
      const e = await refusal(run());
      t(
        `${label}: refused before the throttle, the function or any AI call`,
        (e as Error)?.message === REFUSED && backend.hits.map((h) => h.name).join() === "platform_settings",
        backend.hits.map((h) => h.name).join(","),
      );
    }
    delete process.env.CRON_SECRET;
  }
} finally {
  console.error = origError;
  globalThis.fetch = origFetch;
}

// ===========================================================================
console.log("\n5. deferred routes redirect to /app; the MVP routes do not");
// ===========================================================================

const R = "src/routes/_authenticated";
const routeFiles = readdirSync(join(ROOT, R)).filter((f) => f.endsWith(".tsx"));
const isDeferredFile = (f: string) =>
  f === "app.coach.tsx" ||
  f === "app.seo-coach.tsx" ||
  (f.startsWith("app.seo.") && f !== "app.seo.sitemap.tsx" && f !== "app.seo.canonical-audit.tsx") ||
  /^app\.content\.(blog|learning|migration|city-heroes|bulk-editor|data-import|data-export)\.tsx$/.test(f) ||
  f.startsWith("app.affiliates") ||
  f === "app.addons.tsx" ||
  f === "app.settings.ai.tsx" ||
  f === "app.settings.api-keys.tsx" ||
  (f.startsWith("app.ops.") && f !== "app.ops.plan-requests.tsx");
const deferred = routeFiles.filter(isDeferredFile);
t("43 deferred route files", deferred.length === 43, String(deferred.length));
for (const f of deferred) {
  const mod = await import(`../${R}/${f}`);
  const beforeLoad = mod.Route?.options?.beforeLoad as undefined | ((c: unknown) => unknown);
  const thrown = await refusal(Promise.resolve().then(() => beforeLoad?.({})));
  t(
    `${f}: beforeLoad redirects to /app`,
    isRedirect(thrown) && (thrown as { options?: { to?: string } }).options?.to === "/app" && /beforeLoad: deferredRoute,/.test(read(`${R}/${f}`)),
  );
}
const stayUp = routeFiles.filter((f) => !isDeferredFile(f));
for (const f of stayUp) {
  t(`${f}: not deferred (no deferredRoute guard)`, !/deferredRoute/.test(read(`${R}/${f}`)));
}
const navFile = (to: string) =>
  to === "/app" ? `${R}/app.index.tsx` : to.startsWith("/help/") ? `src/routes/${to.slice(1).replace(/\//g, ".")}.tsx` : `${R}/${to.slice(1).replace(/\//g, ".")}.tsx`;
for (const item of catalog) {
  const f = navFile(item.to);
  t(`sidebar "${item.label}" opens a route that exists and is not deferred`, existsSync(join(ROOT, f)) && !/deferredRoute/.test(read(f)), f);
}
{
  const mod = await import("../src/routes/apply.$slug.tsx");
  const thrown = await refusal(Promise.resolve().then(() => (mod.Route.options.beforeLoad as (c: unknown) => unknown)({})));
  t("the public affiliate sign-up page (/apply/$slug) is a 404 before its loader runs", isNotFound(thrown));
}

// ===========================================================================
console.log("\n6. the dashboard: setup, sync health, opportunities, pages — no Coach");
// ===========================================================================

const dash = read(`${R}/app.index.tsx`);
t("no Coach import, no daily briefing, no Coach link", !/components\/coach|DailyBriefing|useCoachEnabled|\/app\/coach|Ask Coach/.test(dash));
t("the setup checklist reads the overview's facts", /<SetupChecklist facts=\{setupFacts\} \/>/.test(dash) && /domains: data\?\.domains \?\? \[\]/.test(dash));
t("sync health comes from the overview's integration fields", /describeSyncHealth\(/.test(dash) && /lastSyncStatus: stats\?\.lastSharetribeSyncStatus/.test(dash));
t("an Opportunities card links /app/opportunities, with no count", /OPPORTUNITIES_PATH/.test(dash) && /View opportunities/.test(dash));
t("drafts and published pages, linking /app/pages", /pagesLine\(stats\?\.publishedPages \?\? 0, stats\?\.draftPages \?\? 0\)/.test(dash) && /MY_PAGES_PATH/.test(dash));
t("the plan / trial card and the AI usage card are still there", /describePlanStatus\(/.test(dash) && /formatAllowanceCount\(allowance\)/.test(dash));
const overviewFn = read("src/lib/workspace.functions.ts");
const overview = overviewFn.slice(overviewFn.indexOf("export const getWorkspaceOverview"), overviewFn.indexOf("export const updateWorkspaceBranding"));
t(
  "getWorkspaceOverview adds drafts, the last sync's status and the domain rows (member-checked as before)",
  /draftPages: draftPageCount \?\? 0/.test(overview) &&
    /lastSharetribeSyncStatus: sharetribe\?\.last_sync_status \?\? null/.test(overview) &&
    /\.from\("workspace_domains"\)/.test(overview) &&
    overview.indexOf('if (!isMember) throw new Error("Not allowed");') < overview.indexOf("workspace_domains"),
);

const none = setupSteps({ sharetribeConnected: false, syncedListings: 0, domains: [], marketplaceDomain: null, publishedPages: 0 });
t(
  "the four MVP steps, in order, linking Sharetribe, Sharetribe, Domains, Page Builder",
  none.map((s) => `${s.id}:${s.to}`).join() ===
    "sharetribe:/app/settings/integrations/sharetribe,listings:/app/settings/integrations/sharetribe,domain:/app/settings/domains,page:/app/pages/new" &&
    none.every((s) => !s.done),
);
const pending = setupSteps({
  sharetribeConnected: true,
  syncedListings: 12,
  domains: [{ hostname: "seo.example.com", status: "ssl_pending", verified: true }],
  marketplaceDomain: "seo.example.com",
  publishedPages: 0,
});
t(
  "a verified domain waiting for its certificate is not yet active, and says so in the Domains page's words",
  pending[0]!.done && pending[1]!.done && !pending[2]!.done && /seo\.example\.com: Ownership verified · Certificate issuing\./.test(pending[2]!.description),
  pending[2]!.description,
);
const active = setupSteps({
  sharetribeConnected: true,
  syncedListings: 12,
  domains: [
    { hostname: "old.example.com", status: "disconnected", verified: true },
    { hostname: "seo.example.com", status: "active", verified: true },
  ],
  marketplaceDomain: "seo.example.com",
  publishedPages: 3,
});
t("an active domain and a published page complete the checklist", active.every((s) => s.done));
const NOW = Date.parse("2026-09-28T12:00:00Z");
const health = (o: Partial<Parameters<typeof describeSyncHealth>[0]>) =>
  describeSyncHealth({ connected: true, integrationStatus: "connected", lastSyncAt: null, lastSyncStatus: null, listings: 0, ...o }, NOW);
t("not connected", health({ connected: false, integrationStatus: null }).headline === "Not connected");
t("connected, never synced", health({}).headline === "Not synced yet");
t(
  "last sync succeeded 5 minutes ago, with the listing count",
  health({ lastSyncAt: "2026-09-28T11:55:00Z", lastSyncStatus: "success", listings: 125 }).headline === "Last synced 5 minutes ago" &&
    health({ lastSyncAt: "2026-09-28T11:55:00Z", lastSyncStatus: "success", listings: 125 }).detail === "125 listings imported",
);
t("a failed sync says so, and where to look", health({ lastSyncAt: "2026-09-28T09:00:00Z", lastSyncStatus: "failed", listings: 1 }).headline === "Last sync failed 3 hours ago" && health({ lastSyncAt: "2026-09-28T09:00:00Z", lastSyncStatus: "failed", listings: 1 }).tone === "bad");
t("a warning", health({ lastSyncAt: "2026-09-27T12:00:00Z", lastSyncStatus: "warning" }).headline === "Last synced on Sep 27, 2026 with a warning");
t("a connection Sharetribe stopped accepting", health({ integrationStatus: "error", connected: false }).headline === "Connection needs attention");
t("no raw status or error text ever reaches the card", !/success|failed"|error"/.test(JSON.stringify(health({ lastSyncAt: "2026-09-28T11:00:00Z", lastSyncStatus: "success" }))));
t("formatSyncTime: just now / minutes / hours / date", formatSyncTime("2026-09-28T11:59:40Z", NOW) === "just now" && formatSyncTime("2026-09-28T11:59:00Z", NOW) === "1 minute ago" && formatSyncTime("2026-09-28T10:00:00Z", NOW) === "2 hours ago" && formatSyncTime("2026-09-01T10:00:00Z", NOW) === "on Sep 1, 2026");
t("pages line", pagesLine(3, 1) === "3 published · 1 draft" && pagesLine(1000, 2) === "1,000 published · 2 drafts");
{
  const rootRoute = createRootRoute({
    component: () =>
      createElement(SetupChecklist, {
        facts: { sharetribeConnected: true, syncedListings: 0, domains: [], marketplaceDomain: null, publishedPages: 0 },
      }),
  });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
  t(
    "SetupChecklist renders: 1 of 4, next is the sync, with links to Sharetribe, Domains and the Page Builder",
    /1 of 4 setup steps complete/.test(html) &&
      /next: sync your listings/.test(html) &&
      /href="\/app\/settings\/integrations\/sharetribe"/.test(html) &&
      /href="\/app\/settings\/domains"/.test(html) &&
      /href="\/app\/pages\/new"/.test(html) &&
      !/fastest path to Google|ranking/i.test(html),
    html.slice(0, 300),
  );
}

// ===========================================================================
console.log("\n7. create-checkout refuses add-ons with 410 before any read or Stripe call");
// ===========================================================================
{
  const g = globalThis as unknown as {
    Deno?: unknown;
    __edgeEnv: Record<string, string | undefined>;
    __edgeHandler?: (req: Request) => Promise<Response>;
    __mvpCk: { stripe: string[]; tables: string[]; user: { id: string } | null };
  };
  if (!g.Deno) {
    g.__edgeEnv = {};
    g.Deno = {
      env: { get: (k: string) => g.__edgeEnv[k] },
      serve: (h: (req: Request) => Promise<Response>) => {
        g.__edgeHandler = h;
      },
    };
  }
  g.__mvpCk = { stripe: [], tables: [], user: { id: "user-1" } };
  const BUILD = join(ROOT, "tests/_build");
  mkdirSync(BUILD, { recursive: true });
  const stripeFake = join(BUILD, "mvp-stripe.fake.ts");
  writeFileSync(
    stripeFake,
    `const ck = () => (globalThis as any).__mvpCk;
const rec = (name: string, out: unknown) => async (..._a: unknown[]) => { ck().stripe.push(name); return out; };
export default class Stripe {
  customers = { create: rec("customers.create", { id: "cus_new" }), retrieve: rec("customers.retrieve", { id: "cus_1" }) };
  products = { list: rec("products.list", { data: [] }), create: rec("products.create", { id: "prod_1", metadata: {} }), update: rec("products.update", { id: "prod_1" }) };
  prices = { list: rec("prices.list", { data: [] }), create: rec("prices.create", { id: "price_1", metadata: {} }) };
  subscriptions = { list: rec("subscriptions.list", { data: [] }) };
  checkout = { sessions: { create: rec("checkout.sessions.create", { url: "https://checkout.stripe.test/s" }) } };
  constructor(..._a: unknown[]) {}
}
`,
  );
  const sbFake = join(BUILD, "mvp-supabase.fake.ts");
  writeFileSync(
    sbFake,
    `const ck = () => (globalThis as any).__mvpCk;
class Q {
  constructor(public table: string) {}
  select() { return this; } eq() { return this; } in() { return this; } limit() { return this; }
  upsert() { return this; } maybeSingle() { return this; }
  then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
    ck().tables.push(this.table);
    let out: unknown = { data: null, error: null };
    if (this.table === "workspace_members") out = { data: { workspace_id: "ws", role: "owner" }, error: null };
    if (this.table === "stripe_customers") out = { data: { stripe_customer_id: "cus_1" }, error: null };
    if (this.table === "workspaces") out = { data: { plan: null, subscription_status: "trialing" }, error: null };
    return Promise.resolve(out).then(res, rej);
  }
}
export function createClient(..._a: unknown[]) {
  return { auth: { getUser: async () => ({ data: { user: ck().user } }) }, from: (t: string) => new Q(t) };
}
`,
  );
  const catalogBuilt = join(BUILD, "mvp-stripe-catalog.ts");
  writeFileSync(
    catalogBuilt,
    read("supabase/functions/_shared/stripe-catalog.ts").replace(/from "https:\/\/esm\.sh\/stripe@[^"]+"/, `from "${stripeFake}"`),
  );
  const checkoutSrc = read("supabase/functions/create-checkout/index.ts");
  const built = checkoutSrc
    .replace(/from "https:\/\/esm\.sh\/stripe@[^"]+"/, `from "${stripeFake}"`)
    .replace(/from "https:\/\/esm\.sh\/@supabase\/supabase-js@[^"]+"/, `from "${sbFake}"`)
    .replace(/from "\.\.\/_shared\/stripe-catalog\.ts"/, `from "${catalogBuilt}"`)
    .replace(/from "\.\.\/_shared\/affiliate-requirement\.ts"/, `from "${join(ROOT, "supabase/functions/_shared/affiliate-requirement.ts")}"`);
  t("create-checkout's remote imports were rewritten to local fakes", !/https:\/\/esm\.sh/.test(built));
  const builtPath = join(BUILD, "mvp-create-checkout.offline.ts");
  writeFileSync(builtPath, built);
  Object.assign(g.__edgeEnv, {
    STRIPE_SECRET_KEY: "sk_test_placeholder",
    SUPABASE_URL: "http://supabase.invalid",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
  });
  g.__edgeHandler = undefined;
  await import(builtPath);
  const checkout = g.__edgeHandler!;
  t("create-checkout registered its handler", typeof checkout === "function");
  const post = async (body: Record<string, unknown>, auth = true) => {
    g.__mvpCk.stripe = [];
    g.__mvpCk.tables = [];
    const res = await checkout(
      new Request("http://fn.test/create-checkout", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://www.founders.click", ...(auth ? { Authorization: "Bearer user-jwt" } : {}) },
        body: JSON.stringify(body),
      }),
    );
    const json = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    return { status: res.status, json, stripe: [...g.__mvpCk.stripe], tables: [...g.__mvpCk.tables] };
  };
  for (const addon_key of ["affiliate-standard", "affiliate-pro", "dmchamp", "anything"]) {
    const r = await post({ workspace_id: WS, mode: "addon", addon_key });
    t(
      `mode "addon" (${addon_key}) → 410 addon_unavailable, "Add-ons aren't available right now.", no read, no Stripe call`,
      r.status === 410 &&
        r.json?.error === "addon_unavailable" &&
        r.json?.message === "Add-ons aren't available right now." &&
        r.tables.length === 0 &&
        r.stripe.length === 0,
      `${r.status} ${JSON.stringify(r.json)} ${r.tables.join(",")} ${r.stripe.join(",")}`,
    );
  }
  const anon = await post({ workspace_id: WS, mode: "addon", addon_key: "dmchamp" }, false);
  t("…an unauthenticated caller still gets 401 first (as for credits)", anon.status === 401 && anon.stripe.length === 0);
  const credits = await post({ workspace_id: WS, mode: "credits" });
  t("credits keep their own 410", credits.status === 410 && credits.json?.error === "credits_unavailable");
  const plan = await post({ workspace_id: WS, mode: "subscription", tier: "starter" });
  t("a plan checkout is not caught by the add-on refusal (it reaches Stripe)", plan.status !== 410 && plan.stripe.length > 0, `${plan.status} ${JSON.stringify(plan.json)}`);
  const unknown = await post({ workspace_id: WS, mode: "gift" });
  t("an unknown mode is still a 400 invalid_mode", unknown.status === 400 && unknown.json?.error === "invalid_mode");
}

// ===========================================================================
console.log("\n8. migration 000300: coach-briefing-nightly deactivated, nothing else");
// ===========================================================================

const CRON_STUB = `
  CREATE SCHEMA IF NOT EXISTS cron;
  CREATE TABLE cron.job (
    jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text NOT NULL, command text NOT NULL,
    active boolean NOT NULL DEFAULT true);
  CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
                                 database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql AS $$
  BEGIN
    UPDATE cron.job j
       SET active = COALESCE(alter_job.active, j.active),
           schedule = COALESCE(alter_job.schedule, j.schedule),
           command = COALESCE(alter_job.command, j.command)
     WHERE j.jobid = alter_job.job_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Could not find valid entry for job %', job_id; END IF;
  END $$;`;
const JOBS = `
  INSERT INTO cron.job (jobname, schedule, command, active) VALUES
    ('sharetribe-sync-30min', '*/30 * * * *', 'SELECT public.enqueue_sharetribe_syncs()', true),
    ('coach-briefing-nightly', '0 7 * * *', 'SELECT net.http_post(''coach-briefing-cron'')', true),
    ('competitor-radar-daily', '0 5 * * *', 'SELECT prnm.radar()', true),
    ('daily-seo-digest', '0 8 * * *', 'SELECT prnm.digest()', true),
    ('canonical-audit-daily', '0 6 * * *', 'SELECT 1', true),
    ('ai-reap-stale-reservations', '*/5 * * * *', 'SELECT public.ai_reap_stale_reservations()', true),
    ('process-auth-emails', '* * * * *', 'SELECT 1', false);`;
const mig300 = read("supabase/migrations/20260929000300_mvp_deferred_jobs.sql");
const rb300 = read("supabase/rollback/20260929000300_mvp_deferred_jobs_rollback.sql");
const lastRows = (results: Array<{ rows: any[] }>) => results[results.length - 1]!.rows;
const jobsOf = async (db: PGlite) =>
  (await db.query<{ jobname: string; schedule: string; command: string; active: boolean }>(
    "SELECT jobname, schedule, command, active FROM cron.job ORDER BY jobname",
  )).rows;
{
  t("the migration deactivates by jobname through cron.alter_job(…, active := false)", /jobname = 'coach-briefing-nightly'/.test(mig300) && /cron\.alter_job\(job_id := v_job\.jobid, active := false\)/.test(mig300));
  const sqlOnly = mig300.replace(/--[^\n]*/g, "");
  const noLiterals = sqlOnly.replace(/'(?:[^']|'')*'/g, "''");
  t(
    "it never names PRNM's jobs as a value, and unschedules, deletes or reschedules nothing",
    !/unschedule|DELETE FROM cron|UPDATE cron|cron\.schedule/i.test(noLiterals) &&
      !/'(competitor-radar-daily|daily-seo-digest)'/.test(sqlOnly) &&
      (sqlOnly.match(/cron\.alter_job\(/g) ?? []).length === 1,
  );
  const db = await PGlite.create();
  await db.exec(CRON_STUB + JOBS);
  const before = await jobsOf(db);
  const v1 = lastRows(await db.exec(mig300));
  const after = await jobsOf(db);
  t("coach-briefing-nightly is inactive", after.find((j) => j.jobname === "coach-briefing-nightly")?.active === false);
  t(
    "…with its schedule and command unchanged (deactivated, not unscheduled)",
    JSON.stringify({ ...after.find((j) => j.jobname === "coach-briefing-nightly"), active: true }) ===
      JSON.stringify(before.find((j) => j.jobname === "coach-briefing-nightly")),
  );
  t(
    "every other job — PRNM's competitor-radar-daily and daily-seo-digest included — is exactly as it was",
    JSON.stringify(after.filter((j) => j.jobname !== "coach-briefing-nightly")) ===
      JSON.stringify(before.filter((j) => j.jobname !== "coach-briefing-nightly")),
  );
  t("the verification: three rows, every one true", v1.length === 3 && v1.every((r) => r.ok === true), JSON.stringify(v1));
  const v2 = lastRows(await db.exec(mig300));
  t("a second run changes nothing and still verifies", JSON.stringify(await jobsOf(db)) === JSON.stringify(after) && v2.every((r) => r.ok === true));
  const vr = lastRows(await db.exec(rb300));
  t("the rollback reactivates it, touching nothing else", JSON.stringify(await jobsOf(db)) === JSON.stringify(before) && vr.every((r) => r.ok === true), JSON.stringify(vr));
  await db.close();
}
{
  const db = await PGlite.create();
  await db.exec(CRON_STUB + JOBS.replace(/\n    \('coach-briefing-nightly'[^\n]*/, ""));
  const before = await jobsOf(db);
  const v = lastRows(await db.exec(mig300));
  t("no coach-briefing-nightly job: a no-op that still verifies", JSON.stringify(await jobsOf(db)) === JSON.stringify(before) && v.every((r) => r.ok === true), JSON.stringify(v));
  await db.close();
}

// ===========================================================================
console.log("\n9. migration 000310: the help copy, on the seed → 000900 → 000910 chain");
// ===========================================================================

const PRNM = "6501e018-0000-4000-8000-000000000001";
const seedSql = read("supabase/migrations/20260511071212_5e1df68f-1937-4a7a-a5f6-8e9cf361abf2.sql");
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  return s.slice(a, s.indexOf(to, a) + to.length);
};
const seedCategories = between(seedSql, "INSERT INTO public.help_categories", "ON CONFLICT (slug) DO NOTHING;");
const seedArticles = between(seedSql, "INSERT INTO public.help_articles (category_slug, slug, title, excerpt, content, status", "ON CONFLICT (slug) DO NOTHING;");
const HELP_SCHEMA = `
  CREATE TABLE public.help_categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL, name text, description text,
    icon text, sort_order int DEFAULT 0, is_published boolean DEFAULT true, workspace_id uuid,
    updated_at timestamptz DEFAULT now());
  CREATE TABLE public.help_articles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), category_slug text, slug text UNIQUE NOT NULL, title text,
    excerpt text, content text, status text, is_published boolean, published_at timestamptz,
    reading_time_minutes int, workspace_id uuid, updated_at timestamptz DEFAULT now());
  -- Pool Rental Near Me's own categories and one of its articles, carrying every old phrase.
  INSERT INTO public.help_categories (slug, name, sort_order, is_published, workspace_id) VALUES
    ('getting-started', 'Getting Started (PRNM)', 1, true, '${PRNM}'),
    ('billing', 'Billing (PRNM)', 2, true, '${PRNM}');
  INSERT INTO public.help_articles (category_slug, slug, title, excerpt, content, status, is_published, reading_time_minutes, workspace_id)
  VALUES ('getting-started', 'prnm-guide', 'Connecting Google Search Console', 'Publish, ping Google, and watch your pages enter the index.',
          'This takes about five minutes. Only the workspace owner can connect a marketplace. open **Sharetribe** in the sidebar (or **Workspace Settings → Sharetribe**) under **Billing & Plans**. syncs in seconds',
          'published', true, 3, '${PRNM}');`;
const mig310 = read("supabase/migrations/20260929000310_mvp_help_copy.sql");
const rb310 = read("supabase/rollback/20260929000310_mvp_help_copy_rollback.sql");
const TARGETS = [
  "welcome-to-founders-click",
  "connecting-your-sharetribe-marketplace",
  "running-your-first-listing-sync",
  "troubleshooting-failed-syncs",
  "submitting-your-sitemap",
  "understanding-page-limits",
  "creating-your-first-seo-page",
  "connecting-google-search-console",
  "publishing-pages-and-getting-indexed",
];
type Row = { slug: string; title: string; excerpt: string; content: string; reading_time_minutes: number; is_published: boolean; status: string; category_slug: string; workspace_id: string | null; updated_at: string };
const rowsOf = async (db: PGlite) =>
  (await db.query<Row>("SELECT slug, title, excerpt, content, reading_time_minutes, is_published, status, category_slug, workspace_id, updated_at::text FROM public.help_articles ORDER BY slug")).rows;
const bySlug = (rows: Row[], slug: string) => rows.find((r) => r.slug === slug)!;
const strip = (rows: Row[]) => rows.map(({ updated_at: _u, ...r }) => r);
async function helpDb(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(HELP_SCHEMA);
  await db.exec(seedCategories);
  await db.exec(seedArticles);
  await db.exec(read("supabase/migrations/20260925000900_help_center_platform_fix.sql"));
  await db.exec(read("supabase/migrations/20260925000910_help_center_claims_fix.sql"));
  return db;
}
function readingTime(md: string): number {
  const words = md.replace(new RegExp("[`*_#>\\-\\[\\]()]", "g"), " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}
{
  // Static: platform rows only, updates only, every write guarded by the old text.
  const writes = (sql: string) =>
    sql
      .replace(/\$(old|new)\$[\s\S]*?\$\1\$/g, "'…'")
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => /^(UPDATE|INSERT|DELETE)\b/i.test(s));
  for (const [label, sql] of [["migration", mig310], ["rollback", rb310]] as const) {
    const w = writes(sql);
    t(`000310 ${label}: ${w.length} UPDATEs, every one on workspace_id IS NULL and one slug, no INSERT or DELETE`, w.length === 12 && w.every((s) => /^UPDATE public\.help_articles\b/.test(s) && /workspace_id IS NULL/.test(s) && /slug = '[a-z-]+'/.test(s)), String(w.length));
    t(`000310 ${label}: every UPDATE is guarded by the text it replaces`, w.every((s) => /AND (content|excerpt) = |AND strpos\(content, /.test(s)));
  }
  t("000310: the rollback runs in one transaction", /^BEGIN;$/m.test(rb310) && /^COMMIT;$/m.test(rb310));

  const db = await helpDb();
  const before = await rowsOf(db);
  t("the chain produced the platform rows the migration targets", TARGETS.every((s) => bySlug(before, s)?.workspace_id === null), TARGETS.filter((s) => !bySlug(before, s)).join(","));
  const verify = lastRows(await db.exec(mig310));
  const after = await rowsOf(db);
  t("the verification: nine rows, every one true", verify.length === 9 && verify.every((r) => r.ok === true), JSON.stringify(verify.filter((r) => r.ok !== true)));
  const changed = after.filter((r, i) => JSON.stringify(r) !== JSON.stringify(before[i])).map((r) => r.slug);
  t("exactly the nine target articles changed", changed.join() === [...TARGETS].sort().join(), changed.join());
  t("the Pool Rental Near Me article, with every old phrase in it, is untouched", JSON.stringify(bySlug(after, "prnm-guide")) === JSON.stringify(bySlug(before, "prnm-guide")));
  t("nothing was unpublished, moved or retitled beyond the GSC article", after.every((r) => {
    const b = bySlug(before, r.slug);
    return r.is_published === b.is_published && r.status === b.status && r.category_slug === b.category_slug && (r.title === b.title || r.slug === "connecting-google-search-console");
  }));
  const all = after.filter((r) => r.workspace_id === null && r.is_published).map((r) => `${r.title}\n${r.excerpt}\n${r.content}`).join("\n");
  for (const [label, re] of [
    ["in days, not months", /in days, not months/],
    ["under 5 minutes", /under 5 minutes/],
    ["about five minutes", /about five minutes/],
    ["syncs in seconds", /syncs in seconds/],
    ["first hour", /first hour/],
    ["Track everything in Google Search Console", /Track everything in Google Search Console/],
    ["ping Google", /ping Google/],
    ["Workspace Settings →", /Workspace Settings →/],
    ["**Sharetribe** in the sidebar", /\*\*Sharetribe\*\* in the sidebar/],
    ["Content → Quick Page Builder", /Quick Page Builder/],
    ["Billing & Plans", /Billing & Plans/],
  ] as const) {
    t(`no published platform article says "${label}" any more`, !re.test(all));
  }
  const welcome = bySlug(after, "welcome-to-founders-click");
  t(
    "the welcome article walks the MVP journey",
    ["Connect Sharetribe", "Sync your listings", "Opportunities", "three page templates", "edit and preview", "Publish on your domain", "sitemap"].every((w) => welcome.content.includes(w)),
  );
  t("creating-your-first-seo-page: Opportunities → template → draft → publish", /^1\. Open \*\*Opportunities\*\*/.test(bySlug(after, "creating-your-first-seo-page").content) && /\*\*draft\*\*/.test(bySlug(after, "creating-your-first-seo-page").content));
  t("the GSC article says founders.click imports no Search Console data", bySlug(after, "connecting-google-search-console").title === "Adding your domain to Google Search Console" && /doesn't connect to Google Search Console or import its data/.test(bySlug(after, "connecting-google-search-console").content));
  for (const slug of ["welcome-to-founders-click", "creating-your-first-seo-page", "connecting-google-search-console"]) {
    const r = bySlug(after, slug);
    t(`${slug}: reading time follows the new text (admin formula), from the seeded 3`, bySlug(before, slug).reading_time_minutes === 3 && r.reading_time_minutes === readingTime(r.content));
  }
  const links = [...all.matchAll(/\]\((\/help\/[^)]+)\)/g)].map((m) => m[1]!);
  const cats = (await db.query<{ slug: string }>("SELECT slug FROM public.help_categories WHERE workspace_id IS NULL AND is_published")).rows.map((r) => r.slug);
  const bad = links.filter((l) => {
    const [, , cat, art] = l.split("/");
    if (l === "/help/contact") return false;
    const a = bySlug(after, art ?? "");
    return !a || a.category_slug !== cat || !cats.includes(cat!) || !a.is_published;
  });
  t("every help link in the platform articles points at a published article in its own published category", bad.length === 0, bad.join(", "));

  const verify2 = lastRows(await db.exec(mig310));
  t("a second run changes nothing (not even updated_at) and still verifies", JSON.stringify(await rowsOf(db)) === JSON.stringify(after) && verify2.every((r) => r.ok === true));
  await db.exec(rb310);
  const rolled = await rowsOf(db);
  t("the rollback restores every row verbatim (all but updated_at)", JSON.stringify(strip(rolled)) === JSON.stringify(strip(before)));
  await db.exec(rb310);
  t("a second rollback changes nothing", JSON.stringify(await rowsOf(db)) === JSON.stringify(rolled));
  await db.close();
}
{
  // An article edited by hand since the seed is left alone.
  const db = await helpDb();
  await db.exec(`UPDATE public.help_articles SET content = 'Written by hand. This takes about five minutes.' WHERE slug IN ('creating-your-first-seo-page', 'connecting-your-sharetribe-marketplace')`);
  await db.exec(mig310);
  const rows = await rowsOf(db);
  t(
    "an article edited in the admin UI keeps its text (the guards need the exact old text)",
    bySlug(rows, "creating-your-first-seo-page").content === "Written by hand. This takes about five minutes." &&
      bySlug(rows, "connecting-your-sharetribe-marketplace").content === "Written by hand. This takes about five minutes.",
  );
  await db.close();
}

// ===========================================================================
console.log("\n10. the homepage and /beta describe the MVP only");
// ===========================================================================

const home = read("src/routes/index.tsx");
const beta = read("src/routes/beta.tsx");
const rootMeta = read("src/routes/__root.tsx");
const i18n = read("src/lib/i18n.tsx");
const visible = (src: string) => code(src);
for (const [file, src] of [
  ["src/routes/index.tsx", visible(home)],
  ["src/routes/beta.tsx", visible(beta)],
  ["src/routes/__root.tsx", visible(rootMeta)],
  ["src/lib/i18n.tsx (footer tagline)", visible(i18n)],
] as const) {
  for (const [label, re] of [
    ["growth engine / all-in-one", /growth engine|all-in-one|Wachstumsplattform|motor de crecimiento|moteur de croissance|Kasvumoottori|Tillväxtmotorn/i],
    ["a speed promise", /in minutes|minutes, not|60 seconds|in seconds|in an afternoon|under 5 minutes|days, not months|in one step/i],
    ["the daily briefing / the Coach", /briefing|\bcoach/i],
    // "affiliated" is the independence sentence, not the add-on.
    ["affiliates / add-ons for sale", /affiliate(?!d)|DM Champ|\badd-ons?\b/i],
    ["competitor tools / rank tracking / audits", /competitor (radar|tracker|tool)|rank track|\baudit/i],
    ["Search Console data or tracking", /Search Console data|track(ing)? [a-z ]*Search Console|\bGSC\b/i],
    ["Content Factory / Quick Page Builder / Data Export", /Content Factory|Quick Page Builder|Data Export|export your data/i],
  ] as const) {
    t(`${file}: no ${label}`, !re.test(src), src.match(re)?.[0]);
  }
}
for (const [label, re] of [
  ["Sharetribe sync", /Sharetribe sync/],
  ["coverage opportunities from real inventory", /Coverage opportunities/],
  ["three page templates", /Three page templates/],
  ["drafts you edit and preview", /Drafts you edit and preview/],
  ["publishing on your verified domain", /Publishing on your domain/],
  ["an automatic sitemap", /Automatic sitemap/],
] as const) {
  t(`homepage: a card for ${label}`, re.test(home));
}
t("/beta lists what the MVP does", /id="what-you-can-do"/.test(beta) && /coverage opportunities/.test(beta) && /three page templates/.test(beta) && /verified/.test(beta) && /sitemap/.test(beta));
t("the plan catalog still drives both pages (pricing unchanged)", /PAGE_PLANS\.map/.test(home) && /PAGE_PLANS\.map/.test(beta) && /PAGE_ADDON\.monthlyPrice/.test(home) && /PAGE_ADDON\.monthlyPrice/.test(beta));
t("the homepage no longer shows the demo video (another product's admin, with deferred tools)", !/product-demo\.mp4|Watch the demo/.test(home));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
