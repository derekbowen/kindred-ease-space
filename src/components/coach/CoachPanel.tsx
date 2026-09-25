import { Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * The Coach chat is not part of launch: its backend (the coach-chat edge
 * function) is being removed, and every entry point that opens this panel is
 * hidden while the Coach is off (coach-availability.ts). So the panel makes
 * no request of any kind — no conversation list, no history, no send — and
 * says so plainly if an internal build (?showStubs=1) opens it, instead of
 * offering a box that cannot answer.
 *
 * The props stay as they were so callers need no change when the Coach
 * returns.
 */
export function CoachPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: string | null;
  context?: { page_id?: string; route?: string };
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg flex flex-col p-0 dark bg-background text-foreground"
      >
        <SheetHeader className="px-4 py-3 border-b border-border space-y-0">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            Coach
          </SheetTitle>
          <SheetDescription className="sr-only">Coach is coming soon.</SheetDescription>
        </SheetHeader>
        <div className="px-4 py-6 space-y-3 text-sm">
          <p className="font-medium">Coach is coming soon.</p>
          <p className="text-muted-foreground">
            Chatting with the coach about your workspace isn't available yet. If you need a hand
            now, contact support.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link to="/help/contact">Contact support</Link>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
