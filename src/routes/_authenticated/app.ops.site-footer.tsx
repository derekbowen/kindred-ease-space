import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";
import { deferredRoute } from "@/lib/deferred-route";

export const Route = createFileRoute("/_authenticated/app/ops/site-footer")({
  beforeLoad: deferredRoute,
  head: () => ({ meta: [{ title: "Site Footer — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Site Footer"
      description="Footer links and copy for your marketplace."
      internalOnly={false}
    />
  ),
});
