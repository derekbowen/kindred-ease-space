import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";
import { deferredRoute } from "@/lib/deferred-route";

export const Route = createFileRoute("/_authenticated/app/seo/link-audit")({
  beforeLoad: deferredRoute,
  head: () => ({ meta: [{ title: "Link Audit Dashboard — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Link Audit Dashboard"
      description="Aggregated view of broken-link audits across the site."
      internalOnly={false}
    />
  ),
});
