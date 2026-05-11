import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sparkles, RefreshCw, X, Loader2 } from "lucide-react";
import { getTodayBriefing, generateBriefingNow, dismissInsight } from "@/lib/coach.functions";

type Insight = {
  title?: string;
  description?: string;
  priority?: "high" | "medium" | "low";
  action_type?: string;
  action_payload?: Record<string, unknown>;
};

export function DailyBriefing({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const [generating, setGenerating] = useState(false);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ["coach-briefing", workspaceId],
    queryFn: () => getTodayBriefing({ data: { workspaceId } }),
  });

  const briefing = data?.briefing as { id: string; insights: Insight[] } | null | undefined;
  const insights = (briefing?.insights ?? []) as Insight[];

  const onGenerate = async () => {
    setGenerating(true);
    try {
      await generateBriefingNow({ data: { workspaceId } });
      await qc.invalidateQueries({ queryKey: ["coach-briefing", workspaceId] });
    } finally {
      setGenerating(false);
    }
  };

  const onDismiss = async (idx: number) => {
    setDismissed((s) => new Set(s).add(idx));
    if (briefing?.id) {
      await dismissInsight({ data: { workspaceId, briefingId: briefing.id, insightIndex: idx } });
    }
  };

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            Today's coach briefing
          </CardTitle>
          <CardDescription className="text-xs">Top actions ranked by impact</CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={onGenerate} disabled={generating}>
          {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          <span className="ml-1.5 text-xs">Refresh</span>
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : insights.length === 0 ? (
          <div className="text-center py-6 space-y-2">
            <p className="text-sm text-muted-foreground">No briefing for today yet.</p>
            <Button size="sm" onClick={onGenerate} disabled={generating}>
              {generating ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : null}
              Generate now
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {insights.map((ins, i) => dismissed.has(i) ? null : (
              <div key={i} className="flex gap-3 p-3 rounded-md border border-border bg-background/50">
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-medium">{ins.title ?? "Insight"}</h4>
                    {ins.priority && (
                      <Badge variant={ins.priority === "high" ? "default" : "secondary"} className="h-4 text-[10px]">
                        {ins.priority}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{ins.description}</p>
                </div>
                <button onClick={() => onDismiss(i)} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
