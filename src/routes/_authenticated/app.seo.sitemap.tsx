import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/seo/sitemap")({
  head: () => ({ meta: [{ title: "Sitemap & Indexing — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Sitemap & Indexing"
      description="Inspect sitemap.xml and submit to Google."
      internalOnly={false}
    />
  ),
});
