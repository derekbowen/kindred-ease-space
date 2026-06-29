import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CoachPanel } from "./CoachPanel";

/**
 * InlineCoach renders a compact "Ask coach" trigger anchored within an editor
 * page. When opened it slides in the shared CoachPanel pre-loaded with the
 * current page/route context so suggestions are scoped to what the user is
 * editing. Hidden until a workspaceId is available.
 */
export function InlineCoach({
  workspaceId,
  context,
  label = "Ask coach",
  variant = "outline",
  size = "sm",
  className,
}: {
  workspaceId: string | null;
  context?: { page_id?: string; route?: string };
  label?: string;
  variant?: "default" | "outline" | "secondary" | "ghost";
  size?: "sm" | "default" | "lg";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!workspaceId) return null;
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={() => setOpen(true)}
        className={className}
      >
        <Sparkles className="h-3.5 w-3.5 mr-1.5" />
        {label}
      </Button>
      <CoachPanel open={open} onOpenChange={setOpen} workspaceId={workspaceId} context={context} />
    </>
  );
}
