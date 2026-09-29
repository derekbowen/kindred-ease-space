import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

/**
 * A scaffolded screen that is not a product. Every route that renders one is
 * deferred (MVP scope, 2026-09-28) and already redirects to /app in its
 * beforeLoad (src/lib/deferred-route.ts); this is the second line: whoever
 * reaches it anyway is sent to the dashboard and shown nothing. There is no
 * way to reveal it: the old URL switch for internal testing is gone.
 *
 * The props are kept so the stub routes need no change.
 */
export function StubToolPage(_props: {
  title: string;
  description: string;
  internalOnly?: boolean;
}) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate({ to: "/app", replace: true });
  }, [navigate]);
  return null;
}
