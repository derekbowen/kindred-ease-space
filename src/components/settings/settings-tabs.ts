/**
 * The Settings tab strip (SettingsNav): workspace & branding, domains, the
 * Sharetribe connection and billing — the same for every workspace, the
 * founder / internal unlimited one included.
 *
 * Bring-your-own AI keys and workspace API keys are deferred (MVP scope,
 * 2026-09-28): they have no tab, their routes redirect to /app
 * (src/lib/deferred-route.ts) and their server functions refuse
 * (src/lib/features.server.ts). Nothing — no URL parameter, no entitlement —
 * adds a tab.
 *
 * Billing lives at /app/billing (outside /app/settings); its tab is here so
 * Settings is one place for the account.
 */
export const SETTINGS_TABS = [
  { to: "/app/settings", label: "Workspace", exact: true },
  { to: "/app/settings/domains", label: "Domains" },
  { to: "/app/settings/integrations/sharetribe", label: "Sharetribe" },
  { to: "/app/billing", label: "Billing" },
] as const;

export type SettingsTabPath = (typeof SETTINGS_TABS)[number]["to"];

/** Is this tab the current page? Exact for Workspace; the path or below it otherwise. */
export function isSettingsTabActive(
  tab: (typeof SETTINGS_TABS)[number],
  pathname: string,
): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if ("exact" in tab && tab.exact) return path === tab.to;
  return path === tab.to || path.startsWith(`${tab.to}/`);
}
