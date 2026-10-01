/**
 * THE SHARETRIBE TEMPLATE STORE. Run: bun tests/template-store.test.ts
 *
 * Buyers pay through a public Stripe Checkout and download a zip from a
 * PRIVATE bucket. The properties that keep that honest:
 *
 *   1. the price charged comes from the server catalog, and the page shows
 *      the same price (the two catalogs agree slug for slug);
 *   2. a download link is only minted for a session Stripe reports as a
 *      completed, paid template purchase of that template;
 *   3. the bucket is private and only platform admins can write to it;
 *   4. template sales never touch SaaS billing: they carry no workspace_id,
 *      and stripe-webhook ignores a completed checkout without one;
 *   5. every template on sale has a self-hosted preview, with no dependency
 *      on the design tool's CDN.
 *
 * Asserted against source, like credit-pack-withdrawn.test.ts: the live
 * functions need Stripe credentials, and a test that only runs after a deploy
 * is a test that never runs.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { STORE_TEMPLATES } from "../src/lib/template-store";
import { TEMPLATE_PRODUCTS } from "../supabase/functions/_shared/template-catalog";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

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

console.log("\n=== 1. one price, from the server catalog ===");
const appView = STORE_TEMPLATES.map((s) => `${s.slug}:${s.name}:${s.priceCents}`).join();
const serverView = TEMPLATE_PRODUCTS.map((s) => `${s.slug}:${s.name}:${s.priceCents}`).join();
t(
  "the display catalog mirrors the price authority, slug for slug",
  appView === serverView,
  `${appView} vs ${serverView}`,
);
t(
  "slugs are unique",
  new Set(TEMPLATE_PRODUCTS.map((p) => p.slug)).size === TEMPLATE_PRODUCTS.length,
);
t(
  "every price is a positive whole number of cents",
  TEMPLATE_PRODUCTS.every((p) => Number.isInteger(p.priceCents) && p.priceCents > 0),
);

const checkout = read("supabase/functions/template-checkout/index.ts");
t(
  "checkout looks the product up in the catalog",
  /findTemplateProduct\(body\.slug\)/.test(checkout),
);
t("checkout charges the catalog price", /unit_amount:\s*product\.priceCents/.test(checkout));
t(
  "checkout reads nothing but the slug from the request",
  !/body\.(price|amount|unit_amount|priceCents|currency|success_url)/.test(checkout),
);
t("checkout is a one-time payment", /mode:\s*"payment"/.test(checkout));
t(
  "checkout refuses a template whose zip is not uploaded",
  /not_available_yet/.test(checkout) && /\.list\(/.test(checkout),
);
t(
  "the return URL's origin is allow-listed, never taken raw from the request",
  /allowedOrigins\.includes\(rawOrigin\)/.test(checkout),
);

console.log("\n=== 2. downloads only for a paid session of that template ===");
const download = read("supabase/functions/template-download/index.ts");
t(
  "the session is re-read from Stripe",
  /stripe\.checkout\.sessions\.retrieve\(sessionId\)/.test(download),
);
t(
  "it must be complete AND paid",
  /session\.status === "complete" && session\.payment_status === "paid"/.test(download),
);
t(
  "it must be a template purchase",
  /session\.metadata\?\.kind !== TEMPLATE_PURCHASE_KIND/.test(download),
);
t(
  "the template comes from the session's metadata, not the request",
  /findTemplateProduct\(session\.metadata\?\.template_slug\)/.test(download),
);
t("a receipt for another template is refused", /wrong_template/.test(download));
t(
  "the link is a short-lived signed URL",
  /createSignedUrl\(/.test(download) && /SIGNED_URL_TTL_SECONDS = 15 \* 60/.test(download),
);
t(
  "an unknown session answers exactly like an unpaid one (no oracle)",
  (download.match(/error: "not_paid" \}, 402/g) ?? []).length === 2,
);

console.log("\n=== 3. the bucket is private, admin-written ===");
const migration = read("supabase/migrations/20261001000100_template_downloads_bucket.sql");
t(
  "the bucket is created private",
  /'template-downloads',\s*\n\s*false,/.test(migration) && /SET public = false/.test(migration),
);
t(
  "every policy on it requires has_role admin",
  (migration.match(/CREATE POLICY/g) ?? []).length === 4 &&
    (migration.match(/public\.has_role\(auth\.uid\(\), 'admin'\)/g) ?? []).length >= 4,
);
t("no policy is granted to anon or public", !/TO (anon|public)\b/i.test(migration));
const config = read("supabase/config.toml");
t(
  "both functions are public at the gateway (they validate their own input)",
  /\[functions\.template-checkout\]\s*\nverify_jwt = false/.test(config) &&
    /\[functions\.template-download\]\s*\nverify_jwt = false/.test(config),
);

console.log("\n=== 4. template sales never touch SaaS billing ===");
t(
  "the checkout session carries no workspace_id",
  (
    checkout.match(/metadata: \{ kind: TEMPLATE_PURCHASE_KIND, template_slug: product\.slug \}/g) ??
    []
  ).length === 2 && !/workspace_id:/.test(checkout),
);
const webhook = read("supabase/functions/stripe-webhook/index.ts");
const completed = webhook.slice(webhook.indexOf('case "checkout.session.completed"'));
t(
  "stripe-webhook ignores a completed checkout without a workspace_id",
  /const workspace_id = s\.metadata\?\.workspace_id;[\s\S]{0,120}if \(!workspace_id\) break;/.test(
    completed,
  ),
);

console.log("\n=== 5. self-hosted previews ===");
function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}
for (const tpl of STORE_TEMPLATES) {
  const dir = join(ROOT, "public/template-previews", tpl.slug);
  const index = join(dir, "index.html");
  t(`${tpl.slug}: preview build is present`, existsSync(index));
  t(
    `${tpl.slug}: catalog thumbnail is present`,
    existsSync(join(ROOT, "public/template-thumbnails", `${tpl.slug}.jpg`)),
  );
  if (!existsSync(index)) continue;
  const files = [...walk(dir)];
  const text = files
    .filter((f) => /\.(html|js|css)$/.test(f))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  t(
    `${tpl.slug}: preview assets are relative (it works under /template-previews/)`,
    /src="\.\/assets\//.test(readFileSync(index, "utf8")),
  );
  t(
    `${tpl.slug}: no design-tool CDN references`,
    !/cdn\.magicpatterns\.com|magicpatterns\.app/.test(text),
  );
  t(
    `${tpl.slug}: images are self-hosted`,
    files.some((f) => /\/images\/[^/]+\.jpg$/.test(f)),
  );
  t(
    `${tpl.slug}: preview routing is hash-based (deep links work as static files)`,
    /createHashRouter|HashRouter|window\.location\.hash|hashchange/.test(text),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:");
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
