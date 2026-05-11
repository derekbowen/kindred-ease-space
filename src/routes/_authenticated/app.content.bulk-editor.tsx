import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/content/bulk-editor")({
  head: () => ({ meta: [{ title: "Bulk Page Editor — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Bulk Page Editor"
      description="Find-and-replace across content_pages with AI assistance."
      internalOnly={false}
    />
  ),
});
