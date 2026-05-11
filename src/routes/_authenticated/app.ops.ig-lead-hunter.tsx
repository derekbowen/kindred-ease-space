import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/ops/ig-lead-hunter")({
  head: () => ({ meta: [{ title: "IG Lead Hunter — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="IG Lead Hunter"
      description="Find Instagram leads (pool owners, party planners) at scale."
      internalOnly={true}
    />
  ),
});
