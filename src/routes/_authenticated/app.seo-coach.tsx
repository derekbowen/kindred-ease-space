import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/seo-coach")({
  head: () => ({ meta: [{ title: "SEO Coach — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="SEO Coach"
      description="AI assistant that critiques a page or topic and suggests improvements."
      internalOnly={false}
    />
  ),
});
