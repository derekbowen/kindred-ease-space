import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Search, Sparkles, TrendingUp, Package, Ban, CheckCircle2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import {
  getOpportunityFlag,
  setAnalysisDomain,
  runOpportunityAnalysis,
  listOpportunities,
  approveOpportunity,
  skipOpportunity,
  type OpportunityListItem,
} from "@/lib/opportunities.functions";

export const Route = createFileRoute("/_authenticated/app/opportunities")({
  head: () => ({ meta: [{ title: "SEO Opportunities — founders.click" }] }),
  component: OpportunitiesPage,
});

/** Customer-facing bands only. The internal numeric score is never rendered —
 *  it exists to sort candidates, not to imply precision we don't have. */
const BAND_STYLE: Record<string, { label: string; cls: string }> = {
  HIGH: { label: "High opportunity", cls: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30" },
  MEDIUM: { label: "Medium opportunity", cls: "bg-blue-500/10 text-blue-600 border-blue-500/30" },
  LOW: { label: "Low opportunity", cls: "bg-muted text-muted-foreground border-border" },
};

const ACTION_LABEL: Record<string, string> = {
  BUILD_NEW_PAGE: "Build new page",
  IMPROVE_EXISTING: "Improve existing page",
  WAIT_FOR_INVENTORY: "Wait for more inventory",
  DO_NOT_BUILD: "Not recommended",
};

function OpportunitiesPage() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [domain, setDomain] = useState("");
  const [rows, setRows] = useState<OpportunityListItem[]>([]);
  const [counts, setCounts] = useState({ build: 0, improve: 0, wait: 0, reject: 0 });
  const [tab, setTab] = useState<string>("BUILD_NEW_PAGE");
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);

  const flagFn = useServerFn(getOpportunityFlag);
  const setDomainFn = useServerFn(setAnalysisDomain);
  const analyzeFn = useServerFn(runOpportunityAnalysis);
  const listFn = useServerFn(listOpportunities);
  const approveFn = useServerFn(approveOpportunity);
  const skipFn = useServerFn(skipOpportunity);

  useEffect(() => {
    getMe().then((me) => {
      const ws = me.memberships[0]?.workspace_id ?? null;
      setWorkspaceId(ws);
      // Availability is global-flag AND workspace-enrollment, both decided
      // server-side. The client is never the authority.
      flagFn({ data: ws ? { workspaceId: ws } : {} })
        .then((f) => setEnabled(f.enabled))
        .catch(() => setEnabled(false));
    });
  }, [flagFn]);

  const reload = useCallback(
    async (ws: string) => {
      try {
        const r = await listFn({ data: { workspaceId: ws } });
        setRows(r.rows);
        setCounts(r.counts);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to load opportunities");
      }
    },
    [listFn],
  );

  useEffect(() => {
    if (workspaceId && enabled) reload(workspaceId);
  }, [workspaceId, enabled, reload]);

  async function onAnalyze() {
    if (!workspaceId) return;
    setAnalyzing(true);
    setErr(null);
    setMsg(null);
    try {
      if (domain.trim()) {
        const d = await setDomainFn({ data: { workspaceId, domain: domain.trim() } });
        if (!d.ok) {
          setErr(d.error);
          return;
        }
      }
      const r = await analyzeFn({ data: { workspaceId, skipScan: false } });
      const steps = (r.steps ?? []).map((s) => `${s.step}: ${s.detail}`).join(" · ");
      setMsg(steps);
      await reload(workspaceId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }

  async function onApprove(id: string) {
    if (!workspaceId) return;
    setWorkingId(id);
    setErr(null);
    try {
      const r = await approveFn({ data: { workspaceId, id } });
      if (r.ok) {
        setMsg("Draft created. Review it under Pages, then publish when you're happy.");
        await reload(workspaceId);
      } else {
        setErr(r.error ?? "Could not build the page");
      }
    } finally {
      setWorkingId(null);
    }
  }

  async function onSkip(id: string) {
    if (!workspaceId) return;
    setWorkingId(id);
    try {
      await skipFn({ data: { workspaceId, id } });
      await reload(workspaceId);
    } finally {
      setWorkingId(null);
    }
  }

  if (enabled === null) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="max-w-2xl p-2">
        <Card>
          <CardHeader>
            <CardTitle>SEO Opportunities</CardTitle>
            <CardDescription>
              This feature isn't enabled for your workspace yet.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const visible = rows.filter((r) => r.recommendation === tab);

  return (
    <div className="space-y-6 max-w-4xl pb-12">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">SEO Opportunities</h1>
        <p className="text-sm text-muted-foreground">
          We analyze your website, your Google Search Console data and your live inventory, then
          recommend only the pages worth building.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Analyze your website</CardTitle>
          <CardDescription>
            Just your existing website address — no DNS changes needed. Connecting a publishing
            domain comes later, once you've approved something worth publishing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[260px] space-y-1">
              <Label>Your website</Label>
              <Input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="example.com"
                onKeyDown={(e) => {
                  if (e.key === "Enter") onAnalyze();
                }}
              />
            </div>
            <Button onClick={onAnalyze} disabled={analyzing || !workspaceId} className="gap-2">
              {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {analyzing ? "Analyzing…" : "Find opportunities"}
            </Button>
          </div>
          {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
          {err && <p className="text-sm text-destructive">{err}</p>}
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { key: "BUILD_NEW_PAGE", n: counts.build, label: "Worth building", icon: Sparkles },
          { key: "IMPROVE_EXISTING", n: counts.improve, label: "Improve instead", icon: TrendingUp },
          { key: "WAIT_FOR_INVENTORY", n: counts.wait, label: "Need inventory", icon: Package },
          { key: "DO_NOT_BUILD", n: counts.reject, label: "We rejected", icon: Ban },
        ].map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-lg border p-3 text-left transition ${
                tab === t.key ? "border-primary bg-primary/5" : "border-border/60 hover:bg-muted/30"
              }`}
            >
              <div className="flex items-center gap-2 text-muted-foreground">
                <Icon className="h-3.5 w-3.5" />
                <span className="text-xs">{t.label}</span>
              </div>
              <p className="mt-1 text-2xl font-bold tabular-nums">{t.n}</p>
            </button>
          );
        })}
      </div>

      <div className="space-y-3">
        {visible.length === 0 && (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              {rows.length === 0
                ? "No analysis yet — enter your website above to get started."
                : "Nothing in this category."}
            </CardContent>
          </Card>
        )}

        {visible.map((o) => {
          const band = o.band ? BAND_STYLE[o.band] : null;
          return (
            <Card key={o.id}>
              <CardHeader className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  {band && (
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${band.cls}`}>
                      {band.label}
                    </span>
                  )}
                  {o.confidence && (
                    <span className="text-xs text-muted-foreground">
                      Confidence: {o.confidence} evidence
                    </span>
                  )}
                </div>
                <CardTitle className="text-lg">{o.intent_label}</CardTitle>
                <CardDescription>
                  Recommended action: <strong>{ACTION_LABEL[o.recommendation]}</strong>
                  {o.proposed_slug && o.recommendation === "BUILD_NEW_PAGE" && (
                    <>
                      {" · "}
                      <code className="text-xs">/a/{o.proposed_slug}</code>
                    </>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Why
                  </p>
                  <ul className="mt-1 space-y-1">
                    {(o.explanation ?? []).slice(0, 6).map((line, i) => (
                      <li key={i} className="flex gap-2 text-sm text-muted-foreground">
                        <span className="text-primary">·</span>
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {o.status === "draft_ready" ? (
                  <p className="flex items-center gap-2 text-sm text-emerald-600">
                    <CheckCircle2 className="h-4 w-4" /> Draft created — review it under Pages.
                  </p>
                ) : o.recommendation === "BUILD_NEW_PAGE" ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => onApprove(o.id)}
                      disabled={workingId === o.id}
                      className="gap-2"
                    >
                      {workingId === o.id && <Loader2 className="h-4 w-4 animate-spin" />}
                      Build this page
                    </Button>
                    <Button variant="ghost" onClick={() => onSkip(o.id)} disabled={workingId === o.id}>
                      Skip
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
