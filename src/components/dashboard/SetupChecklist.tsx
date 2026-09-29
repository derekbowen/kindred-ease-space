import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Circle, Plug, Globe, RefreshCw, FileText } from "lucide-react";
import { setupSteps, type SetupFacts, type SetupStepId } from "./overview-status";

const ICONS: Record<SetupStepId, React.ComponentType<{ className?: string }>> = {
  sharetribe: Plug,
  listings: RefreshCw,
  domain: Globe,
  page: FileText,
};

/**
 * The MVP journey as four setup steps (overview-status.ts): Sharetribe
 * connected → listings synced → domain active → first page published, each
 * linking to the screen that completes it. Hidden once every step is done.
 */
export function SetupChecklist({ facts }: { facts: SetupFacts }) {
  const steps = setupSteps(facts);
  const completed = steps.filter((s) => s.done).length;
  if (completed === steps.length) return null;
  const next = steps.find((s) => !s.done);

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Get your first page live</CardTitle>
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
          const Icon = ICONS[step.id];
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
                <p className="text-xs text-muted-foreground mt-0.5 break-words">
                  {step.description}
                </p>
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
