import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";
import { deferredRoute } from "@/lib/deferred-route";

export const Route = createFileRoute("/_authenticated/app/content/blog")({
  beforeLoad: deferredRoute,
  head: () => ({ meta: [{ title: "Blog Admin — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Blog Admin"
      description="Long-form posts surfaced under /p/blog/*."
      internalOnly={false}
    />
  ),
});
