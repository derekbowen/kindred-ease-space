import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";
import { deferredRoute } from "@/lib/deferred-route";

export const Route = createFileRoute("/_authenticated/app/ops/email-verify")({
  beforeLoad: deferredRoute,
  head: () => ({ meta: [{ title: "Email Verify — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Email Verify"
      description="Verify lead email addresses (deliverable / catch-all / invalid)."
      internalOnly={false}
    />
  ),
});
