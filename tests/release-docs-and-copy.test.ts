/**
 * RELEASE CHECKLIST, DIALOG COPY AND THE ROUND-4 RELEASE LOWS.
 * Run: bun tests/release-docs-and-copy.test.ts
 *
 *  - M6 / security L6: one ordered release checklist in the repo
 *    (docs/RELEASE_CHECKLIST.md) — CRON_SECRET parity without printing it,
 *    every migration before the Worker deploy, verify_jwt=false deploys with
 *    their _shared files, the four legacy deletes with a 404 check each, the
 *    burn-in removal of the Worker's OPENROUTER_API_KEY only. And the rollback
 *    README no longer says 000900 may follow the app (M3).
 *  - M2: the Daily Briefing never promises a revert that does not exist, and
 *    add_meta is worded without column names (L3).
 *  - The cheap copy / SEO / UI LOWs (L1, L2, L3, L6, L7, L8, L9, L10).
 * Offline.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describePlanStatus } from "../src/components/billing/plan-status";

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
/** Source without comments: what renders, not what a comment says was removed. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ---------------------------------------------------------------------------
console.log("\nM6: one ordered release checklist");

const cl = read("docs/RELEASE_CHECKLIST.md");
const at = (s: string) => cl.indexOf(s);
const order = [
  "## 0. Before the window",
  "## 1. Secrets",
  "## 2. Migrations",
  "## 3. Edge functions",
  "## 4. Deploy the app",
  "## 5. Smoke",
  '## 6. Dashboard "Generate now"',
  "## 7. Kill-switch drill",
  "## 8. Delete the four legacy functions",
  "## 9. Watch",
  "## 10. After the burn-in",
  "## Rollback",
];
t(
  "every step is there, in order",
  order.every((h, i) => at(h) >= 0 && (i === 0 || at(h) > at(order[i - 1]!))),
  order.map(at).join(","),
);
t(
  "DEPLOYMENT.md points at it",
  /\[`docs\/RELEASE_CHECKLIST\.md`\]\(RELEASE_CHECKLIST\.md\)/.test(read("docs/DEPLOYMENT.md")),
);

// Secrets
const secrets = cl.slice(at("## 1. Secrets"), at("## 2. Migrations"));
t(
  "the Worker's OPENAI_API_KEY is checked",
  /wrangler secret list --name founders-click/.test(secrets) && /OPENAI_API_KEY/.test(secrets),
);
t(
  "the Supabase function secret OPENAI_API_KEY is checked and set from a file",
  /supabase secrets list --project-ref xbxhzinnfhosoztqaaao/.test(secrets) &&
    /supabase secrets set --env-file/.test(secrets),
);
t(
  "CRON_SECRET parity covers the Worker, Vault and coach-briefing-cron",
  /identical in the Worker, in Vault and in the\s+`coach-briefing-cron` function secret/.test(
    secrets,
  ),
);
t(
  "…by behaviour from inside the database: the value is never selected or printed",
  /public\._cron_secret\(\)/.test(secrets) &&
    /net\.http_post/.test(secrets) &&
    /net\._http_response/.test(secrets) &&
    /do not select the value/.test(secrets) &&
    !/SELECT\s+decrypted_secret/i.test(secrets),
);
t(
  "…probing the Worker hook and the function",
  /hooks\/sync-sharetribe/.test(secrets) && /functions\/v1\/coach-briefing-cron/.test(secrets),
);
t(
  "…with a nil workspace, so the probes change nothing",
  (secrets.match(/00000000-0000-0000-0000-000000000000/g) ?? []).length === 2,
);
t(
  "…and says what a 401 / 503 means",
  /A 401 means that copy differs from Vault/.test(secrets) &&
    /503 means the function has no `CRON_SECRET`/.test(secrets),
);
t(
  "the Supabase OPENROUTER_API_KEY is kept (PRNM)",
  /Supabase `OPENROUTER_API_KEY` forever \(PRNM\)/.test(secrets),
);
t(
  "no secret-looking literal anywhere in the checklist",
  !/\b(sk-[A-Za-z0-9]{16,}|sk_live_\w+|whsec_\w{8,}|eyJ[A-Za-z0-9_-]{20,})/.test(cl),
);

// Migrations: every file from the launch series, in apply order, before the deploy.
const migSection = cl.slice(at("## 2. Migrations"), at("## 3. Edge functions"));
const versions = readdirSync(join(ROOT, "supabase/migrations"))
  .filter((f) => /^\d{14}_.+\.sql$/.test(f) && f.slice(0, 14) >= "20260923000100")
  .map((f) => f.slice(0, 14))
  .sort();
const positions = versions.map((v) => migSection.indexOf(v));
t(
  `every launch migration (${versions.length}, from 20260923000100) is listed in the migration step`,
  versions.length >= 10 && positions.every((p) => p >= 0),
  versions.filter((_, i) => positions[i]! < 0).join(", "),
);
t(
  "…in apply order",
  positions.every((p, i) => i === 0 || p > positions[i - 1]!),
);
t(
  "…ending with the founder data migration (000930), now that the file exists",
  /`20260925000930_founder_internal_unlimited\.sql` \(data: at most one grant for the founder workspace/.test(migSection),
);
t(
  "…every one BEFORE the Worker deploy, 000900/000910 included (M3)",
  /## 2\. Migrations — every one of them BEFORE the Worker deploy/.test(cl) &&
    /\*\*000900 and 000910 must precede the deploy\*\*/.test(migSection),
);
t(
  "…each verified by its own block, stopping on a false row",
  /verification block at the end of that file/.test(migSection) &&
    /stop on any\s+`false`/.test(migSection),
);

// Edge functions
const fnSection = cl.slice(at("## 3. Edge functions"), at("## 4. Deploy the app"));
for (const fn of ["stripe-webhook", "coach-briefing-cron"]) {
  t(
    `${fn} deploys with --no-verify-jwt`,
    new RegExp(
      `supabase functions deploy ${fn}\\s+--no-verify-jwt --project-ref xbxhzinnfhosoztqaaao`,
    ).test(fnSection),
  );
  t(
    `${fn}: supabase/config.toml agrees (verify_jwt = false)`,
    new RegExp(`\\[functions\\.${fn}\\]\\s*\\nverify_jwt = false`).test(
      read("supabase/config.toml"),
    ),
  );
}
t(
  "create-checkout (changed for M1) deploys with JWT verification on",
  /supabase functions deploy create-checkout\s+--project-ref xbxhzinnfhosoztqaaao/.test(
    fnSection,
  ) && !/deploy create-checkout[^\n]*--no-verify-jwt/.test(fnSection),
);
for (const fn of ["stripe-webhook", "coach-briefing-cron", "create-checkout"]) {
  const shared = [
    ...read(`supabase/functions/${fn}/index.ts`).matchAll(/from "\.\.\/_shared\/([\w.-]+\.ts)"/g),
  ].map((m) => m[1]!);
  const line = fnSection.split("\n").find((l) => l.startsWith(`- \`${fn}\`:`)) ?? "";
  t(
    `the MCP file list for ${fn} names every _shared file it imports (${shared.join(", ")})`,
    shared.length > 0 && shared.every((f) => line.includes(`../_shared/${f}`)),
    line,
  );
}
t(
  "the stripe-webhook check expects the function's own 400, not a gateway 401",
  /stripe-signature: t=1,v1=bogus/.test(fnSection) &&
    /400 \{"error":"Invalid webhook signature"\}/.test(fnSection),
);

// Deploy, smoke, Generate now, kill switch
t(
  "the deploy is a push to main through deploy-app.yml",
  /git push origin <SHA>:main/.test(cl) && /deploy-app\.yml/.test(cl),
);
t(
  "smoke runs the production smoke with the SHA",
  /bun scripts\/smoke-production\.ts https:\/\/www\.founders\.click --sha <SHA>/.test(cl),
);
t(
  "smoke checks the retired BYOK URL 404s and the help sitemap (M3)",
  /bring-your-own-ai-key-byok` → \*\*404\*\*/.test(cl) && /help\/sitemap\.xml/.test(cl),
);
t(
  "the ops probe is not relied on (OPS_PROBE_SECRET is not a Worker secret)",
  /OPS_PROBE_SECRET/.test(cl) && /not a Worker secret/.test(cl),
);
t(
  '"Generate now" is the end-to-end CRON_SECRET check',
  /Generate now/.test(cl) && /end-to-end CRON_SECRET check/.test(cl),
);
t(
  "the kill-switch drill turns it off, checks the sentence, turns it back on",
  /SET platform_ai_enabled = false/.test(cl) &&
    /AI features are paused\s+platform-wide right now\. Try again later\./.test(cl) &&
    /SET platform_ai_enabled = true/.test(cl),
);

// Legacy deletes
const del = cl.slice(at("## 8. Delete the four legacy functions"), at("## 9. Watch"));
const LEGACY = ["ai-proxy", "coach-chat", "help-assistant-chat", "help-assistant-embed"];
for (const f of LEGACY) {
  t(
    `delete ${f} with the exact command`,
    new RegExp(`supabase functions delete ${f}\\s+--project-ref xbxhzinnfhosoztqaaao`).test(del),
  );
}
t(
  "a 404 check covers each of the four",
  /for f in ai-proxy coach-chat help-assistant-chat help-assistant-embed; do/.test(del) &&
    /\[ "\$code" = 404 \]/.test(del),
);
t(
  "…with a customer token, never an admin's",
  /throwaway customer account's access token/.test(del) && /never an admin's/.test(del),
);
t(
  "coach-chat goes only after the Worker deploy",
  /delete `coach-chat` only after step 4/.test(del),
);
t("the PRNM isolation probe follows", /bun scripts\/probe-prnm-isolation\.ts/.test(del));

// Burn-in
const burn = cl.slice(at("## 10. After the burn-in"), at("## Rollback"));
t(
  "burn-in deletes the Worker's OPENROUTER_API_KEY",
  /bunx wrangler secret delete OPENROUTER_API_KEY --name founders-click/.test(burn),
);
t(
  "…and never the Supabase one",
  /\*\*Never\*\* `supabase secrets unset OPENROUTER_API_KEY`: PRNM/.test(burn) &&
    !/^\s*supabase secrets unset/m.test(cl),
);
t(
  "rollback of a fast-forward release restores the old tree in one commit (round-4 L9)",
  /git rm -r -q \. && git checkout 123534f -- \. && git commit/.test(cl) &&
    /git diff --stat 123534f HEAD\s+# must be empty/.test(cl),
);

console.log("\nM3: the rollback README orders the help migrations before the deploy");
const rb = read("supabase/rollback/README.md");
t(
  "no longer says 000900 may run before or after the app",
  !/before or after the app release/.test(rb) && !/With the app first/.test(rb),
);
t(
  "says 000900 then 000910 BEFORE the Worker deploy",
  /\*\*Apply 000900, then 000910, BEFORE the Worker deploy\*\*/.test(rb),
);
t(
  "the verification heading counts what it covers (was 'all eight' of ten)",
  !/run after applying all eight\)/.test(rb) &&
    /000900 and 000910 have their own checks below/.test(rb),
);

// ---------------------------------------------------------------------------
console.log("\nM2: the Daily Briefing promises nothing it cannot do");
const db = read("src/components/coach/DailyBriefing.tsx");
t("no revert / history promise left", !/revert/i.test(code(db)) && !/history/i.test(code(db)));
t(
  "the replaced-text sentence is the requested one",
  db.includes(`const PAGE_TEXT_IS_REPLACED = "This replaces the page text and can't be undone.";`),
);
const body = (key: string) =>
  db.slice(db.indexOf(`  ${key}: {`), db.indexOf("\n  },", db.indexOf(`  ${key}: {`)));
t(
  "fix_thin_page says it",
  /\$\{PAGE_TEXT_IS_REPLACED\}/.test(body("fix_thin_page")) &&
    !/markdown/i.test(body("fix_thin_page")),
);
t("add_internal_links says it", /\$\{PAGE_TEXT_IS_REPLACED\}/.test(body("add_internal_links")));
t("add_meta says it can't be undone", /This can't be undone\./.test(body("add_meta")));
t(
  "add_meta names no column (L3)",
  !/seo_title|seo_description|meta_description/.test(body("add_meta")) &&
    /page title and meta description/.test(body("add_meta")),
);

// ---------------------------------------------------------------------------
console.log("\nL1: numbers render the same on the server and in every browser");
for (const f of ["src/routes/index.tsx", "src/routes/beta.tsx"]) {
  const src = read(f);
  t(
    `${f}: no locale-dependent toLocaleString()`,
    !/\.toLocaleString\(\)/.test(src) && /\.toLocaleString\("en-US"\)/.test(src),
  );
}
t(
  "de-DE would have printed a different number (the hydration mismatch)",
  (1000).toLocaleString("de-DE") !== (1000).toLocaleString("en-US"),
);

console.log("\nL2: /beta, /terms and /privacy are styled");
for (const f of ["src/components/LegalLayout.tsx", "src/routes/beta.tsx"]) {
  const src = read(f);
  t(
    `${f} uses the help typography, not the missing prose plugin`,
    /className=\{`mt-8 \$\{ARTICLE_BODY_CLASS\}`\}/.test(src) && !/className="prose/.test(src),
  );
}
t(
  "@tailwindcss/typography is still not installed (so prose would style nothing)",
  !/@tailwindcss\/typography/.test(read("package.json")),
);

console.log("\nL3: no provider name on the generate page or the coach");
t(
  "the generate page no longer points at the hidden BYOK key",
  !/own OpenAI key/.test(read("src/routes/_authenticated/app.content.generate.tsx")),
);
t(
  "the SEO coach no longer says 'Powered by OpenAI'",
  !/Powered by OpenAI/.test(read("src/routes/_authenticated/app.seo-coach.tsx")),
);

console.log("\nL6: copy that promised more than the product does");
const home = read("src/routes/index.tsx");
t(
  "the Quick Page Builder card says it publishes in one step",
  /publish it in one step/.test(home) && !/then publish when it's ready/.test(home),
);
t(
  "the article page's reply time is 'usually', not a promise",
  /Our team usually replies within 1 business day\./.test(
    read("src/routes/help.$category_.$article.tsx"),
  ),
);
t(
  "so is the help home's",
  !/and we'll get back to you within one business day/.test(read("src/routes/help.index.tsx")),
);

console.log("\nL7: the dashboard no longer advertises a hidden page");
const dash = read("src/routes/_authenticated/app.index.tsx");
t(
  "no link to the launch-hidden GSC import",
  !/\/app\/seo\/gsc-import/.test(code(dash)) && !/track clicks and impressions/.test(code(dash)),
);
t(
  "the Coach link stays behind its switch",
  /\{coachEnabled && \(\s*<Button[\s\S]*?to="\/app\/coach"/.test(dash),
);

console.log("\nL8: SEO hygiene");
const robots = read("public/robots.txt");
/** Google's robots.txt matching: `*` wildcards, a trailing `$` anchor, the longest rule wins, a tie goes to Allow. */
function allowed(path: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  let inStar = false;
  for (const raw of robots.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^(user-agent|allow|disallow)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    if (key === "user-agent") {
      inStar = m[2]!.trim() === "*";
      continue;
    }
    const rule = m[2]!.trim();
    if (!inStar || !rule) continue;
    const anchored = rule.endsWith("$");
    const re = new RegExp(
      "^" +
        (anchored ? rule.slice(0, -1) : rule)
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        (anchored ? "$" : ""),
    );
    if (!re.test(path)) continue;
    const cand = { len: rule.length, allow: key === "allow" };
    if (!best || cand.len > best.len || (cand.len === best.len && cand.allow)) best = cand;
  }
  return best ? best.allow : true;
}
t("/app itself is disallowed (was allowed)", !allowed("/app"));
t("everything under /app/ stays disallowed", !allowed("/app/") && !allowed("/app/billing"));
t("/apply/<slug> is NOT caught by the /app rule", allowed("/apply/pool-rental-near-me"));
t(
  "/login, /signup, /reset-password are crawlable, so their noindex can be read",
  allowed("/login") && allowed("/signup") && allowed("/reset-password"),
);
t(
  "…and each still says noindex",
  ["src/routes/login.tsx", "src/routes/signup.tsx", "src/routes/reset-password.tsx"].every((f) =>
    read(f).includes('{ name: "robots", content: "noindex, nofollow" }'),
  ),
);
t(
  "public pages stay crawlable",
  ["/", "/help", "/help/start-here/x", "/beta", "/terms", "/a/x"].every(allowed),
);
t(
  "both sitemaps are still announced",
  /Sitemap: https:\/\/www\.founders\.click\/sitemap\.xml/.test(robots) &&
    /Sitemap: https:\/\/www\.founders\.click\/help\/sitemap\.xml/.test(robots),
);
t(
  "the app shell's head says noindex (it SSRs even with ssr:false)",
  /head: \(\) => \(\{ meta: \[\{ name: "robots", content: "noindex, nofollow" \}\] \}\),/.test(
    read("src/routes/_authenticated.tsx"),
  ),
);
for (const f of ["src/routes/reset-password.tsx", "src/routes/help.search.tsx"]) {
  t(`${f} renders exactly one <h1>`, (read(f).match(/<h1\b/g) ?? []).length === 1);
}
const helpMap = read("src/routes/help.sitemap[.]xml.tsx");
t(
  "the help sitemap's lastmod values are real (article dates), never 'now'",
  !/lastmod: new Date\(\)\.toISOString\(\)/.test(helpMap) &&
    /isoOrUndefined\(a\.updated_at\)/.test(helpMap),
);
const staticMap = read("src/routes/sitemap[.]xml.tsx");
t(
  "the static sitemap's lastmod is the build date, not today",
  /Date\.parse\(BUILD_TIME\)/.test(staticMap) && !/const today = new Date\(\)/.test(staticMap),
);
t(
  "the affiliate application page no longer promises an email nothing sends",
  !/We'll email you/.test(read("src/routes/apply.$slug.tsx")),
);

console.log("\nL9: release-mechanics and doc drift");
const deploy = read(".github/workflows/deploy-app.yml");
t(
  "the secrets preflight skips only on Cloudflare's worker-not-found code",
  /grep -qiE "script_not_found\|\\b10007\\b" \/tmp\/secret-err/.test(deploy) &&
    !/could not find\|not found"/.test(deploy),
);
t(
  "README and .env.example no longer send BYOK to 'Settings → API Keys'",
  !/Settings → API Keys/.test(read("README.md")) &&
    !/Settings → API Keys/.test(read(".env.example")),
);
t(
  "README no longer describes a Lovable deploy flow",
  !/Typical flow \(Lovable or manual\)/.test(read("README.md")),
);
t(
  "the edge README no longer says the app ships through Lovable",
  !/ships through Lovable/.test(read("edge/founders-edge/README.md")) &&
    !/Lovable secrets/.test(read("edge/founders-edge/README.md")),
);

console.log("\nL10: billing and allowance wording");
t(
  "the dashboard's AI card says what it counts (a rolling 24 hours)",
  /AI pages \(last 24 hours\)/.test(dash) && !/AI pages today/.test(dash),
);
t(
  "…and no longer says 'Included with your plan' to trial and beta workspaces",
  !/Included with your plan/.test(dash),
);
const NOW = Date.parse("2026-09-25T12:00:00Z");
const paid = (status: string) =>
  describePlanStatus(
    {
      subscriptionStatus: status,
      trialEndsAt: null,
      currentPeriodEnd: "2026-10-20T00:00:00Z",
      planKey: "growth",
    },
    { now: NOW, timeZone: "UTC" },
  );
t("an active plan's badge is the plan name", paid("active").badge === "Growth");
t(
  "a past-due plan's badge says so",
  paid("past_due").badge === "Growth · Payment past due",
  paid("past_due").badge,
);
t(
  "a cancelled plan's badge says so",
  paid("canceled").badge === "Growth · Cancelled",
  paid("canceled").badge,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
