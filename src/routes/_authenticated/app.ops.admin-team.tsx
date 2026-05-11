import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/ops/admin-team")({
  head: () => ({ meta: [{ title: "Admin Team — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Admin Team"
      description="Manage workspace members and roles."
      internalOnly={false}
    />
  ),
});
