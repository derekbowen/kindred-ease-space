import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { Settings, Sparkles, Plug, Globe, KeyRound } from "lucide-react";

const LINKS = [
  { to: "/app/settings", label: "Workspace", icon: Settings, exact: true },
  { to: "/app/settings/domains", label: "Domains", icon: Globe },
  { to: "/app/settings/integrations/sharetribe", label: "Sharetribe", icon: Plug },
  { to: "/app/settings/ai", label: "AI Providers", icon: Sparkles },
  { to: "/app/settings/api-keys", label: "API Keys", icon: KeyRound },
] as const;

export function SettingsNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav className="flex flex-wrap gap-1 rounded-lg border border-border/60 bg-muted/30 p-1">
      {LINKS.map(({ to, label, icon: Icon, ...rest }) => {
        const exact = "exact" in rest && rest.exact;
        const active = exact ? pathname === to : pathname.startsWith(to);
        return (
          <Link
            key={to}
            to={to}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition",
              active
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-background/60",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
