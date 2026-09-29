/**
 * THE DOCUMENT SHELL OF A CUSTOMER'S PAGE (used by src/routes/__root.tsx).
 *
 * Everything under /a/ is served on customers' own hostnames: the Founders
 * edge forwards customer.com/a/* to this app and nothing else. Two things
 * follow for those responses:
 *
 *  1. They must not carry the platform's identity — no founders.click title,
 *     description, Open Graph poster, favicon or google-site-verification
 *     tag. The root head is reduced to charset + viewport + the stylesheet;
 *     the page route supplies its own title and meta.
 *  2. Only /a/* reaches this app on a customer's hostname, so the build's
 *     /assets/* files are NOT reachable there (customer.com/assets/... is the
 *     customer's own site). The stylesheet is referenced absolutely from the
 *     platform origin (a cross-origin stylesheet needs no CORS), and no client
 *     script or modulepreload is emitted: the pages are complete as
 *     server-rendered HTML and work without JavaScript.
 *
 * App pages are untouched: every other path keeps the platform head, relative
 * assets and hydration.
 */
import { CANONICAL_ORIGIN } from "@/lib/canonical";

/** Is this request path a customer-facing page surface (the proxied /a/ prefix)? */
export function isTenantSurfacePath(pathname: string | null | undefined): boolean {
  const p = pathname ?? "";
  return p === "/a" || p.startsWith("/a/");
}

/**
 * A build asset referenced from a customer's page: /assets/* → the platform
 * origin (https://www.founders.click/assets/...). Anything else (the dev
 * server's /src/... modules, an already absolute URL) is left alone.
 */
export function tenantAssetHref(href: string): string {
  return href.startsWith("/assets/") ? `${CANONICAL_ORIGIN}${href}` : href;
}

type RootHead = {
  meta: Array<Record<string, string>>;
  links: Array<Record<string, string>>;
};

/** The root head for a customer's page: no platform identity, the stylesheet absolute. */
export function tenantRootHead(stylesheetHref: string): RootHead {
  const href = tenantAssetHref(stylesheetHref);
  const links: Array<Record<string, string>> = [];
  if (href.startsWith(CANONICAL_ORIGIN)) links.push({ rel: "preconnect", href: CANONICAL_ORIGIN });
  links.push({ rel: "stylesheet", href });
  return {
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      // Only seen when no route below supplies a title (a root-level 404).
      { title: "Page not found" },
    ],
    links,
  };
}

type ManagedTag = {
  tag: string;
  attrs?: Record<string, unknown>;
  children?: unknown;
};

/**
 * The head tags TanStack collected for a customer's page, made safe for a
 * customer's hostname: module preloads and external scripts are dropped
 * (the page ships no client code), icon links are dropped (the platform's
 * favicon is not the customer's), and any relative /assets/ stylesheet is
 * pointed at the platform origin.
 */
export function tenantHeadTags<T extends ManagedTag>(tags: readonly T[]): T[] {
  const out: T[] = [];
  for (const tag of tags) {
    const attrs = tag.attrs ?? {};
    const rel = typeof attrs.rel === "string" ? attrs.rel.toLowerCase() : "";
    if (tag.tag === "link") {
      if (rel === "modulepreload" || rel === "preload" || rel.includes("icon")) continue;
      if (rel === "stylesheet" && typeof attrs.href === "string") {
        out.push({ ...tag, attrs: { ...attrs, href: tenantAssetHref(attrs.href) } });
        continue;
      }
    }
    if (tag.tag === "script" && typeof attrs.src === "string") continue;
    out.push(tag);
  }
  return out;
}
