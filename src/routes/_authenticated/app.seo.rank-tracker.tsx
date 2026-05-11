import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/seo/rank-tracker")({
  head: () => ({ meta: [{ title: "Rank Tracker — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Rank Tracker"
      description="Daily keyword positions per workspace."
      internalOnly={false}
    />
  ),
});
