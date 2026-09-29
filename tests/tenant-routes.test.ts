/**
 * THE PUBLIC PAGE ROUTES, DRIVEN. Run: bun tests/tenant-routes.test.ts
 *
 * The real route modules (src/routes/a.$slug.tsx, s.$ws.$slug.tsx,
 * p.$slug.tsx) with getPublicTenantPage replaced by a controllable stand-in
 * (bun's mock.module — the server function itself is exercised by
 * tests/public-tenant-page.test.ts):
 *
 *  - a redirect row → a 301 (not the default 307), with the page cache
 *    headers; no page / a billing hold / a template with no renderer → 404;
 *    /a/{slug}/anything → 404 without a lookup;
 *  - Cache-Control: private, max-age=60 + Vary: Host,
 *    X-Forwarded-Host on public pages (and their 404s), no-store on errors
 *    and on every preview;
 *  - head(): the page's head, a plain noindex title for 404 / error;
 *  - a server render through a real (memory) router: the registered
 *    template, one <main>, one <h1>, a white-labelled 404, and the preview
 *    banner with links kept inside /s/{ws}.
 * Offline.
 */
import { mock } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
  isNotFound,
} from "@tanstack/react-router";
import type { TemplateData } from "../src/components/templates/types";

type Result = {
  page: TemplateData | null;
  host: string | null;
  preview: boolean;
  redirect?: string;
  billingBlocked?: boolean;
  unsupportedTemplate?: string;
};
let next: Result = { page: null, host: null, preview: false };
const calls: Array<{ slug: string; workspaceSlug?: string }> = [];
mock.module("@/lib/public-tenant-page.functions", () => ({
  getPublicTenantPage: async ({ data }: { data: { slug: string; workspaceSlug?: string } }) => {
    calls.push(data);
    return next;
  },
}));

const { Route: PublicRoute } = await import("../src/routes/a.$slug.tsx");
const { Route: PreviewRoute } = await import("../src/routes/s.$ws.$slug.tsx");
const { Route: LegacyRoute } = await import("../src/routes/p.$slug.tsx");
const { buildTenantPageHead } = await import("../src/components/templates/head");

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

const HOST = "www.splash-pools.example";
const DATA: TemplateData = {
  page: {
    id: "p1",
    kind: "category_page",
    slug: "pool-rentals",
    title: "Pool rentals",
    seoTitle: "Pool rentals near you | Splash",
    h1: "Pool rentals near you",
    metaDescription: "Private pools by the hour.",
    intro: "Private pools by the hour.",
    bodyMarkdown: "Pools are great. ".repeat(30),
    noindex: false,
    publishedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    place: { city: null, region: null, country: null },
    category: "Pool",
    listingNoun: null,
    matchingListings: 1,
    legacy: false,
  },
  listings: [
    {
      id: "l1",
      title: "Sunny pool",
      url: "https://www.splash-pools.example/l/sunny-pool/abc",
      image: { url: "https://img.example/1.jpg", alt: "Sunny pool", width: 400, height: 300 },
      location: "Portland, OR",
      price: { text: "$125", unitText: "per hour", amount: "125.00", currency: "USD" },
    },
  ],
  related: [{ slug: "pool-guide", title: "Pool guide", kind: "resource_article", place: null, category: null, relation: "other" }],
  branding: { name: "Splash", color: "#0ea5e9", logoUrl: null },
  marketplace: { homeUrl: "https://www.splash-pools.example/", browseUrl: "https://www.splash-pools.example/s" },
};

async function runLoader(route: any, params: Record<string, string>, pathname: string): Promise<{ value?: any; thrown?: any }> {
  try {
    return { value: await route.options.loader({ params, location: { pathname, searchStr: "" } }) };
  } catch (e) {
    return { thrown: e };
  }
}

// ---------------------------------------------------------------------------
console.log("\n1. /a/$slug: 301 for a move, 404 for anything not served");
{
  next = { page: null, host: HOST, preview: false, redirect: "/a/pool-rentals" };
  const moved = await runLoader(PublicRoute, { slug: "old-pools" }, "/a/old-pools");
  const r = moved.thrown as Response | undefined;
  t("a redirect row is a 301 (not the default 307)", r instanceof Response && r.status === 301, String(r?.status));
  t("…to its target", r?.headers.get("Location") === "/a/pool-rentals");
  t("…fresh for a minute and varied by host, like the page", r?.headers.get("Cache-Control") === "private, max-age=60" && r?.headers.get("Vary") === "Host, X-Forwarded-Host");
  for (const [label, res] of [
    ["no page", { page: null, host: HOST, preview: false }],
    ["a billing hold", { page: null, host: HOST, preview: false, billingBlocked: true }],
    ["a template with no renderer", { page: null, host: HOST, preview: false, unsupportedTemplate: "neighborhood" }],
  ] as Array<[string, Result]>) {
    next = res;
    const out = await runLoader(PublicRoute, { slug: "pool-rentals" }, "/a/pool-rentals");
    t(`${label} → 404`, isNotFound(out.thrown));
  }
  calls.length = 0;
  next = { page: DATA, host: HOST, preview: false };
  const extra = await runLoader(PublicRoute, { slug: "pool-rentals" }, "/a/pool-rentals/extra");
  t("/a/{slug}/anything → 404 without a lookup", isNotFound(extra.thrown) && calls.length === 0);
  const ok = await runLoader(PublicRoute, { slug: "pool-rentals" }, "/a/pool-rentals");
  t("a served page returns its data and host", ok.value?.page === DATA && ok.value?.host === HOST && calls.at(-1)?.slug === "pool-rentals" && calls.at(-1)?.workspaceSlug === undefined);
  const slash = await runLoader(PublicRoute, { slug: "pool-rentals" }, "/a/pool-rentals/");
  t("a trailing slash is the same page", slash.value?.page === DATA);
}

console.log("\n2. cache headers");
{
  const headers = (PublicRoute.options as any).headers as (ctx: any) => Record<string, string>;
  const ok = headers({ loaderData: { page: DATA, host: HOST }, match: { status: "success" } });
  t("a served page: private, max-age=60 (no shared cache may store it)", ok["Cache-Control"] === "private, max-age=60");
  t("…Vary: Host, X-Forwarded-Host (one path serves every customer's hostname)", ok.Vary === "Host, X-Forwarded-Host");
  const missing = headers({ loaderData: undefined, match: { status: "notFound" } });
  t("a 404 is held no longer than a page", missing["Cache-Control"] === "private, max-age=60");
  const broken = headers({ loaderData: undefined, match: { status: "error" } });
  t("an error is never stored", broken["Cache-Control"] === "no-store" && !("Vary" in broken));
  const preview = (PreviewRoute.options as any).headers({ loaderData: { page: DATA }, match: { status: "success" } });
  t("the preview is never stored and never indexed", preview["Cache-Control"] === "no-store" && preview["X-Robots-Tag"] === "noindex, nofollow");
}

console.log("\n3. head()");
{
  const head = (PublicRoute.options as any).head as (ctx: any) => any;
  const served = head({ loaderData: { page: DATA, host: HOST }, match: { status: "success" } });
  t("a served page's head is buildTenantPageHead's", JSON.stringify(served) === JSON.stringify(buildTenantPageHead(DATA, { host: HOST })));
  t("…canonical on the verified host", served.links[0]?.href === "https://www.splash-pools.example/a/pool-rentals");
  const nf = head({ loaderData: undefined, match: { status: "notFound" } });
  t("404: a plain title, noindex", nf.meta.some((m: any) => m.title === "Page not found") && nf.meta.some((m: any) => m.name === "robots" && m.content === "noindex"));
  const err = head({ loaderData: undefined, match: { status: "error" } });
  t("error: a plain title, noindex", err.meta.some((m: any) => m.title === "Something went wrong"));
  const pv = (PreviewRoute.options as any).head({ loaderData: { page: DATA } });
  t("preview: its own title and noindex, nofollow", pv.meta.some((m: any) => m.title === "Pool rentals near you | Splash — preview") && pv.meta.some((m: any) => m.name === "robots" && m.content === "noindex, nofollow") && pv.links.length === 0);
}

console.log("\n4. the preview and the legacy prefix");
{
  next = { page: null, host: "www.founders.click", preview: true, redirect: "/s/splash/pool-rentals" };
  const moved = await runLoader(PreviewRoute, { ws: "splash", slug: "old" }, "/s/splash/old");
  const r = moved.thrown as Response | undefined;
  t("a preview move is a 301 that is never stored", r?.status === 301 && r.headers.get("Location") === "/s/splash/pool-rentals" && r.headers.get("Cache-Control") === "no-store");
  t("the preview asks for the workspace by slug", calls.at(-1)?.workspaceSlug === "splash");
  next = { page: null, host: null, preview: true };
  t("an unpublished page in the preview → 404", isNotFound((await runLoader(PreviewRoute, { ws: "splash", slug: "draft" }, "/s/splash/draft")).thrown));
  let legacy: any;
  try {
    (LegacyRoute.options as any).loader({ params: { slug: "pool-rentals" }, location: { searchStr: "?utm=x" } });
  } catch (e) {
    legacy = e;
  }
  t("/p/{slug} → 301 /a/{slug}, query kept", legacy?.status === 301 && legacy.headers.get("Location") === "/a/pool-rentals?utm=x");
  let odd: any;
  try {
    (LegacyRoute.options as any).loader({ params: { slug: "a/../b?c" }, location: { searchStr: "" } });
  } catch (e) {
    odd = e;
  }
  t("…with the slug re-encoded (a decoded / or ? cannot reshape the target)", odd?.headers.get("Location") === "/a/a%2F..%2Fb%3Fc");
}

// ---------------------------------------------------------------------------
console.log("\n5. rendered through a real (memory) router");
async function renderAt(route: any, id: string, path: string): Promise<string> {
  const root = createRootRoute({ component: () => createElement(Outlet) });
  route.update({ id, path: id, getParentRoute: () => root });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToStaticMarkup(createElement(RouterProvider, { router } as any));
}
{
  next = { page: DATA, host: HOST, preview: false };
  const html = await renderAt(PublicRoute, "/a/$slug", "/a/pool-rentals");
  t("the page renders with its registered template", html.includes('data-template="category_page"') && !html.includes("data-template-error"), html.slice(0, 200));
  t("one <main>, one <h1>", (html.match(/<main[\s>]/g) ?? []).length === 1 && (html.match(/<h1[\s>]/g) ?? []).length === 1);
  t("real listing cards with their price", html.includes('data-listing-id="l1"') && html.includes(">$125<") && html.includes(" per hour<"));
  t("links to the customer's marketplace are followed", html.includes('href="https://www.splash-pools.example/l/sunny-pool/abc" target="_blank" rel="noopener"') && !/nofollow/.test(html));
  t("related pages under /a/", html.includes('href="/a/pool-guide"'));
  t("no platform name", !/founders\.click/i.test(html));
  next = { page: null, host: HOST, preview: false };
  const missing = await renderAt(PublicRoute, "/a/$slug", "/a/nothing-here");
  t("404: a white-labelled page", missing.includes("Page not found") && missing.includes("doesn&#x27;t exist") && !/founders\.click|bg-primary|Go home/i.test(missing), missing.slice(0, 300));
  next = { page: DATA, host: "www.founders.click", preview: true };
  const preview = await renderAt(PreviewRoute, "/s/$ws/$slug", "/s/splash/pool-rentals");
  t("the preview: a banner, the same template, links kept inside /s/{ws}",
    preview.includes("Preview — connect your marketplace domain") && preview.includes('data-template="category_page"') && preview.includes('href="/s/splash/pool-guide"') && !preview.includes('href="/a/'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
