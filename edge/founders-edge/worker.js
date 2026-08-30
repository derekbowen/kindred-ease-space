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
const CONFIG_TTL_OK = 60; // seconds — fresh copy, so changes propagate fast
const CONFIG_TTL_MISS = 10;

// Last-known-good config survives this long and is used only when the control
// plane is unreachable. It is a safety net, NOT a second source of truth: a
// customer can legitimately migrate their origin inside this window, so every
// stale serve is reported and /a/* stops being served well before the window
// closes.
const STALE_MAX_S = 86_400; // 24h
const STALE_HARD_LIMIT_S = 3_600; // 1h — beyond this we stop serving OUR pages
const STALE_ALERT_AFTER_S = 300; // 5m — report to the control plane

/** Fire-and-forget staleness telemetry so a control-plane outage is visible to
 *  us before a customer has to report it. Never blocks the response. */
function reportStale(hostname, ageS, ctx) {
  if (ageS < STALE_ALERT_AFTER_S) return;
  try {
    ctx.waitUntil(
      fetch(`${FOUNDERS_ORIGIN}/api/public/edge-health`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-founders-edge": "1" },
        body: JSON.stringify({ hostname, state: "STALE_CONFIG", stale_age_s: ageS }),
      }).catch(() => {}),
    );
  } catch {
    /* telemetry must never break routing */
  }
}

// ROUTING MODEL — one Worker route per connected customer hostname
// (`customer.com/*`), created automatically when a domain is provisioned. See
// src/lib/domain-provisioning.server.ts.
//
// Cloudflare documents three options for getting custom-hostname traffic to a
// Worker. `*/*` is the one they recommend, but it routes EVERY request
// entering the zone through this Worker — marketing site and app included. We
// deliberately use their third option ("Route only custom hostname traffic to
// the Worker", route = the vanity hostname) so platform traffic never enters
// this code path at all. Note a route on the fallback-origin hostname alone
// would NOT work: the route has to name the customer hostname.
//
// Consequence to keep in mind: with no wildcard, a custom hostname created
// WITHOUT its route falls through to the originless fallback origin and that
// customer is hard down. That is why provisioning creates hostname + route as
// one unit and rolls back if either half fails.
//
// The PLATFORM_HOSTS passthrough below is belt-and-braces: if anyone ever adds
// a `*/*` route by hand, founders.click still cannot be taken down by this
// Worker.
const PLATFORM_HOSTS = new Set([
  "founders.click",
  "www.founders.click",
  "proxy.founders.click",
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase();

    if (PLATFORM_HOSTS.has(hostname)) {
      return fetch(request);
    }

    if (request.headers.get("x-founders-edge")) {
      return new Response("loop detected", { status: 508 });
    }

    const config = await getDomainConfig(hostname, env, ctx);

    // A hostname we have never successfully resolved is not ours to serve.
    if (!config) {
      return new Response("Not found", { status: 404 });
    }

    const prefix = config.route_prefix || "/a/";
    const isFoundersPath =
      url.pathname === prefix.replace(/\/$/, "") || url.pathname.startsWith(prefix);

    // KILL SWITCH: the control plane can disable Founders handling for one
    // hostname without the customer touching DNS. Everything, /a/* included,
    // passes straight through to their origin. Their marketplace always wins.
    if (config.disabled) {
      if (config.customer_origin) {
        return proxyToCustomerOrigin(request, url, config.customer_origin);
      }
      return new Response("Not found", { status: 404 });
    }

    // FAIL OPEN vs FAIL CLOSED — the asymmetry is deliberate.
    // `stale` means the control plane was unreachable and we are running on a
    // cached config. Our own pages fail closed (502, our problem). The
    // customer's traffic keeps flowing to their origin, because a founders.click
    // outage must never take down somebody's booking site.
    if (isFoundersPath) {
      if (config.stale && config.stale_age_s > STALE_HARD_LIMIT_S) {
        return new Response("Temporarily unavailable", {
          status: 502,
          headers: { "Cache-Control": "no-store", "Retry-After": "60" },
        });
      }
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

/**
 * Resolve routing config with STALE-WHILE-ERROR semantics.
 *
 * The fresh cache expires quickly so config changes propagate. A second,
 * long-lived copy survives for STALE_MAX_S and is used whenever the control
 * plane is unreachable or erroring. In full_proxy this is the difference
 * between "founders.click is down" and "the customer's entire business is
 * returning 404" — a stale origin is infinitely better than no origin.
 */
async function getDomainConfig(hostname, env, ctx) {
  const cache = caches.default;
  const freshKey = new Request(`https://edge-config.founders.internal/fresh/${hostname}`);
  const staleKey = new Request(`https://edge-config.founders.internal/stale/${hostname}`);

  const fresh = await cache.match(freshKey);
  if (fresh) {
    const body = await fresh.json();
    return body && body.error ? null : body;
  }

  let res = null;
  let body = null;
  try {
    res = await fetch(
      `${FOUNDERS_ORIGIN}/api/public/domain-config?hostname=${encodeURIComponent(hostname)}`,
      { headers: { "x-founders-edge": "1" } },
    );
    body = await res.json();
  } catch {
    body = null;
  }

  const ok = res && res.status === 200 && body && !body.error;

  if (ok) {
    const stamped = JSON.stringify({ ...body, cached_at: Date.now() });
    ctx.waitUntil(
      Promise.all([
        cache.put(freshKey, new Response(stamped, {
          headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CONFIG_TTL_OK}` },
        })),
        cache.put(staleKey, new Response(stamped, {
          headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${STALE_MAX_S}` },
        })),
      ]),
    );
    return body;
  }

  // A definitive 404 from a healthy control plane means the domain really is
  // not ours — drop the stale copy so disconnects take effect.
  if (res && res.status === 404) {
    ctx.waitUntil(cache.delete(staleKey));
    ctx.waitUntil(
      cache.put(freshKey, new Response(JSON.stringify({ error: "domain_not_found" }), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CONFIG_TTL_MISS}` },
      })),
    );
    return null;
  }

  // Control plane unreachable or 5xx — fall back to the last known good config.
  const stale = await cache.match(staleKey);
  if (stale) {
    const body2 = await stale.json();
    if (body2 && !body2.error) {
      const ageS = Math.round((Date.now() - (body2.cached_at ?? 0)) / 1000);
      console.warn("[founders-edge] serving stale config", hostname, "age_s=", ageS);
      reportStale(hostname, ageS, ctx);
      return { ...body2, stale: true, stale_age_s: ageS };
    }
  }
  return null;
}

async function proxyToFounders(request, url, tenantHost) {
  const target = new URL(url.pathname + url.search, FOUNDERS_ORIGIN);
  const headers = new Headers(request.headers);
  // The Founders app resolves the tenant from x-forwarded-host and
  // canonicalizes to it — this is what keeps canonicals on the customer domain.
  headers.set("x-forwarded-host", tenantHost);
  headers.set("x-founders-edge", "1");
  headers.set("host", target.hostname);
  try {
    return await fetch(target.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
  } catch (e) {
    console.error("[founders-edge] founders origin unreachable", tenantHost, String(e));
    return new Response("Temporarily unavailable", {
      status: 502,
      headers: { "Cache-Control": "no-store", "Retry-After": "30" },
    });
  }
}

// Safe-disable posture: the customer's own traffic is the highest-blast-radius
// path, so origin passthrough NEVER turns off for transient states (error /
// failing health keep proxying). Only an unreachable origin produces a 502 —
// uncached, retryable, logged — and the control plane surfaces the failure to
// the customer with revert-DNS instructions. True rollback is the customer's
// DNS change; nothing here can silently take their site down harder.
async function proxyToCustomerOrigin(request, url, origin) {
  const originHost = origin.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!originHost || originHost === url.hostname) {
    return new Response("loop detected", { status: 508 });
  }
  const target = new URL(url.pathname + url.search, `https://${originHost}`);
  const headers = new Headers(request.headers);
  headers.set("host", originHost);
  headers.set("x-founders-edge", "1");
  headers.set("x-forwarded-host", url.hostname);
  try {
    return await fetch(target.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
  } catch (e) {
    console.error("[founders-edge] customer origin unreachable", url.hostname, originHost, String(e));
    return new Response("Origin temporarily unavailable", {
      status: 502,
      headers: { "Cache-Control": "no-store", "Retry-After": "30" },
    });
  }
}
