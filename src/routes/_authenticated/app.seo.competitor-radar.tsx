import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";
import { deferredRoute } from "@/lib/deferred-route";

export const Route = createFileRoute("/_authenticated/app/seo/competitor-radar")({
  beforeLoad: deferredRoute,
  head: () => ({ meta: [{ title: "Competitor Radar — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Competitor Radar"
      description="Watch competitor SERP movement and new pages."
      internalOnly={false}
    />
  ),
});
