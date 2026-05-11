import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/content/generate")({
  head: () => ({ meta: [{ title: "Generate Content — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Generate Content"
      description="Bulk-generate programmatic pages from a content plan with AI."
      internalOnly={false}
    />
  ),
});
