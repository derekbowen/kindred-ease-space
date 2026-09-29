import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { Settings, Plug, Globe, CreditCard } from "lucide-react";
import { SETTINGS_TABS, isSettingsTabActive, type SettingsTabPath } from "./settings-tabs";

const ICONS: Record<SettingsTabPath, typeof Settings> = {
  "/app/settings": Settings,
  "/app/settings/domains": Globe,
  "/app/settings/integrations/sharetribe": Plug,
  "/app/billing": CreditCard,
};

/**
 * The Settings tab strip. Every workspace sees the same four tabs
 * (settings-tabs.ts): there is no flag that shows or hides one.
 */
export function SettingsNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav className="flex flex-wrap gap-1 rounded-lg border border-border/60 bg-muted/30 p-1">
      {SETTINGS_TABS.map((tab) => {
        const Icon = ICONS[tab.to];
        const active = isSettingsTabActive(tab, pathname);
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
