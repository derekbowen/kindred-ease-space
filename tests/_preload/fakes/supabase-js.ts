/**
 * Recording fake of the supabase-js service-role client used by edge
 * functions. Every table call is captured as {table, op, payload, filters};
 * responses come from globalThis.__sbResponses, a queue keyed by
 * "<table>.<op>" (each entry consumed once; default {data:null,error:null}).
 */
type Resp = { data?: unknown; error?: { code?: string; message: string } | null; count?: number | null };
type Call = { table: string; op: string; payload?: unknown; filters: Array<[string, string, unknown]> };
const g = globalThis as unknown as {
  __sbCalls: Call[];
  __sbResponses: Record<string, Resp[]>;
  __sbRpc: Record<string, (args: unknown) => Resp>;
};
g.__sbCalls ??= [];
g.__sbResponses ??= {};
g.__sbRpc ??= {};

function next(key: string): Resp {
  const q = g.__sbResponses[key];
  if (q && q.length) return q.shift()!;
  return { data: null, error: null };
}

class Query implements PromiseLike<Resp> {
  private call: Call;
  private key: string;
  constructor(table: string, op: string, payload?: unknown) {
    this.call = { table, op, payload, filters: [] };
    this.key = `${table}.${op}`;
    g.__sbCalls.push(this.call);
  }
  select(cols?: string) {
    if (this.call.op === "from") {
      this.call.op = "select";
      this.key = `${this.call.table}.select`;
    }
    this.call.filters.push(["select", "cols", cols]);
    return this;
  }
  insert(payload: unknown) { this.call.op = "insert"; this.call.payload = payload; this.key = `${this.call.table}.insert`; return this; }
  update(payload: unknown) { this.call.op = "update"; this.call.payload = payload; this.key = `${this.call.table}.update`; return this; }
  upsert(payload: unknown) { this.call.op = "upsert"; this.call.payload = payload; this.key = `${this.call.table}.upsert`; return this; }
  eq(col: string, val: unknown) { this.call.filters.push(["eq", col, val]); return this; }
  limit(n: number) { this.call.filters.push(["limit", "n", n]); return this; }
  maybeSingle() { return this; }
  single() { return this; }
  then<T1 = Resp, T2 = never>(res?: (v: Resp) => T1 | PromiseLike<T1>, rej?: (e: unknown) => T2 | PromiseLike<T2>) {
    return Promise.resolve(next(this.key)).then(res, rej);
  }
}

export function createClient() {
  return {
    from: (table: string) => new Query(table, "from"),
    rpc: async (name: string, args: unknown) => {
      g.__sbCalls.push({ table: `rpc:${name}`, op: "rpc", payload: args, filters: [] });
      const fn = g.__sbRpc[name];
      return fn ? fn(args) : { data: null, error: null };
    },
  };
}
