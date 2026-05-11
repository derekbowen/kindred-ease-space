import { createFileRoute, Navigate } from "@tanstack/react-router";

// "New" is just edit with no id — redirect to the edit shell which handles both.
export const Route = createFileRoute("/_authenticated/app/pages/new")({
  component: () => <Navigate to="/app/pages/$id/edit" params={{ id: "new" }} />,
});
