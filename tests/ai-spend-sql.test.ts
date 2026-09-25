/**
 * THE 000800 SQL, EXECUTED. Run: bun tests/ai-spend-sql.test.ts
 *
 * Loads supabase/migrations/20260924000600 and 20260925000800 into PGlite
 * (Postgres compiled to WASM, in-process) on top of the Supabase stand-ins in
 * tests/_support/ai-db.ts, then drives the functions the app calls, as the
 * app calls them (the service role, PostgREST-style JWT claims):
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
 *   - the daily-briefing claim;
 *   - the migration's verification block, a re-run, the rollback with open
 *     holds, and a re-apply.
 *
 * PGlite is one connection: this suite proves the logic. Concurrency (many
 * connections racing for the same rows) is proven on a real Postgres 16 by
 * tests/ai-concurrency.pg.ts (bun run test:pg).
 */
import { PGlite } from "@electric-sql/pglite";
import {
  MIGRATION_600,
  MIGRATION_800,
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
const MEMBER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER2 = "abababab-abab-4bab-8bab-abababababab";
const STRANGER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let seq = 0;
const rid = () => `cccccccc-cccc-4ccc-8ccc-${String(++seq).padStart(12, "0")}`;

const db = await PGlite.create();
await db.exec(SUPABASE_STUBS);
await db.exec(`
  INSERT INTO public.workspaces (id) VALUES ('${WS}'), ('${WS2}');
  INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
    ('${WS}', '${MEMBER}', 'owner'), ('${WS2}', '${MEMBER2}', 'owner');
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
const setSettings = (o: { enabled?: boolean; budget?: number; rate?: number }) =>
  db.query(
    `UPDATE public.ai_platform_settings SET
       platform_ai_enabled = COALESCE($1, platform_ai_enabled),
       daily_budget_micros = COALESCE($2, daily_budget_micros),
       workspace_reservations_per_minute = COALESCE($3, workspace_reservations_per_minute)`,
    [o.enabled ?? null, o.budget ?? null, o.rate ?? null],
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
    DELETE FROM public.coach_daily_briefings;
    UPDATE public.platform_settings SET value = 'false'::jsonb WHERE key = 'generation_paused';
  `);
  await setSettings({ enabled: true, budget: 10_000_000, rate: 1000 });
  for (const ws of [WS, WS2]) {
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
console.log("\n=== the chain loads (000600 → 000800), verifies itself, re-runs harmlessly ===");
{
  const six = await applyScript(MIGRATION_600);
  t("000600 applies and verifies", six.length > 0 && six.every((r) => r.ok === true), JSON.stringify(six.filter((r) => r.ok !== true)));
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
  ];
  for (const role of ["authenticated", "anon"] as const) {
    for (const [name, args] of calls) {
      const err = await rpcErr(name, args, role, MEMBER);
      t(`${role} cannot execute ${name} (even as a member)`, !!err && /permission denied/.test(err.message), err?.message);
    }
    for (const table of ["ai_spend_reservations", "ai_platform_settings", "ai_budget_days", "coach_briefing_claims"]) {
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
  t("…with one ledger row: ai_hold −3, ref '<request>#1'", hold.rows.length === 1 && hold.rows[0].delta === -3 && hold.rows[0].reason === "ai_hold" && hold.rows[0].ref_type === "ai_spend" && hold.rows[0].ref_id === `${id}#1`, JSON.stringify(hold.rows));
  await mark(WS, id);
  const s = await settle(WS, id, { _cost_micros: 1500, _credits: 1 });
  t("settle charges the actual credits (1) and refunds the rest (2)", s.status === "settled" && s.credits_charged === 1 && (await balance(WS)) === 9, JSON.stringify(s));
  const refund = await db.query<any>("SELECT delta FROM public.credit_ledger WHERE workspace_id = $1 AND reason = 'ai_refund'", [WS]);
  t("…one ai_refund +2 row", refund.rows.length === 1 && refund.rows[0].delta === 2);
  const life = await one<any>("SELECT lifetime_spent FROM public.credit_balances WHERE workspace_id = $1", [WS]);
  t("lifetime_spent grows by the charge only (1)", life.lifetime_spent === 1);
  const dupe = await raises(null, `INSERT INTO public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id) VALUES ('${WS}', 2, 'ai_refund', 'ai_spend', '${id}#1')`);
  t("a second refund of the same hold is impossible (unique index, 23505)", dupe?.code === "23505", JSON.stringify(dupe));
  const dupeHold = await raises(null, `INSERT INTO public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id) VALUES ('${WS}', -3, 'ai_hold', 'ai_spend', '${id}#1')`);
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
console.log("\n=== the rollback with open holds, then a re-apply ===");
{
  await resetMoney({ quota: 0, balance: 10 });
  const open = reserveArgs({ _max_credits: 4 });
  await rpc("ai_reserve", open);
  const inflight = reserveArgs({ _max_credits: 2 });
  await rpc("ai_reserve", inflight);
  await mark(WS, String(inflight._request_id));
  t("before the rollback: 10 − 4 − 2 = 4", (await balance(WS)) === 4);
  const results = await db.exec(readRepo(ROLLBACK_800));
  const verify = (results[results.length - 1]?.rows ?? []) as Array<{ item: string }>;
  t(
    "the rollback's VERIFY lists exactly the two restored objects",
    verify.length === 2 && verify.every((r) => /^restored /.test(r.item)),
    JSON.stringify(verify),
  );
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
