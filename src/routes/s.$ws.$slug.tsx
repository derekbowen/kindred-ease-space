import { createFileRoute, notFound, redirect, useRouter } from "@tanstack/react-router";
import { getPublicTenantPage } from "@/lib/public-tenant-page.functions";
import { CityHub } from "@/components/templates/CityHub";

export const Route = createFileRoute("/s/$ws/$slug")({
  // Platform-hosted preview of a tenant page (founders.click/s/{workspace}/{slug}).
  // Lets a customer view a published page immediately, before they've connected
  // and verified their own marketplace domain. It is deliberately noindexed so it
  // never competes with (or duplicates) the canonical page on the tenant's domain.
  loader: async ({ params }) => {
    const r = await getPublicTenantPage({
      data: { slug: params.slug, workspaceSlug: params.ws },
    });
    if (r.redirect) {
      throw redirect({ href: r.redirect });
    }
    if (!r.page) throw notFound();
    return { page: r.page };
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const p = loaderData.page;
    return {
      meta: [
        { title: `${p.title} — preview` },
        { name: "robots", content: "noindex, nofollow" },
      ],
    };
  },
  component: PreviewPage,
  errorComponent: ErrorComp,
  notFoundComponent: NotFoundComp,
});

function PreviewPage() {
  const { page } = Route.useLoaderData();
  return (
    <div>
      <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 text-center text-xs text-amber-700 dark:text-amber-300">
        Preview — connect your marketplace domain in Settings → Domains to publish this page for
        search engines.
      </div>
      <CityHub page={page} />
    </div>
  );
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
        <p className="text-muted-foreground mt-2">Page not found or not published yet.</p>
      </div>
    </div>
  );
}
