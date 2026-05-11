import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/seo/link-checker")({
  head: () => ({ meta: [{ title: "Link Checker — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Link Checker"
      description="Crawl every page and flag broken links."
      internalOnly={false}
    />
  ),
});
