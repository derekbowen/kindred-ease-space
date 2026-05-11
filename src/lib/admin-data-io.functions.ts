import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertWorkspaceMember } from "@/lib/admin-helpers.functions";
import { z } from "zod";

// Tables exposed to the admin data-io tool. All are workspace-scoped.
const TABLES = ["content_plan", "content_pages"] as const;
type TableName = (typeof TABLES)[number];

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
    cols.join(",") +
    "\n" +
    rows.map((r) => cols.map((c) => csvEscape(r[c])).join(",")).join("\n")
  );
}

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
const tableInput = z.object({ table: z.enum(TABLES) });

export const exportTable = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => tableInput.parse(d))
  .handler(async ({ data, context }) => {
    const { workspaceId } = await assertWorkspaceMember((context as any).userId);

    const all: Record<string, unknown>[] = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const { data: rows, error } = await supabaseAdmin
        .from(data.table)
        .select("*")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: true })
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

async function getTableColumns(table: TableName, workspaceId: string): Promise<string[]> {
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
    const { workspaceId } = await assertWorkspaceMember((context as any).userId);
    const tableColumns = await getTableColumns(data.table, workspaceId);
    const conflictColumn = data.table === "content_plan" ? "slug" : "id";
    return { tableColumns, conflictColumn };
  });

const importInput = z.object({
  table: z.enum(TABLES),
  csv: z.string().min(1).max(25 * 1024 * 1024),
  mode: z.enum(["upsert", "insert"]).default("upsert"),
  conflictColumn: z.string().optional(),
  dryRun: z.boolean().optional(),
});

export const importTable = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => importInput.parse(d))
  .handler(async ({ data, context }) => {
    const { workspaceId } = await assertWorkspaceMember((context as any).userId);
    const parsed = parseCsv(data.csv);
    if (parsed.length < 2) throw new Error("CSV has no data rows");
    const header = parsed[0];
    const dataRows = parsed.slice(1);
    const conflictColumn =
      data.conflictColumn || (data.table === "content_plan" ? "slug" : "id");

    const rowErrors: { row: number; key?: string; reason: string }[] = [];
    const validRows: Record<string, any>[] = [];
    const validRowNumbers: number[] = [];
    const seenKeys = new Map<string, number>();

    dataRows.forEach((rawRow, idx) => {
      const csvRowNum = idx + 2;
      const obj: Record<string, any> = {};
      header.forEach((col, i) => {
        if (col === "workspace_id") return; // never trust CSV-supplied workspace_id
        obj[col] = coerceValue(rawRow[i] ?? "");
      });
      // Force tenant
      obj.workspace_id = workspaceId;

      if (header.includes(conflictColumn) && (obj[conflictColumn] == null || obj[conflictColumn] === "")) {
        rowErrors.push({ row: csvRowNum, reason: `Missing required "${conflictColumn}"` });
        return;
      }
      const keyVal = obj[conflictColumn];
      if (keyVal != null) {
        const prior = seenKeys.get(String(keyVal));
        if (prior !== undefined) {
          rowErrors.push({
            row: csvRowNum,
            key: String(keyVal),
            reason: `Duplicate "${conflictColumn}"="${keyVal}" (also row ${prior})`,
          });
          return;
        }
        seenKeys.set(String(keyVal), csvRowNum);
      }
      validRows.push(obj);
      validRowNumbers.push(csvRowNum);
    });

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
      // Per-row retry to isolate failures.
      for (let j = 0; j < chunk.length; j++) {
        const tbl2 = supabaseAdmin.from(data.table) as any;
        const q2 =
          data.mode === "upsert"
            ? tbl2.upsert([chunk[j]], { onConflict: conflictColumn })
            : tbl2.insert([chunk[j]]);
        const { error: rowErr } = await q2;
        if (rowErr) {
          rowErrors.push({
            row: chunkRowNums[j],
            key: chunk[j][conflictColumn] != null ? String(chunk[j][conflictColumn]) : undefined,
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
