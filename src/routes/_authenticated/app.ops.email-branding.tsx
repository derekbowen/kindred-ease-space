import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";
import { deferredRoute } from "@/lib/deferred-route";

export const Route = createFileRoute("/_authenticated/app/ops/email-branding")({
  beforeLoad: deferredRoute,
  head: () => ({ meta: [{ title: "Email Branding — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Email Branding"
      description="Logo, colors, and footer applied to outbound email."
      internalOnly={false}
    />
  ),
});
