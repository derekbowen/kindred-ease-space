import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/content/data-import")({
  head: () => ({ meta: [{ title: "Data Import — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Data Import"
      description="Bulk-upload CSV to seed cities, pages, leads, and more."
      internalOnly={false}
    />
  ),
});
