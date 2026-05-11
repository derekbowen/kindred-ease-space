import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const TABLES = ["content_plan", "content_pages"] as const;
type TableName = (typeof TABLES)[number];

async function assertAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Forbidden");
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const head = cols.join(",");
  const body = rows
    .map((r) => cols.map((c) => csvEscape(r[c])).join(","))
    .join("\n");
  return head + "\n" + body;
}

export const exportTable = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { table: TableName }) => {
    if (!TABLES.includes(d.table)) throw new Error("Invalid table");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    await assertAdmin(userId);

    const all: Record<string, unknown>[] = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const { data: rows, error } = await supabaseAdmin
        .from(data.table)
        .select("*")
        .order("created_at", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error(error.message);
      if (!rows || rows.length === 0) break;
      all.push(...(rows as Record<string, unknown>[]));
      if (rows.length < pageSize) break;
      from += pageSize;
    }

    return { csv: toCsv(all), rowCount: all.length, columns: all[0] ? Object.keys(all[0]) : [] };
  });

// Minimal CSV parser (handles quoted fields, escaped quotes, CR/LF)
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") {
        row.push(cur);
        cur = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cur);
        cur = "";
        rows.push(row);
        row = [];
      } else cur += ch;
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

function coerceValue(raw: string, col: string): unknown {
  if (raw === "") return null;
  // jsonb / array columns: try JSON first
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return raw;
}

async function getTableColumns(table: TableName): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from(table)
    .select("*")
    .limit(1);
  if (error) throw new Error(`Schema lookup failed: ${error.message}`);
  if (data && data.length > 0) return Object.keys(data[0] as object);
  // Fall back to inserting nothing — column discovery only works with a sample row
  return [];
}

function applyMapping(
  header: string[],
  mapping?: Record<string, string>,
): { effective: string[]; map: (string | null)[] } {
  const m = header.map((h) => {
    if (!mapping) return h;
    if (!(h in mapping)) return h; // unmapped → identity
    const v = mapping[h];
    return v && v.length > 0 ? v : null;
  });
  const effective: string[] = [];
  m.forEach((v) => { if (v) effective.push(v); });
  return { effective, map: m };
}

export const previewImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { table: TableName; csv: string; columnMapping?: Record<string, string> }) => {
    if (!TABLES.includes(d.table)) throw new Error("Invalid table");
    if (!d.csv) throw new Error("Empty CSV");
    if (d.csv.length > 25 * 1024 * 1024) throw new Error("CSV too large (>25MB)");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    await assertAdmin(userId);

    const parsed = parseCsv(data.csv);
    if (parsed.length < 2) throw new Error("CSV has no data rows");
    const header = parsed[0];
    const dataRows = parsed.slice(1);

    const tableCols = await getTableColumns(data.table);
    const knownCols = new Set(tableCols);

    const { effective: effectiveHeader, map: headerMap } = applyMapping(
      header,
      data.columnMapping,
    );

    const unknownCols = tableCols.length > 0
      ? effectiveHeader.filter((c) => !knownCols.has(c))
      : [];
    const missingCols = tableCols.length > 0
      ? tableCols.filter((c) => !effectiveHeader.includes(c))
      : [];

    const conflictColumn = data.table === "content_plan" ? "slug" : "id";
    const conflictEffectiveIdx = effectiveHeader.indexOf(conflictColumn);
    const conflictCsvIdx = headerMap.findIndex((m) => m === conflictColumn);
    const conflictValues: string[] = [];
    if (conflictCsvIdx >= 0) {
      for (const r of dataRows) {
        const v = r[conflictCsvIdx];
        if (v) conflictValues.push(v);
      }
    }

    let existingCount = 0;
    if (conflictValues.length > 0) {
      const lookupChunk = 500;
      for (let i = 0; i < conflictValues.length; i += lookupChunk) {
        const slice = conflictValues.slice(i, i + lookupChunk);
        const { count } = await supabaseAdmin
          .from(data.table)
          .select(conflictColumn, { count: "exact", head: true })
          .in(conflictColumn, slice);
        existingCount += count ?? 0;
      }
    }

    const sampleSize = Math.min(5, dataRows.length);
    const sample = dataRows.slice(0, sampleSize).map((r) => {
      const obj: Record<string, any> = {};
      headerMap.forEach((eff, i) => {
        if (!eff) return;
        obj[eff] = coerceValue(r[i] ?? "", eff);
      });
      return obj;
    });

    return {
      totalRows: dataRows.length,
      header,
      effectiveHeader,
      tableColumns: tableCols,
      unknownColumns: unknownCols,
      missingColumns: missingCols,
      conflictColumn,
      hasConflictColumn: conflictEffectiveIdx >= 0,
      existingMatches: existingCount,
      newRowsEstimate: dataRows.length - existingCount,
      sample,
    };
  });

export const importTable = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      table: TableName;
      csv: string;
      mode: "upsert" | "insert";
      conflictColumn?: string;
      dryRun?: boolean;
      ignoreUnknownColumns?: boolean;
      columnMapping?: Record<string, string>;
    }) => {
      if (!TABLES.includes(d.table)) throw new Error("Invalid table");
      if (!d.csv || d.csv.length === 0) throw new Error("Empty CSV");
      if (d.csv.length > 25 * 1024 * 1024) throw new Error("CSV too large (>25MB)");
      return d;
    },
  )
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    await assertAdmin(userId);

    const parsed = parseCsv(data.csv);
    if (parsed.length < 2) throw new Error("CSV has no data rows");
    const header = parsed[0];

    // Apply user-supplied column mapping first (CSV header → table column, "" = skip)
    const { map: headerMap0 } = applyMapping(header, data.columnMapping);
    let headerMap: (string | null)[] = headerMap0;

    const tableCols = new Set(await getTableColumns(data.table));
    const knownSchema = tableCols.size > 0;

    // Optionally drop columns whose mapped name isn't in the schema
    const droppedColumns: string[] = [];
    if (data.ignoreUnknownColumns && knownSchema) {
      headerMap = headerMap.map((eff, i) => {
        if (eff && !tableCols.has(eff)) {
          droppedColumns.push(eff || header[i]);
          return null;
        }
        return eff;
      });
    } else {
      // Skipped columns from mapping are already dropped
      headerMap.forEach((eff, i) => { if (!eff) droppedColumns.push(header[i]); });
    }

    const effectiveHeader: string[] = [];
    headerMap.forEach((eff) => { if (eff) effectiveHeader.push(eff); });

    const rowErrors: { row: number; slug?: string; reason: string }[] = [];
    const validRows: Record<string, any>[] = [];
    const validRowNumbers: number[] = [];

    const conflictColumn =
      data.conflictColumn || (data.table === "content_plan" ? "slug" : "id");
    const seenKeys = new Map<string, number>();

    parsed.slice(1).forEach((rawRow, idx) => {
      const csvRowNum = idx + 2;
      const obj: Record<string, any> = {};
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
        obj[col] = coerceValue(raw, col);
      });

      // Required: conflict column must be present and non-empty
      if (
        effectiveHeader.includes(conflictColumn) &&
        (obj[conflictColumn] === null || obj[conflictColumn] === "")
      ) {
        issues.push(`Missing required "${conflictColumn}"`);
      }

      // Schema check: any unknown columns left after drop step?
      if (knownSchema) {
        for (const col of effectiveHeader) {
          if (!tableCols.has(col)) {
            issues.push(`Unknown column "${col}"`);
          }
        }
      }

      // Duplicate key within the CSV
      const keyVal = obj[conflictColumn];
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

    if (data.dryRun) {
      return {
        dryRun: true,
        totalRows: parsed.length - 1,
        validRowCount: validRows.length,
        inserted: 0,
        rowErrors,
        chunkErrors: [] as string[],
        columns: effectiveHeader,
        droppedColumns,
      };
    }

    // Insert valid rows in chunks. On chunk failure, retry per-row to pinpoint
    // the offending rows so the rest of the chunk still lands.
    const chunkSize = 500;
    let inserted = 0;
    const chunkErrors: string[] = [];

    const writeOne = async (row: Record<string, any>) => {
      const tbl = supabaseAdmin.from(data.table) as any;
      const q =
        data.mode === "upsert"
          ? tbl.upsert([row], { onConflict: conflictColumn })
          : tbl.insert([row]);
      return q;
    };

    for (let i = 0; i < validRows.length; i += chunkSize) {
      const chunk = validRows.slice(i, i + chunkSize);
      const chunkRowNums = validRowNumbers.slice(i, i + chunkSize);
      const tbl = supabaseAdmin.from(data.table) as any;
      const q =
        data.mode === "upsert"
          ? tbl.upsert(chunk, { onConflict: conflictColumn })
          : tbl.insert(chunk);
      const { error } = await q;

      if (!error) {
        inserted += chunk.length;
        continue;
      }

      // Fall back to per-row writes so good rows still land.
      for (let j = 0; j < chunk.length; j++) {
        const { error: rowErr } = await writeOne(chunk[j]);
        if (rowErr) {
          rowErrors.push({
            row: chunkRowNums[j],
            slug:
              chunk[j][conflictColumn] != null
                ? String(chunk[j][conflictColumn])
                : undefined,
            reason: `DB: ${rowErr.message}`,
          });
        } else {
          inserted++;
        }
      }
      // Note the chunk-level message too for context
      chunkErrors.push(
        `Chunk rows ${chunkRowNums[0]}-${chunkRowNums[chunkRowNums.length - 1]} retried per-row: ${error.message}`,
      );
    }

    return {
      dryRun: false,
      totalRows: parsed.length - 1,
      validRowCount: validRows.length,
      inserted,
      rowErrors,
      chunkErrors,
      columns: effectiveHeader,
      droppedColumns,
    };
  });

// ----------------------------------------------------------------------------
// Chunked client-driven import. Used by the data-import page so we never have
// to push the full CSV through a single server-fn request (Workers + the JSON
// transport choke on multi-MB payloads). The browser parses the CSV, calls
// `getImportSchema` once, optionally `lookupExistingKeys` for the preview, and
// then ships rows in batches via `importTableRows`.
// ----------------------------------------------------------------------------

export const getImportSchema = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { table: TableName }) => {
    if (!TABLES.includes(d.table)) throw new Error("Invalid table");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    await assertAdmin(userId);
    const tableColumns = await getTableColumns(data.table);
    const conflictColumn = data.table === "content_plan" ? "slug" : "id";
    return { tableColumns, conflictColumn };
  });

export const lookupExistingKeys = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { table: TableName; conflictColumn: string; values: string[] }) => {
      if (!TABLES.includes(d.table)) throw new Error("Invalid table");
      if (!Array.isArray(d.values)) throw new Error("values must be an array");
      if (d.values.length > 5000) throw new Error("Too many keys (max 5000 per call)");
      return d;
    },
  )
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    await assertAdmin(userId);
    if (data.values.length === 0) return { existingCount: 0 };
    const { count } = await supabaseAdmin
      .from(data.table)
      .select(data.conflictColumn, { count: "exact", head: true })
      .in(data.conflictColumn, data.values);
    return { existingCount: count ?? 0 };
  });

export const importTableRows = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      table: TableName;
      rows: Record<string, unknown>[];
      mode: "upsert" | "insert";
      conflictColumn?: string;
      rowNumbers?: number[];
    }) => {
      if (!TABLES.includes(d.table)) throw new Error("Invalid table");
      if (!Array.isArray(d.rows)) throw new Error("rows must be an array");
      if (d.rows.length === 0) throw new Error("rows is empty");
      if (d.rows.length > 500) throw new Error("Chunk too large (max 500 rows)");
      return d;
    },
  )
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    await assertAdmin(userId);

    const conflictColumn =
      data.conflictColumn || (data.table === "content_plan" ? "slug" : "id");
    const rowNumbers = data.rowNumbers ?? data.rows.map((_, i) => i + 1);

    const rowErrors: { row: number; slug?: string; reason: string }[] = [];
    let inserted = 0;

    const tbl = supabaseAdmin.from(data.table) as any;
    const q =
      data.mode === "upsert"
        ? tbl.upsert(data.rows, { onConflict: conflictColumn })
        : tbl.insert(data.rows);
    const { error } = await q;

    if (!error) {
      inserted = data.rows.length;
    } else {
      // Retry per-row so good rows still land and we can pinpoint failures.
      for (let j = 0; j < data.rows.length; j++) {
        const tbl2 = supabaseAdmin.from(data.table) as any;
        const q2 =
          data.mode === "upsert"
            ? tbl2.upsert([data.rows[j]], { onConflict: conflictColumn })
            : tbl2.insert([data.rows[j]]);
        const { error: rowErr } = await q2;
        if (rowErr) {
          const r: any = data.rows[j];
          rowErrors.push({
            row: rowNumbers[j],
            slug: r?.[conflictColumn] != null ? String(r[conflictColumn]) : undefined,
            reason: `DB: ${rowErr.message}`,
          });
        } else {
          inserted++;
        }
      }
    }

    return {
      inserted,
      rowErrors,
      chunkError: error ? error.message : null,
    };
  });


