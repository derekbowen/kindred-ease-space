import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /templates was the store's address for a few hours on 2026-10-01 (served by
 * the old founders repo build). Keep old links working.
 */
export const Route = createFileRoute("/templates")({
  beforeLoad: () => {
    throw redirect({ to: "/sharetribe-templates", statusCode: 301 });
  },
});
