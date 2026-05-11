import { createFileRoute } from "@tanstack/react-router";
import { StubToolPage } from "@/components/StubToolPage";

export const Route = createFileRoute("/_authenticated/app/content/city-heroes")({
  head: () => ({ meta: [{ title: "City Heroes — founders.click" }] }),
  component: () => (
    <StubToolPage
      title="City Heroes"
      description="Manage city hero imagery and copy. Internal staff only."
      internalOnly={true}
    />
  ),
});
