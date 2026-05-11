import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/ops/lead-inbox")({
  head: () => ({ meta: [{ title: "Lead Inbox — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Lead Inbox"
      description="Leads captured by the social-media scraper land here."
      internalOnly={false}
    />
  ),
});
