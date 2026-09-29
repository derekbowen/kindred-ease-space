import { createFileRoute, notFound, redirect, useRouterState } from "@tanstack/react-router";
import { getPublicTenantPage } from "@/lib/public-tenant-page.functions";
import { TemplateRenderer } from "@/components/templates/registry";
import {
  NO_STORE_HEADERS,
  PUBLIC_PAGE_HEADERS,
  buildTenantPageHead,
  tenantStatusHead,
} from "@/components/templates/head";
import { TENANT_NOT_FOUND, TenantStatusPage } from "@/components/templates/StatusPage";

// /a/ is the canonical public prefix for tenant SEO pages. On a connected
// customer domain the Founders edge only controls the /a/* path space (DNS
// can't delegate a URL path), so everything public-facing — pages, the tenant
// sitemap, the activation test — lives under /a/. /p/* 301s here.
//
// These pages are the customer's, on the customer's domain: the root renders
// them without the platform's head tags or client scripts (see __root.tsx),
// and everything here is complete as server-rendered HTML.
export const Route = createFileRoute("/a/$slug")({
  loader: async ({ params, location }) => {
    // /a/{slug}/anything fuzzy-matches this route; it is not a page.
    if (location.pathname.replace(/\/+$/, "") !== `/a/${params.slug}`) throw notFound();
    // Host is resolved server-side inside the server fn (from request headers);
    // `window.location.host` is undefined during SSR, which would 404 every
    // crawler / first-paint hit on tenant custom domains.
    const r = await getPublicTenantPage({ data: { slug: params.slug } });
    if (r.redirect) {
      // A moved page moved for good: 301 (not the default 307), so search
      // engines carry its signals to the new URL.
      throw redirect({ href: r.redirect, statusCode: 301, headers: { ...PUBLIC_PAGE_HEADERS } });
    }
    // No page, a billing hold, or a template with no renderer: 404.
    if (!r.page) throw notFound();
    return { page: r.page, host: r.host };
  },
  // Fresh for a minute: a publish, edit or unpublish shows within 60 seconds.
  // A 404 is held no longer than a page; an error is never stored.
  headers: ({ loaderData, match }) =>
    loaderData || match.status === "notFound"
      ? { ...PUBLIC_PAGE_HEADERS }
      : { ...NO_STORE_HEADERS },
  head: ({ loaderData, match }) => {
    if (!loaderData) {
      return tenantStatusHead(
        match.status === "error" ? "Something went wrong" : TENANT_NOT_FOUND.heading,
      );
    }
    // <title>, description, canonical (https://{verified host}/a/{slug}),
    // robots (the page's noindex switch or the shared thin rule), Open Graph
    // and structured data — all from the facts the page shows.
    return buildTenantPageHead(loaderData.page, { host: loaderData.host });
  },
  component: PublicPage,
  errorComponent: ErrorComp,
  notFoundComponent: NotFoundComp,
});

function PublicPage() {
  const { page } = Route.useLoaderData();
  // The component registered for the page's template (the loader already
  // refused a template with no renderer).
  return <TemplateRenderer {...page} basePath="/a" />;
}

// A visitor on the tenant's own domain reads this: never the loader's error
// text (it can carry database or transport wording), and never a sentence
// naming the platform — these pages are white-labelled. "Try again" is a
// plain link: these pages carry no client script.
function ErrorComp() {
  const href = useRouterState({ select: (s) => s.location.href });
  return (
    <TenantStatusPage
      heading="Something went wrong"
      message="This page couldn't load. Try again in a moment."
      retryHref={href}
    />
  );
}

function NotFoundComp() {
  return <TenantStatusPage {...TENANT_NOT_FOUND} />;
}
