import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { GENERATION_STEPS } from "./page-builder-utils";
import { Progress } from "@/components/ui/progress";

export function GenerationProgress({ active }: { active: boolean }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!active) {
      setStep(0);
      return;
    }
    const id = setInterval(() => {
      setStep((s) => (s + 1) % GENERATION_STEPS.length);
    }, 2200);
    return () => clearInterval(id);
  }, [active]);

  if (!active) return null;

  const progress = ((step + 1) / GENERATION_STEPS.length) * 100;

  return (
    <div className="relative overflow-hidden rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 via-background to-primary/5 p-6">
      <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-primary/10 blur-2xl" />
      <div className="relative flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/15">
          <Sparkles className="h-5 w-5 text-primary animate-pulse" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="font-semibold">Building your page</p>
            <p className="text-sm text-muted-foreground transition-all duration-500">
              {GENERATION_STEPS[step]}…
            </p>
          </div>
          <Progress value={progress} className="h-1.5" />
          <ul className="grid gap-1 sm:grid-cols-2">
            {GENERATION_STEPS.map((label, i) => (
              <li
                key={label}
                className={`flex items-center gap-2 text-xs transition-colors ${
                  i <= step ? "text-foreground" : "text-muted-foreground/50"
                }`}
              >
                {i < step ? (
                  <span className="text-emerald-500">✓</span>
                ) : i === step ? (
                  <Loader2 className="h-3 w-3 animate-spin text-primary" />
                ) : (
                  <span className="h-3 w-3 rounded-full border border-border" />
                )}
                {label}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}