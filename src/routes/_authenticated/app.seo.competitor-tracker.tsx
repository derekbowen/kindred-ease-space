import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/seo/competitor-tracker")({
  head: () => ({ meta: [{ title: "Competitor Tracker — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Competitor Tracker"
      description="Track named competitors over time."
      internalOnly={false}
    />
  ),
});
