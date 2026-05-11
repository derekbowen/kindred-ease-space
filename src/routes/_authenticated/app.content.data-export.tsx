import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/content/data-export")({
  head: () => ({ meta: [{ title: "Data Export — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Data Export"
      description="Export tables to CSV (leads, pages, blog) for offline analysis."
      internalOnly={false}
    />
  ),
});
