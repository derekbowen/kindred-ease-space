import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/ops/site-footer")({
  head: () => ({ meta: [{ title: "Site Footer — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Site Footer"
      description="Footer links and copy for your marketplace."
      internalOnly={false}
    />
  ),
});
