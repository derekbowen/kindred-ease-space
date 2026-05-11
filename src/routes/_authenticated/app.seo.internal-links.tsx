import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/seo/internal-links")({
  head: () => ({ meta: [{ title: "Internal Link Recommender — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Internal Link Recommender"
      description="Suggest internal links between content_pages."
      internalOnly={false}
    />
  ),
});
