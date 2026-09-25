/**
 * A fake PostgREST (http://supabase.test) and a fake OpenAI Responses API
 * (https://api.openai.com), both behind globalThis.fetch, for driving the
 * real server code offline: the real supabase-js service-role client and the
 * real openai SDK build every request, so a test asserts exactly what would
 * reach the database and the provider. Any other host is an error — nothing
 * here can reach the network.
 *
 * The spend RPCs (ai_reserve / ai_mark_called / ai_settle / ai_release) get
 * canned answers a test can override; the SQL behind them is exercised by
 * tests/ai-spend-sql.test.ts (PGlite) and tests/ai-concurrency.pg.ts
 * (PostgreSQL 16).
 */

export type Hit = {
  kind: "rest" | "rpc" | "openai";
  method: string;
  /** table, rpc name, or the OpenAI path */
  name: string;
  query: URLSearchParams;
  body: any;
  headers: Headers;
};
export type RestAnswer = unknown[] | { status: number; body: unknown } | undefined;
export type RestHandler = (h: Hit) => RestAnswer;

export const SUPABASE_URL = "http://supabase.test";

export const USAGE = { input: 812, output: 1204 };

/** A Responses API body: one assistant message with `text` (or a refusal). */
export function responseBody(
  text: string,
  opts: { usage?: { input: number; output: number } | null; refusal?: string; status?: string } = {},
): Record<string, unknown> {
  const usage = opts.usage === undefined ? USAGE : opts.usage;
  return {
    id: "resp_fake",
    object: "response",
    created_at: 1,
    status: opts.status ?? "completed",
    model: "gpt-5-nano-2025-08-07",
    output: [
      {
        type: "message",
        id: "msg_fake",
        status: "completed",
        role: "assistant",
        content: opts.refusal
          ? [{ type: "refusal", refusal: opts.refusal }]
          : [{ type: "output_text", text, annotations: [] }],
      },
    ],
    ...(usage
      ? {
          usage: {
            input_tokens: usage.input,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: usage.output,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: usage.input + usage.output,
          },
        }
      : {}),
  };
}

export const okText = (text: string, usage?: { input: number; output: number } | null) =>
  Response.json(responseBody(text, { usage }), { headers: { "x-request-id": "req_fake" } });
export const okJson = (value: unknown, usage?: { input: number; output: number } | null) =>
  okText(JSON.stringify(value), usage);

const json = (status: number, body: unknown) =>
  body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class FakeBackend {
  hits: Hit[] = [];
  rest: Record<string, RestHandler> = {};
  rpc: Record<string, (args: any) => unknown> = {};
  openai: (h: Hit) => Response | Promise<Response> = () => okText("ok");

  constructor() {
    this.reset();
  }

  /** Defaults: a member (owner) with its own key; every spend RPC succeeds. */
  reset() {
    this.hits = [];
    this.rpc = {
      tenant_get_workspace_secret: () => "sk-byok-flow",
      ai_reserve: () => ({ status: "reserved", billing: "byok", hold_seq: 1, credits_charged: 0 }),
      ai_mark_called: () => true,
      ai_release: () => true,
      ai_settle: (a: any) => ({
        status: "settled",
        billing: "byok",
        credits_charged: 0,
        cost_micros: a._cost_micros,
        full_hold: a._cost_micros === null,
      }),
      reserve_generation_slot: () => "reserved",
      mark_generation_provider_called: () => true,
      release_generation_slot: () => true,
    };
    this.rest = {
      "GET workspace_members": () => [{ role: "owner" }],
      "GET page_templates": () => [{ id: "tpl-1" }],
      "POST tenant_pages": (h) => [{ id: "page-new", slug: h.body.slug, title: h.body.title }],
    };
    this.openai = () => okText("ok");
  }

  install() {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
      if (url.hostname === "api.openai.com") {
        const hit: Hit = { kind: "openai", method, name: url.pathname, query: url.searchParams, body, headers };
        this.hits.push(hit);
        return this.openai(hit);
      }
      if (url.origin !== SUPABASE_URL) throw new TypeError(`unexpected host ${url.host}`);
      const path = url.pathname.replace(/^\/rest\/v1\//, "");
      if (path.startsWith("rpc/")) {
        const name = path.slice(4);
        this.hits.push({ kind: "rpc", method, name, query: url.searchParams, body, headers });
        const fn = this.rpc[name];
        if (!fn) return json(404, { code: "PGRST202", message: `unexpected rpc ${name}` });
        const out = fn(body);
        if (out && typeof out === "object" && "status" in (out as object) && "body" in (out as object)) {
          const o = out as { status: number; body: unknown };
          return json(o.status, o.body);
        }
        return json(200, out);
      }
      const hit: Hit = { kind: "rest", method, name: path, query: url.searchParams, body, headers };
      this.hits.push(hit);
      const handler = this.rest[`${method} ${path}`];
      let rows: RestAnswer = handler ? handler(hit) : undefined;
      if (rows === undefined) {
        if (method === "GET" || method === "HEAD") rows = [];
        else if (method === "POST") rows = Array.isArray(body) ? body : [{ id: `${path}-row`, ...body }];
        else if (method === "PATCH") rows = [{ id: `${path}-row` }];
        else rows = [];
      }
      if (rows && !Array.isArray(rows) && typeof rows === "object" && "status" in rows) {
        return json(rows.status, rows.body);
      }
      const list = rows as unknown[];
      const wantsRows = (headers.get("prefer") ?? "").includes("return=representation") || method === "GET";
      if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": `0-0/${list.length}` } });
      if (!wantsRows) return json(method === "POST" ? 201 : 204, undefined);
      const single = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
      if (single) return list.length ? json(200, list[0]) : json(406, { code: "PGRST116", message: "no rows" });
      return json(200, list);
    }) as typeof fetch;
  }

  rpcHits(name: string) {
    return this.hits.filter((h) => h.kind === "rpc" && h.name === name);
  }
  restHits(method: string, table: string) {
    return this.hits.filter((h) => h.kind === "rest" && h.method === method && h.name === table);
  }
  providerHits() {
    return this.hits.filter((h) => h.kind === "openai");
  }
  indexOf(pred: (h: Hit) => boolean) {
    return this.hits.findIndex(pred);
  }
  rpcAt(name: string) {
    return this.indexOf((h) => h.kind === "rpc" && h.name === name);
  }
  /** No hold, no mark, no provider request, no settlement. */
  noSpend() {
    return (
      this.rpcHits("ai_reserve").length === 0 &&
      this.rpcHits("ai_mark_called").length === 0 &&
      this.providerHits().length === 0 &&
      this.rpcHits("ai_settle").length === 0
    );
  }
  /** The spend RPC sequence, with the provider request in place. */
  spendOrder() {
    return this.hits
      .filter((h) => h.kind === "openai" || (h.kind === "rpc" && h.name.startsWith("ai_")))
      .map((h) => (h.kind === "openai" ? "provider" : h.name))
      .join(" → ");
  }
}
