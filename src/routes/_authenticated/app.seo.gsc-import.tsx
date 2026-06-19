import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { importGscQueries, getKeywordStats } from "@/lib/admin-seo-tools.functions";

export const Route = createFileRoute("/_authenticated/app/seo/gsc-import")({
  head: () => ({ meta: [{ title: "GSC Import — founders.click" }] }),
  component: GscImportPage,
});

type ParsedRow = { url_path: string; query: string; clicks: number; impressions: number; ctr: number | null; position: number | null };

// GSC exports CTR as "2.2%"; store it as a 0-1 fraction (0.022) so downstream
// views (which render ctr * 100) show 2.2%, not 220%.
function parseCtr(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw.replace("%", ""));
  if (!isFinite(n)) return null;
  return raw.includes("%") || n > 1 ? n / 100 : n;
}

function parseCsv(csv: string): ParsedRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const header = lines[0].toLowerCase().split(/[,\t]/).map((h) => h.trim().replace(/"/g, ""));
  const idx = (name: string) => header.findIndex((h) => h.includes(name));
  const iPage = idx("page") >= 0 ? idx("page") : idx("url");
  const iQuery = idx("query") >= 0 ? idx("query") : idx("keyword");
  const iClicks = idx("click");
  const iImpr = idx("impression");
  const iCtr = idx("ctr");
  const iPos = idx("position");
  const out: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(/[,\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (!cols[iQuery] || !cols[iPage]) continue;
    let urlPath = cols[iPage];
    try { urlPath = new URL(urlPath).pathname; } catch { /* already a path */ }
    out.push({
      url_path: urlPath,
      query: cols[iQuery],
      clicks: parseInt(cols[iClicks] || "0", 10) || 0,
      impressions: parseInt(cols[iImpr] || "0", 10) || 0,
      ctr: parseCtr(cols[iCtr]),
      position: cols[iPos] ? parseFloat(cols[iPos]) || null : null,
    });
  }
  return out;
}

function GscImportPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [csv, setCsv] = useState("");
  const [stats, setStats] = useState<{ totalQueries: number; opportunities: number; top3: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const importFn = useServerFn(importGscQueries);
  const statsFn = useServerFn(getKeywordStats);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);

  async function loadStats(ws: string) {
    setStats(await statsFn({ data: { workspaceId: ws } }));
  }
  useEffect(() => { if (workspaceId) loadStats(workspaceId); /* eslint-disable-next-line */ }, [workspaceId]);

  async function doImport() {
    if (!workspaceId) return;
    const rows = parseCsv(csv);
    if (!rows.length) { setMsg("No rows parsed. Make sure the CSV has Page, Query, Clicks, Impressions, CTR, Position columns."); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await importFn({ data: { workspaceId, rows: rows.slice(0, 5000) } });
      setMsg(r.ok ? `Imported ${r.upserted} rows.` : `Error: ${r.error}`);
      if (r.ok) await loadStats(workspaceId);
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">GSC Import</h1>
        <p className="text-sm text-muted-foreground">Paste a Google Search Console query export to feed the keyword opportunity finder.</p>
      </div>

      {stats && (
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Total queries" value={stats.totalQueries} />
          <Stat label="Opportunities (pos 5–20)" value={stats.opportunities} />
          <Stat label="Top-3 keywords" value={stats.top3} />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Paste CSV</CardTitle>
          <CardDescription>Headers expected: Page (or URL), Query, Clicks, Impressions, CTR, Position. Tab- or comma-separated.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={10} className="font-mono text-xs" placeholder="Page,Query,Clicks,Impressions,CTR,Position&#10;/p/los-angeles,pool rental,12,540,2.2%,8.4" />
          <div className="flex items-center gap-3">
            <Button onClick={doImport} disabled={busy || !workspaceId || !csv.trim()} className="gap-2">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Import
            </Button>
            {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl">{value.toLocaleString()}</CardTitle>
      </CardHeader>
    </Card>
  );
}
