import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";
import { deferredRoute } from "@/lib/deferred-route";

export const Route = createFileRoute("/_authenticated/app/ops/social-lead-hunter")({
  beforeLoad: deferredRoute,
  head: () => ({ meta: [{ title: "Social Lead Hunter — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Social Lead Hunter"
      description="Cross-platform social scraper for inbound demand."
      internalOnly={true}
    />
  ),
});
