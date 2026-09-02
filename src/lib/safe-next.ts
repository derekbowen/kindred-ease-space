/**
 * Post-login destination from a `?next=` parameter. Only same-origin paths
 * are honoured; anything that could leave the site (absolute URLs,
 * protocol-relative "//host", backslash tricks) falls back to the app home.
 */
export const DEFAULT_NEXT = "/app";

export function safeNextPath(next: string | undefined | null, fallback = DEFAULT_NEXT): string {
  if (!next) return fallback;
  if (!next.startsWith("/")) return fallback;
  if (next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(next)) return fallback;
  return next;
}
