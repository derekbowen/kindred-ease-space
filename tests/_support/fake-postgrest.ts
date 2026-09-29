/**
 * A FAKE POSTGREST behind globalThis.fetch, for the sitemap suites.
 *
 * The real supabase-js service-role client (src/integrations/supabase/
 * client.server.ts) builds every request, so a test sees exactly the query
 * strings production sends — filters, keyset `id=gt.…`, `order`, `limit`,
 * `offset`, `Prefer: count=exact`, HEAD counts, PATCH writes and RPC POSTs.
 * Like PostgREST it caps EVERY response at `maxRows` rows (the Supabase
 * default, 1,000) whatever was asked for, and reports exact counts in
 * Content-Range. Columns are checked against SCHEMA, so selecting a column
 * that does not exist fails the way PostgREST does (400, 42703).
 *
 * Offline: any other origin throws. Failures are 500s (never 503/520, which
 * postgrest-js would retry with back-off).
 */

export type Row = Record<string, unknown>;

export type Hit = {
  method: string;
  kind: "table" | "rpc";
  name: string;
  params: URLSearchParams;
  body: unknown;
  prefer: string;
};

export type RpcHandler = (args: Record<string, unknown>, hit: Hit) => unknown;

/** The columns each table has, as far as the sitemap code is concerned. */
export const SCHEMA: Record<string, readonly string[]> = {
  workspace_domains: [
    "id",
    "workspace_id",
    "hostname",
    "verified",
    "verified_at",
    "status",
    "connection_type",
    "founders_disabled",
    "sitemap_check",
    "created_at",
    "updated_at",
    "last_error",
    "route_prefix",
  ],
  workspaces: [
    "id",
    "name",
    "marketplace_domain",
    "domain_verified_at",
    "subscription_status",
    "trial_ends_at",
    "current_period_end",
  ],
  workspace_members: ["id", "workspace_id", "user_id", "role"],
  page_templates: ["id", "slug", "name", "is_active", "config_schema"],
  tenant_pages: [
    "id",
    "workspace_id",
    "template_id",
    "slug",
    "title",
    "status",
    "noindex",
    "listing_filter",
    "body_markdown",
    "published_at",
    "created_at",
    "updated_at",
    "seo_title",
    "target_key",
    "content_version",
  ],
  content_pages: [
    "id",
    "workspace_id",
    "slug",
    "url_path",
    "status",
    "in_sitemap",
    "redirect_to",
    "body_markdown",
    "title",
    "created_at",
    "updated_at",
  ],
  tenant_listings: [
    "id",
    "workspace_id",
    "state_published",
    "country",
    "state",
    "city",
    "category",
    "country_key",
    "region_key",
    "city_key",
    "category_key",
    "price_amount",
    "price_currency",
    "price_unit",
    "synced_at",
  ],
};

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A scalar compared with a filter's text value, numerically when both are numbers. */
function compareValue(cell: unknown, value: string): number {
  if (typeof cell === "number" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return cell - Number(value);
  }
  return compare(String(cell), value);
}

function parseList(raw: string): Set<string> {
  if (!raw.startsWith("(") || !raw.endsWith(")")) throw new Error(`malformed list ${raw}`);
  const body = raw.slice(1, -1);
  const out = new Set<string>();
  let cur = "";
  let quoted = false;
  for (const ch of body) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.add(cur);
      cur = "";
    } else cur += ch;
  }
  if (body !== "") out.add(cur);
  return out;
}

function likeRegex(pattern: string, flags: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "%" || ch === "*") re += ".*";
    else if (ch === "_") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, flags);
}

type Pred = (row: Row) => boolean;

function predicate(col: string, raw: string): Pred {
  let expr = raw;
  let negate = false;
  if (expr.startsWith("not.")) {
    negate = true;
    expr = expr.slice(4);
  }
  const dot = expr.indexOf(".");
  if (dot < 0) throw new Error(`malformed filter ${col}=${raw}`);
  const op = expr.slice(0, dot);
  const val = expr.slice(dot + 1);
  let test: (cell: unknown) => boolean | null; // null: SQL NULL, never matches
  switch (op) {
    case "eq":
      test = (c) => (c == null ? null : String(c) === val);
      break;
    case "neq":
      test = (c) => (c == null ? null : String(c) !== val);
      break;
    case "gt":
      test = (c) => (c == null ? null : compareValue(c, val) > 0);
      break;
    case "gte":
      test = (c) => (c == null ? null : compareValue(c, val) >= 0);
      break;
    case "lt":
      test = (c) => (c == null ? null : compareValue(c, val) < 0);
      break;
    case "lte":
      test = (c) => (c == null ? null : compareValue(c, val) <= 0);
      break;
    case "is":
      if (val === "null") test = (c) => c == null;
      else if (val === "true") test = (c) => c === true;
      else if (val === "false") test = (c) => c === false;
      else throw new Error(`unsupported is.${val}`);
      break;
    case "in": {
      const set = parseList(val);
      test = (c) => (c == null ? null : set.has(String(c)));
      break;
    }
    case "ilike": {
      const re = likeRegex(val, "i");
      test = (c) => (c == null ? null : re.test(String(c)));
      break;
    }
    case "like": {
      const re = likeRegex(val, "");
      test = (c) => (c == null ? null : re.test(String(c)));
      break;
    }
    default:
      throw new Error(`fake PostgREST: unsupported operator ${op} (${col}=${raw})`);
  }
  return (row) => {
    const v = test(row[col]);
    if (v === null) return false;
    return negate ? !v : v;
  };
}

type OrderTerm = { col: string; desc: boolean; nullsFirst: boolean };

function parseOrder(raw: string | null): OrderTerm[] {
  if (!raw) return [];
  return raw.split(",").map((term) => {
    const [col, ...mods] = term.split(".");
    const desc = mods.includes("desc");
    const nullsFirst = mods.includes("nullsfirst") ? true : mods.includes("nullslast") ? false : desc;
    return { col: col!, desc, nullsFirst };
  });
}

function sortRows(rows: Row[], order: OrderTerm[]): Row[] {
  if (order.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const o of order) {
      const x = a[o.col];
      const y = b[o.col];
      const xn = x == null;
      const yn = y == null;
      if (xn || yn) {
        if (xn && yn) continue;
        return (xn ? -1 : 1) * (o.nullsFirst ? 1 : -1);
      }
      const c = compare(x, y);
      if (c !== 0) return o.desc ? -c : c;
    }
    return 0;
  });
}

export class FakePostgrest {
  readonly origin: string;
  maxRows = 1000;
  hits: Hit[] = [];
  rpcs: Record<string, RpcHandler> = {};
  /** Return a message to fail a request with a 500 (checked before anything else). */
  failWhen: ((hit: Hit) => string | null | undefined) | null = null;
  private data: Record<string, Row[]> = {};
  private generation = 0;
  private cache = new Map<string, { generation: number; rows: Row[] }>();

  constructor(origin: string) {
    this.origin = origin;
  }

  /** Route globalThis.fetch through this fake. Returns the undo. */
  install(): () => void {
    const previous = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      this.handle(input, init)) as typeof fetch;
    return () => {
      globalThis.fetch = previous;
    };
  }

  set(table: string, rows: Row[]): void {
    this.data[table] = rows;
    this.generation++;
  }

  rows(table: string): Row[] {
    return this.data[table] ?? [];
  }

  /** Change rows in place (tests); later reads see it. Returns how many changed. */
  update(table: string, match: (r: Row) => boolean, patch: Row | ((r: Row) => void)): number {
    let n = 0;
    for (const r of this.rows(table)) {
      if (!match(r)) continue;
      if (typeof patch === "function") patch(r);
      else Object.assign(r, patch);
      n++;
    }
    this.generation++;
    return n;
  }

  count(name: string, method?: string): number {
    return this.hits.filter((h) => h.name === name && (!method || h.method === method)).length;
  }

  clearHits(): void {
    this.hits.length = 0;
  }

  async handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== this.origin) {
      throw new TypeError(`fake PostgREST: unexpected request to ${url.origin} (offline)`);
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers);
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    const isRpc = path.startsWith("rpc/");
    const name = isRpc ? path.slice(4) : path;
    let body: unknown;
    if (init?.body != null) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = init.body;
      }
    }
    const hit: Hit = {
      method,
      kind: isRpc ? "rpc" : "table",
      name,
      params: new URLSearchParams(url.searchParams),
      body,
      prefer: headers.get("prefer") ?? "",
    };
    this.hits.push(hit);
    const failure = this.failWhen?.(hit);
    if (failure) return json(500, { code: "XX000", message: failure });

    let source: Row[];
    if (isRpc) {
      const handler = this.rpcs[name];
      if (!handler) return json(404, { code: "PGRST202", message: `Could not find the function public.${name}` });
      const out = handler((body ?? {}) as Record<string, unknown>, hit);
      if (!Array.isArray(out)) return json(200, out);
      source = out as Row[];
    } else {
      if (!(name in this.data)) return json(404, { code: "42P01", message: `relation "public.${name}" does not exist` });
      source = this.data[name]!;
    }

    const schema = isRpc ? null : SCHEMA[name];
    const known = (col: string) => !schema || schema.includes(col);
    const select = url.searchParams.get("select") ?? "*";
    if (select.includes("(")) return json(400, { code: "PGRST100", message: "embedding is not supported by the fake" });
    const columns = select === "*" ? null : select.split(",").filter(Boolean);
    const order = parseOrder(url.searchParams.get("order"));
    const filters: Array<[string, string]> = [...url.searchParams].filter(([k]) => !RESERVED.has(k));
    for (const col of [...(columns ?? []), ...order.map((o) => o.col), ...filters.map(([k]) => k)]) {
      if (!known(col)) return json(400, { code: "42703", message: `column ${name}.${col} does not exist` });
    }

    // Keyset reads (`id=gt.X` + `order=id.asc`) re-scan the same filtered,
    // ordered table on every page; that base is cached per data generation.
    const keyset =
      !isRpc && order.length === 1 && order[0]!.col === "id" && !order[0]!.desc
        ? filters.find(([k, v]) => k === "id" && v.startsWith("gt."))
        : undefined;
    const baseFilters = keyset ? filters.filter((f) => f !== keyset) : filters;
    let preds: Pred[];
    try {
      preds = baseFilters.map(([k, v]) => predicate(k, v));
    } catch (e) {
      return json(400, { code: "PGRST100", message: (e as Error).message });
    }

    if (method === "PATCH") {
      if (isRpc) return json(405, { message: "PATCH on an RPC" });
      const patch = (body ?? {}) as Row;
      for (const col of Object.keys(patch)) {
        if (!known(col)) return json(400, { code: "42703", message: `column ${name}.${col} does not exist` });
      }
      let n = 0;
      for (const r of source) {
        if (preds.every((p) => p(r))) {
          Object.assign(r, structuredClone(patch));
          n++;
        }
      }
      this.generation++;
      return new Response(null, { status: 204, headers: { "content-range": `*/${n}` } });
    }
    if (method !== "GET" && method !== "HEAD" && !(isRpc && method === "POST")) {
      return json(405, { message: `fake PostgREST: ${method} ${name} not supported` });
    }

    let matched: Row[];
    const cacheKey = `${method === "HEAD" ? "GET" : method} ${name} ${JSON.stringify(baseFilters)} ${url.searchParams.get("order") ?? ""}`;
    const cached = !isRpc ? this.cache.get(cacheKey) : undefined;
    if (cached && cached.generation === this.generation) matched = cached.rows;
    else {
      matched = sortRows(
        source.filter((r) => preds.every((p) => p(r))),
        order,
      );
      if (!isRpc) this.cache.set(cacheKey, { generation: this.generation, rows: matched });
    }
    if (keyset) {
      const after = keyset[1].slice(3);
      let lo = 0;
      let hi = matched.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (compare(matched[mid]!.id, after) <= 0) lo = mid + 1;
        else hi = mid;
      }
      matched = matched.slice(lo);
    }

    const total = matched.length;
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : Infinity;
    const page = matched.slice(offset, offset + Math.min(limit, this.maxRows)).map((r) => {
      if (!columns) return structuredClone(r);
      const out: Row = {};
      for (const c of columns) out[c] = r[c] === undefined ? null : structuredClone(r[c]);
      return out;
    });
    const out: Record<string, string> = { "content-type": "application/json" };
    if (/count=exact/.test(hit.prefer)) {
      out["content-range"] = page.length ? `${offset}-${offset + page.length - 1}/${total}` : `*/${total}`;
    }
    if (method === "HEAD") return new Response(null, { status: 200, headers: out });
    return new Response(JSON.stringify(page), { status: 200, headers: out });
  }
}

/**
 * inventory_coverage_groups(ws) over a tenant_listings fixture, as the SQL
 * function computes it (migration 20260929000100): published rows of the
 * workspace, grouped by the four keys.
 */
export function coverageGroupsOf(listings: readonly Row[], workspaceId: string): Row[] {
  const groups = new Map<string, Row>();
  for (const l of listings) {
    if (l.workspace_id !== workspaceId || l.state_published !== true) continue;
    const keyOf = (v: unknown) => (v == null ? null : String(v));
    const k = JSON.stringify([keyOf(l.country_key), keyOf(l.region_key), keyOf(l.city_key), keyOf(l.category_key)]);
    let g = groups.get(k);
    if (!g) {
      g = {
        country_key: keyOf(l.country_key),
        region_key: keyOf(l.region_key),
        city_key: keyOf(l.city_key),
        category_key: keyOf(l.category_key),
        country: l.country ?? null,
        region: l.state ?? null,
        city: l.city ?? null,
        category: l.category ?? null,
        listing_count: 0,
        priced_count: 0,
        currencies: [],
        price_units: [],
        unkeyed_count: 0,
      };
      groups.set(k, g);
    }
    g.listing_count = (g.listing_count as number) + 1;
    const cityText = typeof l.city === "string" && l.city.trim() !== "";
    const catText = typeof l.category === "string" && l.category.trim() !== "";
    if ((cityText && l.city_key == null) || (catText && l.category_key == null)) {
      g.unkeyed_count = (g.unkeyed_count as number) + 1;
    }
  }
  return [...groups.values()];
}

/** A tiny assertion harness in the style of the other suites. */
export function harness() {
  let pass = 0;
  let fail = 0;
  const failed: string[] = [];
  const t = (name: string, cond: boolean, extra = "") => {
    if (cond) {
      pass++;
      console.log(`  PASS  ${name}`);
    } else {
      fail++;
      failed.push(name);
      console.log(`  FAIL  ${name}  ${extra}`);
    }
  };
  const done = () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) {
      console.log("Failed:\n  " + failed.join("\n  "));
      process.exit(1);
    }
    process.exit(0);
  };
  return { t, done };
}
