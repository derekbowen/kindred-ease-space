import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { getPublicTenantPage } from "@/lib/public-tenant-page.functions";
import { CityHub } from "@/components/templates/CityHub";
import { canonicalUrl } from "@/lib/canonical";

export const Route = createFileRoute("/p/$slug")({
  loader: async ({ params, location }) => {
    // Host is resolved server-side inside the server fn (from request headers);
    // `window.location.host` is undefined during SSR, which would 404 every
    // crawler / first-paint hit on tenant custom domains.
    const r = await getPublicTenantPage({ data: { slug: params.slug } });
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
    const tags = [
      { title: p.title },
      { name: "description", content: p.meta_description ?? p.title },
      { property: "og:title", content: p.title },
      { property: "og:description", content: p.meta_description ?? p.title },
      { property: "og:url", content: url },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: p.title },
      { name: "twitter:description", content: p.meta_description ?? p.title },
    ];
    const firstImage = p.listings.find((l) => l.images?.[0]?.url)?.images?.[0]?.url;
    if (firstImage) {
      tags.push({ property: "og:image", content: firstImage });
      tags.push({ name: "twitter:image", content: firstImage });
    }
    return {
      meta: tags,
      links: [{ rel: "canonical", href: url }],
      scripts: p.listings
        .filter((l) => l.structured_data)
        .map((l) => ({
          type: "application/ld+json",
          children: JSON.stringify(l.structured_data),
        })),
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
