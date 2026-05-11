import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/ops/plan-requests")({
  head: () => ({ meta: [{ title: "Plan Requests — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Plan Requests"
      description="Manual plan upgrades & comps. Internal only."
      internalOnly={true}
    />
  ),
});
