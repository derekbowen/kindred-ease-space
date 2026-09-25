import { useEffect, useState } from "react";
import { NAV_SECTIONS, isNavItemVisible, type NavItem } from "@/lib/app-nav";

/**
 * The one switch for every Coach surface: the floating launcher, each
 * "Ask coach" button (InlineCoach) and the dashboard's "Ask Coach" link.
 *
 * It is the Coach's own sidebar entry, read through the sidebar's rule
 * (isNavItemVisible in src/lib/app-nav.ts). While that entry is
 * `launch: false` no entry point renders — so none can open the chat — and
 * they all come back together the day the entry ships. `?showStubs=1`
 * reveals them for internal testing, exactly as it does the sidebar. A build
 * with no Coach entry at all has no Coach.
 *
 * The DailyBriefing dashboard card is not a chat entry point and is not
 * behind this switch.
 */
export const COACH_ROUTE = "/app/coach";

export function coachNavItem(): NavItem | undefined {
  for (const section of NAV_SECTIONS) {
    const item = section.items.find((i) => i.to === COACH_ROUTE);
    if (item) return item;
  }
  return undefined;
}

export function isCoachEnabled(opts: { showStubs: boolean; isInternal?: boolean }): boolean {
  const item = coachNavItem();
  if (!item) return false;
  return isNavItemVisible(item, {
    showStubs: opts.showStubs,
    isInternal: opts.isInternal ?? false,
  });
}

/** `?showStubs=1` on the current URL, as the shell reads it. False during SSR. */
export function showStubsInUrl(): boolean {
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("showStubs") === "1"
  );
}

/**
 * isCoachEnabled for the current page. Starts false and is decided after
 * mount, so the server render and the first client render agree (no
 * hydration mismatch under ?showStubs=1) and a launch build never renders a
 * Coach entry point even for a frame.
 */
export function useCoachEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    setEnabled(isCoachEnabled({ showStubs: showStubsInUrl() }));
  }, []);
  return enabled;
}
