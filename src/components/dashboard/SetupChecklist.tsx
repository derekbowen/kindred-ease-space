import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Circle, Plug, Globe, RefreshCw, FileText } from "lucide-react";

export type SetupStatus = {
  sharetribeConnected: boolean;
  hasListings: boolean;
  hasDomain: boolean;
  hasPublishedPage: boolean;
};

type Step = {
  id: string;
  label: string;
  description: string;
  done: boolean;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  cta: string;
};

export function SetupChecklist({ status }: { status: SetupStatus }) {
  const steps: Step[] = [
    {
      id: "sharetribe",
      label: "Connect Sharetribe",
      description: "Pull your listings so we can build SEO pages around them.",
      done: status.sharetribeConnected,
      to: "/app/settings/integrations/sharetribe",
      icon: Plug,
      cta: "Connect",
    },
    {
      id: "listings",
      label: "Sync listings",
      description: "Run a sync after connecting — city and category pages need listing data.",
      done: status.hasListings,
      to: "/app/settings/integrations/sharetribe",
      icon: RefreshCw,
      cta: "Sync now",
    },
    {
      id: "domain",
      label: "Set marketplace domain",
      description: "Used for canonical URLs and tenant page hosting on your real domain.",
      done: status.hasDomain,
      to: "/app/settings",
      icon: Globe,
      cta: "Add domain",
    },
    {
      id: "page",
      label: "Publish your first page",
      description: "A city hub or category page is the fastest path to Google impressions.",
      done: status.hasPublishedPage,
      to: "/app/pages/new",
      icon: FileText,
      cta: "Create page",
    },
  ];

  const completed = steps.filter((s) => s.done).length;
  const allDone = completed === steps.length;
  if (allDone) return null;

  const next = steps.find((s) => !s.done);

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Get your marketplace ranking</CardTitle>
            <CardDescription>
              {completed} of {steps.length} setup steps complete
              {next ? ` — next: ${next.label.toLowerCase()}` : ""}
            </CardDescription>
          </div>
          {next && (
            <Button size="sm" asChild>
              <Link to={next.to}>{next.cta}</Link>
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {steps.map((step) => {
          const Icon = step.icon;
          return (
            <div
              key={step.id}
              className={`flex items-start gap-3 rounded-md border p-3 ${
                step.done
                  ? "border-border/50 bg-background/40 opacity-80"
                  : "border-border bg-background"
              }`}
            >
              {step.done ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
              ) : (
                <Circle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm font-medium">{step.label}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{step.description}</p>
              </div>
              {!step.done && (
                <Button variant="ghost" size="sm" className="shrink-0 h-7 text-xs" asChild>
                  <Link to={step.to}>{step.cta}</Link>
                </Button>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
