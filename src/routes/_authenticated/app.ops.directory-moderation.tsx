import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/ops/directory-moderation")({
  head: () => ({ meta: [{ title: "Directory Moderation — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="Directory Moderation"
      description="Approve / remove provider listings. Internal only."
      internalOnly={true}
    />
  ),
});
