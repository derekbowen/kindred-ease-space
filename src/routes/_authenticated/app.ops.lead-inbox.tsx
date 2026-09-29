import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";
import { deferredRoute } from "@/lib/deferred-route";

export const Route = createFileRoute("/_authenticated/app/ops/lead-inbox")({
  beforeLoad: deferredRoute,
  head: () => ({ meta: [{ title: "Lead Inbox — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Lead Inbox"
      description="Leads captured by the social-media scraper land here."
      internalOnly={false}
    />
  ),
});
