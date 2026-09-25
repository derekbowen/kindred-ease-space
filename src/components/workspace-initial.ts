/**
 * The letter shown where a workspace has no logo: the brand name's initial,
 * else the workspace name's, else "F". Shared by the app sidebar and the
 * Branding card so the two placeholders always agree (the card used to show
 * a fixed "W").
 */
export function workspaceInitial(
  brandName: string | null | undefined,
  workspaceName: string | null | undefined,
): string {
  return (brandName?.trim() || workspaceName?.trim() || "F").slice(0, 1).toUpperCase();
}
