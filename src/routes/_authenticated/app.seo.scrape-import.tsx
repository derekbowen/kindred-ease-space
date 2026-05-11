import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/seo/scrape-import")({
  head: () => ({ meta: [{ title: "Scrape Import — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Scrape Import"
      description="Import scraped competitor pages and keywords."
      internalOnly={false}
    />
  ),
});
