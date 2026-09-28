/**
 * An in-memory PostgREST for driving server code through the REAL supabase-js
 * client (install() replaces globalThis.fetch for one host). Enough of the
 * wire protocol for this app's queries: eq/neq/is/in/lt/lte/gt/gte/ilike
 * filters (including JSON paths like generation->>request_id), or=(…),
 * order (with nullsfirst/nullslast), offset/limit, count=exact with HEAD,
 * return=representation, single/maybeSingle, one-level embeds
 * (alias:fk(cols)), unique indexes that answer 23505 like Postgres, and RPCs.
 *
 * It is a test double, not a database: every behavior a test relies on is
 * asserted by that test. Unknown operators throw, so a query this fake cannot
 * answer fails loudly instead of matching everything.
 */
export type Row = Record<string, any>;

export type UniqueIndex = {
  name: string;
  columns: string[];
  /** Partial index predicate; default: every row. */
  where?: (row: Row) => boolean;
};

export type Embed = { table: string; fk: string };

export type RpcHandler = (args: any, ctx: { db: FakeDb }) => unknown;

export type Hit = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  headers: Headers;
};

export class FakeDb {
  tables: Record<string, Row[]> = {};
  uniques: Record<string, UniqueIndex[]> = {};
  embeds: Record<string, Record<string, Embed>> = {};
  rpcs: Record<string, RpcHandler> = {};
  hits: Hit[] = [];
  /** Called before a write is applied; throw or return a Response to fail it. */
  beforeWrite?: (op: {
    method: string;
    table: string;
    body: any;
    query: URLSearchParams;
  }) => Response | void;
  private seq = 0;

  table(name: string): Row[] {
    return (this.tables[name] ??= []);
  }
  insertRow(table: string, row: Row): Row {
    const r = { id: row.id ?? this.nextId(), ...row };
    this.table(table).push(r);
    return r;
  }
  nextId(): string {
    this.seq++;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }

  hitsOf(method: string, path: string): Hit[] {
    return this.hits.filter((h) => h.method === method && h.path === path);
  }

  /** Install as globalThis.fetch for `host`; other hosts go to `fallback`. */
  install(host: string, fallback?: typeof fetch): void {
    const self = this;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.hostname !== host) {
        if (fallback) return fallback(input as any, init);
        throw new TypeError(`unexpected host ${url.host}`);
      }
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
      const path = url.pathname.replace(/^\/rest\/v1\//, "");
      self.hits.push({ method, path, query: url.searchParams, body, headers });
      try {
        return self.handle(method, path, url.searchParams, body, headers);
      } catch (e) {
        return json(500, { message: e instanceof Error ? e.message : String(e) });
      }
    }) as typeof fetch;
  }

  private handle(
    method: string,
    path: string,
    q: URLSearchParams,
    body: any,
    headers: Headers,
  ): Response {
    const prefer = headers.get("prefer") ?? "";
    const single = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
    if (path.startsWith("rpc/")) {
      const name = path.slice(4);
      const fn = this.rpcs[name];
      if (!fn) return json(404, { code: "PGRST202", message: `function ${name} not found` });
      const out = fn(body ?? {}, { db: this });
      if (out instanceof Response) return out;
      if (Array.isArray(out)) {
        let rows = out.filter((r) => matches(r, q));
        rows = order(rows, q.get("order"));
        rows = page(rows, q);
        return json(200, rows);
      }
      return json(200, out);
    }
    const table = path;
    if (method === "GET" || method === "HEAD") {
      let rows = this.table(table).filter((r) => matches(r, q));
      const total = rows.length;
      rows = order(rows, q.get("order"));
      rows = page(rows, q);
      const out = rows.map((r) => this.project(table, r, q.get("select")));
      const extra: Record<string, string> = {};
      if (/count=exact/.test(prefer))
        extra["content-range"] = `${out.length ? `0-${out.length - 1}` : "*"}/${total}`;
      if (method === "HEAD") return new Response(null, { status: 200, headers: extra });
      if (single)
        return out.length === 1
          ? json(200, out[0], extra)
          : json(406, {
              code: "PGRST116",
              message: "JSON object requested, multiple (or no) rows returned",
            });
      return json(200, out, extra);
    }
    const veto = this.beforeWrite?.({ method, table, body, query: q });
    if (veto instanceof Response) return veto;
    let affected: Row[] = [];
    if (method === "POST") {
      const input = Array.isArray(body) ? body : [body];
      const staged = input.map((b) => ({ id: b.id ?? this.nextId(), ...b }));
      for (const r of staged) {
        const v = this.violation(table, r, null);
        if (v) return v;
        this.table(table).push(r);
      }
      affected = staged;
    } else if (method === "PATCH") {
      const targets = this.table(table).filter((r) => matches(r, q));
      for (const r of targets) {
        const next = { ...r, ...body };
        const v = this.violation(table, next, r);
        if (v) return v;
      }
      for (const r of targets) Object.assign(r, body);
      affected = targets;
    } else if (method === "DELETE") {
      const keep: Row[] = [];
      for (const r of this.table(table)) (matches(r, q) ? affected : keep).push(r);
      this.tables[table] = keep;
    } else {
      return json(405, { message: `method ${method}` });
    }
    if (!/return=representation/.test(prefer))
      return new Response(null, { status: method === "POST" ? 201 : 204 });
    const out = affected.map((r) => this.project(table, r, q.get("select")));
    if (single)
      return out.length === 1
        ? json(200, out[0])
        : json(406, {
            code: "PGRST116",
            message: "JSON object requested, multiple (or no) rows returned",
          });
    return json(method === "POST" ? 201 : 200, out);
  }

  private violation(table: string, row: Row, self: Row | null): Response | null {
    for (const idx of this.uniques[table] ?? []) {
      if (idx.where && !idx.where(row)) continue;
      if (idx.columns.some((c) => row[c] === null || row[c] === undefined)) continue;
      const clash = this.table(table).find(
        (o) =>
          o !== self && (!idx.where || idx.where(o)) && idx.columns.every((c) => o[c] === row[c]),
      );
      if (clash) {
        return json(409, {
          code: "23505",
          message: `duplicate key value violates unique constraint "${idx.name}"`,
          details: `Key (${idx.columns.join(", ")})=(${idx.columns.map((c) => row[c]).join(", ")}) already exists.`,
        });
      }
    }
    return null;
  }

  private project(table: string, row: Row, select: string | null): Row {
    const out: Row = { ...row };
    for (const item of splitTop(select ?? "*")) {
      const m = item.match(/^(\w+):(\w+)\(([^)]*)\)$/) ?? item.match(/^(\w+)\(([^)]*)\)$/);
      if (!m) continue;
      const alias = m[1]!;
      const embed = this.embeds[table]?.[alias];
      if (!embed) throw new Error(`fake-postgrest: no embed ${table}.${alias}`);
      const target = this.table(embed.table).find((r) => r.id === row[embed.fk]);
      out[alias] = target ? { ...target } : null;
    }
    return out;
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Column value, with JSON paths: a->b->>c. */
export function colValue(row: Row, col: string): unknown {
  const parts = col.split(/->>?/);
  let v: any = row[parts[0]!];
  for (const p of parts.slice(1)) {
    if (v === null || v === undefined || typeof v !== "object") return null;
    v = v[p];
  }
  if (/->>/.test(col) && v !== null && v !== undefined)
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  return v ?? null;
}

function cmp(a: unknown, b: string): number {
  if (typeof a === "number") return a - Number(b);
  const sa = String(a);
  return sa < b ? -1 : sa > b ? 1 : 0;
}

function test(row: Row, col: string, expr: string): boolean {
  const neg = expr.startsWith("not.");
  const e = neg ? expr.slice(4) : expr;
  const dot = e.indexOf(".");
  const op = e.slice(0, dot);
  const val = e.slice(dot + 1);
  const v = colValue(row, col);
  let r: boolean;
  switch (op) {
    case "eq":
      r =
        v !== null &&
        v !== undefined &&
        (typeof v === "boolean"
          ? String(v) === val
          : typeof v === "number"
            ? v === Number(val)
            : String(v) === val);
      break;
    case "neq":
      r = v !== null && v !== undefined && String(v) !== val;
      break;
    case "is":
      r =
        val === "null"
          ? v === null || v === undefined
          : val === "true"
            ? v === true
            : val === "false"
              ? v === false
              : false;
      break;
    case "in": {
      const list = val
        .replace(/^\(|\)$/g, "")
        .split(",")
        .map((x) => x.replace(/^"|"$/g, ""));
      r = v !== null && v !== undefined && list.includes(String(v));
      break;
    }
    case "lt":
      r = v !== null && v !== undefined && cmp(v, val) < 0;
      break;
    case "lte":
      r = v !== null && v !== undefined && cmp(v, val) <= 0;
      break;
    case "gt":
      r = v !== null && v !== undefined && cmp(v, val) > 0;
      break;
    case "gte":
      r = v !== null && v !== undefined && cmp(v, val) >= 0;
      break;
    case "ilike": {
      const re = new RegExp(
        `^${val
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/%/g, ".*")}$`,
        "i",
      );
      r = v !== null && v !== undefined && re.test(String(v));
      break;
    }
    default:
      throw new Error(`fake-postgrest: unsupported operator ${op} on ${col}`);
  }
  return neg ? !r : r;
}

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function matches(row: Row, q: URLSearchParams): boolean {
  for (const [key, value] of q) {
    if (RESERVED.has(key)) continue;
    if (key === "or") {
      const inner = value.replace(/^\(|\)$/g, "");
      const ok = splitTop(inner).some((cond) => {
        const m = cond.match(/^([^.]+(?:->>?[^.]+)*)\.(.+)$/);
        if (!m) throw new Error(`fake-postgrest: bad or condition ${cond}`);
        return test(row, m[1]!, m[2]!);
      });
      if (!ok) return false;
      continue;
    }
    if (!test(row, key, value)) return false;
  }
  return true;
}

function order(rows: Row[], spec: string | null): Row[] {
  if (!spec) return rows;
  const keys = spec.split(",").map((s) => {
    const [col, ...mods] = s.split(".");
    return { col: col!, desc: mods.includes("desc"), nullsFirst: mods.includes("nullsfirst") };
  });
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const va = colValue(a, k.col);
      const vb = colValue(b, k.col);
      if (va === vb) continue;
      if (va === null || va === undefined) return k.nullsFirst ? -1 : 1;
      if (vb === null || vb === undefined) return k.nullsFirst ? 1 : -1;
      const c =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va) < String(vb)
            ? -1
            : 1;
      return k.desc ? -c : c;
    }
    return 0;
  });
}

function page(rows: Row[], q: URLSearchParams): Row[] {
  const offset = Number(q.get("offset") ?? 0);
  const limit = q.get("limit");
  return rows.slice(offset, limit === null ? undefined : offset + Number(limit));
}
