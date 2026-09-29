import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { MessagesSquare } from "lucide-react";
import { deferredRoute } from "@/lib/deferred-route";

/**
 * DEFERRED (MVP scope, 2026-09-28): unreachable — `beforeLoad: deferredRoute`
 * sends every visit to the dashboard (src/lib/deferred-route.ts), there is
 * no sidebar entry, and the Coach and daily-briefing server functions refuse
 * (src/lib/features.server.ts). The page below is kept as it was: a static
 * notice that makes no call of any kind.
 */
export const Route = createFileRoute("/_authenticated/app/coach")({
  beforeLoad: deferredRoute,
  head: () => ({ meta: [{ title: "Coach — founders.click" }] }),
  component: CoachPage,
});

function CoachPage() {
  return (
    <div className="p-6">
      <Card className="max-w-xl mx-auto p-8 text-center space-y-3">
        <MessagesSquare className="h-10 w-10 text-primary mx-auto" />
        <h1 className="text-lg font-semibold">Coach isn&apos;t available yet</h1>
        <p className="text-sm text-muted-foreground">
          The Coach chat is coming later. Your daily briefing on the dashboard still lists the
          most useful next steps for your workspace.
        </p>
      </Card>
    </div>
  );
}
