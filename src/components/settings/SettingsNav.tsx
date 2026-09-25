import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { Settings, Sparkles, Plug, Globe, KeyRound } from "lucide-react";
import { showStubsInUrl } from "@/components/coach/coach-availability";
import { SETTINGS_TABS, isSettingsTabVisible, type SettingsTabPath } from "./settings-tabs";

const ICONS: Record<SettingsTabPath, typeof Settings> = {
  "/app/settings": Settings,
  "/app/settings/domains": Globe,
  "/app/settings/integrations/sharetribe": Plug,
  "/app/settings/ai": Sparkles,
  "/app/settings/api-keys": KeyRound,
};

export function SettingsNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Decided after mount, like the sidebar and the Coach switch: the server
  // render and the first client render agree, and ?showStubs=1 only widens
  // the strip once the page is interactive.
  const [showStubs, setShowStubs] = useState(false);
  useEffect(() => {
    setShowStubs(showStubsInUrl());
  }, []);

  return (
    <nav className="flex flex-wrap gap-1 rounded-lg border border-border/60 bg-muted/30 p-1">
      {SETTINGS_TABS.filter((tab) => isSettingsTabVisible(tab.to, { showStubs })).map((tab) => {
        const Icon = ICONS[tab.to];
        const exact = "exact" in tab && tab.exact;
        const active = exact ? pathname === tab.to : pathname.startsWith(tab.to);
        return (
          <Link
            key={tab.to}
            to={tab.to}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition",
              active
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-background/60",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
