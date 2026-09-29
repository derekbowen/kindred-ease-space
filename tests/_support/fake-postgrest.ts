/**
 * An in-memory PostgREST for FakeBackend (tests/_support/fake-backend.ts):
 * fixture tables answer the real supabase-js requests the server code builds,
 * with the query string applied the way PostgREST applies it — eq / neq / is
 * / in / ilike / like / gt(e) / lt(e) / not.*, top-level or=(...), order
 * (several keys, asc/desc, nulls first/last), limit and offset. So a test
 * asserts what the real query SELECTS, not what a stub was told to return:
 * `applyFilter`'s city_key=eq.portland&region_key=eq.or really excludes the
 * Portland, ME rows.
 *
 * Embedded resources (`page_templates:template_id(slug)`) are not joined:
 * fixture rows carry the embedded object already, as PostgREST would return
 * it. Columns are not projected (tests assert the `select` they sent).
 */
import type { FakeBackend, Hit } from "./fake-backend";

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

const RESERVED = new Set(["select", "order", "limit", "offset", "or", "and", "columns", "on_conflict"]);

function asText(v: unknown): string {
  if (v === null || v === undefined) return "null";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function likeToRegExp(pattern: string, flags: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[*%]/g, ".*");
  return new RegExp(`^${escaped}$`, flags);
}

/** Split "a,b,(c,d)" on top-level commas. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Does `value` (a column's value) satisfy "op.operand" (e.g. "eq.portland", "is.null", "not.is.null")? */
export function matchesOperator(value: unknown, expr: string): boolean {
  if (expr.startsWith("not.")) return !matchesOperator(value, expr.slice(4));
  const dot = expr.indexOf(".");
  const op = dot < 0 ? expr : expr.slice(0, dot);
  const operand = dot < 0 ? "" : expr.slice(dot + 1);
  switch (op) {
    case "eq":
      return value !== null && value !== undefined && asText(value) === operand;
    case "neq":
      return value !== null && value !== undefined && asText(value) !== operand;
    case "is":
      if (operand === "null") return value === null || value === undefined;
      if (operand === "true") return value === true;
      if (operand === "false") return value === false;
      return false;
    case "in": {
      const list = splitTop(operand.replace(/^\(|\)$/g, "")).map((x) => x.replace(/^"|"$/g, ""));
      return value !== null && value !== undefined && list.includes(asText(value));
    }
    case "like":
      return typeof value === "string" && likeToRegExp(operand, "").test(value);
    case "ilike":
      return typeof value === "string" && likeToRegExp(operand, "i").test(value);
    case "gt":
      return value !== null && value !== undefined && asText(value) > operand;
    case "gte":
      return value !== null && value !== undefined && asText(value) >= operand;
    case "lt":
      return value !== null && value !== undefined && asText(value) < operand;
    case "lte":
      return value !== null && value !== undefined && asText(value) <= operand;
    default:
      throw new Error(`fake-postgrest: unsupported operator ${op}`);
  }
}

function orMatches(row: Row, expr: string): boolean {
  const inner = expr.replace(/^\(|\)$/g, "");
  return splitTop(inner).some((cond) => {
    const dot = cond.indexOf(".");
    const col = cond.slice(0, dot);
    return matchesOperator(row[col], cond.slice(dot + 1));
  });
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = asText(a);
  const sb = asText(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** The rows a GET with this query string returns, in order. */
export function applyPostgrestQuery(rows: readonly Row[], query: URLSearchParams): Row[] {
  let out = rows.filter((row) => {
    for (const [key, value] of query.entries()) {
      if (RESERVED.has(key)) continue;
      if (!matchesOperator(row[key], value)) return false;
    }
    const or = query.get("or");
    return or ? orMatches(row, or) : true;
  });
  const order = query.get("order");
  if (order) {
    const keys = order.split(",").map((part) => {
      const [col, ...mods] = part.split(".");
      const desc = mods.includes("desc");
      const nullsFirst = mods.includes("nullsfirst") || (!mods.includes("nullslast") && desc);
      return { col: col!, desc, nullsFirst };
    });
    out = [...out].sort((x, y) => {
      for (const k of keys) {
        const a = x[k.col];
        const b = y[k.col];
        const an = a === null || a === undefined;
        const bn = b === null || b === undefined;
        if (an || bn) {
          if (an && bn) continue;
          return (an ? -1 : 1) * (k.nullsFirst ? 1 : -1);
        }
        const c = compare(a, b);
        if (c !== 0) return k.desc ? -c : c;
      }
      return 0;
    });
  }
  const offset = Number(query.get("offset") ?? 0) || 0;
  const limit = query.get("limit");
  return out.slice(offset, limit === null ? undefined : offset + Number(limit));
}

/**
 * Serve `tables` through a FakeBackend: GET/HEAD read with the query applied,
 * POST inserts, PATCH updates the matching rows. `errors[table]` makes every
 * read of that table fail with a PostgREST error (500).
 */
export function serveTables(
  backend: FakeBackend,
  tables: Tables,
  errors: Partial<Record<string, string>> = {},
): void {
  backend.rest = {};
  for (const name of Object.keys(tables)) {
    const read = (h: Hit) => {
      const msg = errors[name];
      if (msg) return { status: 500, body: { code: "XX000", message: msg } };
      return applyPostgrestQuery(tables[name]!, h.query);
    };
    backend.rest[`GET ${name}`] = read;
    backend.rest[`HEAD ${name}`] = read;
    backend.rest[`POST ${name}`] = (h) => {
      const rows = (Array.isArray(h.body) ? h.body : [h.body]) as Row[];
      tables[name]!.push(...rows);
      return rows;
    };
    backend.rest[`PATCH ${name}`] = (h) => {
      const hit = applyPostgrestQuery(tables[name]!, h.query);
      for (const r of hit) Object.assign(r, h.body);
      return hit;
    };
  }
}
