import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

// Onboarding is no longer a wall. Workspaces are auto-provisioned on app entry
// and marketplace setup is an optional portal in Settings — so this route just
// forwards anyone who lands here (old links, email redirects) into the product.
export const Route = createFileRoute("/_authenticated/app/onboarding")({
  component: OnboardingRedirect,
});

function OnboardingRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate({ to: "/app", replace: true });
  }, [navigate]);
  return null;
}