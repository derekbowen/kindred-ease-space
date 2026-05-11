import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/content/migration")({
  head: () => ({ meta: [{ title: "Content Migration — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Content Migration"
      description="Import legacy URLs into /p/{slug} with redirects."
      internalOnly={false}
    />
  ),
});
