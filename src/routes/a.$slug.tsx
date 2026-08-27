import { createFileRoute, notFound, redirect, useRouter } from "@tanstack/react-router";
import { getPublicTenantPage } from "@/lib/public-tenant-page.functions";
import { CityHub } from "@/components/templates/CityHub";
import { canonicalUrl } from "@/lib/canonical";

// /a/ is the canonical public prefix for tenant SEO pages. On a connected
// customer domain the Founders edge only controls the /a/* path space (DNS
// can't delegate a URL path), so everything public-facing — pages, the tenant
// sitemap, the activation test — lives under /a/. /p/* 301s here.
export const Route = createFileRoute("/a/$slug")({
  loader: async ({ params, location }) => {
    // Host is resolved server-side inside the server fn (from request headers);
    // `window.location.host` is undefined during SSR, which would 404 every
    // crawler / first-paint hit on tenant custom domains.
    const r = await getPublicTenantPage({ data: { slug: params.slug } });
    if (r.redirect) {
      throw redirect({ href: r.redirect });
    }
    if (!r.page) throw notFound();
    return { page: r.page, path: location.pathname, host: r.host };
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const p = loaderData.page;
    // Tenant pages are served on the tenant's own domain, so the canonical must
    // be self-referential to that host — not the founders.click platform origin.
    const url = loaderData.host
      ? `https://${loaderData.host}${loaderData.path}`
      : canonicalUrl(loaderData.path);
    // Tenant pages are served on the customer's own brand/domain — override the
    // platform-wide og:site_name and author from the root head so share cards and
    // SEO don't advertise "founders.click" on a customer's marketplace.
    const tags = [
      { title: p.title },
      { name: "description", content: p.meta_description ?? p.title },
      { property: "og:title", content: p.title },
      { property: "og:description", content: p.meta_description ?? p.title },
      { property: "og:url", content: url },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: p.workspace_name || p.title },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: p.title },
      { name: "twitter:description", content: p.meta_description ?? p.title },
    ];
    if (p.workspace_name) {
      tags.push({ name: "author", content: p.workspace_name });
    }
    const firstImage = p.listings.find((l) => l.images?.[0]?.url)?.images?.[0]?.url;
    if (firstImage) {
      tags.push({ property: "og:image", content: firstImage });
      tags.push({ name: "twitter:image", content: firstImage });
    }

    // Thin/empty pages are a scaled-content-abuse and deindexing risk: never let
    // Google index a page with no listings and little body. noindex,follow keeps
    // it out of the index while still letting crawlers follow its links.
    const bodyLen = (p.body_markdown ?? "").trim().length;
    const isThin = p.listings.length === 0 && bodyLen < 300;
    if (isThin) {
      tags.push({ name: "robots", content: "noindex, follow" });
    }

    // Page-level structured data: a BreadcrumbList (SERP breadcrumbs + crawl
    // context) and an ItemList wrapping the listings. Per-listing Product JSON-LD
    // is emitted below from each listing's structured_data.
    const origin = loaderData.host ? `https://${loaderData.host}` : "";
    const ldScripts: Array<{ type: string; children: string }> = [];
    ldScripts.push({
      type: "application/ld+json",
      children: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: p.workspace_name || "Home",
            item: origin || url,
          },
          { "@type": "ListItem", position: 2, name: p.h1 || p.title, item: url },
        ],
      }),
    });
    if (p.listings.length > 0) {
      ldScripts.push({
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: p.title,
          numberOfItems: p.listings.length,
          itemListElement: p.listings.map((l, i) => ({
            "@type": "ListItem",
            position: i + 1,
            url: l.marketplace_url,
            name: l.title,
          })),
        }),
      });
    }
    for (const l of p.listings) {
      if (l.structured_data) {
        ldScripts.push({
          type: "application/ld+json",
          children: JSON.stringify(l.structured_data),
        });
      }
    }

    return {
      meta: tags,
      links: [{ rel: "canonical", href: url }],
      scripts: ldScripts,
    };
  },
  component: PublicPage,
  errorComponent: ErrorComp,
  notFoundComponent: NotFoundComp,
});

function PublicPage() {
  const { page } = Route.useLoaderData();
  if (page.template_slug === "city_hub") return <CityHub page={page} />;
  // Fallback: render City Hub for any template until others ship
  return <CityHub page={page} />;
}

function ErrorComp({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
        <p className="text-muted-foreground mb-4">{error.message}</p>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="underline"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

function NotFoundComp() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
      <div className="text-center">
        <h1 className="text-3xl font-bold">404</h1>
        <p className="text-muted-foreground mt-2">Page not found.</p>
      </div>
    </div>
  );
}
