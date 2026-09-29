import { redirect } from "@tanstack/react-router";

/**
 * THE GUARD ON A DEFERRED SCREEN (MVP scope, owner 2026-09-28).
 *
 * A deferred route keeps its file and its code but cannot be reached:
 * `beforeLoad: deferredRoute` sends every visit to the dashboard before the
 * route loads or renders anything — for every workspace, the founder /
 * internal unlimited one and platform admins included, and whatever the URL
 * says (there is no ?showStubs=1 any more). Nothing in the sidebar links to a
 * deferred route (src/lib/app-nav.ts), and whatever the screen would have
 * called is refused on the server as well (src/lib/features.server.ts).
 *
 * To bring a screen back: remove its `beforeLoad: deferredRoute`, add it to
 * the sidebar, and turn its server feature back on.
 */
export const DEFERRED_ROUTE_TARGET = "/app";

export function deferredRoute(): never {
  throw redirect({ to: DEFERRED_ROUTE_TARGET, replace: true });
}
