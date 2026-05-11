import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CoachPanel } from "./CoachPanel";

export function CoachLauncher({ workspaceId }: { workspaceId: string | null }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!workspaceId) return null;

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        size="lg"
        className="fixed bottom-6 right-6 z-40 rounded-full shadow-lg shadow-primary/30 h-14 w-14 p-0"
        aria-label="Open coach (⌘J)"
      >
        <Sparkles className="h-5 w-5" />
      </Button>
      <CoachPanel open={open} onOpenChange={setOpen} workspaceId={workspaceId} />
    </>
  );
}
