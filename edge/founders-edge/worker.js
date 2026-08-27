/**
 * Founders Edge — the reverse-proxy router for connected customer domains.
 *
 * Runs in the founders.click Cloudflare account, in front of every connected
 * customer hostname (Cloudflare for SaaS custom hostnames CNAME here; root
 * domains point A/CNAME-flattened records here).
 *
 * Routing contract (per hostname, config from the Founders control plane):
 *
 *   /a/*  -> Founders origin (SEO pages, tenant sitemap, domain test)
 *   else  -> the customer's stored origin (their existing website), only in
 *            full_proxy mode. In subdomain mode non-/a/ paths redirect into /a/.
 *
 * ZERO per-customer configuration lives here: everything is data, read from
 * GET {FOUNDERS_ORIGIN}/api/public/domain-config?hostname=... and cached at
 * the edge (60s positive / 10s negative). Adding a customer domain is a
 * database row + a Cloudflare custom-hostname API call — never a config file.
 *
 * Host-header security: hostnames the control plane doesn't recognize get a
 * 404. We never proxy for a host that isn't verified in workspace_domains.
 *
 * Loop protection:
 *   - the control plane refuses to store customer_origin == hostname
 *   - every proxied request carries x-founders-edge: 1; if we ever receive a
 *     request already carrying it, we stop with 508 instead of looping.
 */

const FOUNDERS_ORIGIN = "https://www.founders.click";
const CONFIG_TTL_OK = 60; // seconds
const CONFIG_TTL_MISS = 10;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase();

    if (request.headers.get("x-founders-edge")) {
      return new Response("loop detected", { status: 508 });
    }

    const config = await getDomainConfig(hostname, env, ctx);
    if (!config) {
      return new Response("Not found", { status: 404 });
    }

    const prefix = config.route_prefix || "/a/";
    const isFoundersPath =
      url.pathname === prefix.replace(/\/$/, "") || url.pathname.startsWith(prefix);

    if (isFoundersPath) {
      return proxyToFounders(request, url, hostname);
    }

    if (config.mode === "subdomain") {
      // The whole subdomain exists for Founders pages; keep URLs uniform by
      // living under /a/ there too.
      if (url.pathname === "/" || url.pathname === "") {
        return Response.redirect(`https://${hostname}${prefix}sitemap.xml`, 302);
      }
      return Response.redirect(
        `https://${hostname}${prefix}${url.pathname.replace(/^\/+/, "")}${url.search}`,
        301,
      );
    }

    // full_proxy: pass everything that isn't ours to the customer's own site.
    if (config.customer_origin) {
      return proxyToCustomerOrigin(request, url, config.customer_origin);
    }

    // No stored origin (misconfigured full_proxy): fail closed with a clear
    // signal rather than serving founders content on their whole domain.
    return new Response("Origin not configured for this domain", { status: 502 });
  },
};

async function getDomainConfig(hostname, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://edge-config.founders.internal/${hostname}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.json();
    return body && body.error ? null : body;
  }

  let res;
  try {
    res = await fetch(
      `${FOUNDERS_ORIGIN}/api/public/domain-config?hostname=${encodeURIComponent(hostname)}`,
      { headers: { "x-founders-edge": "1" } },
    );
  } catch {
    return null;
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = { error: "bad_config_response" };
  }
  const ok = res.status === 200 && body && !body.error;
  const ttl = ok ? CONFIG_TTL_OK : CONFIG_TTL_MISS;
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(ok ? body : { error: body?.error || "miss" }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${ttl}`,
        },
      }),
    ),
  );
  return ok ? body : null;
}

function proxyToFounders(request, url, tenantHost) {
  const target = new URL(url.pathname + url.search, FOUNDERS_ORIGIN);
  const headers = new Headers(request.headers);
  // The Founders app resolves the tenant from x-forwarded-host and
  // canonicalizes to it — this is what keeps canonicals on the customer domain.
  headers.set("x-forwarded-host", tenantHost);
  headers.set("x-founders-edge", "1");
  headers.set("host", target.hostname);
  return fetch(target.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}

function proxyToCustomerOrigin(request, url, origin) {
  const originHost = origin.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!originHost || originHost === url.hostname) {
    return new Response("loop detected", { status: 508 });
  }
  const target = new URL(url.pathname + url.search, `https://${originHost}`);
  const headers = new Headers(request.headers);
  headers.set("host", originHost);
  headers.set("x-founders-edge", "1");
  headers.set("x-forwarded-host", url.hostname);
  return fetch(target.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}
