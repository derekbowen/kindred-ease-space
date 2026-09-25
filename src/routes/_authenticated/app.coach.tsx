import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { MessagesSquare } from "lucide-react";

/**
 * The Coach chat is not part of launch: its backend (the coach-chat edge
 * function) has been removed, and this route makes no call of any kind —
 * no conversation reads, no chat request. The daily briefing on the
 * dashboard is unaffected. Nav entry: launch:false (src/lib/app-nav.ts).
 */
export const Route = createFileRoute("/_authenticated/app/coach")({
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
