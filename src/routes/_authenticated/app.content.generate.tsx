import { createFileRoute, redirect } from "@tanstack/react-router";

// "Generate Content" (batch generation) is consolidated into the page
// builder: pages start from Opportunities, one reviewed draft at a time.
// Old links land on Opportunities.
export const Route = createFileRoute("/_authenticated/app/content/generate")({
  beforeLoad: () => {
    throw redirect({ to: "/app/opportunities" });
  },
});
