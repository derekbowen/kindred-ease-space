import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Loader2, Upload, Table2, ArrowLeft } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { bulkCreatePages, listPageTemplates } from "@/lib/tenant-pages.functions";

export const Route = createFileRoute("/_authenticated/app/pages/bulk")({
  head: () => ({ meta: [{ title: "Bulk pages — founders.click" }] }),
  component: BulkPage,
});

const SAMPLE = `slug,title,city,state,category_plural
austin-pools,Pool Rentals in Austin TX,Austin,TX,pools
dallas-pools,Pool Rentals in Dallas TX,Dallas,TX,pools
houston-pools,Pool Rentals in Houston TX,Houston,TX,pools`;

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((s) => s.trim());
  return lines.slice(1).filter((l) => l.trim()).map((line) => {
    const cells = line.split(",").map((s) => s.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

function BulkPage() {
  const navigate = useNavigate();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string>("");
  const [csv, setCsv] = useState(SAMPLE);
  const [publish, setPublish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const tplFn = useServerFn(listPageTemplates);
  const bulkFn = useServerFn(bulkCreatePages);

  const rows = useMemo(() => parseCSV(csv), [csv]);

  useEffect(() => {
    Promise.all([getMe(), tplFn()]).then(([me, t]) => {
      setWorkspaceId(me.memberships[0]?.workspace_id ?? null);
      const cityHub = (t.templates as any[]).find((x) => x.slug === "city_hub" && x.is_active);
      if (cityHub) setTemplateId(cityHub.id);
    });
  }, [tplFn]);

  async function onRun() {
    if (!workspaceId || !templateId) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    const parsed = rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      variables: { city: r.city, state: r.state, category_plural: r.category_plural || "listings" },
      listingFilter: { city: r.city, state: r.state, limit: 24, sort: "newest" },
    }));
    if (parsed.length === 0) {
      setErr("No rows found — need a header row plus at least one data row");
      setBusy(false);
      return;
    }
    try {
      const r = await bulkFn({
        data: { workspaceId, templateId, rows: parsed, status: publish ? "published" : "draft" },
      });
      if (r.ok) {
        setMsg(`${publish ? "Published" : "Created"} ${r.count} city hub pages.`);
        setTimeout(() => navigate({ to: "/app/pages" }), 900);
      } else {
        setErr(r.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-10">
      <header className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2 gap-1 text-muted-foreground">
          <Link to="/app/pages">
            <ArrowLeft className="h-4 w-4" /> Back to pages
          </Link>
        </Button>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Bulk city import</h1>
            <p className="text-sm text-muted-foreground">
              Paste CSV — we spin up City Hub pages with listing grids in one shot.
            </p>
          </div>
          <Badge variant="secondary" className="gap-1">
            <Table2 className="h-3 w-3" /> {rows.length} rows
          </Badge>
        </div>
      </header>

      {msg && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600">
          {msg}
        </div>
      )}
      {err && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {err}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>CSV input</CardTitle>
            <CardDescription>
              Columns: <code className="text-xs">slug, title, city, state, category_plural</code> — up to 500 rows.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={14}
              className="font-mono text-xs leading-relaxed"
            />
            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <div>
                <p className="text-sm font-medium">Publish immediately</p>
                <p className="text-xs text-muted-foreground">Off = save as drafts for review first</p>
              </div>
              <Switch checked={publish} onCheckedChange={setPublish} />
            </div>
            <Button onClick={onRun} disabled={busy || rows.length === 0} className="w-full sm:w-auto">
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
              {publish ? `Publish ${rows.length} pages` : `Create ${rows.length} drafts`}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>First 8 rows from your paste.</CardDescription>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Add a header row and data to preview.</p>
            ) : (
              <div className="space-y-2">
                {rows.slice(0, 8).map((r, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border/50 px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{r.title || "—"}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        /p/{r.slug}
                        {(r.city || r.state) && ` · ${[r.city, r.state].filter(Boolean).join(", ")}`}
                      </p>
                    </div>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {publish ? "live" : "draft"}
                    </Badge>
                  </div>
                ))}
                {rows.length > 8 && (
                  <p className="text-center text-xs text-muted-foreground">+{rows.length - 8} more</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}