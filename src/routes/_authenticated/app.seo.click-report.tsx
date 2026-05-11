import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/seo/click-report")({
  head: () => ({ meta: [{ title: "Click Report — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Click Report"
      description="Click-through performance per page and query."
      internalOnly={false}
    />
  ),
});
