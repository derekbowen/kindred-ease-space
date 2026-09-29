import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";
import { deferredRoute } from "@/lib/deferred-route";

export const Route = createFileRoute("/_authenticated/app/seo/listing-auditor")({
  beforeLoad: deferredRoute,
  head: () => ({ meta: [{ title: "Listing Auditor — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Listing Auditor"
      description="Audit Sharetribe listings for missing fields and weak copy."
      internalOnly={false}
    />
  ),
});
