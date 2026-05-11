import * as React from "react";
import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import {
  getImportSchema,
  lookupExistingKeys,
  importTableRows,
} from "@/server/admin-data-io.functions";
import { parseCsv, coerceValue, applyMapping } from "@/lib/csv-import";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  FileText,
  X,
} from "lucide-react";

type TableName = "content_plan" | "content_pages";

interface PreviewState {
  totalRows: number;
  header: string[];
  effectiveHeader: string[];
  tableColumns: string[];
  unknownColumns: string[];
  missingColumns: string[];
  conflictColumn: string;
  hasConflictColumn: boolean;
  existingMatches: number;
  newRowsEstimate: number;
  sample: Record<string, unknown>[];
}

interface ParsedCsv {
  header: string[];
  rows: string[][];
}

export const Route = createFileRoute("/admin/data-import")({
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user)
      throw redirect({
        to: "/auth",
        search: { redirect: "/admin/data-import", mode: "signin" },
      });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  component: DataImportPage,
});

const CHUNK_SIZE = 200;
const LOOKUP_CHUNK = 2000;

function DataImportPage() {
  const [table, setTable] = React.useState<TableName>("content_plan");
  const [file, setFile] = React.useState<File | null>(null);
  const [parsed, setParsed] = React.useState<ParsedCsv | null>(null);
  const [preview, setPreview] = React.useState<PreviewState | null>(null);
  const [busy, setBusy] = React.useState<"preview" | "commit" | null>(null);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{
    inserted: number;
    totalRows: number;
    rowErrors: { row: number; slug?: string; reason: string }[];
    chunkErrors: string[];
    droppedColumns: string[];
  } | null>(null);
  const [mode, setMode] = React.useState<"upsert" | "insert">("upsert");
  const [ignoreUnknown, setIgnoreUnknown] = React.useState(true);
  const [confirmText, setConfirmText] = React.useState("");
  const [mapping, setMapping] = React.useState<Record<string, string>>({});
  const fileRef = React.useRef<HTMLInputElement>(null);

  const reset = () => {
    setFile(null);
    setParsed(null);
    setPreview(null);
    setError(null);
    setResult(null);
    setProgress(null);
    setConfirmText("");
    setMapping({});
    if (fileRef.current) fileRef.current.value = "";
  };

  const buildPreview = React.useCallback(
    async (p: ParsedCsv, m: Record<string, string>) => {
      setBusy("preview");
      setError(null);
      try {
        const { tableColumns, conflictColumn } = await getImportSchema({
          data: { table },
        });
        const knownCols = new Set(tableColumns);

        const { effective: effectiveHeader, map: headerMap } = applyMapping(
          p.header,
          m,
        );

        const unknownColumns = tableColumns.length > 0
          ? effectiveHeader.filter((c) => !knownCols.has(c))
          : [];
        const missingColumns = tableColumns.length > 0
          ? tableColumns.filter((c) => !effectiveHeader.includes(c))
          : [];

        const conflictCsvIdx = headerMap.findIndex((mm) => mm === conflictColumn);
        const conflictValues: string[] = [];
        if (conflictCsvIdx >= 0) {
          for (const r of p.rows) {
            const v = r[conflictCsvIdx];
            if (v) conflictValues.push(v);
          }
        }

        let existingMatches = 0;
        for (let i = 0; i < conflictValues.length; i += LOOKUP_CHUNK) {
          const slice = conflictValues.slice(i, i + LOOKUP_CHUNK);
          const { existingCount } = await lookupExistingKeys({
            data: { table, conflictColumn, values: slice },
          });
          existingMatches += existingCount;
        }

        const sampleSize = Math.min(5, p.rows.length);
        const sample = p.rows.slice(0, sampleSize).map((r) => {
          const obj: Record<string, unknown> = {};
          headerMap.forEach((eff, i) => {
            if (!eff) return;
            obj[eff] = coerceValue(r[i] ?? "");
          });
          return obj;
        });

        setPreview({
          totalRows: p.rows.length,
          header: p.header,
          effectiveHeader,
          tableColumns,
          unknownColumns,
          missingColumns,
          conflictColumn,
          hasConflictColumn: effectiveHeader.includes(conflictColumn),
          existingMatches,
          newRowsEstimate: p.rows.length - existingMatches,
          sample,
        });
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setBusy(null);
      }
    },
    [table],
  );

  const handleFile = async (f: File) => {
    reset();
    setFile(f);
    setBusy("preview");
    try {
      const text = await f.text();
      const all = parseCsv(text);
      if (all.length < 2) {
        setError("CSV has no data rows");
        setBusy(null);
        return;
      }
      const p: ParsedCsv = { header: all[0], rows: all.slice(1) };
      setParsed(p);
      await buildPreview(p, {});
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setBusy(null);
    }
  };

  React.useEffect(() => {
    if (!parsed || !preview) return;
    const t = setTimeout(() => { void buildPreview(parsed, mapping); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapping]);

  const handleCommit = async () => {
    if (!parsed || !preview) return;
    setBusy("commit");
    setError(null);
    setResult(null);
    setProgress({ done: 0, total: parsed.rows.length });

    try {
      const tableCols = new Set(preview.tableColumns);
      const knownSchema = tableCols.size > 0;
      const { map: headerMap0 } = applyMapping(parsed.header, mapping);

      let headerMap: (string | null)[] = headerMap0;
      const droppedColumns: string[] = [];
      if (ignoreUnknown && knownSchema) {
        headerMap = headerMap.map((eff, i) => {
          if (eff && !tableCols.has(eff)) {
            droppedColumns.push(eff || parsed.header[i]);
            return null;
          }
          return eff;
        });
      } else {
        headerMap.forEach((eff, i) => {
          if (!eff) droppedColumns.push(parsed.header[i]);
        });
      }
      const effectiveHeader: string[] = [];
      headerMap.forEach((eff) => { if (eff) effectiveHeader.push(eff); });

      const conflictColumn = preview.conflictColumn;
      const seenKeys = new Map<string, number>();
      const rowErrors: { row: number; slug?: string; reason: string }[] = [];
      const validRows: Record<string, unknown>[] = [];
      const validRowNumbers: number[] = [];

      parsed.rows.forEach((rawRow, idx) => {
        const csvRowNum = idx + 2;
        const obj: Record<string, unknown> = {};
        const issues: string[] = [];

        headerMap.forEach((col, i) => {
          if (!col) return;
          const raw = rawRow[i] ?? "";
          const trimmed = String(raw).trim();
          if (
            (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
            (trimmed.startsWith("[") && trimmed.endsWith("]"))
          ) {
            try { JSON.parse(trimmed); }
            catch { issues.push(`Invalid JSON in "${col}"`); }
          }
          obj[col] = coerceValue(raw);
        });

        if (
          effectiveHeader.includes(conflictColumn) &&
          (obj[conflictColumn] === null || obj[conflictColumn] === "")
        ) {
          issues.push(`Missing required "${conflictColumn}"`);
        }

        if (knownSchema) {
          for (const col of effectiveHeader) {
            if (!tableCols.has(col)) issues.push(`Unknown column "${col}"`);
          }
        }

        const keyVal = obj[conflictColumn] as string | number | null;
        if (keyVal != null && keyVal !== "") {
          const prior = seenKeys.get(String(keyVal));
          if (prior !== undefined) {
            issues.push(
              `Duplicate "${conflictColumn}"="${keyVal}" (also on CSV row ${prior})`,
            );
          } else {
            seenKeys.set(String(keyVal), csvRowNum);
          }
        }

        if (issues.length > 0) {
          rowErrors.push({
            row: csvRowNum,
            slug: keyVal != null ? String(keyVal) : undefined,
            reason: issues.join("; "),
          });
          return;
        }
        validRows.push(obj);
        validRowNumbers.push(csvRowNum);
      });

      let inserted = 0;
      const chunkErrors: string[] = [];

      for (let i = 0; i < validRows.length; i += CHUNK_SIZE) {
        const chunk = validRows.slice(i, i + CHUNK_SIZE);
        const chunkRowNums = validRowNumbers.slice(i, i + CHUNK_SIZE);
        try {
          const res = await importTableRows({
            data: {
              table,
              rows: chunk,
              mode,
              conflictColumn,
              rowNumbers: chunkRowNums,
            },
          });
          inserted += res.inserted;
          rowErrors.push(...res.rowErrors);
          if (res.chunkError) {
            chunkErrors.push(
              `Chunk rows ${chunkRowNums[0]}-${chunkRowNums[chunkRowNums.length - 1]} retried per-row: ${res.chunkError}`,
            );
          }
        } catch (e: any) {
          chunkErrors.push(
            `Chunk rows ${chunkRowNums[0]}-${chunkRowNums[chunkRowNums.length - 1]} failed entirely: ${e?.message ?? String(e)}`,
          );
        }
        setProgress({ done: Math.min(i + CHUNK_SIZE, validRows.length), total: validRows.length });
      }

      setResult({
        inserted,
        totalRows: parsed.rows.length,
        rowErrors,
        chunkErrors,
        droppedColumns,
      });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const effectiveFor = (csvHeader: string): string | null => {
    if (csvHeader in mapping) {
      const v = mapping[csvHeader];
      return v && v.length > 0 ? v : null;
    }
    return csvHeader;
  };

  const blockingIssues: string[] = [];
  if (preview) {
    if (!preview.hasConflictColumn && mode === "upsert") {
      blockingIssues.push(
        `CSV is missing the "${preview.conflictColumn}" column required for upsert.`,
      );
    }
    if (preview.unknownColumns.length > 0 && !ignoreUnknown) {
      blockingIssues.push(
        `CSV has ${preview.unknownColumns.length} unknown column(s). Enable "Ignore unknown columns" or fix the CSV.`,
      );
    }
  }
  const requiredConfirm = `${table} ${mode}`;
  const canCommit =
    !!preview &&
    blockingIssues.length === 0 &&
    !busy &&
    confirmText.trim() === requiredConfirm;

  return (
    <AdminLayout>
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <div>
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold">Import CSV into table</h1>
            <Link
              to="/admin/data-export"
              className="text-sm text-muted-foreground underline-offset-2 hover:underline"
            >
              Need an export? →
            </Link>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload a CSV, review the preview, then explicitly confirm to write
            to the database. Parsing happens in your browser and rows ship in
            chunks of {CHUNK_SIZE}, so large files (100MB+) work fine.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">1. Target table</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              {(["content_plan", "content_pages"] as TableName[]).map((t) => (
                <label
                  key={t}
                  className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-2 font-mono text-sm ${
                    table === t ? "border-primary bg-primary/10" : ""
                  }`}
                >
                  <input
                    type="radio"
                    checked={table === t}
                    onChange={() => {
                      setTable(t);
                      reset();
                    }}
                  />
                  {t}
                </label>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. Upload CSV</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              disabled={busy === "commit"}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
              className="block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-primary file:px-3 file:py-2 file:text-primary-foreground hover:file:bg-primary/90"
            />
            {file && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="h-4 w-4" />
                <span className="font-mono">{file.name}</span>
                <span>·</span>
                <span>{(file.size / 1024).toFixed(1)} KB</span>
                <button
                  onClick={reset}
                  className="ml-auto text-destructive hover:underline"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
            {busy === "preview" && (
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" /> Parsing and validating...
              </div>
            )}
          </CardContent>
        </Card>

        {error && (
          <div className="rounded border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {preview && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">3. Preview</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Rows in CSV" value={preview.totalRows} />
                <Stat
                  label="Existing matches"
                  value={preview.existingMatches}
                  hint={`by ${preview.conflictColumn}`}
                />
                <Stat
                  label="New rows"
                  value={preview.newRowsEstimate}
                  hint="if upsert/insert"
                />
                <Stat label="CSV columns" value={preview.header.length} />
              </div>

              {preview.unknownColumns.length > 0 && (
                <div className="rounded border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                  <div className="mb-1 flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-4 w-4" />
                    Unknown columns ({preview.unknownColumns.length})
                  </div>
                  <div className="font-mono text-xs">
                    {preview.unknownColumns.join(", ")}
                  </div>
                </div>
              )}

              {preview.missingColumns.length > 0 && (
                <div className="rounded border bg-muted p-3 text-sm">
                  <div className="mb-1 font-medium">
                    Table columns not in CSV ({preview.missingColumns.length})
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {preview.missingColumns.join(", ")}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    These will be left at their existing value (upsert) or
                    default (insert).
                  </p>
                </div>
              )}

              <div>
                <div className="mb-2 text-sm font-medium">
                  Sample rows ({preview.sample.length})
                </div>
                <div className="max-h-64 overflow-auto rounded border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted">
                      <tr>
                        {preview.header.map((h) => (
                          <th key={h} className="px-2 py-1 text-left font-mono">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sample.map((row, i) => (
                        <tr key={i} className="border-t">
                          {preview.header.map((h) => (
                            <td
                              key={h}
                              className="max-w-[200px] truncate px-2 py-1"
                            >
                              {(row as any)[h] === null
                                ? <span className="text-muted-foreground">null</span>
                                : typeof (row as any)[h] === "object"
                                ? JSON.stringify((row as any)[h])
                                : String((row as any)[h])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {preview && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">4. Map CSV columns to table columns</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Each CSV column is mapped to a table column of the same name by
                default. Pick a different target or "Skip" to ignore a column.
                Preview updates automatically.
              </p>
              <div className="flex flex-wrap gap-2 text-xs">
                <button
                  className="rounded border px-2 py-1 hover:bg-muted"
                  onClick={() => setMapping({})}
                >
                  Reset to identity
                </button>
                <button
                  className="rounded border px-2 py-1 hover:bg-muted"
                  onClick={() => {
                    const next: Record<string, string> = {};
                    const known = new Set(preview.tableColumns);
                    preview.header.forEach((h) => { if (!known.has(h)) next[h] = ""; });
                    setMapping(next);
                  }}
                >
                  Skip all unknown
                </button>
              </div>
              <div className="max-h-80 overflow-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="bg-muted">
                    <tr>
                      <th className="px-2 py-1 text-left">CSV column</th>
                      <th className="px-2 py-1 text-left">→ Table column</th>
                      <th className="px-2 py-1 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.header.map((h) => {
                      const eff = effectiveFor(h);
                      const known = preview.tableColumns.length === 0
                        || (eff !== null && preview.tableColumns.includes(eff));
                      const dup = eff
                        ? preview.header.filter((x) => effectiveFor(x) === eff).length > 1
                        : false;
                      return (
                        <tr key={h} className="border-t">
                          <td className="px-2 py-1 font-mono">{h}</td>
                          <td className="px-2 py-1">
                            <select
                              value={h in mapping ? mapping[h] : h}
                              onChange={(e) =>
                                setMapping((m) => ({ ...m, [h]: e.target.value }))
                              }
                              className="w-full rounded border bg-background px-2 py-1 font-mono"
                            >
                              <option value="">— Skip —</option>
                              {preview.tableColumns.length === 0 && (
                                <option value={h}>{h} (identity)</option>
                              )}
                              {preview.tableColumns.map((c) => (
                                <option key={c} value={c}>{c}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2 py-1">
                            {eff === null ? (
                              <span className="text-muted-foreground">skipped</span>
                            ) : dup ? (
                              <span className="text-destructive">duplicate target</span>
                            ) : !known ? (
                              <span className="text-amber-700 dark:text-amber-400">unknown</span>
                            ) : (
                              <span className="text-green-700 dark:text-green-400">ok</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {preview && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">5. Confirm and import</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm">Mode</Label>
                <div className="flex flex-wrap gap-3 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={mode === "upsert"}
                      onChange={() => setMode("upsert")}
                    />
                    Upsert <Badge variant="secondary">match by {preview.conflictColumn}</Badge>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={mode === "insert"}
                      onChange={() => setMode("insert")}
                    />
                    Insert only <Badge variant="outline">fails on duplicates</Badge>
                  </label>
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={ignoreUnknown}
                  onChange={(e) => setIgnoreUnknown(e.target.checked)}
                />
                Ignore unknown columns ({preview.unknownColumns.length})
              </label>

              {blockingIssues.length > 0 && (
                <div className="rounded border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  <div className="mb-1 flex items-center gap-2 font-medium">
                    <AlertTriangle className="h-4 w-4" />
                    Blocking issues
                  </div>
                  <ul className="ml-4 list-disc">
                    {blockingIssues.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </div>
              )}

              <div className="space-y-1">
                <Label className="text-sm">
                  Type <span className="font-mono">{requiredConfirm}</span> to confirm
                </Label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  className="w-full rounded border bg-background px-3 py-2 font-mono text-sm"
                  placeholder={requiredConfirm}
                />
              </div>

              <Button
                onClick={handleCommit}
                disabled={!canCommit}
                className="w-full sm:w-auto"
              >
                {busy === "commit" ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Importing...</>
                ) : (
                  <>Commit import</>
                )}
              </Button>

              {progress && busy === "commit" && (
                <div className="text-xs text-muted-foreground">
                  {progress.done} / {progress.total} rows shipped
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {result && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Result</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
                <CheckCircle2 className="h-5 w-5" />
                Inserted/updated <strong>{result.inserted}</strong> of {result.totalRows} rows.
              </div>
              {result.droppedColumns.length > 0 && (
                <div className="text-muted-foreground">
                  Dropped columns: <span className="font-mono">{result.droppedColumns.join(", ")}</span>
                </div>
              )}
              {result.chunkErrors.length > 0 && (
                <div className="rounded border border-amber-500/50 bg-amber-500/10 p-3">
                  <div className="mb-1 font-medium">Chunk-level notes</div>
                  <ul className="ml-4 list-disc text-xs">
                    {result.chunkErrors.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                </div>
              )}
              {result.rowErrors.length > 0 && (
                <div className="rounded border border-destructive/50 bg-destructive/10 p-3">
                  <div className="mb-1 font-medium">
                    Row errors ({result.rowErrors.length})
                  </div>
                  <div className="max-h-64 overflow-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr>
                          <th className="px-2 py-1 text-left">Row</th>
                          <th className="px-2 py-1 text-left">Key</th>
                          <th className="px-2 py-1 text-left">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.rowErrors.slice(0, 200).map((r, i) => (
                          <tr key={i} className="border-t">
                            <td className="px-2 py-1">{r.row}</td>
                            <td className="px-2 py-1 font-mono">{r.slug ?? "—"}</td>
                            <td className="px-2 py-1">{r.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {result.rowErrors.length > 200 && (
                    <div className="mt-2 text-xs text-muted-foreground">
                      Showing first 200 of {result.rowErrors.length} errors.
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold">{value.toLocaleString()}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
