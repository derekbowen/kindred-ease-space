import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Upload, Loader2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { importTable } from "@/lib/admin-data-io.functions";

type TableName = "content_plan" | "content_pages";

export const Route = createFileRoute("/_authenticated/app/content/data-import")({
  head: () => ({ meta: [{ title: "Data import — founders.click" }] }),
  component: DataImportPage,
});

type ImportResult = Awaited<ReturnType<typeof importTable>>;

function TableImporter({ workspaceId, table }: { workspaceId: string | null; table: TableName }) {
  const [mode, setMode] = useState<"upsert" | "insert">("upsert");
  const [busy, setBusy] = useState<"dry" | "import" | null>(null);
  const [status, setStatus] = useState<string>("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const run = useServerFn(importTable);

  async function readFile(): Promise<string | null> {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setStatus("Pick a CSV file first.");
      return null;
    }
    return await file.text();
  }

  async function go(dryRun: boolean) {
    if (!workspaceId) return;
    const csv = await readFile();
    if (!csv) return;
    setBusy(dryRun ? "dry" : "import");
    setStatus(dryRun ? "Validating…" : "Importing…");
    setResult(null);
    try {
      const res = await run({ data: { workspaceId, table, csv, mode, dryRun } });
      setResult(res);
      setStatus(
        dryRun
          ? `Dry-run: ${res.validRowCount}/${res.totalRows} rows valid`
          : `Imported ${res.inserted}/${res.totalRows} rows`,
      );
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-base">{table}</CardTitle>
        <CardDescription>
          Upload a CSV. <code>workspace_id</code> is forced to the active workspace — never trust the file's value.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>CSV file</Label>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:text-secondary-foreground"
          />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Label className="text-sm">Mode:</Label>
          <button
            type="button"
            onClick={() => setMode("upsert")}
            className={`rounded-full border px-3 py-1 ${mode === "upsert" ? "bg-primary text-primary-foreground" : ""}`}
          >
            Upsert
          </button>
          <button
            type="button"
            onClick={() => setMode("insert")}
            className={`rounded-full border px-3 py-1 ${mode === "insert" ? "bg-primary text-primary-foreground" : ""}`}
          >
            Insert
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => go(true)} disabled={busy !== null || !workspaceId}>
            {busy === "dry" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Dry-run
          </Button>
          <Button onClick={() => go(false)} disabled={busy !== null || !workspaceId}>
            {busy === "import" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            Import
          </Button>
        </div>
        {status && <p className="text-sm text-muted-foreground">{status}</p>}
        {result && (
          <div className="space-y-2 rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">Total: {result.totalRows}</Badge>
              <Badge variant="outline">Valid: {result.validRowCount}</Badge>
              <Badge>Inserted: {result.inserted}</Badge>
              {result.rowErrors.length > 0 && (
                <Badge variant="destructive">{result.rowErrors.length} row errors</Badge>
              )}
            </div>
            {result.rowErrors.length > 0 && (
              <details>
                <summary className="cursor-pointer">Row errors ({result.rowErrors.length})</summary>
                <ul className="mt-2 max-h-64 overflow-auto space-y-1 text-xs">
                  {result.rowErrors.slice(0, 200).map((e, i) => (
                    <li key={i} className="font-mono">
                      Row {e.row} {e.key ? `(${e.key})` : ""}: {e.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {result.chunkErrors.length > 0 && (
              <details>
                <summary className="cursor-pointer">Chunk errors ({result.chunkErrors.length})</summary>
                <ul className="mt-2 space-y-1 text-xs">
                  {result.chunkErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </details>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DataImportPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Data import</h1>
        <p className="text-sm text-muted-foreground">
          Upload CSVs into your workspace's tables. Dry-run first, then import. Max 25&nbsp;MB.
        </p>
      </div>
      {!workspaceId && <p className="text-sm text-muted-foreground">Loading workspace…</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <TableImporter workspaceId={workspaceId} table="content_plan" />
        <TableImporter workspaceId={workspaceId} table="content_pages" />
      </div>
    </div>
  );
}
