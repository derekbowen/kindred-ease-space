/**
 * THE 000800 SQL, EXECUTED. Run: bun tests/ai-spend-sql.test.ts
 *
 * Loads the chain the spend SQL runs on — 20260918000000 (entitlement grants,
 * production), 20260924000600, 20260924000700 (the internal-unlimited
 * predicate) and 20260925000800 — into PGlite (Postgres compiled to WASM,
 * in-process) on top of the Supabase stand-ins in tests/_support/ai-db.ts,
 * which carry production's indexes (credit_ledger_grant_ref_unique, global
 * across workspaces, among them), then drives the functions the app calls,
 * as the app calls them (the service role, PostgREST-style JWT claims):
 *
 *   - every state transition: held → called → settled, held → released,
 *     released → held again (next hold sequence), and every refusal;
 *   - idempotency by request id (in_progress / done / conflict);
 *   - grants: anon and authenticated can neither execute nor read anything;
 *   - the money: free-quota units, credits (hold, refund, cap at the hold),
 *     the daily ceiling (conditional increment, undo of the tenant charge);
 *     after every step the ceiling equals the sum of the rows' holds;
 *   - the kill switch (reserve AND mark) and the page-generation pause;
 *   - the per-workspace rate limit;
 *   - lazy expiry inside ai_reserve and the traffic-independent reaper, with
 *     a simulated worker death after reserve and after mark-called;
 *   - the double-refund guard (ledger unique index);
 *   - the daily-briefing claim and the on-demand refresh throttle;
 *   - round-4 H1: one request id in two workspaces (tenant-scoped ledger
 *     keys under the global index), and one row that cannot be closed never
 *     stops the lazy expiry, the reaper or the rollback;
 *   - round-4 H2: the per-workspace daily platform-cost cap (failed and
 *     refunded calls count), and who is exempt;
 *   - the founder / internal unlimited entitlement: billing 'internal' on
 *     every route, decided in SQL, revocable;
 *   - the migration's verification block, a re-run, the rollback with open
 *     holds (and with one that cannot be closed), and a re-apply.
 *
 * PGlite is one connection: this suite proves the logic. Concurrency (many
 * connections racing for the same rows) is proven on a real Postgres 16 by
 * tests/ai-concurrency.pg.ts (bun run test:pg).
 */
import { PGlite } from "@electric-sql/pglite";
import {
  AI_CHAIN,
  MIGRATION_800,
  PRODUCTION_INDEXES,
  ROLLBACK_800,
  SUPABASE_STUBS,
  readRepo,
  rpcSql,
  type CheckRow,
} from "./_support/ai-db";

let pass = 0,
  fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failed.push(name);
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}

const WS = "11111111-1111-4111-8111-111111111111";
const WS2 = "22222222-2222-4222-8222-222222222222";
const WS3 = "33333333-3333-4333-8333-333333333333";
const MEMBER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER2 = "abababab-abab-4bab-8bab-abababababab";
const MEMBER3 = "acacacac-acac-4cac-8cac-acacacacacac";
const STRANGER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
let seq = 0;
const rid = () => `cccccccc-cccc-4ccc-8ccc-${String(++seq).padStart(12, "0")}`;

const db = await PGlite.create();
await db.exec(SUPABASE_STUBS);
await db.exec(`
  INSERT INTO public.workspaces (id) VALUES ('${WS}'), ('${WS2}'), ('${WS3}');
  INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
    ('${WS}', '${MEMBER}', 'owner'), ('${WS2}', '${MEMBER2}', 'owner'), ('${WS3}', '${MEMBER3}', 'owner');
  INSERT INTO auth.users (id) VALUES ('${ADMIN}');
`);

type Role = "service_role" | "authenticated" | "anon";

/** One statement as `role` with PostgREST-style claims ({role, sub}). */
async function as<T = Record<string, unknown>>(
  role: Role | null,
  sql: string,
  params: unknown[] = [],
  uid: string | null = null,
): Promise<T[]> {
  const claims = role ? JSON.stringify(uid ? { role, sub: uid } : { role }) : "";
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [claims]);
  if (role) await db.exec(`SET ROLE ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    if (role) await db.exec("RESET ROLE");
    await db.query(`SELECT set_config('request.jwt.claims', '', false)`);
  }
}
async function raises(role: Role | null, sql: string, params: unknown[] = [], uid: string | null = null) {
  try {
    await as(role, sql, params, uid);
    return null;
  } catch (e) {
    const err = e as { message?: string; code?: string };
    return { message: String(err.message ?? e), code: err.code };
  }
}
async function rpc<T = any>(name: string, args: Record<string, unknown>, role: Role = "service_role", uid: string | null = null): Promise<T> {
  const q = rpcSql(name, args);
  const rows = await as<{ result: T }>(role, q.text, q.values, uid);
  return rows[0]!.result;
}
async function rpcErr(name: string, args: Record<string, unknown>, role: Role = "service_role", uid: string | null = null) {
  const q = rpcSql(name, args);
  return raises(role, q.text, q.values, uid);
}

const reserveArgs = (o: Record<string, unknown> = {}) => ({
  _workspace_id: WS,
  _request_id: rid(),
  _user_id: MEMBER,
  _feature: "seo_coach",
  _source: "seo_coach",
  _model: "gpt-5-nano",
  _max_input_tokens: 1000,
  _max_output_tokens: 1200,
  _max_cost_micros: 3000,
  _max_credits: 2,
  _billing_class: "tenant",
  ...o,
});
const settleArgs = (ws: string, id: string, o: Record<string, unknown> = {}) => ({
  _workspace_id: ws,
  _request_id: id,
  _input_tokens: 500,
  _cached_input_tokens: 0,
  _output_tokens: 300,
  _reasoning_tokens: 50,
  _cost_micros: 1000,
  _credits: 1,
  _outcome: "ok",
  _error: null,
  ...o,
});
const reserve = (o: Record<string, unknown> = {}) => rpc("ai_reserve", reserveArgs(o));
const mark = (ws: string, id: string) => rpc<boolean>("ai_mark_called", { _workspace_id: ws, _request_id: id });
const settle = (ws: string, id: string, o: Record<string, unknown> = {}) => rpc("ai_settle", settleArgs(ws, id, o));
const release = (ws: string, id: string) => rpc<boolean>("ai_release", { _workspace_id: ws, _request_id: id });

const one = async <T = any>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]!;
const row = (ws: string, id: string) =>
  db.query<any>("SELECT * FROM public.ai_spend_reservations WHERE workspace_id = $1 AND request_id = $2", [ws, id]).then((r) => r.rows[0] ?? null);
const quota = async (ws: string) =>
  (await db.query<{ n: number }>("SELECT platform_credits_remaining AS n FROM public.workspace_ai_quota WHERE workspace_id = $1", [ws])).rows[0]?.n ?? null;
const balance = async (ws: string) =>
  (await db.query<{ n: number }>("SELECT balance AS n FROM public.credit_balances WHERE workspace_id = $1", [ws])).rows[0]?.n ?? null;
const spent = async () =>
  Number((await one<{ n: string | number }>("SELECT COALESCE((SELECT spent_micros FROM public.ai_budget_days WHERE day = (now() AT TIME ZONE 'UTC')::date), 0) AS n")).n);
/** The ceiling ledger always equals the sum of the rows' holds for the day. */
const budgetConsistent = async () => {
  const r = await one<{ a: string; b: string }>(`
    SELECT COALESCE((SELECT sum(spent_micros) FROM public.ai_budget_days), 0)::text AS a,
           COALESCE((SELECT sum(budget_micros) FROM public.ai_spend_reservations), 0)::text AS b`);
  return r.a === r.b;
};
const setSettings = (o: { enabled?: boolean; budget?: number; rate?: number; wsBudget?: number }) =>
  db.query(
    `UPDATE public.ai_platform_settings SET
       platform_ai_enabled = COALESCE($1, platform_ai_enabled),
       daily_budget_micros = COALESCE($2, daily_budget_micros),
       workspace_reservations_per_minute = COALESCE($3, workspace_reservations_per_minute),
       workspace_daily_budget_micros = COALESCE($4, workspace_daily_budget_micros)`,
    [o.enabled ?? null, o.budget ?? null, o.rate ?? null, o.wsBudget ?? null],
  );
/** The ledger key of a hold and its refund: the tenant's (round-4 H1). */
const ledgerRef = (ws: string, id: string, seq = 1) => `${ws}:${id}#${seq}`;
/** An active founder / internal unlimited grant for `ws` (20260924000700), or revoke it. */
const grantInternal = (ws: string) =>
  db.query(
    `INSERT INTO public.workspace_entitlement_grants (workspace_id, grant_type, page_limit, granted_by, reason)
     VALUES ($1, 'internal', 1000000, $2, 'test: internal unlimited')`,
    [ws, ADMIN],
  );
const revokeInternal = (ws: string) =>
  db.query(
    `UPDATE public.workspace_entitlement_grants SET revoked_at = now()
      WHERE workspace_id = $1 AND grant_type = 'internal' AND revoked_at IS NULL`,
    [ws],
  );
const resetMoney = async (o: { quota?: number; balance?: number } = {}) => {
  await db.exec(`
    DELETE FROM public.ai_spend_reservations;
    DELETE FROM public.ai_budget_days;
    DELETE FROM public.credit_ledger;
    DELETE FROM public.ai_usage_log;
    DELETE FROM public.workspace_ai_quota;
    DELETE FROM public.credit_balances;
    DELETE FROM public.coach_briefing_claims;
    DELETE FROM public.coach_briefing_refreshes;
    DELETE FROM public.coach_daily_briefings;
    DELETE FROM public.workspace_entitlement_grants;
    UPDATE public.platform_settings SET value = 'false'::jsonb WHERE key = 'generation_paused';
  `);
  await setSettings({ enabled: true, budget: 10_000_000, rate: 1000, wsBudget: 1_000_000 });
  for (const ws of [WS, WS2, WS3]) {
    await db.query("INSERT INTO public.workspace_ai_quota (workspace_id, platform_credits_remaining) VALUES ($1, $2)", [ws, o.quota ?? 20]);
    await db.query("INSERT INTO public.credit_balances (workspace_id, balance) VALUES ($1, $2)", [ws, o.balance ?? 0]);
  }
};
const age = (ws: string, id: string, col: "reserved_at" | "provider_called_at", interval: string) =>
  db.query(`UPDATE public.ai_spend_reservations SET ${col} = now() - $3::interval WHERE workspace_id = $1 AND request_id = $2`, [ws, id, interval]);

async function applyScript(rel: string): Promise<CheckRow[]> {
  const results = await db.exec(readRepo(rel));
  return (results[results.length - 1]?.rows ?? []) as CheckRow[];
}

// ---------------------------------------------------------------------------
console.log("\n=== the chain loads (20260918 → 000600 → 000700 → 000800), verifies itself, re-runs harmlessly ===");
{
  const idx = await db.query<{ name: string }>(
    "SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])",
    [[...PRODUCTION_INDEXES]],
  );
  t(
    `the stubs carry production's indexes (${PRODUCTION_INDEXES.join(", ")})`,
    PRODUCTION_INDEXES.every((n) => idx.rows.some((r) => r.name === n)),
    JSON.stringify(idx.rows),
  );
  const grantIdx = await one<{ def: string }>("SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'credit_ledger_grant_ref_unique'");
  t(
    "credit_ledger_grant_ref_unique is GLOBAL, as in production (no workspace_id in its key)",
    /\(reason, ref_type, ref_id\)/.test(grantIdx.def) && !/workspace_id/.test(grantIdx.def) && /delta > 0/.test(grantIdx.def),
    grantIdx.def,
  );
  for (const rel of AI_CHAIN.slice(0, -1)) {
    const rows = await applyScript(rel);
    t(`${rel.split("/").pop()} applies and verifies`, rows.length > 0 && rows.every((r) => r.ok === true), JSON.stringify(rows.filter((r) => r.ok !== true)));
  }
  const first = await applyScript(MIGRATION_800);
  t("000800's verification block returned its rows", first.length >= 12, String(first.length));
  const bad = first.filter((r) => r.ok !== true);
  t("every 000800 verification row reads true", bad.length === 0, JSON.stringify(bad));
  const second = await applyScript(MIGRATION_800);
  t("re-running 000800 is harmless", second.length === first.length && second.every((r) => r.ok === true), JSON.stringify(second.filter((r) => r.ok !== true)));
  const jobs = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM cron.job WHERE jobname = 'ai-reap-stale-reservations'");
  t("exactly one reaper job after a re-run", jobs.rows[0]!.n === 1);
  const s = await one<any>("SELECT * FROM public.ai_platform_settings");
  t("the kill switch defaults ON and the ceiling to $10.00/day", s.platform_ai_enabled === true && Number(s.daily_budget_micros) === 10_000_000);
  t("the per-workspace daily cap defaults to $1.00/day", Number(s.workspace_daily_budget_micros) === 1_000_000, String(s.workspace_daily_budget_micros));
}

// ---------------------------------------------------------------------------
console.log("\n=== grants: service role only, despite Supabase's default grants ===");
{
  await resetMoney();
  const calls: Array<[string, Record<string, unknown>]> = [
    ["ai_reserve", reserveArgs()],
    ["ai_mark_called", { _workspace_id: WS, _request_id: rid() }],
    ["ai_settle", settleArgs(WS, rid())],
    ["ai_release", { _workspace_id: WS, _request_id: rid() }],
    ["ai_reap_stale_reservations", {}],
    ["coach_briefing_claim", { _workspace_id: WS, _briefing_date: "2026-09-25", _claim_token: rid() }],
    ["coach_briefing_store", { _workspace_id: WS, _briefing_date: "2026-09-25", _claim_token: rid(), _insights: [] }],
    ["_ai_release_row", { _workspace_id: WS, _request_id: rid(), _reason: "x" }],
    ["_ai_expire_workspace", { _workspace_id: WS }],
    ["_ai_generation_paused", {}],
    ["_ai_ledger_ref", { _workspace_id: WS, _request_id: rid(), _hold_seq: 1 }],
    ["ai_workspace_spent_micros", { _workspace_id: WS, _day: "2026-09-25" }],
    ["coach_briefing_refresh_allowed", { _workspace_id: WS, _min_interval_seconds: 600 }],
    ["workspace_is_internal_unlimited", { _workspace_id: WS }],
  ];
  for (const role of ["authenticated", "anon"] as const) {
    for (const [name, args] of calls) {
      const err = await rpcErr(name, args, role, MEMBER);
      t(`${role} cannot execute ${name} (even as a member)`, !!err && /permission denied/.test(err.message), err?.message);
    }
    for (const table of ["ai_spend_reservations", "ai_platform_settings", "ai_budget_days", "coach_briefing_claims", "coach_briefing_refreshes"]) {
      const err = await raises(role, `SELECT count(*) FROM public.${table}`, [], MEMBER);
      t(`${role} cannot read ${table}`, !!err && /permission denied/.test(err.message), err?.message);
    }
    const upd = await raises(role, "UPDATE public.ai_platform_settings SET platform_ai_enabled = true", [], MEMBER);
    t(`${role} cannot flip the kill switch`, !!upd && /permission denied/.test(upd.message), upd?.message);
  }
  const ok = await reserve();
  t("the service role can reserve", ok.status === "reserved", JSON.stringify(ok));
}

// ---------------------------------------------------------------------------
console.log("\n=== guards: identity, allowlist, billing policy, bounds ===");
{
  await resetMoney();
  const stranger = await rpcErr("ai_reserve", reserveArgs(), "service_role", STRANGER);
  t("a JWT user who is not a member of the workspace is refused (42501)", stranger?.code === "42501", JSON.stringify(stranger));
  const crossTenant = await rpcErr("ai_reserve", reserveArgs({ _workspace_id: WS2, _user_id: MEMBER }));
  t("attributing a call to a user outside the workspace is refused (42501): member of A cannot spend B", crossTenant?.code === "42501", JSON.stringify(crossTenant));
  const bad: Array<[string, Record<string, unknown>]> = [
    ["an arbitrary model (gpt-4o)", { _model: "gpt-4o" }],
    ["an arbitrary model (gpt-5)", { _model: "gpt-5" }],
    ["an unknown feature", { _feature: "chat" }],
    ["an unknown billing class", { _billing_class: "free" }],
    ["'granted' outside page generation", { _billing_class: "granted" }],
    ["'system' outside the daily briefing", { _billing_class: "system" }],
    ["the daily briefing billed to a tenant", { _feature: "daily_briefing", _billing_class: "tenant" }],
    ["a customer call without its user", { _user_id: null }],
    ["max output tokens above every route's ceiling", { _max_output_tokens: 6001 }],
    ["zero output tokens", { _max_output_tokens: 0 }],
    ["an input bound above the model window", { _max_input_tokens: 272001 }],
    ["a zero-cost hold", { _max_cost_micros: 0 }],
    ["a tenant hold of zero credits", { _max_credits: 0 }],
    ["a NULL request id", { _request_id: null }],
  ];
  for (const [label, o] of bad) {
    const err = await rpcErr("ai_reserve", reserveArgs(o));
    t(`refused: ${label} (22023)`, err?.code === "22023", JSON.stringify(err));
  }
  const n = await one<{ n: number }>("SELECT count(*)::int AS n FROM public.ai_spend_reservations");
  t("…and none of them reserved anything", n.n === 0);
  const direct = await raises(null, `INSERT INTO public.ai_spend_reservations (workspace_id, request_id, user_id, feature, source, model, max_input_tokens, max_output_tokens, max_cost_micros, billing, budget_day) VALUES ('${WS}', '${rid()}', '${MEMBER}', 'seo_coach', 'x', 'gpt-4o', 1, 1, 1, 'free_quota', current_date)`);
  t("the schema itself rejects a model outside the allowlist", !!direct && /ai_spend_model_check/.test(direct.message), direct?.message);
}

// ---------------------------------------------------------------------------
console.log("\n=== one request id, one provider call: the state machine ===");
{
  await resetMoney();
  const args = reserveArgs();
  const id = String(args._request_id);
  const r1 = await rpc("ai_reserve", args);
  t("a new id is reserved (free quota first)", r1.status === "reserved" && r1.billing === "free_quota" && r1.hold_seq === 1, JSON.stringify(r1));
  t("…taking one free-quota unit (20 → 19)", (await quota(WS)) === 19);
  t("the same id again while held → in_progress (no second hold)", (await rpc("ai_reserve", args)).status === "in_progress" && (await quota(WS)) === 19);
  t("settle before mark → not_called (nothing moves)", (await settle(WS, id)).status === "not_called" && (await row(WS, id)).status === "held");
  t("mark: held → called, once", (await mark(WS, id)) === true && (await row(WS, id)).status === "called");
  t("a second mark is refused", (await mark(WS, id)) === false);
  t("the same id while called → in_progress", (await rpc("ai_reserve", args)).status === "in_progress");
  t("release after the call is refused: a called request is settled, never released", (await release(WS, id)) === false && (await row(WS, id)).status === "called");
  const s1 = await settle(WS, id);
  t("settle: called → settled", s1.status === "settled" && s1.billing === "free_quota" && s1.full_hold === false, JSON.stringify(s1));
  t("…the unit stays spent (19)", (await quota(WS)) === 19);
  const s2 = await settle(WS, id, { _cost_micros: 999999, _credits: 999 });
  t("a second settle is 'already_settled' and moves nothing", s2.status === "already_settled" && (await quota(WS)) === 19);
  t("the same id after settlement → done (never a second call)", (await rpc("ai_reserve", args)).status === "done");
  t("the same id under another feature → conflict", (await rpc("ai_reserve", { ...args, _feature: "page_audit" })).status === "conflict");
  const usage = await db.query<any>("SELECT * FROM public.ai_usage_log WHERE workspace_id = $1", [WS]);
  t(
    "exactly one ai_usage_log row for the call: provider openai, the source as feature, tokens and cost",
    usage.rows.length === 1 && usage.rows[0].provider === "openai" && usage.rows[0].feature === "seo_coach" &&
      usage.rows[0].prompt_tokens === 500 && usage.rows[0].completion_tokens === 300 && Number(usage.rows[0].cost_usd_micros) === 1000 &&
      usage.rows[0].status === "ok" && usage.rows[0].used_byok === false,
    JSON.stringify(usage.rows),
  );

  const args2 = reserveArgs();
  const id2 = String(args2._request_id);
  await rpc("ai_reserve", args2);
  t("release: held → released, full refund of the unit", (await release(WS, id2)) === true && (await row(WS, id2)).status === "released" && (await quota(WS)) === 19);
  t("a second release is a harmless no", (await release(WS, id2)) === false && (await quota(WS)) === 19);
  t("mark after release is refused (no call)", (await mark(WS, id2)) === false);
  const again = await rpc("ai_reserve", args2);
  t("a released id may be reserved again, under the next hold sequence", again.status === "reserved" && again.hold_seq === 2 && (await row(WS, id2)).status === "held", JSON.stringify(again));
  t("the budget ledger matches the rows", await budgetConsistent());
  const noCall = await raises(null, `UPDATE public.ai_spend_reservations SET status = 'released', released_at = now(), provider_called_at = now() WHERE workspace_id = '${WS}' AND request_id = '${id2}'`);
  t("the schema forbids a released row that was called", !!noCall && /ai_spend_release_never_called/.test(noCall.message), noCall?.message);
}

// ---------------------------------------------------------------------------
console.log("\n=== the money: free quota, credits, the cap at the hold ===");
{
  await resetMoney({ quota: 0, balance: 10 });
  const a = reserveArgs({ _max_credits: 3 });
  const id = String(a._request_id);
  const r = await rpc("ai_reserve", a);
  t("no free quota left → credits: the hold (3) is taken up front", r.status === "reserved" && r.billing === "credits" && (await balance(WS)) === 7, JSON.stringify(r));
  const hold = await db.query<any>("SELECT delta, reason, ref_type, ref_id FROM public.credit_ledger WHERE workspace_id = $1", [WS]);
  t("…with one ledger row: ai_hold −3, ref '<workspace>:<request>#1' (the tenant's key)", hold.rows.length === 1 && hold.rows[0].delta === -3 && hold.rows[0].reason === "ai_hold" && hold.rows[0].ref_type === "ai_spend" && hold.rows[0].ref_id === ledgerRef(WS, id), JSON.stringify(hold.rows));
  await mark(WS, id);
  const s = await settle(WS, id, { _cost_micros: 1500, _credits: 1 });
  t("settle charges the actual credits (1) and refunds the rest (2)", s.status === "settled" && s.credits_charged === 1 && (await balance(WS)) === 9, JSON.stringify(s));
  const refund = await db.query<any>("SELECT delta, ref_id FROM public.credit_ledger WHERE workspace_id = $1 AND reason = 'ai_refund'", [WS]);
  t("…one ai_refund +2 row, under the same tenant key", refund.rows.length === 1 && refund.rows[0].delta === 2 && refund.rows[0].ref_id === ledgerRef(WS, id));
  const life = await one<any>("SELECT lifetime_spent FROM public.credit_balances WHERE workspace_id = $1", [WS]);
  t("lifetime_spent grows by the charge only (1)", life.lifetime_spent === 1);
  const dupe = await raises(null, `INSERT INTO public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id) VALUES ('${WS}', 2, 'ai_refund', 'ai_spend', '${ledgerRef(WS, id)}')`);
  t("a second refund of the same hold is impossible (unique index, 23505)", dupe?.code === "23505", JSON.stringify(dupe));
  const dupeHold = await raises(null, `INSERT INTO public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id) VALUES ('${WS}', -3, 'ai_hold', 'ai_spend', '${ledgerRef(WS, id)}')`);
  t("a second hold under the same sequence is impossible (23505)", dupeHold?.code === "23505");

  const b = reserveArgs({ _max_credits: 3 });
  await rpc("ai_reserve", b);
  await mark(WS, String(b._request_id));
  const over = await settle(WS, String(b._request_id), { _cost_micros: 99_000, _credits: 50 });
  t("actual credits above the hold are capped at the hold (3), never more", over.credits_charged === 3 && (await balance(WS)) === 6, JSON.stringify(over));
  t("…while the ceiling records the true cost", Number((await row(WS, String(b._request_id))).budget_micros) === 99_000 && (await budgetConsistent()));

  const c = reserveArgs({ _max_credits: 3 });
  await rpc("ai_reserve", c);
  await mark(WS, String(c._request_id));
  const full = await settle(WS, String(c._request_id), { _cost_micros: null, _credits: null, _outcome: "failed", _error: "timeout" });
  t(
    "a failed call with unknown usage: the customer gets all 3 back, the platform budget keeps the full hold",
    full.full_hold === true && full.credits_charged === 0 && (await balance(WS)) === 6 &&
      Number((await row(WS, String(c._request_id))).budget_micros) === Number(c._max_cost_micros) && (await budgetConsistent()),
    JSON.stringify(full),
  );
  const failedLog = await one<any>("SELECT status, error, cost_usd_micros FROM public.ai_usage_log WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1", [WS]);
  t("…logged as failed with the failure code only, at the platform's cost", failedLog.status === "failed" && failedLog.error === "timeout" && Number(failedLog.cost_usd_micros) === Number(c._max_cost_micros));

  const e = reserveArgs({ _max_credits: 3 });
  await rpc("ai_reserve", e);
  await mark(WS, String(e._request_id));
  const blind = await settle(WS, String(e._request_id), { _cost_micros: null, _credits: null, _outcome: "ok", _error: "usage_missing" });
  t("a DELIVERED result with unknown usage is charged the whole hold (3), never free", blind.full_hold === true && blind.credits_charged === 3 && (await balance(WS)) === 3, JSON.stringify(blind));

  const d = reserveArgs({ _max_credits: 3 });
  await rpc("ai_reserve", d);
  t("release refunds the whole hold (3 → 0 → 3)", (await balance(WS)) === 0 && (await release(WS, String(d._request_id))) === true && (await balance(WS)) === 3);

  await db.query("UPDATE public.credit_balances SET balance = 2 WHERE workspace_id = $1", [WS]);
  const poor = await reserve({ _max_credits: 3 });
  t("no quota and a balance below the hold → insufficient, nothing moved", poor.status === "insufficient" && (await balance(WS)) === 2 && (await quota(WS)) === 0, JSON.stringify(poor));
  await db.query("UPDATE public.credit_balances SET balance = 3 WHERE workspace_id = $1", [WS]);
  const exactArgs = reserveArgs({ _max_credits: 3 });
  const exact = await rpc("ai_reserve", exactArgs);
  t("a balance of exactly the hold → reserved, balance 0 (a page must be affordable, not balance > 0)", exact.status === "reserved" && exact.billing === "credits" && (await balance(WS)) === 0, JSON.stringify(exact));
  t("…and its release puts the whole hold back", (await release(WS, String(exactArgs._request_id))) === true && (await balance(WS)) === 3);

  await resetMoney({ quota: 1 });
  const q = reserveArgs();
  await rpc("ai_reserve", q);
  await mark(WS, String(q._request_id));
  const zero = await settle(WS, String(q._request_id), { _input_tokens: 0, _output_tokens: 0, _reasoning_tokens: 0, _cost_micros: 0, _credits: 0, _outcome: "failed", _error: "not_sent" });
  t("a call that provably cost nothing gives its free-quota unit back", zero.status === "settled" && zero.quota_units === 0 && (await quota(WS)) === 1, JSON.stringify(zero));
  const bogus = await rpcErr("ai_settle", settleArgs(WS, rid(), { _error: "Incorrect API key provided: sk-proj-****" }));
  t("ai_settle refuses raw error text (only short failure codes can reach ai_usage_log)", bogus?.code === "22023", JSON.stringify(bogus));
  const halfUsage = await rpcErr("ai_settle", settleArgs(WS, rid(), { _cost_micros: 100, _credits: null }));
  t("ai_settle refuses a cost without credits", halfUsage?.code === "22023");
}

// ---------------------------------------------------------------------------
console.log("\n=== granted, byok, system ===");
{
  await resetMoney({ quota: 0, balance: 0 });
  const g = await reserve({ _feature: "page_generation", _source: "quick_page", _billing_class: "granted", _max_output_tokens: 6000 });
  t("granted (page generation, beta grant): reserved with no tenant funds at all", g.status === "reserved" && g.billing === "granted", JSON.stringify(g));
  t("…but it takes the platform ceiling", (await spent()) === 3000);
  const byok = await reserve({ _billing_class: "byok" });
  t("byok: reserved with no tenant funds", byok.status === "reserved" && byok.billing === "byok");
  t("…and no ceiling (still 3000)", (await spent()) === 3000);
  const sys = await reserve({ _feature: "daily_briefing", _source: "daily_briefing", _billing_class: "system", _user_id: null, _max_output_tokens: 1000, _max_credits: 0 });
  t("system (daily briefing): reserved, the ceiling only", sys.status === "reserved" && sys.billing === "system" && (await spent()) === 6000, JSON.stringify(sys));
  t("the budget ledger matches the rows", await budgetConsistent());
}

// ---------------------------------------------------------------------------
console.log("\n=== the global ceiling ===");
{
  await resetMoney({ quota: 20 });
  await setSettings({ budget: 10_000 });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const a = reserveArgs();
    ids.push(String(a._request_id));
    t(`hold ${i + 1} of 3000 under a 10000 ceiling is reserved`, (await rpc("ai_reserve", a)).status === "reserved");
  }
  const fourth = await reserve({ _workspace_id: WS2, _user_id: MEMBER2 });
  t("the 4th (another workspace) is budget_exhausted — the ceiling is global", fourth.status === "budget_exhausted", JSON.stringify(fourth));
  t("…and its free-quota unit was given back (undo of the tenant charge)", (await quota(WS2)) === 20);
  t("the ceiling holds 9000", (await spent()) === 9000);
  await mark(WS, ids[0]!);
  await settle(WS, ids[0]!, { _cost_micros: 1000, _credits: 1 });
  t("settling at the actual cost returns the unused 2000", (await spent()) === 7000 && (await budgetConsistent()));
  t("…so another hold fits again", (await reserve({ _workspace_id: WS2, _user_id: MEMBER2 })).status === "reserved");
  await release(WS, ids[1]!);
  t("a release returns the whole hold", (await spent()) === 7000 && (await budgetConsistent()));
  t("byok is never refused by the ceiling", (await reserve({ _billing_class: "byok" })).status === "reserved");
}

// ---------------------------------------------------------------------------
console.log("\n=== the kill switch ===");
{
  await resetMoney({ quota: 20, balance: 100 });
  const held = reserveArgs();
  await rpc("ai_reserve", held);
  const heldByok = reserveArgs({ _billing_class: "byok" });
  await rpc("ai_reserve", heldByok);
  const called = reserveArgs();
  await rpc("ai_reserve", called);
  await mark(WS, String(called._request_id));
  await setSettings({ enabled: false });
  for (const [label, o] of [
    ["tenant", {}],
    ["granted", { _feature: "page_generation", _source: "quick_page", _billing_class: "granted" }],
    ["system (the daily briefing)", { _feature: "daily_briefing", _source: "daily_briefing", _billing_class: "system", _user_id: null, _max_credits: 0 }],
  ] as const) {
    const before = await quota(WS);
    const r = await reserve(o as Record<string, unknown>);
    t(`OFF: ${label} is refused with platform_paused, whatever the balance`, r.status === "platform_paused" && (await quota(WS)) === before, JSON.stringify(r));
  }
  t("OFF: a hold taken before the flip cannot reach the provider (mark → false)", (await mark(WS, String(held._request_id))) === false);
  t("…and is released with its refund", (await release(WS, String(held._request_id))) === true);
  t("OFF: BYOK is not the platform's money — still reserved and marked", (await reserve({ _billing_class: "byok" })).status === "reserved" && (await mark(WS, String(heldByok._request_id))) === true);
  const inflight = await settle(WS, String(called._request_id));
  t("OFF: an in-flight call settles normally", inflight.status === "settled", JSON.stringify(inflight));
  await setSettings({ enabled: true });
  t("ON again: reservations resume", (await reserve()).status === "reserved");
  await db.exec("DELETE FROM public.ai_platform_settings");
  t("a missing settings row fails closed (platform_paused)", (await reserve()).status === "platform_paused");
  await db.exec("INSERT INTO public.ai_platform_settings (id, workspace_reservations_per_minute) VALUES (true, 1000)");
}

// ---------------------------------------------------------------------------
console.log("\n=== the page-generation pause (enforced here for every key type) ===");
{
  for (const value of ["true", '"true"', '" TRUE "']) {
    await resetMoney();
    await db.query("UPDATE public.platform_settings SET value = $1::jsonb WHERE key = 'generation_paused'", [value]);
    const pg = await reserve({ _feature: "page_generation", _source: "quick_page", _billing_class: "byok" });
    t(`generation_paused = ${value}: page generation refused even on BYOK`, pg.status === "generation_paused", JSON.stringify(pg));
    t(`…other features are unaffected`, (await reserve()).status === "reserved");
  }
  await resetMoney();
  const held = reserveArgs({ _feature: "page_generation", _source: "quick_page", _billing_class: "granted" });
  await rpc("ai_reserve", held);
  await db.query("UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'generation_paused'");
  t("a page-generation hold taken before the pause cannot be marked", (await mark(WS, String(held._request_id))) === false);
  await db.query("UPDATE public.platform_settings SET value = '\"false\"'::jsonb WHERE key = 'generation_paused'");
  t("\"false\" does not pause", (await mark(WS, String(held._request_id))) === true);
}

// ---------------------------------------------------------------------------
console.log("\n=== the per-workspace rate limit ===");
{
  await resetMoney({ quota: 100 });
  await setSettings({ rate: 3 });
  const first = reserveArgs();
  const results = [await rpc("ai_reserve", first), await reserve(), await reserve()];
  t("3 reservations in a minute are allowed", results.every((r) => r.status === "reserved"));
  t("the 4th is rate_limited, nothing charged", (await reserve()).status === "rate_limited" && (await quota(WS)) === 97);
  t("a replay of a held id is not a new reservation (in_progress, not rate_limited)", (await rpc("ai_reserve", first)).status === "in_progress");
  t("another workspace has its own limit", (await reserve({ _workspace_id: WS2, _user_id: MEMBER2 })).status === "reserved");
  t("byok counts too", (await reserve({ _billing_class: "byok" })).status === "rate_limited");
  await db.query("UPDATE public.ai_spend_reservations SET reserved_at = now() - interval '2 minutes' WHERE workspace_id = $1", [WS]);
  t("a minute later the workspace may reserve again", (await reserve()).status === "reserved");
  await setSettings({ rate: 1000 });
}

// ---------------------------------------------------------------------------
console.log("\n=== who pays when a call fails after it reached the provider: two books ===");
{
  // One row per case of the table in the report (section 6). The Worker's
  // settleInputFor (tests/ai-provider.test.ts) maps each provider outcome to
  // these (outcome, cost) inputs; here the database applies them.
  type Case = { label: string; outcome: "ok" | "failed"; cost: number | null; error: string | null; charged: number; budget: "cost" | "zero" | "hold" };
  const CASES: Case[] = [
    { label: "delivered, usage reported", outcome: "ok", cost: 1500, error: null, charged: 1, budget: "cost" },
    { label: "delivered, usage missing", outcome: "ok", cost: null, error: "usage_missing", charged: 3, budget: "hold" },
    { label: "rejected before generation (400-429)", outcome: "failed", cost: 0, error: "rate_limited", charged: 0, budget: "zero" },
    { label: "never sent", outcome: "failed", cost: 0, error: "not_sent", charged: 0, budget: "zero" },
    { label: "incomplete, usage reported", outcome: "failed", cost: 2200, error: "incomplete", charged: 0, budget: "cost" },
    { label: "refusal, usage reported", outcome: "failed", cost: 900, error: "refusal", charged: 0, budget: "cost" },
    { label: "malformed / schema-invalid, usage reported", outcome: "failed", cost: 1800, error: "schema_mismatch", charged: 0, budget: "cost" },
    { label: "rejected by the route's own check, usage reported", outcome: "failed", cost: 1700, error: "thin_output", charged: 0, budget: "cost" },
    { label: "answered but the result could not be saved, usage reported", outcome: "failed", cost: 1600, error: "not_delivered", charged: 0, budget: "cost" },
    { label: "5xx, usage unknown", outcome: "failed", cost: null, error: "server_error", charged: 0, budget: "hold" },
    { label: "timeout after sending", outcome: "failed", cost: null, error: "timeout", charged: 0, budget: "hold" },
    { label: "network error after sending", outcome: "failed", cost: null, error: "network", charged: 0, budget: "hold" },
  ];
  for (const billing of ["credits", "free_quota"] as const) {
    for (const c of CASES) {
      await resetMoney(billing === "credits" ? { quota: 0, balance: 10 } : { quota: 5, balance: 0 });
      const args = reserveArgs({ _max_credits: 3, _max_cost_micros: 3000 });
      const id = String(args._request_id);
      const r = await rpc("ai_reserve", args);
      await mark(WS, id);
      const s = await settle(WS, id, {
        _cost_micros: c.cost,
        _credits: c.cost === null ? null : c.outcome === "ok" ? 1 : 0,
        _outcome: c.outcome,
        _error: c.error,
      });
      const after = await row(WS, id);
      const expectBudget = c.budget === "cost" ? c.cost : c.budget === "zero" ? 0 : 3000;
      const customerOk =
        billing === "credits"
          ? s.credits_charged === c.charged && (await balance(WS)) === 10 - c.charged
          : (await quota(WS)) === (c.outcome === "ok" ? 4 : 5) && s.credits_charged === 0;
      t(
        `${billing} — ${c.label}: customer ${c.outcome === "ok" ? "charged" : "refunded in full"}, platform budget ${c.budget}`,
        r.billing === billing && s.status === "settled" && customerOk && Number(after.budget_micros) === expectBudget && (await spent()) === expectBudget && (await budgetConsistent()),
        JSON.stringify({ s, budget: after.budget_micros, balance: await balance(WS), quota: await quota(WS) }),
      );
    }
  }
  // Anti-abuse is not refunded: every reservation counts toward the
  // per-minute rate limit, whatever became of it.
  await resetMoney({ quota: 0, balance: 50 });
  await setSettings({ rate: 3 });
  for (let i = 0; i < 3; i++) {
    const a = reserveArgs({ _max_credits: 1 });
    await rpc("ai_reserve", a);
    await mark(WS, String(a._request_id));
    await settle(WS, String(a._request_id), { _cost_micros: null, _credits: null, _outcome: "failed", _error: "timeout" });
  }
  t("three refunded failures still count: the fourth reservation this minute is rate_limited", (await reserve({ _max_credits: 1 })).status === "rate_limited" && (await balance(WS)) === 50);
  await setSettings({ rate: 1000 });
}

console.log("\n=== lazy expiry inside ai_reserve ===");
{
  await resetMoney({ quota: 0, balance: 10 });
  const dead = reserveArgs({ _max_credits: 3 });
  await rpc("ai_reserve", dead);
  await age(WS, String(dead._request_id), "reserved_at", "11 minutes");
  t("a hold abandoned for 11 minutes still holds its credits (7)", (await balance(WS)) === 7);
  await reserve({ _max_credits: 1 });
  t("the next reservation of the workspace releases it first (refund 3, then hold 1 → 9)", (await row(WS, String(dead._request_id))).status === "released" && (await balance(WS)) === 9);
  const zombie = reserveArgs({ _max_credits: 2 });
  await rpc("ai_reserve", zombie);
  await mark(WS, String(zombie._request_id));
  await age(WS, String(zombie._request_id), "provider_called_at", "31 minutes");
  await reserve({ _max_credits: 1 });
  const z = await row(WS, String(zombie._request_id));
  t(
    "a call left unsettled for 31 minutes is settled: the full hold on the budget, the customer refunded (9 − 1 + 2 − 2 = 8)",
    z.status === "settled" && z.credits_charged === 0 && Number(z.budget_micros) === Number(zombie._max_cost_micros ?? z.max_cost_micros) && z.close_reason === "expired_full_hold" && (await balance(WS)) === 8,
    JSON.stringify(z),
  );
  const stale = reserveArgs({ _max_credits: 1 });
  await rpc("ai_reserve", stale);
  await age(WS, String(stale._request_id), "reserved_at", "11 minutes");
  const retake = await rpc("ai_reserve", stale);
  t("the same id, stale and never called, is released and retaken (hold 2)", retake.status === "reserved" && retake.hold_seq === 2, JSON.stringify(retake));
  t("the budget ledger matches the rows", await budgetConsistent());
}

// ---------------------------------------------------------------------------
console.log("\n=== the reaper: a dead worker's money comes back without any traffic ===");
{
  await resetMoney({ quota: 1, balance: 10 });
  // Worker death 1: after reserve (free quota), never marked.
  const d1 = reserveArgs();
  await rpc("ai_reserve", d1);
  // Worker death 2: after reserve (credits), never marked.
  const d2 = reserveArgs({ _max_credits: 4 });
  await rpc("ai_reserve", d2);
  // Worker death 3: after mark-called, never settled.
  const d3 = reserveArgs({ _max_credits: 3, _max_cost_micros: 5000 });
  await rpc("ai_reserve", d3);
  await mark(WS, String(d3._request_id));
  // A live request in another workspace must not be touched.
  const live = reserveArgs({ _workspace_id: WS2, _user_id: MEMBER2 });
  await rpc("ai_reserve", live);
  t("before: quota 0, balance 10 − 4 − 3 = 3", (await quota(WS)) === 0 && (await balance(WS)) === 3);
  const early = await rpc("ai_reap_stale_reservations", {});
  t("a reap before the thresholds touches nothing", early.released === 0 && early.settled === 0, JSON.stringify(early));
  await age(WS, String(d1._request_id), "reserved_at", "11 minutes");
  await age(WS, String(d2._request_id), "reserved_at", "11 minutes");
  await age(WS, String(d3._request_id), "provider_called_at", "31 minutes");
  const spentBefore = await spent();
  const reaped = await rpc("ai_reap_stale_reservations", {});
  t("the reaper released 2 dead holds and settled 1 dead call", reaped.released === 2 && reaped.settled === 1 && reaped.skipped === false, JSON.stringify(reaped));
  t("death after reserve (quota): the unit is back", (await quota(WS)) === 1 && (await row(WS, String(d1._request_id))).status === "released");
  t("death after reserve (credits): the 4 credits are back", (await row(WS, String(d2._request_id))).status === "released");
  const s3 = await row(WS, String(d3._request_id));
  t(
    "death after mark-called: settled, the customer refunded (3 back: 10 in total), nothing recorded as delivered",
    s3.status === "settled" && s3.credits_charged === 0 && s3.close_reason === "expired_full_hold" && (await balance(WS)) === 10,
    JSON.stringify({ status: s3.status, charged: s3.credits_charged, balance: await balance(WS) }),
  );
  t("…while its platform budget stays at the full hold (the provider may have been paid)", Number(s3.budget_micros) === 5000 && (await budgetConsistent()));
  t("the ceiling got back exactly the two released holds (3000 + 3000)", spentBefore - (await spent()) === 6000, `${spentBefore} → ${await spent()}`);
  t("the live request in the other workspace is untouched", (await row(WS2, String(live._request_id))).status === "held");
  const expiredLog = await one<any>("SELECT status, error FROM public.ai_usage_log WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1", [WS]);
  t("the expired call is in ai_usage_log as failed / expired", expiredLog.status === "failed" && expiredLog.error === "expired");
  const again = await rpc("ai_reap_stale_reservations", {});
  t("a second run finds nothing (terminal states)", again.released === 0 && again.settled === 0);
  t("an expired row is terminal: a late settle from the dead worker moves nothing", (await settle(WS, String(d3._request_id), { _cost_micros: 10, _credits: 1 })).status === "already_settled" && (await balance(WS)) === 10);
  t("…and a late mark of the released hold cannot call", (await mark(WS, String(d2._request_id))) === false);
}

// ---------------------------------------------------------------------------
console.log("\n=== the daily briefing's claim: one stored briefing per workspace and UTC day ===");
{
  await resetMoney();
  const DAY = "2026-09-25";
  const tokA = rid();
  const tokB = rid();
  const claim = (tok: string, ws = WS) => rpc("coach_briefing_claim", { _workspace_id: ws, _briefing_date: DAY, _claim_token: tok });
  const store = (tok: string, insights: unknown, ws = WS) => rpc("coach_briefing_store", { _workspace_id: ws, _briefing_date: DAY, _claim_token: tok, _insights: insights });
  t("the first run claims the day", (await claim(tokA)).status === "claimed");
  t("a concurrent run is told in_progress", (await claim(tokB)).status === "in_progress");
  t("a run without the claim cannot store", (await store(tokB, [{ title: "B" }])).status === "lost_claim");
  t("the claim holder stores", (await store(tokA, [{ title: "A" }])).status === "stored");
  const rows = await db.query<any>("SELECT insights FROM public.coach_daily_briefings WHERE workspace_id = $1", [WS]);
  t("exactly one briefing row, the claim holder's", rows.rows.length === 1 && rows.rows[0].insights[0].title === "A");
  t("after that every run is told 'exists'", (await claim(tokB)).status === "exists" && (await claim(rid())).status === "exists");
  t("nothing overwrites a stored briefing", (await store(tokA, [{ title: "again" }])).status === "exists");
  const tokC = rid();
  t("another workspace has its own day", (await claim(tokC, WS2)).status === "claimed");
  await db.query("UPDATE public.coach_briefing_claims SET claimed_at = now() - interval '4 minutes' WHERE workspace_id = $1", [WS2]);
  const tokD = rid();
  t("a claim abandoned for 4 minutes is taken over", (await claim(tokD, WS2)).status === "claimed");
  t("…and the dead run's late store is refused", (await store(tokC, [{ title: "late" }], WS2)).status === "lost_claim");
  const tooMany = await rpcErr("coach_briefing_store", { _workspace_id: WS2, _briefing_date: DAY, _claim_token: tokD, _insights: [1, 2, 3, 4, 5, 6] });
  t("insights must be an array of at most 5", tooMany?.code === "22023");
  const notArray = await rpcErr("coach_briefing_store", { _workspace_id: WS2, _briefing_date: DAY, _claim_token: tokD, _insights: { x: 1 } });
  t("…an object is refused", notArray?.code === "22023");
  // The AI call behind a briefing is idempotent by its deterministic id.
  const bid = rid();
  const sysArgs = reserveArgs({ _request_id: bid, _feature: "daily_briefing", _source: "daily_briefing", _billing_class: "system", _user_id: null, _max_credits: 0 });
  t("the day's briefing reservation is taken once", (await rpc("ai_reserve", sysArgs)).status === "reserved");
  t("a second run for the same day gets in_progress (no second AI call)", (await rpc("ai_reserve", sysArgs)).status === "in_progress");
}

// ---------------------------------------------------------------------------
console.log("\n=== round-4 H1: one request id in two workspaces — the tenant's ledger keys ===");
{
  // The old key ('<request>#<seq>') collides on production's GLOBAL index:
  // prove the index here is the one that bit.
  await resetMoney();
  const bare = rid();
  await db.query("INSERT INTO public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id) VALUES ($1, 2, 'ai_refund', 'ai_spend', $2)", [WS, `${bare}#1`]);
  const clash = await raises(null, `INSERT INTO public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id) VALUES ('${WS2}', 2, 'ai_refund', 'ai_spend', '${bare}#1')`);
  t(
    "the stubs' credit_ledger_grant_ref_unique refuses a second tenant's refund under a bare request key (23505) — the H1 failure",
    clash?.code === "23505" && /credit_ledger_grant_ref_unique/.test(clash.message),
    JSON.stringify(clash),
  );

  await resetMoney({ quota: 0, balance: 10 });
  const X = rid();
  const a1 = await rpc("ai_reserve", reserveArgs({ _request_id: X, _max_credits: 3 }));
  await mark(WS, X);
  const a2 = await settle(WS, X, { _cost_micros: 1500, _credits: 1 });
  const b1 = await rpc("ai_reserve", reserveArgs({ _workspace_id: WS2, _user_id: MEMBER2, _request_id: X, _max_credits: 3 }));
  await mark(WS2, X);
  const b2 = await settle(WS2, X, { _cost_micros: 1500, _credits: 1 });
  t("workspace A reserves and settles request X with a refund", a1.status === "reserved" && a2.status === "settled" && a2.credits_charged === 1, JSON.stringify(a2));
  t(
    "workspace B reserves the SAME request id X and its refund settles too (no 23505 on the global index)",
    b1.status === "reserved" && b2.status === "settled" && b2.credits_charged === 1,
    JSON.stringify({ b1, b2 }),
  );
  const refunds = await db.query<any>(
    "SELECT workspace_id, ref_id, delta FROM public.credit_ledger WHERE reason = 'ai_refund' AND ref_type = 'ai_spend' ORDER BY ref_id",
  );
  t(
    "two refund rows, each under its own tenant's key",
    refunds.rows.length === 2 && refunds.rows.some((r: any) => r.workspace_id === WS && r.ref_id === ledgerRef(WS, X)) &&
      refunds.rows.some((r: any) => r.workspace_id === WS2 && r.ref_id === ledgerRef(WS2, X)),
    JSON.stringify(refunds.rows),
  );
  t("each workspace paid 1 credit of its own (10 → 9)", (await balance(WS)) === 9 && (await balance(WS2)) === 9);

  // The release path: the same id released in both workspaces.
  const Y = rid();
  await rpc("ai_reserve", reserveArgs({ _request_id: Y, _max_credits: 2 }));
  await rpc("ai_reserve", reserveArgs({ _workspace_id: WS2, _user_id: MEMBER2, _request_id: Y, _max_credits: 2 }));
  t(
    "the release path: request Y released in both workspaces, both refunded",
    (await release(WS, Y)) === true && (await release(WS2, Y)) === true && (await balance(WS)) === 9 && (await balance(WS2)) === 9,
  );
  t("…and Y may be reserved again in both (next hold sequence, new keys)", (await rpc("ai_reserve", reserveArgs({ _request_id: Y, _max_credits: 2 }))).hold_seq === 2 && (await rpc("ai_reserve", reserveArgs({ _workspace_id: WS2, _user_id: MEMBER2, _request_id: Y, _max_credits: 2 }))).hold_seq === 2);

  // The reaper keeps working for every workspace: B's dead call under the id
  // A already settled with a refund, and an unrelated abandoned hold in C.
  await resetMoney({ quota: 0, balance: 10 });
  const Z = rid();
  await rpc("ai_reserve", reserveArgs({ _request_id: Z, _max_credits: 3 }));
  await mark(WS, Z);
  await settle(WS, Z, { _cost_micros: 1000, _credits: 1 });
  await rpc("ai_reserve", reserveArgs({ _workspace_id: WS2, _user_id: MEMBER2, _request_id: Z, _max_credits: 3 }));
  await mark(WS2, Z);
  await age(WS2, Z, "provider_called_at", "31 minutes");
  const c = reserveArgs({ _workspace_id: WS3, _user_id: MEMBER3, _max_credits: 3 });
  await rpc("ai_reserve", c);
  await age(WS3, String(c._request_id), "reserved_at", "11 minutes");
  const reaped = await rpc("ai_reap_stale_reservations", {});
  t(
    "the reaper settles B's dead call under the reused id and releases C's hold, with no failure",
    reaped.skipped === false && reaped.settled === 1 && reaped.released === 1 && reaped.failed === 0,
    JSON.stringify(reaped),
  );
  t(
    "B got its full hold back (the call was never recorded as delivered) and C its abandoned hold",
    (await balance(WS2)) === 10 && (await balance(WS3)) === 10 && (await row(WS3, String(c._request_id))).status === "released",
    `${await balance(WS2)} ${await balance(WS3)}`,
  );
  t("…and B can reserve again (its lazy expiry found nothing stuck)", (await rpc("ai_reserve", reserveArgs({ _workspace_id: WS2, _user_id: MEMBER2, _max_credits: 1 }))).status === "reserved");
  t("the budget ledger matches the rows", await budgetConsistent());
}

// ---------------------------------------------------------------------------
console.log("\n=== one row that cannot be closed never stops the lazy expiry or the reaper ===");
{
  await resetMoney({ quota: 0, balance: 20 });
  // A poisoned row: something already occupies its refund's ledger key, so
  // closing it raises 23505 — whatever the cause, it must stay local.
  const bad = reserveArgs({ _max_credits: 3 });
  await rpc("ai_reserve", bad);
  await db.query("INSERT INTO public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id) VALUES ($1, 1, 'ai_refund', 'ai_spend', $2)", [WS, ledgerRef(WS, String(bad._request_id))]);
  await age(WS, String(bad._request_id), "reserved_at", "11 minutes");
  const good = reserveArgs({ _max_credits: 2 });
  await rpc("ai_reserve", good);
  await age(WS, String(good._request_id), "reserved_at", "11 minutes");
  const other = reserveArgs({ _workspace_id: WS3, _user_id: MEMBER3, _max_credits: 2 });
  await rpc("ai_reserve", other);
  await age(WS3, String(other._request_id), "reserved_at", "11 minutes");
  const reaped = await rpc("ai_reap_stale_reservations", {});
  t(
    "the reaper closes the two good holds and reports the poisoned one as failed — no error",
    reaped.skipped === false && reaped.released === 2 && reaped.failed === 1,
    JSON.stringify(reaped),
  );
  t("the poisoned row is left exactly as it was (held, its credits still held)", (await row(WS, String(bad._request_id))).status === "held");
  t(
    "the good hold in the SAME workspace and the one in another workspace came back",
    (await row(WS, String(good._request_id))).status === "released" && (await row(WS3, String(other._request_id))).status === "released" && (await balance(WS3)) === 20,
  );
  const next = await reserve({ _max_credits: 1 });
  t("the workspace's own reservations still work (its lazy expiry skips the poisoned row)", next.status === "reserved", JSON.stringify(next));
  await db.query("DELETE FROM public.credit_ledger WHERE workspace_id = $1 AND ref_id = $2 AND delta = 1", [WS, ledgerRef(WS, String(bad._request_id))]);
  const repaired = await rpc("ai_reap_stale_reservations", {});
  t("once repaired, the next pass closes it", repaired.released === 1 && repaired.failed === 0 && (await row(WS, String(bad._request_id))).status === "released", JSON.stringify(repaired));
  t("the budget ledger matches the rows", await budgetConsistent());
}

// ---------------------------------------------------------------------------
console.log("\n=== round-4 H2: the per-workspace daily platform-cost cap ===");
{
  await resetMoney({ quota: 100, balance: 100 });
  await setSettings({ wsBudget: 10_000 });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const a = reserveArgs();
    ids.push(String(a._request_id));
    t(`hold ${i + 1} of 3000 under a 10000 workspace cap is reserved`, (await rpc("ai_reserve", a)).status === "reserved");
  }
  const quotaBefore = await quota(WS);
  const spentBefore = await spent();
  const fourth = await reserve();
  t("the 4th hold of the same workspace is refused: workspace_budget_exhausted", fourth.status === "workspace_budget_exhausted", JSON.stringify(fourth));
  t("…and nothing moved: no free-quota unit, no ceiling, no row", (await quota(WS)) === quotaBefore && (await spent()) === spentBefore && (await db.query("SELECT 1 FROM public.ai_spend_reservations WHERE workspace_id = $1", [WS])).rows.length === 3);
  t("another workspace is not affected", (await reserve({ _workspace_id: WS2, _user_id: MEMBER2 })).status === "reserved");
  const sum = Number(await rpc("ai_workspace_spent_micros", { _workspace_id: WS, _day: new Date().toISOString().slice(0, 10) }));
  t("ai_workspace_spent_micros is the day's sum of the workspace's holds (9000)", sum === 9000, String(sum));

  // A FAILED call that reported usage is refunded to the customer, but its
  // platform cost still counts toward the workspace's day (the H2 lever).
  await mark(WS, ids[0]!);
  const failed = await settle(WS, ids[0]!, { _cost_micros: 2500, _credits: 0, _outcome: "failed", _error: "thin_output" });
  t("a failed call is refunded in full (the free-quota unit comes back)", failed.status === "settled" && (await quota(WS)) === quotaBefore + 1, JSON.stringify(failed));
  t("…yet its 2500 still counts: 2500 + 3000 + 3000 + a new 3000 > 10000 → refused", (await reserve()).status === "workspace_budget_exhausted");
  await release(WS, ids[1]!);
  t("a released hold (never called) counts nothing: 2500 + 3000 + 3000 ≤ 10000 → reserved", (await reserve()).status === "reserved");
  // A failure with unknown usage keeps the full hold.
  await mark(WS, ids[2]!);
  await settle(WS, ids[2]!, { _cost_micros: null, _credits: null, _outcome: "failed", _error: "timeout" });
  t("…and a timeout keeps its full hold on the workspace's day", Number(await rpc("ai_workspace_spent_micros", { _workspace_id: WS, _day: new Date().toISOString().slice(0, 10) })) === 8500);

  t("byok is never refused by the workspace cap (it is not the platform's money)", (await reserve({ _billing_class: "byok" })).status === "reserved");
  t(
    "the daily briefing ('system') takes the workspace cap too",
    (await reserve({ _feature: "daily_briefing", _source: "daily_briefing", _billing_class: "system", _user_id: null, _max_credits: 0 })).status === "workspace_budget_exhausted",
  );
  t(
    "page generation on a beta grant ('granted') takes it too",
    (await reserve({ _feature: "page_generation", _source: "quick_page", _billing_class: "granted" })).status === "workspace_budget_exhausted",
  );

  // Yesterday's spend is not today's.
  await db.query("UPDATE public.ai_spend_reservations SET budget_day = budget_day - 1 WHERE workspace_id = $1", [WS]);
  t("a new UTC day starts from zero", (await reserve()).status === "reserved");

  // When the platform ceiling is also full, the workspace cap answers first.
  await resetMoney({ quota: 100 });
  await setSettings({ wsBudget: 3_000, budget: 6_000 });
  t("setup: one hold each for two workspaces fills both caps and the ceiling", (await reserve()).status === "reserved" && (await reserve({ _workspace_id: WS2, _user_id: MEMBER2 })).status === "reserved");
  t("both full: the workspace's own cap is what the customer hears", (await reserve()).status === "workspace_budget_exhausted");
  t("the platform ceiling still refuses a workspace that has room of its own", (await reserve({ _workspace_id: WS3, _user_id: MEMBER3 })).status === "budget_exhausted");
  t("the budget ledger matches the rows", await budgetConsistent());
}

// ---------------------------------------------------------------------------
console.log("\n=== the founder / internal unlimited entitlement in ai_reserve (decided in SQL) ===");
{
  await resetMoney({ quota: 5, balance: 0 });
  await setSettings({ wsBudget: 5_000 });
  t("no grant: not internal", (await one<{ v: boolean }>("SELECT public.workspace_is_internal_unlimited($1) AS v", [WS])).v === false);
  await grantInternal(WS);
  t("an active internal grant: internal", (await one<{ v: boolean }>("SELECT public.workspace_is_internal_unlimited($1) AS v", [WS])).v === true);
  t("…for THAT workspace only", (await one<{ v: boolean }>("SELECT public.workspace_is_internal_unlimited($1) AS v", [WS2])).v === false);

  const routes: Array<[string, Record<string, unknown>]> = [
    ["page_generation (tenant)", { _feature: "page_generation", _source: "quick_page", _max_output_tokens: 6000 }],
    ["page_generation (granted)", { _feature: "page_generation", _source: "quick_page", _billing_class: "granted" }],
    ["add_meta", { _feature: "add_meta", _source: "add_meta", _max_output_tokens: 800 }],
    ["fix_thin_page", { _feature: "fix_thin_page", _source: "fix_thin_page", _max_output_tokens: 3000 }],
    ["add_internal_links", { _feature: "add_internal_links", _source: "add_internal_links", _max_output_tokens: 4000 }],
    ["seo_coach", { _feature: "seo_coach", _source: "seo_coach" }],
    ["page_audit", { _feature: "page_audit", _source: "page_audit" }],
  ];
  for (const [label, o] of routes) {
    const r = await reserve(o);
    t(`internal, ${label}: billing 'internal' — no free-quota unit, no credits`, r.status === "reserved" && r.billing === "internal" && (await quota(WS)) === 5, JSON.stringify(r));
  }
  const holds = await db.query<any>("SELECT count(*)::int AS n FROM public.credit_ledger WHERE workspace_id = $1", [WS]);
  t("…no credit ledger row at all", holds.rows[0].n === 0);
  t(
    "exempt from the per-workspace cap: 7 holds of 3000 under a 5000 cap all reserved",
    Number(await rpc("ai_workspace_spent_micros", { _workspace_id: WS, _day: new Date().toISOString().slice(0, 10) })) === 21_000,
  );
  const sys = await reserve({ _feature: "daily_briefing", _source: "daily_briefing", _billing_class: "system", _user_id: null, _max_credits: 0 });
  t("the daily briefing stays 'system' and is exempt too", sys.status === "reserved" && sys.billing === "system", JSON.stringify(sys));
  t("its own key stays its own key ('byok')", (await reserve({ _billing_class: "byok" })).billing === "byok");
  const claim = await rpcErr("ai_reserve", reserveArgs({ _billing_class: "internal" }));
  t("no caller can claim 'internal' (22023): only the grant decides", claim?.code === "22023", JSON.stringify(claim));

  // The settlement: the customer pays nothing, the platform budget records the cost, usage is logged.
  const pay = reserveArgs({ _max_credits: 3 });
  await rpc("ai_reserve", pay);
  await mark(WS, String(pay._request_id));
  const st = await settle(WS, String(pay._request_id), { _cost_micros: 1200, _credits: 1 });
  t("settled: billing internal, 0 credits charged, cost 1200 on the platform budget", st.status === "settled" && st.billing === "internal" && st.credits_charged === 0 && Number((await row(WS, String(pay._request_id))).budget_micros) === 1200, JSON.stringify(st));
  const log = await one<any>("SELECT status, used_byok, cost_usd_micros FROM public.ai_usage_log WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1", [WS]);
  t("…and the usage is still recorded (ai_usage_log)", log?.status === "ok" && log?.used_byok === false && Number(log?.cost_usd_micros) === 1200);

  // Still under the platform's own limits.
  await setSettings({ budget: (await spent()) + 1_000 });
  t("the platform ceiling still applies to internal", (await reserve()).status === "budget_exhausted");
  await setSettings({ budget: 10_000_000, enabled: false });
  t("the kill switch still applies to internal", (await reserve()).status === "platform_paused");
  await setSettings({ enabled: true, rate: 1 });
  t("the per-minute rate limit still applies to internal", (await reserve()).status === "rate_limited");
  await setSettings({ rate: 1000 });

  // Revocation takes effect on the next reservation: tenant funds and the cap again.
  await revokeInternal(WS);
  const after = await reserve();
  t(
    "revoked: the very next reservation is under the workspace cap again — today's internal spend (way over 5000) counts, so it is refused",
    after.status === "workspace_budget_exhausted" && (await quota(WS)) === 5,
    JSON.stringify(after),
  );
  await db.query("UPDATE public.ai_spend_reservations SET budget_day = budget_day - 1 WHERE workspace_id = $1", [WS]);
  const fresh = await reserve();
  t("…and on a fresh day it is metered normally (free quota)", fresh.status === "reserved" && fresh.billing === "free_quota" && (await quota(WS)) === 4, JSON.stringify(fresh));
  await db.query(
    `INSERT INTO public.workspace_entitlement_grants (workspace_id, grant_type, page_limit, granted_by, reason, starts_at, expires_at)
     VALUES ($1, 'internal', 1000000, $2, 'test: expired', now() - interval '2 days', now() - interval '1 day'),
            ($1, 'internal', 1000000, $2, 'test: not started', now() + interval '1 day', NULL)`,
    [WS, ADMIN],
  );
  await setSettings({ wsBudget: 1_000_000 });
  t("an expired or not-yet-started internal grant is not internal", (await one<{ v: boolean }>("SELECT public.workspace_is_internal_unlimited($1) AS v", [WS])).v === false && (await reserve()).billing === "free_quota");
  const wrongLimit = await raises(null, `INSERT INTO public.workspace_entitlement_grants (workspace_id, grant_type, page_limit, granted_by, reason) VALUES ('${WS}', 'internal', 50, '${ADMIN}', 'x')`);
  t("an internal grant must be the maximum page grant (CHECK)", /workspace_entitlement_grants_internal_page_limit/.test(wrongLimit?.message ?? ""), JSON.stringify(wrongLimit));
  t("the budget ledger matches the rows", await budgetConsistent());
}

// ---------------------------------------------------------------------------
console.log("\n=== the on-demand briefing refresh throttle ===");
{
  await resetMoney();
  const allowed = (ws: string, secs = 600) => rpc<boolean>("coach_briefing_refresh_allowed", { _workspace_id: ws, _min_interval_seconds: secs });
  t("the first refresh of a workspace is let through", (await allowed(WS)) === true);
  t("a second one within the interval is not", (await allowed(WS)) === false && (await allowed(WS)) === false);
  t("another workspace has its own interval", (await allowed(WS2)) === true);
  await db.query("UPDATE public.coach_briefing_refreshes SET last_requested_at = now() - interval '601 seconds' WHERE workspace_id = $1", [WS]);
  t("after the interval one more is let through, and only one", (await allowed(WS)) === true && (await allowed(WS)) === false);
  const bad = await rpcErr("coach_briefing_refresh_allowed", { _workspace_id: WS, _min_interval_seconds: 0 });
  t("a zero interval is refused (22023)", bad?.code === "22023");
  const stranger = await rpcErr("coach_briefing_refresh_allowed", { _workspace_id: WS, _min_interval_seconds: 600 }, "service_role", STRANGER);
  t("a JWT user who is not a member is refused (42501)", stranger?.code === "42501");
}

// ---------------------------------------------------------------------------
console.log("\n=== the rollback with open holds, then a re-apply ===");
{
  await resetMoney({ quota: 0, balance: 10 });
  const open = reserveArgs({ _max_credits: 4 });
  await rpc("ai_reserve", open);
  const inflight = reserveArgs({ _max_credits: 2 });
  await rpc("ai_reserve", inflight);
  await mark(WS, String(inflight._request_id));
  // One row that cannot be closed (its refund key is occupied) must not
  // block the emergency rollback: it is listed, the rest is refunded.
  const poisoned = reserveArgs({ _workspace_id: WS2, _user_id: MEMBER2, _max_credits: 3 });
  await db.query("UPDATE public.credit_balances SET balance = 10 WHERE workspace_id = $1", [WS2]);
  await db.query("UPDATE public.workspace_ai_quota SET platform_credits_remaining = 0 WHERE workspace_id = $1", [WS2]);
  await rpc("ai_reserve", poisoned);
  await db.query("INSERT INTO public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id) VALUES ($1, 1, 'ai_refund', 'ai_spend', $2)", [WS2, ledgerRef(WS2, String(poisoned._request_id))]);
  t("before the rollback: 10 − 4 − 2 = 4", (await balance(WS)) === 4);
  const results = await db.exec(readRepo(ROLLBACK_800));
  const verify = (results[results.length - 1]?.rows ?? []) as Array<{ item: string }>;
  t(
    "the rollback's VERIFY lists the two restored objects and the one hold it could not close",
    verify.length === 3 && verify.filter((r) => /^restored /.test(r.item)).length === 2 &&
      verify.some((r) => r.item.startsWith(`UNCLOSED hold: workspace ${WS2} request ${poisoned._request_id} (held, credits, 3 credits`)),
    JSON.stringify(verify),
  );
  t("the rollback still completed: every ai table is gone", (await one<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('ai_spend_reservations','ai_budget_days','ai_platform_settings','coach_briefing_claims','coach_briefing_refreshes')")).n === 0);
  t("the open hold and the in-flight call were both refunded to the customer: 4 + 4 + 2 = 10", (await balance(WS)) === 10);
  const ledger = await db.query<any>("SELECT reason, delta FROM public.credit_ledger WHERE workspace_id = $1 ORDER BY created_at", [WS]);
  t("the ledger keeps its history (two holds, two refunds)", ledger.rows.filter((r: any) => r.reason === "ai_hold").length === 2 && ledger.rows.filter((r: any) => r.reason === "ai_refund").length === 2);
  const fn = await one<{ ok: boolean }>("SELECT to_regprocedure('public.settle_generation_free_quota(uuid,text,text,text)') IS NOT NULL AS ok");
  t("settle_generation_free_quota is back for the previous build", fn.ok === true);
  const again = await applyScript(MIGRATION_800);
  t("re-applying 000800 after the rollback verifies clean", again.length > 0 && again.every((r) => r.ok === true), JSON.stringify(again.filter((r) => r.ok !== true)));
}

await db.close();
const pkg = readRepo("package.json");
t("this suite is in the test chain", /bun tests\/ai-spend-sql\.test\.ts/.test(pkg));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
