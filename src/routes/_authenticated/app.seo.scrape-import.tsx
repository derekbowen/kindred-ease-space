import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";
import { deferredRoute } from "@/lib/deferred-route";

export const Route = createFileRoute("/_authenticated/app/seo/scrape-import")({
  beforeLoad: deferredRoute,
  head: () => ({ meta: [{ title: "Scrape Import — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Scrape Import"
      description="Import scraped competitor pages and keywords."
      internalOnly={false}
    />
  ),
});
