import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import { importTable } from "@/server/admin-data-io.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Download, Upload, Loader2 } from "lucide-react";

type TableName = "content_plan" | "content_pages";

export const Route = createFileRoute("/admin/data-export")({
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user)
      throw redirect({ to: "/auth", search: { redirect: "/admin/data-export", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  component: DataExportPage,
});

function TableCard({ table }: { table: TableName }) {
  const [busy, setBusy] = React.useState<"export" | "import" | null>(null);
  const [status, setStatus] = React.useState<string>("");
  const [importResult, setImportResult] = React.useState<{
    totalRows: number;
    inserted: number;
    rowErrors: { row: number; slug?: string; reason: string }[];
    chunkErrors: string[];
  } | null>(null);
  const [mode, setMode] = React.useState<"upsert" | "insert">("upsert");
  const fileRef = React.useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    setBusy("export");
    setStatus("Downloading CSV...");
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in");
      const res = await fetch(`/api/admin/data-export?table=${table}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const blob = await res.blob();
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${table}-${ts}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus(`Exported ~${Math.round(blob.size / 1024)} KB`);
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async (file: File) => {
    setBusy("import");
    setImportResult(null);
    setStatus(`Reading ${file.name}...`);
    try {
      const csv = await file.text();
      setStatus("Uploading and importing...");
      const res = await importTable({ data: { table, csv, mode } });
      setImportResult({
        totalRows: res.totalRows,
        inserted: res.inserted,
        rowErrors: res.rowErrors,
        chunkErrors: res.chunkErrors,
      });
      const totalErr = res.rowErrors.length;
      setStatus(
        `Imported ${res.inserted}/${res.totalRows} rows${totalErr ? ` (${totalErr} bad row(s))` : ""}`,
      );
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-base">{table}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Button onClick={handleExport} disabled={!!busy} className="w-full sm:w-auto">
            {busy === "export" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Export to CSV
          </Button>
        </div>

        <div className="space-y-2 border-t pt-4">
          <Label className="text-sm font-medium">Re-import CSV</Label>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={mode === "upsert"}
                onChange={() => setMode("upsert")}
              />
              Upsert (update if exists)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={mode === "insert"}
                onChange={() => setMode("insert")}
              />
              Insert only
            </label>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            disabled={!!busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImport(f);
            }}
            className="block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-primary file:px-3 file:py-2 file:text-primary-foreground hover:file:bg-primary/90"
          />
          <p className="text-xs text-muted-foreground">
            Upsert conflict column:{" "}
            <code>{table === "content_plan" ? "slug" : "id"}</code>. Max 25MB.
          </p>
        </div>

        {status && (
          <div className="rounded border bg-muted p-3 text-sm">
            {busy && <Loader2 className="mr-2 inline h-3 w-3 animate-spin" />}
            {status}
          </div>
        )}
        {importResult && importResult.rowErrors.length > 0 && (
          <div className="rounded border border-destructive/50 bg-destructive/10 p-3 text-xs">
            <div className="mb-1 font-medium">
              Bad rows ({importResult.rowErrors.length}):
            </div>
            <ul className="max-h-48 list-inside list-disc space-y-1 overflow-auto">
              {importResult.rowErrors.slice(0, 50).map((e, i) => (
                <li key={i}>
                  Row {e.row}
                  {e.slug ? ` (${e.slug})` : ""}: {e.reason}
                </li>
              ))}
              {importResult.rowErrors.length > 50 && (
                <li>...and {importResult.rowErrors.length - 50} more</li>
              )}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DataExportPage() {
  return (
    <AdminLayout>
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold">Content data export / import</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Download a full snapshot of the content tables as CSV, or restore a
            previously exported CSV. Exports paginate through all rows; imports
            run in 500-row chunks.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <TableCard table="content_plan" />
          <TableCard table="content_pages" />
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              <strong>Upsert</strong> matches by the conflict column and
              overwrites all other fields with the CSV values.
            </p>
            <p>
              <strong>Insert only</strong> fails on duplicate keys — use this
              for fresh restores into an empty table.
            </p>
            <p>
              JSON/array columns (e.g. <code>legacy_slugs</code>) are detected
              automatically when the value starts with <code>{`[`}</code> or{" "}
              <code>{`{`}</code>.
            </p>
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
