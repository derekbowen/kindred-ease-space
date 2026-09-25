/**
 * HELP CENTER DATA FIX (20260925000900). Run: bun tests/help-center-migration.test.ts
 *
 * Six platform help articles were filed under Pool Rental Near Me's
 * categories and 404'd; four Sharetribe articles described a connect flow the
 * product no longer has. The migration must touch ONLY platform rows
 * (workspace_id IS NULL), be idempotent, and ship with a rollback that holds
 * the previous text verbatim. Offline: parses the SQL text and cross-checks it
 * against the launch code and the original seed migration.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
const MIGRATION = "supabase/migrations/20260925000900_help_center_platform_fix.sql";
const ROLLBACK = "supabase/rollback/20260925000900_help_center_platform_fix_rollback.sql";

/** Split SQL into statements, respecting quotes, dollar quotes and comments. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
      cur += "\n";
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        cur += sql.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }
    if (ch === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Statement text with every quoted literal blanked, for structural checks. */
const skeleton = (s: string) =>
  s.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "$$…$$").replace(/'(?:[^']|'')*'/g, "'…'");

const kindOf = (s: string) => {
  const k = skeleton(s).replace(/^WITH[\s\S]*?\)\s*(?=UPDATE|INSERT|DELETE)/i, "");
  const m = k.match(/^(INSERT INTO|UPDATE|DELETE FROM)\s+(public\.\w+)/i);
  return m ? { verb: m[1].toUpperCase(), table: m[2] } : null;
};

const mig = read(MIGRATION);
const stmts = statements(mig);
const writes = stmts.filter((s) => kindOf(s));

// ---------------------------------------------------------------------------
console.log("\nonly platform rows are touched");

t("the migration has data-changing statements", writes.length >= 10, String(writes.length));
t(
  "every write targets help_categories or help_articles",
  writes.every((s) => ["public.help_categories", "public.help_articles"].includes(kindOf(s)!.table)),
);
t("nothing is deleted", !writes.some((s) => kindOf(s)!.verb === "DELETE FROM"));
t(
  "no DDL (data only)",
  !stmts.some((s) => /^\s*(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i.test(skeleton(s))),
);
const updates = writes.filter((s) => kindOf(s)!.verb === "UPDATE");
for (const u of updates) {
  const sk = skeleton(u);
  const where = sk.slice(sk.search(/\bWHERE\b/i));
  const slug = u.match(/\bslug = '([a-z0-9-]+)'/)?.[1] ?? "?";
  t(
    `UPDATE ${slug}: guarded by workspace_id IS NULL AND slug = '…'`,
    /\b(a\.)?workspace_id IS NULL\b/.test(where) && /\b(a\.)?slug = '…'/.test(where),
    sk.slice(0, 200),
  );
  t(
    `UPDATE ${slug}: idempotent (IS DISTINCT FROM, or only from the old value)`,
    /IS DISTINCT FROM/.test(where) ||
      /category_slug = '…'/.test(where) ||
      /excerpt = '…'/.test(where) ||
      /reading_time_minutes = \d+/.test(where),
  );
}
const inserts = writes.filter((s) => kindOf(s)!.verb === "INSERT INTO");
t("exactly one insert: the start-here category", inserts.length === 1 && /'start-here'/.test(inserts[0]));
t(
  "the category insert writes workspace_id NULL and only when absent",
  /workspace_id\)/.test(inserts[0]) &&
    /true,\s*NULL\s*WHERE NOT EXISTS \(SELECT 1 FROM public\.help_categories WHERE slug = 'start-here'\)/.test(
      inserts[0].replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")"),
    ),
  inserts[0].slice(-200),
);
t(
  "Pool Rental Near Me's categories are never written",
  !writes.some((s) => kindOf(s)!.table === "public.help_categories" && kindOf(s)!.verb !== "INSERT INTO") &&
    !writes.some((s) => /SET category_slug = 'getting-started'|SET category_slug = 'billing'/.test(s)),
);
t(
  "'getting-started' appears in writes only as the old value of a platform article move",
  writes
    .filter((s) => s.includes("'getting-started'"))
    .every((s) => /SET category_slug = 'start-here'/.test(s) && /AND category_slug = 'getting-started'/.test(s)),
);
t(
  "a workspace-owned start-here aborts before any change",
  /IF EXISTS \(\s*SELECT 1 FROM public\.help_categories\s*WHERE slug = 'start-here' AND workspace_id IS NOT NULL\s*\) THEN\s*RAISE EXCEPTION/.test(mig) &&
    mig.indexOf("RAISE EXCEPTION") < mig.indexOf("INSERT INTO public.help_categories"),
);

// ---------------------------------------------------------------------------
console.log("\nwhat moves, and the category");

for (const slug of [
  "welcome-to-founders-click",
  "connecting-your-sharetribe-marketplace",
  "running-your-first-listing-sync",
  "creating-your-first-seo-page",
  "publishing-pages-and-getting-indexed",
]) {
  t(
    `${slug} moves getting-started → start-here`,
    new RegExp(
      `UPDATE public\\.help_articles SET category_slug = 'start-here'\\s+WHERE workspace_id IS NULL AND slug = '${slug}' AND category_slug = 'getting-started'`,
    ).test(mig),
  );
}
t(
  'start-here is "Getting started", published, first in order',
  /SELECT 'start-here',\s*'Getting started',/.test(mig) &&
    /LEAST\(0, COALESCE\(\(SELECT min\(c\.sort_order\) FROM public\.help_categories c WHERE c\.workspace_id IS NULL\), 1\) - 1\),\s*true,/.test(mig),
);

// ---------------------------------------------------------------------------
console.log("\nBYOK is unpublished the way the admin UI unpublishes");

const admin = read("src/lib/help-admin.functions.ts");
t(
  "the admin editor's draft is status 'draft' with is_published false",
  /status: z\.enum\(\["draft", "published", "archived"\]\)\.default\("draft"\)/.test(admin) &&
    /is_published: isPublishing/.test(admin) &&
    /const isPublishing = data\.status === "published"/.test(admin),
);
t(
  "the migration sets exactly that on the BYOK article",
  /UPDATE public\.help_articles SET status = 'draft', is_published = false\s+WHERE workspace_id IS NULL AND slug = 'bring-your-own-ai-key-byok'/.test(mig),
);
const helpServer = read("src/lib/help.server.ts");
t(
  "the public help center reads only status 'published' (so a draft disappears)",
  (helpServer.match(/\.eq\("status", "published"\)/g) ?? []).length >= 5,
);

// ---------------------------------------------------------------------------
console.log("\nthe rewritten articles describe the launch product");

const bodies = [...mig.matchAll(/\$md\$([\s\S]*?)\$md\$/g)].map((m) => m[1]);
const [connect, whereToFind, troubleshoot, firstSync] = bodies;
t("four rewritten bodies", bodies.length === 4, String(bodies.length));
t("no body repeats the title as a # heading (the page renders the <h1>)", bodies.every((b) => !/^#\s/.test(b)));
const all = bodies.join("\n");
for (const stale of [
  "Test connection",
  "Re-paste your client secret",
  "Sync history",
  "on the dashboard",
  "paste both values",
  "Add new application",
  "5,000 listings",
  "mapped automatically",
  "Author profiles",
]) {
  t(`no longer says "${stale}"`, !all.includes(stale));
}

const sharetribePage = read("src/routes/_authenticated/app.settings.integrations.sharetribe.tsx");
const shown = (label: string) => sharetribePage.includes(label.replace("&", "&amp;")) || sharetribePage.includes(label);
for (const label of [
  "Marketplace URL",
  "Client ID",
  "Client Secret",
  "Validate & Connect",
  "Sync now",
  "Listings imported",
  "Sync status",
  "Needs attention",
  "Marketplace API",
  "Integration API",
  "Build → Applications",
]) {
  t(`the article names "${label}", which the launch page shows`, all.includes(label) && shown(label));
}
t("the launch page promises the ~30-minute refresh the articles repeat", /refreshed automatically about every 30 minutes/.test(sharetribePage) && /about every 30 minutes/.test(firstSync) && /about every 30 minutes/.test(troubleshoot));
t("…and the cron behind it runs every 30 minutes", /'\*\/30 \* \* \* \*'/.test(read("supabase/migrations/20260923000200_sync_fanout_cron.sql")));

t("(a) Marketplace URL + Client ID, read-only, no secret needed", /Marketplace URL/.test(connect) && /read-only/.test(connect) && /don't need the application's client secret/.test(connect));
t("(a) the marketplace's ID and name are looked up, not typed", /looks up your marketplace's ID and name itself/.test(connect));
const syncFns = read("src/lib/sharetribe-sync.functions.ts");
t("…as connectSharetribe does (validateSharetribeCredentials → marketplace/show)", /marketplace_id: v\.marketplaceId/.test(syncFns) && /marketplace_name: v\.name/.test(syncFns));
t("(a) Integration API only as the advanced option", /## Advanced: Integration API/.test(connect));
t("(a) one workspace per marketplace", /one founders\.click workspace at a time/.test(connect) && /MARKETPLACE_ALREADY_CONNECTED_ERROR/.test(syncFns));
t("(a) owner-only, as the server enforces", /Only the workspace owner can connect/.test(connect) && /assertWorkspaceOwner\(data\.workspaceId, context\.userId\)/.test(syncFns));
t('(b) retitled "Where to find your Client ID", slug kept', /SELECT 'Where to find your Client ID'::text/.test(mig) && /a\.slug = 'where-to-find-integration-api-credentials'/.test(mig));
t("(b) Marketplace API first, secret only for the advanced option (shown once)", whereToFind.indexOf("Marketplace API (recommended)") < whereToFind.indexOf("Integration API (advanced)") && /shows the secret only once/.test(whereToFind));

const syncServer = read("src/lib/sharetribe-sync.server.ts");
const quoted = [...troubleshoot.matchAll(/\*\*"([^"]+)"\*\*/g)].map((m) => m[1]);
t("(c) explains the messages customers actually see", quoted.length >= 4, quoted.join(" | "));
for (const q of quoted) {
  t(`(c) "${q}" is a real message`, syncServer.includes(q), q);
}
t("(c) points at the Sharetribe page, not a Sync history screen", /\*\*Sharetribe\*\* page/.test(troubleshoot));

const mapListing = syncServer.slice(syncServer.indexOf("export function mapListing"), syncServer.indexOf("/** Run a sync for one workspace"));
for (const [claim, field] of [
  ["title and description", "description:"],
  ["price and currency", "price_currency:"],
  ["city, state and country", "country:"],
  ["map location", "lat:"],
  ["category", "category:"],
  ["photos", "images,"],
  ["the author's display name", "author_name:"],
  ["other public fields", "custom_fields: { publicData: pub, metadata: meta }"],
  ["a link back to the listing", "marketplace_url: listingUrl"],
] as const) {
  t(`(d) "${claim}" is imported by mapListing`, firstSync.includes(claim) && mapListing.includes(field));
}
t("(d) Sync now is on the Sharetribe page, not the dashboard", /open \*\*Sharetribe\*\* in the sidebar/.test(firstSync) && /click \*\*Sync now\*\*/.test(firstSync));
t("(d) private data is never imported (only publicData/metadata are kept)", /Private listing data is never imported/.test(firstSync) && !/privateData/.test(mapListing.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")));
t("(d) 100 listings per page, as the sync requests", /100 at a time/.test(firstSync) && /per_page: "100"/.test(syncServer));

for (const href of [...all.matchAll(/\]\((\/[^)]+)\)/g)].map((m) => m[1])) {
  const ok =
    href === "/help/contact" ||
    /^\/help\/start-here\/(running-your-first-listing-sync|connecting-your-sharetribe-marketplace)$/.test(href);
  t(`link ${href} points at a page that exists after this migration`, ok);
}

// "N min read" follows the new text, computed like the admin editor.
function readingTime(md: string): number {
  const words = md.replace(new RegExp("[`*_#>\\-\\[\\]()]", "g"), " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}
t("readingTime() here is the admin editor's formula", admin.includes('.replace(new RegExp("[`*_#>\\\\-\\\\[\\\\]()]", "g"), " ")') && admin.includes("Math.max(1, Math.round(words / 200))"));
for (const [slug, body, from] of [
  ["connecting-your-sharetribe-marketplace", connect, 4],
  ["where-to-find-integration-api-credentials", whereToFind, 2],
  ["troubleshooting-failed-syncs", troubleshoot, 4],
  ["running-your-first-listing-sync", firstSync, 2],
] as const) {
  const want = readingTime(body);
  t(
    `${slug}: reading time ${from} → ${want}, only from ${from}`,
    new RegExp(
      `SET reading_time_minutes = ${want}\\s+WHERE workspace_id IS NULL AND slug = '${slug}' AND reading_time_minutes = ${from};`,
    ).test(mig),
  );
}

// ---------------------------------------------------------------------------
console.log("\nthe rollback holds the previous text verbatim");

t("rollback file exists", existsSync(join(ROOT, ROLLBACK)));
const rb = read(ROLLBACK);
// Production content on 2026-09-25 (the brief's appendix), byte for byte.
const APPENDIX: Record<string, string> = {
  "connecting-your-sharetribe-marketplace":
    "# Connecting your Sharetribe marketplace\n\nThis takes about 5 minutes.\n\n## 1. Create Integration API credentials\n\nGo to **Sharetribe Console -> Build -> Applications** and click *Add new*. Pick the **Integration API** scope.\n\n## 2. Copy your client ID and secret\n\nSharetribe shows the client secret only once. Copy both immediately.\n\n## 3. Paste them into founders.click\n\nOpen **Workspace Settings -> Sharetribe** and paste both values, then click *Test connection*.",
  "running-your-first-listing-sync":
    "# Running your first sync\n\nOnce Sharetribe is connected, hit **Sync now** on the dashboard. The first sync pulls every published listing.\n\n## What gets synced\n\n- Listing titles, descriptions, prices\n- Custom fields (mapped automatically when names match)\n- Author profiles\n- Photos\n\n## How long does it take?\n\nMost marketplaces sync in under 2 minutes. Marketplaces over 5,000 listings can take up to 15 minutes.",
  "troubleshooting-failed-syncs":
    "# Troubleshooting failed syncs\n\n## Most common causes\n\n1. **Invalid credentials** - Re-paste your client secret\n2. **API rate limits** - Sharetribe limits to 60 req/min. Wait and retry.\n3. **Schema mismatch** - A custom field type changed in Sharetribe\n\nCheck **Settings -> Sync history** for the error log.",
  "where-to-find-integration-api-credentials":
    "# Finding your Integration API credentials\n\n1. Log in to **Sharetribe Console**\n2. Open **Build -> Applications**\n3. Click *Add new application*\n4. Choose **Integration API**\n5. Copy the client ID and secret immediately",
};
const oldBodies = [...rb.matchAll(/\$old\$([\s\S]*?)\$old\$/g)].map((m) => m[1]);
// The seed migration that created these rows holds the same text as E'' strings.
const seed = read("supabase/migrations/20260511071212_5e1df68f-1937-4a7a-a5f6-8e9cf361abf2.sql");
const seedText = (slug: string) => {
  const m = seed.match(new RegExp(`\\('[a-z-]+','${slug}','[^']*','([^']*)',E'((?:[^']|'')*)',(\\d+)\\)`));
  return m ? { excerpt: m[1], content: m[2].replace(/\\n/g, "\n").replace(/''/g, "'"), minutes: Number(m[3]) } : null;
};
for (const [slug, text] of Object.entries(APPENDIX)) {
  t(`${slug}: the rollback restores the production text byte for byte`, oldBodies.includes(text));
  t(`${slug}: …which is also the seed migration's text`, seedText(slug)?.content === text);
  t(
    `${slug}: the restore is guarded by workspace_id IS NULL AND slug`,
    new RegExp(`a\\.workspace_id IS NULL AND a\\.slug = '${slug}'`).test(rb),
  );
}
t('the old title "Where to find your Integration API credentials" comes back', /SELECT 'Where to find your Integration API credentials'::text/.test(rb));
for (const slug of ["connecting-your-sharetribe-marketplace", "where-to-find-integration-api-credentials"]) {
  const s = seedText(slug)!;
  t(`${slug}: excerpt restored from its seeded text, only where the migration's text is`, rb.includes(`SET excerpt = '${s.excerpt}'`) && mig.includes(`AND excerpt = '${s.excerpt}'`));
}
for (const slug of Object.keys(APPENDIX)) {
  const s = seedText(slug)!;
  t(`${slug}: reading time restored to the seeded ${s.minutes}`, new RegExp(`SET reading_time_minutes = ${s.minutes}\\s+WHERE workspace_id IS NULL AND slug = '${slug}'`).test(rb));
}
t(
  "BYOK back to status 'published', is_published true",
  /UPDATE public\.help_articles SET status = 'published', is_published = true\s+WHERE workspace_id IS NULL AND slug = 'bring-your-own-ai-key-byok'/.test(rb),
);
t(
  "the five go back to 'getting-started', only from 'start-here'",
  (rb.match(/SET category_slug = 'getting-started'\s+WHERE workspace_id IS NULL AND slug = '[a-z-]+' AND category_slug = 'start-here';/g) ?? []).length === 5,
);
t(
  "start-here is removed only if nothing else is filed under it",
  /DELETE FROM public\.help_categories\s+WHERE workspace_id IS NULL AND slug = 'start-here'[\s\S]*?AND NOT EXISTS \(SELECT 1 FROM public\.help_articles WHERE category_slug = 'start-here'\);/.test(rb),
);
const rbWrites = statements(rb).filter((s) => kindOf(s));
t(
  "every rollback write is limited to workspace_id IS NULL",
  rbWrites.length > 0 && rbWrites.every((s) => /\b(a\.)?workspace_id IS NULL\b/.test(skeleton(s))),
);
t("the rollback runs in one transaction and ends with a VERIFY", /^BEGIN;$/m.test(rb) && /^COMMIT;$/m.test(rb) && /-- VERIFY/.test(rb));

// ---------------------------------------------------------------------------
console.log("\ndocumented");

const readme = read("supabase/rollback/README.md");
t("the rollback README has an entry for 20260925000900", /## 20260925000900/.test(readme) && readme.includes(ROLLBACK) && readme.includes(MIGRATION));
t("the migration ends with a verification query", /-- VERIFY: every row should say true\./.test(mig));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
