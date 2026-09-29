import { createFileRoute, redirect } from "@tanstack/react-router";

// Bulk page creation bypassed the builder's template, inventory and publish
// checks. Pages are created one at a time from an opportunity or
// Pages → New page; this address now leads there.
export const Route = createFileRoute("/_authenticated/app/pages/bulk")({
  beforeLoad: () => {
    throw redirect({ to: "/app/pages" });
  },
});
