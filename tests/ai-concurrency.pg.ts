/**
 * REAL CONCURRENCY ON POSTGRESQL 16. Run: AI_PG_URL=postgres://… bun run test:pg
 *
 * Not in the default chain: it needs a real PostgreSQL 16 superuser URL
 * (a throwaway local cluster — it creates and drops its own database). Without
 * AI_PG_URL it SKIPS loudly and exits 0.
 *
 * What it proves, on real connections racing for the same rows:
 *
 *   Through the REAL Worker helper (runMeteredAiCall, src/lib/ai/spend.server.ts)
 *   with a pg-backed stand-in for supabase-js .rpc(name, args) — every call in
 *   its own transaction on a pool of 60 connections, SET LOCAL ROLE
 *   service_role and request.jwt.claims set as PostgREST sets them — and a
 *   fake OpenAI server (Bun.serve on 127.0.0.1) that COUNTS requests:
 *     1. 50 simultaneous calls, allowance for exactly 10 (credits, then free
 *        quota) → exactly 10 holds, exactly 10 provider requests, 40 refused
 *        with zero provider requests; balance and quota never negative;
 *     2. 50 simultaneous calls sharing ONE request id → 1 provider request;
 *     3. 50 calls across 50 workspaces against a platform ceiling that fits
 *        exactly 10 holds → 10 provider requests;
 *     4. the kill switch off → 0 provider requests.
 *   At the SQL level, 20 simultaneous connections (the brief):
 *     (a) an allowance that fits exactly N < 20 → exactly N holds;
 *     (b) the same request id → exactly one hold;
 *     (c) the global ceiling is never exceeded;
 *     (d) the per-minute rate limit holds;
 *     (e) concurrent settle / release of one request → a single refund;
 *   plus the daily briefing's claim (50 racing runs → one claim) and the
 *   reaper racing itself and live traffic (no deadlock, one reaper).
 */
import { Pool, type PoolClient } from "pg";
import { MIGRATION_600, MIGRATION_800, SUPABASE_STUBS, readRepo, rpcSql } from "./_support/ai-db";
import { responseBody } from "./_support/fake-backend";

const URL_ = process.env.AI_PG_URL ?? process.env.TEST_PG_URL ?? "";
if (!URL_) {
  console.log("\n" + "!".repeat(78));
  console.log("!!  SKIPPED: tests/ai-concurrency.pg.ts needs a real PostgreSQL 16.");
  console.log("!!  Set AI_PG_URL=postgres://postgres@127.0.0.1:<port>/postgres (a throwaway");
  console.log("!!  cluster: the script creates and drops its own database) and re-run");
  console.log("!!  `bun run test:pg`. NOTHING WAS PROVEN.");
  console.log("!".repeat(78) + "\n");
  process.exit(0);
}

let pass = 0,
  fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra ? `  (${extra})` : ""}`);
  } else {
    fail++;
    failed.push(name);
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}

// ---- a fresh database on the given server ---------------------------------------
const admin = new Pool({ connectionString: URL_, max: 2 });
const dbName = `ai_concurrency_${Date.now()}`;
await admin.query(`CREATE DATABASE ${dbName}`);
const target = new URL(URL_);
target.pathname = `/${dbName}`;
const pool = new Pool({ connectionString: target.toString(), max: 60 });
const version = (await pool.query<{ v: string }>("SELECT version() AS v")).rows[0]!.v;
console.log(`\nServer: ${version}`);
console.log(`Database: ${dbName} (created for this run, dropped at the end)`);
await pool.query(SUPABASE_STUBS);
await pool.query(readRepo(MIGRATION_600));
await pool.query(readRepo(MIGRATION_800));
console.log("Applied: Supabase stubs → 000600 → 000800");

const { runMeteredAiCall } = await import("../src/lib/ai/spend.server");
const { CustomerFacingError } = await import("../src/lib/ai/customer-error");

// ---- PostgREST-shaped rpc over a real pool ---------------------------------------
type RpcResult = { data: any; error: { message: string; code?: string } | null };
let maxInUse = 0;
async function inTx<T>(fn: (c: PoolClient) => Promise<T>, claims: Record<string, unknown> = { role: "service_role" }): Promise<T> {
  const c = await pool.connect();
  maxInUse = Math.max(maxInUse, pool.totalCount - pool.idleCount);
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL ROLE ${claims.role === "service_role" ? "service_role" : "authenticated"}`);
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
/** supabase-js .rpc(name, args) as PostgREST runs it: one transaction per call. */
const serviceDb = {
  rpc: async (name: string, args: Record<string, unknown>): Promise<RpcResult> => {
    try {
      const q = rpcSql(name, args);
      const rows = await inTx((c) => c.query(q.text, q.values as unknown[]));
      return { data: rows.rows[0]?.result ?? null, error: null };
    } catch (e) {
      const err = e as { message?: string; code?: string };
      return { data: null, error: { message: String(err.message ?? e), code: err.code } };
    }
  },
};
const rpc = async (name: string, args: Record<string, unknown>) => {
  const r = await serviceDb.rpc(name, args);
  if (r.error) throw new Error(`${name}: ${r.error.message}`);
  return r.data;
};
const q1 = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0] as T;

// ---- a fake OpenAI that counts ---------------------------------------------------
let providerRequests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/v1/responses") return new Response("not found", { status: 404 });
    providerRequests++;
    await Bun.sleep(100); // every accepted call is still in flight while the others arrive
    return Response.json(responseBody("A short, useful answer."), { headers: { "x-request-id": "req_pg" } });
  },
});
const transport = { baseURL: `http://127.0.0.1:${server.port}/v1` };
console.log(`Fake OpenAI: ${transport.baseURL}/responses (counts requests)`);

// ---- fixtures ------------------------------------------------------------------------
let wsSeq = 0;
const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function newWorkspace(o: { quota?: number; balance?: number } = {}) {
  const n = ++wsSeq;
  const ws = uuid("11111111", n);
  const user = uuid("aaaaaaaa", n);
  await pool.query(
    `INSERT INTO public.workspaces (id, name) VALUES ($1, $2);
     `.trim(),
    [ws, `ws ${n}`],
  );
  await pool.query("INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [ws, user]);
  await pool.query("INSERT INTO public.workspace_ai_quota (workspace_id, platform_credits_remaining) VALUES ($1, $2)", [ws, o.quota ?? 0]);
  await pool.query("INSERT INTO public.credit_balances (workspace_id, balance) VALUES ($1, $2)", [ws, o.balance ?? 0]);
  return { ws, user };
}
async function settings(o: { enabled?: boolean; budget?: number; rate?: number }) {
  await pool.query(
    `UPDATE public.ai_platform_settings SET
       platform_ai_enabled = COALESCE($1, platform_ai_enabled),
       daily_budget_micros = COALESCE($2, daily_budget_micros),
       workspace_reservations_per_minute = COALESCE($3, workspace_reservations_per_minute)`,
    [o.enabled ?? null, o.budget ?? null, o.rate ?? null],
  );
}
/** What today's ceiling has already recorded (rows are never deleted: the ledger stays consistent). */
const spentToday = async () =>
  Number(
    (await q1<{ s: string }>("SELECT COALESCE((SELECT spent_micros FROM public.ai_budget_days WHERE day = (now() AT TIME ZONE 'UTC')::date), 0)::text AS s")).s,
  );
const balance = async (ws: string) => (await q1<{ b: number }>("SELECT balance AS b FROM public.credit_balances WHERE workspace_id = $1", [ws])).b;
const quota = async (ws: string) => (await q1<{ q: number }>("SELECT platform_credits_remaining AS q FROM public.workspace_ai_quota WHERE workspace_id = $1", [ws])).q;

// A watchdog that samples the lowest balance and quota while a scenario runs.
function watch(ws: string[]) {
  let running = true;
  let minBalance = Infinity;
  let minQuota = Infinity;
  const loop = (async () => {
    while (running) {
      const r = await pool.query<{ b: number; q: number }>(
        `SELECT (SELECT min(balance) FROM public.credit_balances WHERE workspace_id = ANY($1::uuid[])) AS b,
                (SELECT min(platform_credits_remaining) FROM public.workspace_ai_quota WHERE workspace_id = ANY($1::uuid[])) AS q`,
        [ws],
      );
      minBalance = Math.min(minBalance, r.rows[0]!.b);
      minQuota = Math.min(minQuota, r.rows[0]!.q);
      await Bun.sleep(5);
    }
  })();
  return async () => {
    running = false;
    await loop;
    return { minBalance, minQuota };
  };
}

const INSTRUCTIONS = "You are the SEO coach. Answer in two sentences.";
function meteredCall(ws: string, user: string, requestId = crypto.randomUUID()) {
  return runMeteredAiCall({
    workspaceId: ws,
    userId: user,
    requestId,
    route: "seo_coach",
    source: "seo_coach",
    key: { apiKey: "sk-fake-platform-key-for-pg-test", source: "platform" },
    billingClass: "tenant",
    instructions: INSTRUCTIONS,
    input: "Where do I start?",
    deps: { db: serviceDb, transport },
  });
}
async function burst(n: number, make: (i: number) => Promise<unknown>) {
  const started = performance.now();
  const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => make(i)));
  const ms = Math.round(performance.now() - started);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const codes = new Map<string, number>();
  for (const r of results) {
    if (r.status === "rejected") {
      const code = r.reason instanceof CustomerFacingError ? (r.reason.code ?? "customer") : `error:${String(r.reason?.message ?? r.reason).slice(0, 60)}`;
      codes.set(code, (codes.get(code) ?? 0) + 1);
    }
  }
  return { ok, refused: n - ok, codes: Object.fromEntries(codes), ms };
}

const origError = console.error;
const origWarn = console.warn;
console.error = () => {};
console.warn = () => {};
const log = (...a: unknown[]) => console.log(...a);

try {
  await settings({ enabled: true, budget: 1_000_000_000, rate: 1000 });

  // =========================================================================
  log("\n=== 1. 50 simultaneous calls through runMeteredAiCall, allowance for exactly 10 ===");
  for (const variant of ["credits", "free_quota"] as const) {
    const { ws, user } = await newWorkspace(variant === "credits" ? { quota: 0, balance: 10 } : { quota: 10, balance: 0 });
    const before = providerRequests;
    const stop = watch([ws]);
    const r = await burst(50, () => meteredCall(ws, user));
    const mins = await stop();
    const holds = await q1<{ n: number }>("SELECT count(*)::int AS n FROM public.ai_spend_reservations WHERE workspace_id = $1", [ws]);
    log(`  [${variant}] ${r.ok} succeeded, ${r.refused} refused ${JSON.stringify(r.codes)} in ${r.ms} ms; provider requests ${providerRequests - before}; holds ${holds.n}; min balance ${mins.minBalance}, min quota ${mins.minQuota}; final balance ${await balance(ws)}, quota ${await quota(ws)}`);
    t(`[${variant}] exactly 10 reservations succeed`, holds.n === 10 && r.ok === 10, `${holds.n} holds, ${r.ok} ok`);
    t(`[${variant}] exactly 10 provider requests`, providerRequests - before === 10, String(providerRequests - before));
    t(`[${variant}] the other 40 are refused as insufficient, with zero provider requests`, r.codes["insufficient"] === 40);
    t(`[${variant}] balance and quota never went negative`, mins.minBalance >= 0 && mins.minQuota >= 0 && (await balance(ws)) >= 0 && (await quota(ws)) >= 0);
    const settled = await q1<{ n: number }>("SELECT count(*)::int AS n FROM public.ai_spend_reservations WHERE workspace_id = $1 AND status = 'settled'", [ws]);
    t(`[${variant}] all 10 calls are settled`, settled.n === 10);
  }

  // =========================================================================
  log("\n=== 2. 50 simultaneous calls sharing ONE request id ===");
  {
    const { ws, user } = await newWorkspace({ quota: 0, balance: 1000 });
    const rid = crypto.randomUUID();
    const before = providerRequests;
    const r = await burst(50, () => meteredCall(ws, user, rid));
    const ledger = await q1<{ n: number }>("SELECT count(*)::int AS n FROM public.credit_ledger WHERE workspace_id = $1 AND reason = 'ai_hold'", [ws]);
    log(`  ${r.ok} succeeded, ${r.refused} refused ${JSON.stringify(r.codes)} in ${r.ms} ms; provider requests ${providerRequests - before}; hold ledger rows ${ledger.n}`);
    t("exactly 1 provider request", providerRequests - before === 1, String(providerRequests - before));
    t("exactly 1 succeeds; 49 are told it is running or done", r.ok === 1 && (r.codes["in_progress"] ?? 0) + (r.codes["done"] ?? 0) === 49);
    t("exactly one hold was taken", ledger.n === 1);
  }

  // =========================================================================
  log("\n=== 3. 50 calls across 50 workspaces vs a platform ceiling that fits exactly 10 ===");
  {
    const people = await Promise.all(Array.from({ length: 50 }, () => newWorkspace({ quota: 0, balance: 100 })));
    // Every call holds the same maximum (same route, same prompt): measure it once.
    const probeWs = await newWorkspace({ quota: 0, balance: 100 });
    const probeId = crypto.randomUUID();
    await meteredCall(probeWs.ws, probeWs.user, probeId);
    const hold = (await q1<{ m: string }>("SELECT max_cost_micros::text AS m FROM public.ai_spend_reservations WHERE request_id = $1", [probeId])).m;
    const base = await spentToday();
    await settings({ budget: base + Number(hold) * 10 });
    const before = providerRequests;
    const r = await burst(50, (i) => meteredCall(people[i]!.ws, people[i]!.user));
    const spent = await q1<{ s: string; b: string }>(
      "SELECT (SELECT spent_micros FROM public.ai_budget_days WHERE day = (now() AT TIME ZONE 'UTC')::date)::text AS s, (SELECT daily_budget_micros FROM public.ai_platform_settings)::text AS b",
    );
    log(`  hold ${hold} micros, ceiling ${spent.b} (already spent today ${base}); ${r.ok} succeeded, ${r.refused} refused ${JSON.stringify(r.codes)} in ${r.ms} ms; provider requests ${providerRequests - before}; spent ${spent.s}`);
    t("exactly 10 provider requests", providerRequests - before === 10, String(providerRequests - before));
    t("the other 40 are refused budget_exhausted", r.ok === 10 && r.codes["budget_exhausted"] === 40);
    t("the ceiling was never exceeded", Number(spent.s) <= Number(spent.b), `${spent.s} ≤ ${spent.b}`);
    await settings({ budget: 1_000_000_000 });
  }

  // =========================================================================
  log("\n=== 4. the kill switch off → no provider request at all ===");
  {
    await settings({ enabled: false });
    const people = await Promise.all(Array.from({ length: 50 }, () => newWorkspace({ quota: 10, balance: 100 })));
    const before = providerRequests;
    const r = await burst(50, (i) => meteredCall(people[i]!.ws, people[i]!.user));
    log(`  ${r.ok} succeeded, ${r.refused} refused ${JSON.stringify(r.codes)} in ${r.ms} ms; provider requests ${providerRequests - before}`);
    t("0 provider requests", providerRequests - before === 0);
    t("all 50 refused platform_paused, nothing held", r.codes["platform_paused"] === 50 && (await q1<{ n: number }>("SELECT count(*)::int AS n FROM public.ai_spend_reservations WHERE workspace_id = ANY($1::uuid[])", [people.map((p) => p.ws)])).n === 0);
    await settings({ enabled: true });
  }

  // =========================================================================
  log("\n=== brief (a)–(e): 20 simultaneous connections at the SQL level ===");
  const reserveArgs = (ws: string, user: string, o: Record<string, unknown> = {}) => ({
    _workspace_id: ws,
    _request_id: crypto.randomUUID(),
    _user_id: user,
    _feature: "seo_coach",
    _source: "seo_coach",
    _model: "gpt-5-nano",
    _max_input_tokens: 1000,
    _max_output_tokens: 1200,
    _max_cost_micros: 3000,
    _max_credits: 3,
    _billing_class: "tenant",
    ...o,
  });
  const statusCount = (rows: any[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.status, (m.get(r.status) ?? 0) + 1);
    return Object.fromEntries(m);
  };
  {
    // (a) credits for exactly 7 holds of 3 (21 credits; an 8th needs 24).
    const { ws, user } = await newWorkspace({ quota: 0, balance: 21 });
    const stop = watch([ws]);
    const rows = await Promise.all(Array.from({ length: 20 }, () => rpc("ai_reserve", reserveArgs(ws, user))));
    const mins = await stop();
    log(`  (a) ${JSON.stringify(statusCount(rows))}; min balance ${mins.minBalance}; final ${await balance(ws)}`);
    t("(a) an allowance for exactly 7 → exactly 7 holds, 13 insufficient", statusCount(rows).reserved === 7 && statusCount(rows).insufficient === 13);
    t("(a) the balance never went negative (0 at the end)", mins.minBalance >= 0 && (await balance(ws)) === 0);
  }
  {
    // (b) one request id, 20 connections.
    const { ws, user } = await newWorkspace({ quota: 0, balance: 100 });
    const args = reserveArgs(ws, user);
    const rows = await Promise.all(Array.from({ length: 20 }, () => rpc("ai_reserve", args)));
    const holds = await q1<{ n: number }>("SELECT count(*)::int AS n FROM public.credit_ledger WHERE workspace_id = $1 AND reason = 'ai_hold'", [ws]);
    log(`  (b) ${JSON.stringify(statusCount(rows))}; hold ledger rows ${holds.n}; balance ${await balance(ws)}`);
    t("(b) the same request id → exactly one hold", statusCount(rows).reserved === 1 && statusCount(rows).in_progress === 19 && holds.n === 1 && (await balance(ws)) === 97);
  }
  {
    // (c) 20 workspaces, a ceiling for exactly 5 more holds of 3000.
    const base = await spentToday();
    await settings({ budget: base + 15_000 });
    const people = await Promise.all(Array.from({ length: 20 }, () => newWorkspace({ quota: 0, balance: 100 })));
    const rows = await Promise.all(people.map((p) => rpc("ai_reserve", reserveArgs(p.ws, p.user))));
    const spent = await q1<{ s: string }>("SELECT spent_micros::text AS s FROM public.ai_budget_days WHERE day = (now() AT TIME ZONE 'UTC')::date");
    const refunded = await q1<{ n: number }>("SELECT count(*)::int AS n FROM public.credit_balances WHERE workspace_id = ANY($1::uuid[]) AND balance = 100", [people.map((p) => p.ws)]);
    log(`  (c) ${JSON.stringify(statusCount(rows))}; spent ${Number(spent.s) - base} of the 15000 left; workspaces untouched ${refunded.n}`);
    t("(c) the global ceiling is never exceeded: exactly 5 holds, 15 budget_exhausted", statusCount(rows).reserved === 5 && statusCount(rows).budget_exhausted === 15 && Number(spent.s) === base + 15_000);
    t("(c) a refused workspace kept its credits (the tenant charge was undone)", refunded.n === 15);
    await settings({ budget: 1_000_000_000 });
  }
  {
    // (d) the per-minute rate limit: 5 per minute, 20 at once.
    await settings({ rate: 5 });
    const { ws, user } = await newWorkspace({ quota: 0, balance: 1000 });
    const rows = await Promise.all(Array.from({ length: 20 }, () => rpc("ai_reserve", reserveArgs(ws, user))));
    log(`  (d) ${JSON.stringify(statusCount(rows))}`);
    t("(d) the per-minute rate limit holds: exactly 5 reserved, 15 rate_limited", statusCount(rows).reserved === 5 && statusCount(rows).rate_limited === 15);
    await settings({ rate: 1000 });
  }
  {
    // (e1) 20 concurrent releases of one held request.
    const { ws, user } = await newWorkspace({ quota: 0, balance: 50 });
    const args = reserveArgs(ws, user);
    await rpc("ai_reserve", args);
    const ids = { _workspace_id: ws, _request_id: args._request_id };
    const rel = await Promise.all(Array.from({ length: 20 }, () => rpc("ai_release", ids)));
    const refunds = await q1<{ n: number }>("SELECT count(*)::int AS n FROM public.credit_ledger WHERE workspace_id = $1 AND reason = 'ai_refund'", [ws]);
    log(`  (e1) releases true: ${rel.filter((x) => x === true).length}; refund rows ${refunds.n}; balance ${await balance(ws)}`);
    t("(e) 20 concurrent releases → one release, a single refund", rel.filter((x) => x === true).length === 1 && refunds.n === 1 && (await balance(ws)) === 50);
    // (e2) a called request: 10 settles and 10 releases at once.
    const args2 = reserveArgs(ws, user);
    await rpc("ai_reserve", args2);
    const ids2 = { _workspace_id: ws, _request_id: args2._request_id };
    await rpc("ai_mark_called", ids2);
    const settle = {
      ...ids2,
      _input_tokens: 500,
      _cached_input_tokens: 0,
      _output_tokens: 300,
      _reasoning_tokens: 0,
      _cost_micros: null,
      _credits: null,
      _outcome: "failed",
      _error: "timeout",
    };
    const mixed = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? rpc("ai_release", ids2) : rpc("ai_settle", settle))));
    const settles = mixed.filter((x) => x && typeof x === "object").map((x: any) => x.status);
    const releases = mixed.filter((x) => typeof x === "boolean");
    const refunds2 = await q1<{ n: number }>("SELECT count(*)::int AS n FROM public.credit_ledger WHERE workspace_id = $1 AND reason = 'ai_refund' AND ref_id = $2", [ws, `${args2._request_id}#1`]);
    log(`  (e2) settles ${JSON.stringify(settles.reduce((m: any, s: string) => ((m[s] = (m[s] ?? 0) + 1), m), {}))}; releases true ${releases.filter(Boolean).length}; refund rows ${refunds2.n}; balance ${await balance(ws)}`);
    t(
      "(e) 10 settles + 10 releases of one called request → one settlement, no release, a single refund",
      settles.filter((s) => s === "settled").length === 1 && settles.filter((s) => s === "already_settled").length === 9 && releases.every((x) => x === false) && refunds2.n === 1 && (await balance(ws)) === 50,
    );
  }

  // =========================================================================
  log("\n=== the daily briefing's claim, 50 racing runs ===");
  {
    const { ws } = await newWorkspace();
    const day = new Date().toISOString().slice(0, 10);
    const rows = await Promise.all(
      Array.from({ length: 50 }, () => rpc("coach_briefing_claim", { _workspace_id: ws, _briefing_date: day, _claim_token: crypto.randomUUID() })),
    );
    log(`  ${JSON.stringify(statusCount(rows))}`);
    t("exactly one run claims the day; 49 are told it is in progress", statusCount(rows).claimed === 1 && statusCount(rows).in_progress === 49);
  }

  // =========================================================================
  log("\n=== the reaper against itself and live traffic ===");
  {
    const people = await Promise.all(Array.from({ length: 10 }, () => newWorkspace({ quota: 0, balance: 30 })));
    // A dead held reservation and a dead called one in every workspace.
    for (const p of people) {
      const h = reserveArgs(p.ws, p.user);
      await rpc("ai_reserve", h);
      const c = reserveArgs(p.ws, p.user);
      await rpc("ai_reserve", c);
      await rpc("ai_mark_called", { _workspace_id: p.ws, _request_id: c._request_id });
    }
    await pool.query(
      `UPDATE public.ai_spend_reservations SET reserved_at = now() - interval '11 minutes', provider_called_at = CASE WHEN status = 'called' THEN now() - interval '31 minutes' END WHERE workspace_id = ANY($1::uuid[])`,
      [people.map((p) => p.ws)],
    );
    const racing = await Promise.allSettled([
      ...Array.from({ length: 10 }, () => rpc("ai_reap_stale_reservations", {})),
      ...people.map((p) => rpc("ai_reserve", reserveArgs(p.ws, p.user))),
    ]);
    const reaps = racing.slice(0, 10).map((r) => (r.status === "fulfilled" ? r.value : null));
    const worked = reaps.filter((r: any) => r && r.skipped === false);
    const errors = racing.filter((r) => r.status === "rejected").map((r: any) => String(r.reason?.message ?? r.reason));
    const open = await q1<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.ai_spend_reservations WHERE workspace_id = ANY($1::uuid[]) AND status IN ('held','called') AND reserved_at < now() - interval '5 minutes'",
      [people.map((p) => p.ws)],
    );
    const balances = await pool.query<{ b: number }>("SELECT balance AS b FROM public.credit_balances WHERE workspace_id = ANY($1::uuid[])", [people.map((p) => p.ws)]);
    log(`  reaper runs that worked ${worked.length}, skipped ${reaps.filter((r: any) => r && r.skipped).length}; errors ${errors.length}; stale rows left ${open.n}; balances ${balances.rows.map((r) => r.b).join(",")}`);
    t("no deadlock or error while 10 reapers race live reservations", errors.length === 0, errors.join(" | "));
    t("no stale hold survives", open.n === 0);
    t(
      "every dead hold came back to its customer (30 − 3 for the one live hold)",
      balances.rows.every((r) => r.b === 27),
      balances.rows.map((r) => r.b).join(","),
    );
    const consistent = await q1<{ a: string; b: string }>(
      "SELECT COALESCE((SELECT sum(spent_micros) FROM public.ai_budget_days), 0)::text AS a, COALESCE((SELECT sum(budget_micros) FROM public.ai_spend_reservations), 0)::text AS b",
    );
    t("the ceiling ledger still equals the sum of the rows' holds", consistent.a === consistent.b, `${consistent.a} = ${consistent.b}`);
  }

  log(`\nPeak pool connections in use: ${maxInUse} (pool max 60); provider requests in total: ${providerRequests}`);
} finally {
  console.error = origError;
  console.warn = origWarn;
  server.stop(true);
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
  await admin.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
