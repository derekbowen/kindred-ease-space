import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Sparkles, RefreshCw, X, Loader2, Wrench, FileText, Link2 } from "lucide-react";
import { toast } from "sonner";
import { getTodayBriefing, generateBriefingNow, dismissInsight } from "@/lib/coach.functions";
import { runCoachAction } from "@/lib/coach-actions.functions";

type Insight = {
  title?: string;
  description?: string;
  priority?: "high" | "medium" | "low";
  action_type?: string;
  action_payload?: Record<string, unknown>;
};

type ActionKey = "fix_thin_page" | "add_meta" | "create_city_page" | "add_internal_links";

const ACTION_META: Record<ActionKey, { label: string; icon: React.ComponentType<{ className?: string }>; confirmTitle: string; confirmBody: (ins: Insight) => string }> = {
  fix_thin_page: {
    label: "Apply fix",
    icon: Wrench,
    confirmTitle: "Apply fix to this page?",
    confirmBody: () => "We'll expand the page body using AI and overwrite the existing markdown. This action is logged and can be reverted from the page editor's history.",
  },
  add_meta: {
    label: "Apply fix",
    icon: Wrench,
    confirmTitle: "Generate SEO meta?",
    confirmBody: (ins) => {
      const ids = (ins.action_payload?.page_ids as unknown[] | undefined) ?? [];
      const count = Array.isArray(ids) ? ids.length : 1;
      return `We'll generate seo_title and seo_description for ${count} page${count === 1 ? "" : "s"} and overwrite any existing meta.`;
    },
  },
  create_city_page: {
    label: "Generate content",
    icon: FileText,
    confirmTitle: "Generate this city page?",
    confirmBody: (ins) => `We'll create a draft page for ${String(ins.action_payload?.city ?? "this city")} (status: draft, not in sitemap). Review it before publishing.`,
  },
  add_internal_links: {
    label: "Add internal links",
    icon: Link2,
    confirmTitle: "Add internal links to this page?",
    confirmBody: () => "We'll add 3-6 contextual internal links to other published pages and overwrite the page body.",
  },
};

export function DailyBriefing({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const [generating, setGenerating] = useState(false);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<{ insight: Insight; index: number; action: ActionKey } | null>(null);
  const [running, setRunning] = useState(false);
  const [completed, setCompleted] = useState<Set<number>>(new Set());

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

  const requestAction = (insight: Insight, index: number) => {
    const at = insight.action_type as ActionKey | undefined;
    if (!at || !(at in ACTION_META)) return;
    setPending({ insight, index, action: at });
  };

  const confirmAction = async () => {
    if (!pending) return;
    setRunning(true);
    const t = toast.loading(`${ACTION_META[pending.action].label}…`);
    try {
      const res = await runCoachAction({
        data: {
          workspaceId,
          briefingId: briefing?.id,
          insightIndex: pending.index,
          actionType: pending.action,
          payload: (pending.insight.action_payload ?? {}) as Record<string, unknown>,
        },
      });
      toast.success(res.summary, { id: t });
      setCompleted((s) => new Set(s).add(pending.index));
      setPending(null);
    } catch (e) {
      toast.error("Action failed", { id: t, description: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
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
              {insights.map((ins, i) => {
                if (dismissed.has(i)) return null;
                const at = ins.action_type as ActionKey | undefined;
                const meta = at && at in ACTION_META ? ACTION_META[at] : null;
                const Icon = meta?.icon;
                const done = completed.has(i);
                return (
                  <div key={i} className="flex gap-3 p-3 rounded-md border border-border bg-background/50">
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-medium">{ins.title ?? "Insight"}</h4>
                        {ins.priority && (
                          <Badge variant={ins.priority === "high" ? "default" : "secondary"} className="h-4 text-[10px]">
                            {ins.priority}
                          </Badge>
                        )}
                        {done && <Badge variant="outline" className="h-4 text-[10px]">Done</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground">{ins.description}</p>
                      {meta && !done && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => requestAction(ins, i)}
                        >
                          {Icon ? <Icon className="h-3 w-3 mr-1.5" /> : null}
                          {meta.label}
                        </Button>
                      )}
                    </div>
                    <button onClick={() => onDismiss(i)} className="text-muted-foreground hover:text-foreground self-start" aria-label="Dismiss">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!pending} onOpenChange={(o) => { if (!o && !running) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending ? ACTION_META[pending.action].confirmTitle : ""}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending ? ACTION_META[pending.action].confirmBody(pending.insight) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={running}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void confirmAction(); }} disabled={running}>
              {running ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : null}
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
