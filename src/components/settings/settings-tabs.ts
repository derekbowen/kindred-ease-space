import { NAV_SECTIONS, isNavItemVisible, type NavItem } from "@/lib/app-nav";

/**
 * Which Settings tabs a customer sees.
 *
 * A tab follows its sidebar entry's launch rule (isNavItemVisible in
 * src/lib/app-nav.ts): AI Providers and API Keys are `launch: false` in the
 * sidebar, but the Settings tab strip listed them for every customer anyway,
 * which put bring-your-own-key screens for tools that are not in this launch
 * one click from Workspace Settings. A tab with no sidebar entry of its own
 * (Domains) is part of settings proper and always shows. `?showStubs=1`
 * reveals everything for internal testing, exactly as it does the sidebar.
 */
export const SETTINGS_TABS = [
  { to: "/app/settings", label: "Workspace", exact: true },
  { to: "/app/settings/domains", label: "Domains" },
  { to: "/app/settings/integrations/sharetribe", label: "Sharetribe" },
  { to: "/app/settings/ai", label: "AI Providers" },
  { to: "/app/settings/api-keys", label: "API Keys" },
] as const;

export type SettingsTabPath = (typeof SETTINGS_TABS)[number]["to"];

function sidebarItemFor(to: string): NavItem | undefined {
  for (const section of NAV_SECTIONS) {
    const item = section.items.find((i) => i.to === to);
    if (item) return item;
  }
  return undefined;
}

export function isSettingsTabVisible(to: string, opts: { showStubs: boolean }): boolean {
  const item = sidebarItemFor(to);
  if (!item) return true;
  return isNavItemVisible(item, { showStubs: opts.showStubs, isInternal: false });
}
