import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/seo/missing-pages")({
  head: () => ({ meta: [{ title: "Missing Pages (404s) — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Missing Pages (404s)"
      description="Detect 404s from GSC + logs and suggest fills."
      internalOnly={false}
    />
  ),
});
