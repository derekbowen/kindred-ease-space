import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/seo/gsc-import")({
  head: () => ({ meta: [{ title: "GSC Import — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="GSC Import"
      description="Connect Google Search Console and pull queries."
      internalOnly={false}
    />
  ),
});
