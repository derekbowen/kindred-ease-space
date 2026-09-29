import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import { z } from "zod";
import { assertFeatureAvailable } from "@/lib/features.server";

// Tables exposed to the admin data-io tool. All are workspace-scoped.
const TABLES = ["content_plan", "content_pages", "tenant_pages"] as const;
type TableName = (typeof TABLES)[number];
// Export covers everything a customer owns, including the live page model and
// the imported marketplace listings; import stays limited to the legacy tables.
const EXPORT_TABLES = [...TABLES, "tenant_listings"] as const;
type ExportTableName = (typeof EXPORT_TABLES)[number];
// What an import may write: the two legacy tables and nothing else. The live
// page model (tenant_pages) is export-only: its status belongs to
// publish_tenant_pages() and the page limit, which a service-role upsert would
// skip (a direct call could publish past the plan's limit or re-publish
// billing_suspended pages).
export const IMPORT_TABLES = ["content_plan", "content_pages"] as const;
type ImportTableName = (typeof IMPORT_TABLES)[number];
// The row key an upsert matches on — always inside the caller's workspace.
export const IMPORT_KEY_COLUMN: Record<ImportTableName, string> = {
  content_plan: "slug",
  content_pages: "url_path",
};
// The upsert's conflict target is the server's, never the caller's, and always
// includes workspace_id. The write runs as the service role (past RLS), and
// content_pages (url_path, source_url, slug) and content_plan (slug) carry
// unique keys that span ALL workspaces: a caller-chosen target such as url_path,
// or a CSV row id naming another workspace's row, turned the upsert into an
// overwrite of that row. The file's id and workspace_id columns are ignored.
export const IMPORT_CONFLICT_TARGET: Record<ImportTableName, string> = {
  content_plan: `workspace_id,${IMPORT_KEY_COLUMN.content_plan}`,
  content_pages: `workspace_id,${IMPORT_KEY_COLUMN.content_pages}`,
};
// tenant_listings has no created_at; its rows are keyed by id.
const EXPORT_ORDER: Record<ExportTableName, string> = {
  content_plan: "created_at",
  content_pages: "created_at",
  tenant_pages: "created_at",
  tenant_listings: "id",
};

// ---------- CSV helpers ----------
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  return (
    cols.join(",") + "\n" + rows.map((r) => cols.map((c) => csvEscape(r[c])).join(",")).join("\n")
  );
}

export function parseCsv(text: string): string[][] {
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

function coerceValue(raw: string): unknown {
  if (raw === "") return null;
  const t = raw.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      /* fall through */
    }
  }
  if (t === "true") return true;
  if (t === "false") return false;
  return raw;
}

// ---------- Server functions ----------
// MVP (2026-09-28): import is deferred — getImportSchema and importTable call
// assertFeatureAvailable("data_import") first (src/lib/features.server.ts), so
// nothing new is written to the legacy content tables. exportTable stays
// available: it is a member-only read of the workspace's own rows.
const tableInput = z.object({ workspaceId: workspaceIdSchema, table: z.enum(EXPORT_TABLES) });

export const exportTable = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => tableInput.parse(d))
  .handler(async ({ data, context }) => {
    const workspaceId = data.workspaceId;
    await assertWorkspaceMember(workspaceId, (context as any).userId);

    const all: Record<string, unknown>[] = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const { data: rows, error } = await supabaseAdmin
        .from(data.table)
        .select("*")
        .eq("workspace_id", workspaceId)
        .order(EXPORT_ORDER[data.table], { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error(error.message);
      if (!rows || rows.length === 0) break;
      all.push(...(rows as Record<string, unknown>[]));
      if (rows.length < pageSize) break;
      from += pageSize;
    }
    return {
      csv: toCsv(all),
      rowCount: all.length,
      columns: all[0] ? Object.keys(all[0]) : [],
    };
  });

async function getTableColumns(table: ExportTableName, workspaceId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from(table)
    .select("*")
    .eq("workspace_id", workspaceId)
    .limit(1);
  if (error) throw new Error(`Schema lookup failed: ${error.message}`);
  if (data && data.length > 0) return Object.keys(data[0] as object);
  return [];
}

export const getImportSchema = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => tableInput.parse(d))
  .handler(async ({ data, context }) => {
    await assertFeatureAvailable("data_import");
    const workspaceId = data.workspaceId;
    await assertWorkspaceMember(workspaceId, (context as any).userId);
    const tableColumns = await getTableColumns(data.table, workspaceId);
    // null: the table is export-only.
    const conflictColumn =
      (IMPORT_CONFLICT_TARGET as Record<string, string | undefined>)[data.table] ?? null;
    return { tableColumns, conflictColumn };
  });

/**
 * The rows an import may write, from the parsed file. The file's id and
 * workspace_id columns are never used: the workspace is the session's, and a
 * row id is always the database's own (a file id could name another
 * workspace's row). Rows missing or repeating the key are reported, not sent.
 */
export function buildImportRows(
  table: ImportTableName,
  header: string[],
  dataRows: string[][],
  workspaceId: string,
) {
  const keyColumn = IMPORT_KEY_COLUMN[table];
  const rowErrors: { row: number; key?: string; reason: string }[] = [];
  const validRows: Record<string, any>[] = [];
  const validRowNumbers: number[] = [];
  const seenKeys = new Map<string, number>();

  dataRows.forEach((rawRow, idx) => {
    const csvRowNum = idx + 2;
    const obj: Record<string, any> = {};
    header.forEach((col, i) => {
      if (col === "workspace_id" || col === "id") return;
      obj[col] = coerceValue(rawRow[i] ?? "");
    });
    // Force tenant
    obj.workspace_id = workspaceId;

    if (header.includes(keyColumn) && (obj[keyColumn] == null || obj[keyColumn] === "")) {
      rowErrors.push({ row: csvRowNum, reason: `Missing required "${keyColumn}"` });
      return;
    }
    const keyVal = obj[keyColumn];
    if (keyVal != null) {
      const prior = seenKeys.get(String(keyVal));
      if (prior !== undefined) {
        rowErrors.push({
          row: csvRowNum,
          key: String(keyVal),
          reason: `Duplicate "${keyColumn}"="${keyVal}" (also row ${prior})`,
        });
        return;
      }
      seenKeys.set(String(keyVal), csvRowNum);
    }
    validRows.push(obj);
    validRowNumbers.push(csvRowNum);
  });
  return { rowErrors, validRows, validRowNumbers };
}

export const ImportTableInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    table: z.enum(IMPORT_TABLES),
    csv: z
      .string()
      .min(1)
      .max(25 * 1024 * 1024),
    mode: z.enum(["upsert", "insert"]).default("upsert"),
    dryRun: z.boolean().optional(),
  })
  // Unknown keys are refused: a body still carrying conflictColumn (or any
  // other extra field) fails validation instead of being quietly dropped.
  .strict();

export const importTable = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ImportTableInputSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertFeatureAvailable("data_import");
    const workspaceId = data.workspaceId;
    await assertWorkspaceMember(workspaceId, (context as any).userId);
    const parsed = parseCsv(data.csv);
    if (parsed.length < 2) throw new Error("CSV has no data rows");
    const header = parsed[0];
    const dataRows = parsed.slice(1);
    const keyColumn = IMPORT_KEY_COLUMN[data.table];
    const conflictColumn = IMPORT_CONFLICT_TARGET[data.table];
    const { rowErrors, validRows, validRowNumbers } = buildImportRows(
      data.table,
      header,
      dataRows,
      workspaceId,
    );

    if (data.dryRun) {
      return {
        dryRun: true,
        totalRows: dataRows.length,
        validRowCount: validRows.length,
        inserted: 0,
        rowErrors,
        chunkErrors: [] as string[],
      };
    }

    const chunkSize = 500;
    let inserted = 0;
    const chunkErrors: string[] = [];

    for (let i = 0; i < validRows.length; i += chunkSize) {
      // Every row carries the session's workspace_id and no id, and the
      // conflict target includes workspace_id: an upsert can only match the
      // caller's own rows, and a clash with another workspace's row on a
      // cross-workspace unique key is refused (23505), never merged.
      const safeChunk = validRows.slice(i, i + chunkSize);
      const safeNums = validRowNumbers.slice(i, i + chunkSize);
      const chunkRowNums = safeNums;

      const tbl = supabaseAdmin.from(data.table) as any;
      const q =
        data.mode === "upsert"
          ? tbl.upsert(safeChunk, { onConflict: conflictColumn })
          : tbl.insert(safeChunk);
      const { error } = await q;
      if (!error) {
        inserted += safeChunk.length;
        continue;
      }
      // Per-row retry to isolate failures.
      for (let j = 0; j < safeChunk.length; j++) {
        const tbl2 = supabaseAdmin.from(data.table) as any;
        const q2 =
          data.mode === "upsert"
            ? tbl2.upsert([safeChunk[j]], { onConflict: conflictColumn })
            : tbl2.insert([safeChunk[j]]);
        const { error: rowErr } = await q2;
        if (rowErr) {
          rowErrors.push({
            row: safeNums[j],
            key: safeChunk[j][keyColumn] != null ? String(safeChunk[j][keyColumn]) : undefined,
            reason: `DB: ${rowErr.message}`,
          });
        } else inserted++;
      }
      chunkErrors.push(
        `Chunk rows ${chunkRowNums[0]}-${chunkRowNums[chunkRowNums.length - 1]} retried per-row: ${error.message}`,
      );
    }

    return {
      dryRun: false,
      totalRows: dataRows.length,
      validRowCount: validRows.length,
      inserted,
      rowErrors,
      chunkErrors,
    };
  });
