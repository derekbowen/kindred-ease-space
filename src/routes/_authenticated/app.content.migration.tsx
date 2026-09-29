import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";
import { deferredRoute } from "@/lib/deferred-route";

export const Route = createFileRoute("/_authenticated/app/content/migration")({
  beforeLoad: deferredRoute,
  head: () => ({ meta: [{ title: "Content Migration — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Content Migration"
      description="Import legacy URLs into /a/{slug} with redirects."
      internalOnly={false}
    />
  ),
});
