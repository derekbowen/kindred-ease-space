import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { exportTable } from "@/lib/admin-data-io.functions";
import { userMessage } from "@/lib/user-message";

type TableName = "tenant_pages" | "tenant_listings" | "content_plan" | "content_pages";

// What the customer reads for each export. The table names are the server's
// allowlist keys only: they are sent to exportTable and never shown. `noun`
// counts rows in the result line; `file` names the download.
const TABLE_COPY: Record<
  TableName,
  { title: string; description: string; noun: [string, string]; file: string }
> = {
  tenant_pages: {
    title: "Your pages",
    description:
      "Every landing page in this workspace: title, web address, content, status and SEO fields.",
    noun: ["page", "pages"],
    file: "pages",
  },
  tenant_listings: {
    title: "Your synced listings",
    description: "The marketplace listings imported from Sharetribe, as they were last synced.",
    noun: ["listing", "listings"],
    file: "synced-listings",
  },
  content_plan: {
    title: "Your planned pages (earlier planner)",
    description: "Pages planned with the earlier content planner, if you used it.",
    noun: ["planned page", "planned pages"],
    file: "planned-pages",
  },
  content_pages: {
    title: "Your earlier content pages",
    description: "Pages written with the earlier content system, if you used it.",
    noun: ["page", "pages"],
    file: "earlier-content-pages",
  },
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
      a.download = `${TABLE_COPY[table].file}-${ts}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      const [one, many] = TABLE_COPY[table].noun;
      setStatus(
        `Downloaded ${res.rowCount.toLocaleString()} ${res.rowCount === 1 ? one : many} (${Math.round(blob.size / 1024)} KB).`,
      );
    } catch (e: any) {
      setStatus(userMessage(e, "Couldn't export this data. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{TABLE_COPY[table].title}</CardTitle>
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
