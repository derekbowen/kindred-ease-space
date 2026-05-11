import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/seo/keyword-opportunities")({
  head: () => ({ meta: [{ title: "Keyword Opportunities — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Keyword Opportunities"
      description="Surface low-hanging keywords from GSC + scrape data."
      internalOnly={false}
    />
  ),
});
