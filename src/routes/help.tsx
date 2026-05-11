import { createFileRoute, Outlet } from "@tanstack/react-router";
import { HelpHeader, HelpFooter } from "@/components/help/HelpHeader";
import { HelpAssistantWidget } from "@/components/help/HelpAssistantWidget";

export const Route = createFileRoute("/help")({
  component: HelpLayout,
});

function HelpLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <HelpHeader />
      <main>
        <Outlet />
      </main>
      <HelpFooter />
      <HelpAssistantWidget />
    </div>
  );
}
