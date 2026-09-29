/**
 * The "Ask coach" button screens used to place beside an editor. The Coach is
 * DEFERRED (MVP scope, 2026-09-28), so this renders nothing — for every
 * workspace, the founder / internal unlimited one included, and whatever the
 * URL says. There is no switch that brings it back: the Coach's route
 * redirects to /app (src/lib/deferred-route.ts) and its server functions
 * refuse (src/lib/features.server.ts).
 *
 * Kept, with its props, only because screens other workstreams own still
 * mount it (the Sharetribe page, the page editor); they can drop the element.
 */
export function InlineCoach(_props: {
  workspaceId: string | null;
  context?: { page_id?: string; route?: string };
  label?: string;
  variant?: "default" | "outline" | "secondary" | "ghost";
  size?: "sm" | "default" | "lg";
  className?: string;
}): null {
  return null;
}
