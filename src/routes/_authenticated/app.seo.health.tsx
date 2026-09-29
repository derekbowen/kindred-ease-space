import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";
import { deferredRoute } from "@/lib/deferred-route";

export const Route = createFileRoute("/_authenticated/app/seo/health")({
  beforeLoad: deferredRoute,
  head: () => ({ meta: [{ title: "SEO Health — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="SEO Health"
      description="Site-wide SEO score and red flags."
      internalOnly={false}
    />
  ),
});
