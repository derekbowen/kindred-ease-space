import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/seo/page-auditor")({
  head: () => ({ meta: [{ title: "AI Page Auditor — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="AI Page Auditor"
      description="AI-driven on-page audit of any URL."
      internalOnly={false}
    />
  ),
});
