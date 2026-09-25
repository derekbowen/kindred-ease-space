/**
 * HELP ARTICLES ONLY IN PUBLISHED PLATFORM CATEGORIES. Run: bun tests/help-category-guard.test.ts
 *
 * Round-4 release review M3. help_categories.slug is globally unique, so a
 * platform article (workspace_id IS NULL) can be filed under a category that
 * Pool Rental Near Me owns (`getting-started`, `billing`) or under one that
 * has been unpublished (`page-builder`, 000910). Against pre-000900 data the
 * un-nested article route rendered the retired BYOK article at
 * /help/billing/bring-your-own-ai-key-byok — provider names, "unlimited",
 * the ai-proxy function — and /help/sitemap.xml listed it.
 *
 * Now an article renders, and is listed anywhere, only while its category is
 * a published platform category; a URL naming another category than the
 * article's gets a 301 to the canonical URL when the article is public there,
 * and a 404 otherwise. The real help.server.ts runs against a fake PostgREST
 * that applies the filters it receives (is / eq / in / order / limit), with
 * the data shaped like the reviewer's reproduction. Offline.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL = "http://help-guard.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";

const help = await import("../src/lib/help.server");

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
// Data: the platform help center before 000900/000910 ran, plus the moved rows.
const PRNM = "6501e018-0000-4000-8000-000000000001";
type Row = Record<string, unknown>;
const categories: Row[] = [
  {
    id: "c1",
    slug: "start-here",
    name: "Getting started",
    workspace_id: null,
    is_published: true,
    sort_order: 0,
    description: null,
    icon: null,
  },
  {
    id: "c2",
    slug: "domains",
    name: "Domains",
    workspace_id: null,
    is_published: true,
    sort_order: 1,
    description: null,
    icon: null,
  },
  {
    id: "c3",
    slug: "page-builder",
    name: "Page builder",
    workspace_id: null,
    is_published: false,
    sort_order: 2,
    description: null,
    icon: null,
  },
  {
    id: "c4",
    slug: "getting-started",
    name: "PRNM start",
    workspace_id: PRNM,
    is_published: true,
    sort_order: 0,
    description: null,
    icon: null,
  },
  {
    id: "c5",
    slug: "billing",
    name: "PRNM billing",
    workspace_id: PRNM,
    is_published: true,
    sort_order: 1,
    description: null,
    icon: null,
  },
];
const art = (id: string, slug: string, category_slug: string, extra: Row = {}): Row => ({
  id,
  slug,
  category_slug,
  title: slug,
  excerpt: null,
  content: `# ${slug}\n\nbody`,
  status: "published",
  is_published: true,
  workspace_id: null,
  reading_time_minutes: 1,
  view_count: 0,
  published_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-20T00:00:00Z",
  author_name: null,
  author_avatar_url: null,
  helpful_count: 0,
  not_helpful_count: 0,
  related_article_ids: [],
  tags: [],
  sort_order: 0,
  ...extra,
});
const articles: Row[] = [
  art("a1", "welcome-to-founders-click", "start-here", {
    view_count: 50,
    related_article_ids: ["a3", "a4", "a2", "a6"],
  }),
  art("a2", "connecting-your-domain", "domains", { view_count: 10 }),
  // Platform article filed under PRNM's category (the M3 reproduction).
  art("a3", "bring-your-own-ai-key-byok", "billing", { view_count: 999 }),
  // Platform article left published in a category that is not.
  art("a4", "using-the-matrix-builder", "page-builder", { view_count: 500 }),
  // A draft in a good category.
  art("a5", "coming-soon", "start-here", { status: "draft", is_published: false, view_count: 700 }),
  // PRNM's own article.
  art("a6", "prnm-welcome", "getting-started", { workspace_id: PRNM, view_count: 800 }),
];

// ---------------------------------------------------------------------------
// A fake PostgREST that applies the filters supabase-js sends.
type Hit = { table: string; query: URLSearchParams };
const hits: Hit[] = [];
let failTable: string | null = null;
let rpcRows: Record<string, Row[]> = {};

function splitIn(v: string): string[] {
  // in.(a,b,"c d")
  const inner = v.slice(1, -1);
  return inner ? inner.split(",").map((s) => s.replace(/^"(.*)"$/, "$1")) : [];
}
function matches(row: Row, col: string, expr: string): boolean {
  const cell = row[col];
  if (expr === "is.null") return cell === null || cell === undefined;
  if (expr.startsWith("eq.")) return String(cell) === expr.slice(3);
  if (expr.startsWith("in.")) return splitIn(expr.slice(3)).includes(String(cell));
  throw new Error(`fake PostgREST: unsupported filter ${col}=${expr}`);
}
const RESERVED = new Set(["select", "order", "limit", "offset"]);

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.origin !== process.env.SUPABASE_URL) throw new TypeError(`unexpected host ${url.host}`);
  const path = url.pathname.replace(/^\/rest\/v1\//, "");
  if (path.startsWith("rpc/")) {
    const name = path.slice(4);
    hits.push({ table: `rpc:${name}`, query: url.searchParams });
    return Response.json(rpcRows[name] ?? []);
  }
  hits.push({ table: path, query: url.searchParams });
  if (failTable === path) return Response.json({ code: "XX000", message: "boom" }, { status: 500 });
  const source =
    path === "help_categories" ? categories : path === "help_articles" ? articles : null;
  if (!source)
    return Response.json({ code: "42P01", message: `no table ${path}` }, { status: 404 });
  let rows = source.filter((r) => {
    for (const [k, v] of url.searchParams) {
      if (RESERVED.has(k)) continue;
      if (!matches(r, k, v)) return false;
    }
    return true;
  });
  const order = url.searchParams.get("order");
  if (order) {
    const keys = order.split(",").map((o) => {
      const [col, dir] = o.split(".");
      return { col, desc: dir === "desc" };
    });
    rows = [...rows].sort((a, b) => {
      for (const { col, desc } of keys) {
        const x = a[col] as string | number;
        const y = b[col] as string | number;
        if (x === y) continue;
        return (x < y ? -1 : 1) * (desc ? -1 : 1);
      }
      return 0;
    });
  }
  const limit = url.searchParams.get("limit");
  if (limit) rows = rows.slice(0, Number(limit));
  const accept = new Headers(init?.headers).get("accept") ?? "";
  if (accept.includes("vnd.pgrst.object")) {
    return rows.length === 1
      ? Response.json(rows[0])
      : Response.json({ code: "PGRST116", message: "not one row" }, { status: 406 });
  }
  return Response.json(rows);
}) as typeof fetch;

const reset = () => {
  hits.length = 0;
  failTable = null;
  rpcRows = {};
};

// ---------------------------------------------------------------------------
console.log("\nthe article route's data: only a published platform category renders");

reset();
const good = await help.getArticleBySlug("start-here", "welcome-to-founders-click");
t(
  "an article in a published platform category renders",
  good?.slug === "welcome-to-founders-click",
);
const catRead = hits.find((h) => h.table === "help_categories");
t(
  "…after reading the URL's category as a platform category (workspace_id IS NULL, is_published)",
  !!catRead &&
    catRead.query.get("workspace_id") === "is.null" &&
    catRead.query.get("is_published") === "eq.true",
);

reset();
t(
  "M3: the platform BYOK article filed under PRNM's `billing` does NOT render",
  (await help.getArticleBySlug("billing", "bring-your-own-ai-key-byok")) === null,
);
t(
  "an article left published in the unpublished `page-builder` category does not render",
  (await help.getArticleBySlug("page-builder", "using-the-matrix-builder")) === null,
);
t("a draft does not render", (await help.getArticleBySlug("start-here", "coming-soon")) === null);
t(
  "PRNM's own article never renders on the platform help center",
  (await help.getArticleBySlug("getting-started", "prnm-welcome")) === null,
);
t(
  "a URL naming another category than the article's does not render the article",
  (await help.getArticleBySlug("domains", "welcome-to-founders-click")) === null,
);
t(
  "…nor under PRNM's old `getting-started` URL",
  (await help.getArticleBySlug("getting-started", "welcome-to-founders-click")) === null,
);

console.log("\nwrong category → 301 to the canonical URL when public, else 404");
t(
  "old /help/getting-started/<moved article> → 301 /help/start-here/<article>",
  (await help.articleRedirectFor("getting-started", "welcome-to-founders-click")) ===
    "/help/start-here/welcome-to-founders-click",
);
t(
  "a made-up category → 301 to the canonical URL",
  (await help.articleRedirectFor("anything", "connecting-your-domain")) ===
    "/help/domains/connecting-your-domain",
);
t(
  "the canonical URL itself never redirects (no loop)",
  (await help.articleRedirectFor("start-here", "welcome-to-founders-click")) === null,
);
t(
  "BYOK under `billing` → 404 (its category is not a platform category)",
  (await help.articleRedirectFor("billing", "bring-your-own-ai-key-byok")) === null,
);
t(
  "BYOK under a platform category's URL → 404, never a redirect into `billing`",
  (await help.articleRedirectFor("start-here", "bring-your-own-ai-key-byok")) === null,
);
t(
  "an article in an unpublished category → 404",
  (await help.articleRedirectFor("start-here", "using-the-matrix-builder")) === null,
);
t("a draft → 404", (await help.articleRedirectFor("domains", "coming-soon")) === null);
t("PRNM's article → 404", (await help.articleRedirectFor("start-here", "prnm-welcome")) === null);
t(
  "an unknown slug → 404",
  (await help.articleRedirectFor("start-here", "no-such-article")) === null,
);

console.log("\n/help/sitemap.xml lists only renderable article URLs");
reset();
const sitemap = await help.listAllPublishedArticleSlugs();
const listed = sitemap.map((a) => `${a.category_slug}/${a.slug}`).sort();
t(
  "exactly the two articles in published platform categories",
  JSON.stringify(listed) ===
    JSON.stringify(["domains/connecting-your-domain", "start-here/welcome-to-founders-click"]),
  JSON.stringify(listed),
);
t(
  "M3: the BYOK URL is not in the help sitemap",
  !listed.some((u) => u.includes("bring-your-own-ai-key-byok")),
);
t(
  "no page-builder, draft or PRNM URL either",
  !listed.some((u) => /matrix|coming-soon|prnm/.test(u)),
);
t(
  "every listed article renders at its listed URL",
  (await Promise.all(sitemap.map((a) => help.getArticleBySlug(a.category_slug, a.slug)))).every(
    (x) => x !== null,
  ),
);
reset();
failTable = "help_categories";
t(
  "categories unreadable → the sitemap lists no article (fails closed)",
  (await help.listAllPublishedArticleSlugs()).length === 0,
);
t(
  "categories unreadable → no article renders",
  (await help.getArticleBySlug("start-here", "welcome-to-founders-click")) === null,
);
t(
  "categories unreadable → no redirect",
  (await help.articleRedirectFor("getting-started", "welcome-to-founders-click")) === null,
);

console.log("\nno help page links to an article that would 404");
reset();
const popular = (await help.listPopularArticles(6)).map((a) => a.slug);
t(
  "popular: highest views first, only renderable articles",
  JSON.stringify(popular) ===
    JSON.stringify(["welcome-to-founders-click", "connecting-your-domain"]),
  JSON.stringify(popular),
);
const recent = (await help.listRecentArticles(4)).map((a) => a.slug).sort();
t(
  "recent: only renderable articles",
  JSON.stringify(recent) ===
    JSON.stringify(["connecting-your-domain", "welcome-to-founders-click"]),
  JSON.stringify(recent),
);
const related = (await help.getRelatedArticles(["a3", "a4", "a2", "a6"])).map((a) => a.slug);
t(
  "related: BYOK, the page-builder article and PRNM's article are dropped",
  JSON.stringify(related) === JSON.stringify(["connecting-your-domain"]),
  JSON.stringify(related),
);
rpcRows = {
  help_search_v2: [articles[2], articles[0], articles[3]].map((a) => ({
    ...a,
    headline: null,
    rank: 1,
  })),
  help_suggest_titles: [
    {
      title: "BYOK",
      slug: "bring-your-own-ai-key-byok",
      category_slug: "billing",
      similarity: 0.9,
    },
    {
      title: "Welcome",
      slug: "welcome-to-founders-click",
      category_slug: "start-here",
      similarity: 0.5,
    },
  ],
};
const found = (await help.searchArticles("ai key")).map((a) => a.slug);
t(
  "search results: only renderable articles",
  JSON.stringify(found) === JSON.stringify(["welcome-to-founders-click"]),
  JSON.stringify(found),
);
const sugg = (await help.suggestArticleTitles("byok")).map((s) => s.slug);
t(
  "did-you-mean suggestions: only renderable articles",
  JSON.stringify(sugg) === JSON.stringify(["welcome-to-founders-click"]),
  JSON.stringify(sugg),
);

// ---------------------------------------------------------------------------
console.log("\nthe route answers 301 / 404 from that data");
const route = read("src/routes/help.$category_.$article.tsx");
const fns = read("src/lib/help.functions.ts");
t(
  "getHelpArticle asks for the canonical URL only when the article is not found at this URL",
  /if \(!article\) \{\s*const redirectTo = await articleRedirectFor\(data\.categorySlug, data\.articleSlug\);/.test(
    fns,
  ),
);
t(
  "the loader 301s to it",
  /if \(data\.redirectTo\) throw redirect\(\{ href: data\.redirectTo, statusCode: 301 \}\);/.test(
    route,
  ),
);
t("…and 404s otherwise", /if \(!data\.article\) \{[\s\S]*?throw notFound\(\);/.test(route));
t(
  "the help sitemap takes its article URLs from listAllPublishedArticleSlugs",
  /listAllPublishedArticleSlugs\(\)/.test(read("src/routes/help.sitemap[.]xml.tsx")),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
