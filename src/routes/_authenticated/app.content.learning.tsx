import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";
import { deferredRoute } from "@/lib/deferred-route";

export const Route = createFileRoute("/_authenticated/app/content/learning")({
  beforeLoad: deferredRoute,
  head: () => ({ meta: [{ title: "Learning Admin — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Learning Admin"
      description="Courses, modules, and certificate completions."
      internalOnly={false}
    />
  ),
});
