import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { exportTable } from "@/lib/admin-data-io.functions";

type TableName = "tenant_pages" | "tenant_listings" | "content_plan" | "content_pages";

const TABLE_COPY: Record<TableName, { title: string; description: string }> = {
  tenant_pages: {
    title: "Pages",
    description: "Every landing page in this workspace: title, slug, body, status and SEO fields.",
  },
  tenant_listings: {
    title: "Listings",
    description: "The marketplace listings imported from Sharetribe, as they were last synced.",
  },
  content_plan: { title: "Content plan (legacy)", description: "Planned pages from the earlier content planner." },
  content_pages: { title: "Content pages (legacy)", description: "Pages from the earlier content system." },
};

export const Route = createFileRoute("/_authenticated/app/content/data-export")({
  head: () => ({ meta: [{ title: "Data export — founders.click" }] }),
  component: DataExportPage,
});

function TableCard({ workspaceId, table }: { workspaceId: string | null; table: TableName }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const run = useServerFn(exportTable);

  async function handleExport() {
    if (!workspaceId) return;
    setBusy(true);
    setStatus("Exporting…");
    try {
      const res = await run({ data: { workspaceId, table } });
      const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${table}-${ts}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      setStatus(`Exported ${res.rowCount} rows (${Math.round(blob.size / 1024)} KB)`);
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {TABLE_COPY[table].title}{" "}
          <span className="font-mono text-xs text-muted-foreground">{table}</span>
        </CardTitle>
        <CardDescription>{TABLE_COPY[table].description} Exported as CSV.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={handleExport} disabled={busy || !workspaceId}>
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          Export CSV
        </Button>
        {status && <p className="text-sm text-muted-foreground">{status}</p>}
      </CardContent>
    </Card>
  );
}

function DataExportPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Data export</h1>
        <p className="text-sm text-muted-foreground">
          Your pages and listing data are yours: download them as CSV at any time, on any plan,
          during and after the beta.
        </p>
      </div>
      {!workspaceId && <p className="text-sm text-muted-foreground">Loading workspace…</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <TableCard workspaceId={workspaceId} table="tenant_pages" />
        <TableCard workspaceId={workspaceId} table="tenant_listings" />
        <TableCard workspaceId={workspaceId} table="content_plan" />
        <TableCard workspaceId={workspaceId} table="content_pages" />
      </div>
    </div>
  );
}
