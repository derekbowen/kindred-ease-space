import { createFileRoute, redirect } from "@tanstack/react-router";

// The Quick Page Builder is consolidated into the page builder
// (Pages → New page): one generation path with three templates, claim-first
// drafts and publish checks. Old links land there.
export const Route = createFileRoute("/_authenticated/app/content/quick-page-builder")({
  beforeLoad: () => {
    throw redirect({ to: "/app/pages/new" });
  },
});
