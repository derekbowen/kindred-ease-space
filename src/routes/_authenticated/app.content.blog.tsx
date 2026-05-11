import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/content/blog")({
  head: () => ({ meta: [{ title: "Blog Admin — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Blog Admin"
      description="Long-form posts surfaced under /p/blog/*."
      internalOnly={false}
    />
  ),
});
