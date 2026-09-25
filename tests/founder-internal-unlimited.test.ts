/**
 * THE FOUNDER / INTERNAL UNLIMITED ENTITLEMENT. Run: bun tests/founder-internal-unlimited.test.ts
 *
 * Owner request 2026-09-25: the founder's own workspace must work end to end
 * with no usage limits — through the entitlement architecture (an ACTIVE
 * grant_type 'internal' grant, 20260924000700), never through an email
 * address, a platform role or the client, and without making anyone else
 * unlimited.
 *
 *   A. the data migration 20260925000930 on PGlite (the full AI chain under
 *      it): every guard (no workspace, wrong owner, a second owner, a granter
 *      that is missing or not an admin) writes nothing; with every guard met
 *      it writes exactly the one row documented; a second run writes nothing;
 *      another workspace owned by the platform admin, and the founder's
 *      fellow members' own workspaces, are NOT internal; the grant then drives
 *      the SQL (capacity, ai_reserve billing 'internal' and the workspace-cap
 *      exemption); the rollback revokes that grant and nothing else, twice
 *      safely; re-applying after a rollback grants again;
 *   B. the predicate and the UI fields, computed on the server per request:
 *      readEntitlement / readBetaStatus through a fake PostgREST (internal,
 *      ordinary, revoked, a failed read), no cache, keyed by the workspace
 *      only; the server functions that return them are member-only and take
 *      nothing from the client but a workspace id;
 *   C. the feature gates that honour it (affiliate add-on, custom domains,
 *      Opportunity Engine enrollment) and the admin screen's server functions
 *      (platform admins only; 'internal' creatable and revocable, always the
 *      maximum page grant).
 *
 * The rest of the proof lives beside the code it covers:
 * tests/entitlement-grants.test.ts (decideCapacity vs workspace_capacity, live,
 * with and without the grant), tests/ai-spend-sql.test.ts (ai_reserve on every
 * route, kill switch / ceiling / rate limit still apply, revocation),
 * tests/generation-flow.test.ts (the daily cap lifted, the slot kept),
 * tests/ai-flows.test.ts (the launch-hidden AI routes' gates, Opportunity
 * Engine enrollment) and tests/ai-allowance.test.ts (the AI figure).
 */
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { FakeBackend } from "./_support/fake-backend";
import { AI_CHAIN, MIGRATION_930, ROLLBACK_930, SUPABASE_STUBS, readRepo, rpcSql, type CheckRow } from "./_support/ai-db";

const backend = new FakeBackend();
backend.install();

const { readEntitlement, readBetaStatus } = await import("../src/lib/entitlements.functions");
const { isInternalUnlimited, isInternalUnlimitedOrFalse, affiliateAddonUsable, GRANT_TYPES } = await import(
  "../src/lib/entitlement-grants.server"
);
const { INTERNAL_UNLIMITED_PAGE_LIMIT, INTERNAL_UNLIMITED_PLAN_LABEL } = await import("../src/lib/billing-capacity");
const { GrantInputSchema, GRANT_TYPE_OPTIONS, grantPageLimit, INTERNAL_GRANT_PAGE_LIMIT } = await import(
  "../src/lib/admin-entitlement-grants.functions"
);

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

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const origError = console.error;
const logs: string[] = [];
console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));

// The three ids the migration names.
const FOUNDER_WS = "509e5a42-7eb9-4bdb-8b6c-981a15b69dce";
const OWNER = "7b3618d3-4d54-4974-8daf-2845777ccc28";
const GRANTER = "26c3147d-89eb-4491-9882-f7da344657fc";
const REASON = "Founder internal unlimited account for end-to-end product testing (owner request 2026-09-25)";
const SOURCE = "migration 20260925000930_founder_internal_unlimited";
// Everyone else.
const STRANGER = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";
const TEAMMATE = "6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b";
const ADMIN_WS = "7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c";
const TEAMMATE_WS = "8d8d8d8d-8d8d-4d8d-8d8d-8d8d8d8d8d8d";
const OTHER_INTERNAL_WS = "9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e";

try {
  // =========================================================================
  console.log("\n=== A. the data migration 20260925000930 (PGlite, the full AI chain under it) ===");
  // =========================================================================
  const db = await PGlite.create();
  await db.exec(SUPABASE_STUBS);
  // has_role / user_roles predate this repo's migration chain; the same
  // reconstruction tests/prnm-isolation.test.ts uses.
  await db.exec(`
    CREATE TYPE public.app_role AS ENUM ('admin', 'editor', 'user');
    CREATE TABLE public.user_roles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      role public.app_role NOT NULL,
      UNIQUE (user_id, role)
    );
    CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
      AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
  `);
  for (const f of AI_CHAIN) await db.exec(readRepo(f));

  const migration = readRepo(MIGRATION_930);
  const rollback = readRepo(ROLLBACK_930);
  /** Apply the migration; its verification rows (the last statement). */
  const apply = async () => {
    const results = await db.exec(migration);
    return results.at(-1)!.rows as CheckRow[];
  };
  const internalRows = async () =>
    (
      await db.query<Record<string, any>>(
        `SELECT workspace_id, grant_type, page_limit, starts_at <= now() AS started, expires_at, revoked_at,
                granted_by, reason, metadata
           FROM public.workspace_entitlement_grants WHERE grant_type = 'internal' ORDER BY created_at, id`,
      )
    ).rows;
  const isInternal = async (ws: string) =>
    (await db.query<{ v: boolean }>("SELECT public.workspace_is_internal_unlimited($1) AS v", [ws])).rows[0]!.v;
  const capacity = async (ws: string) =>
    (await db.query<{ state: string; serve: boolean; publish: boolean; page_limit: number }>(
      "SELECT state, serve, publish, page_limit FROM public.workspace_capacity($1)",
      [ws],
    )).rows[0]!;
  const allTrue = (rows: CheckRow[]) => rows.length > 0 && rows.every((r) => r.ok === true);

  // --- guard 1: the workspace does not exist -------------------------------
  {
    const checks = await apply();
    t("guard: no such workspace → nothing written", (await internalRows()).length === 0);
    t(
      "…and the verification says so (the grant, the predicate and the capacity rows read false)",
      checks.length === 4 && checks[0]!.ok === false && checks[1]!.ok === false && checks[2]!.ok === true && checks[3]!.ok === false,
      JSON.stringify(checks),
    );
  }
  // The founder workspace: an ended trial, 25-page base (it must still work).
  await db.exec(`
    INSERT INTO auth.users (id) VALUES ('${OWNER}'), ('${GRANTER}'), ('${STRANGER}'), ('${TEAMMATE}');
    INSERT INTO public.workspaces (id, name, subscription_status, trial_ends_at)
      VALUES ('${FOUNDER_WS}', 'My Marketplace', 'trialing', now() - interval '10 days');
  `);
  // --- guard 2: the owner is someone else ----------------------------------
  await db.exec(`
    INSERT INTO public.user_roles (user_id, role) VALUES ('${GRANTER}', 'admin');
    INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ('${FOUNDER_WS}', '${STRANGER}', 'owner');
  `);
  await apply();
  t("guard: the workspace's owner is not the founder → nothing written", (await internalRows()).length === 0);
  // The founder is a member there but not the owner: still nothing.
  await db.exec(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ('${FOUNDER_WS}', '${OWNER}', 'member')`);
  await apply();
  t("guard: the founder is only a member (someone else owns it) → nothing written", (await internalRows()).length === 0);
  // --- guard 3: two owners, one of them the founder ------------------------
  await db.exec(`UPDATE public.workspace_members SET role = 'owner' WHERE workspace_id = '${FOUNDER_WS}' AND user_id = '${OWNER}'`);
  await apply();
  t("guard: the founder is not the ONLY owner → nothing written", (await internalRows()).length === 0);
  await db.exec(`DELETE FROM public.workspace_members WHERE workspace_id = '${FOUNDER_WS}' AND user_id = '${STRANGER}'`);
  // --- guard 4: the granter is not a platform admin ------------------------
  await db.exec(`DELETE FROM public.user_roles WHERE user_id = '${GRANTER}'`);
  await apply();
  t("guard: the granting account is not a platform admin → nothing written", (await internalRows()).length === 0);
  await db.exec(`INSERT INTO public.user_roles (user_id, role) VALUES ('${GRANTER}', 'editor')`);
  await apply();
  t("guard: …an 'editor' role is not admin either → nothing written", (await internalRows()).length === 0);
  // --- guard 5: the granter does not exist ---------------------------------
  await db.exec(`
    DELETE FROM public.user_roles WHERE user_id = '${GRANTER}';
    INSERT INTO public.user_roles (user_id, role) VALUES ('${GRANTER}', 'admin');
    DELETE FROM auth.users WHERE id = '${GRANTER}';
  `);
  await apply();
  t("guard: the granting account does not exist → nothing written", (await internalRows()).length === 0);
  await db.exec(`INSERT INTO auth.users (id) VALUES ('${GRANTER}')`);

  // A teammate in the founder workspace who owns a workspace of their own,
  // and a workspace the platform admin owns: neither may inherit anything.
  await db.exec(`
    INSERT INTO public.workspaces (id, name, subscription_status, trial_ends_at) VALUES
      ('${ADMIN_WS}', 'Admin sandbox', 'trialing', now() + interval '5 days'),
      ('${TEAMMATE_WS}', 'Teammate shop', 'trialing', now() - interval '1 day');
    INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
      ('${ADMIN_WS}', '${GRANTER}', 'owner'),
      ('${TEAMMATE_WS}', '${TEAMMATE}', 'owner'),
      ('${FOUNDER_WS}', '${TEAMMATE}', 'member');
  `);

  // --- every guard met: exactly one row -----------------------------------
  const before = Date.now();
  const checks = await apply();
  const rows = await internalRows();
  const r = rows[0] ?? {};
  t("every guard met → exactly ONE internal grant in the whole table", rows.length === 1, JSON.stringify(rows));
  t("…for workspace 509e5a42-7eb9-4bdb-8b6c-981a15b69dce", r.workspace_id === FOUNDER_WS);
  t("…grant_type 'internal', page_limit 1000000 (the CHECK's maximum)", r.grant_type === "internal" && r.page_limit === 1_000_000);
  t("…started (starts_at = now()), permanent (expires_at NULL), active (revoked_at NULL)", r.started === true && r.expires_at === null && r.revoked_at === null);
  t("…granted_by the platform admin account 26c3147d-…", r.granted_by === GRANTER);
  t("…the reason, verbatim", r.reason === REASON, String(r.reason));
  t(
    "…metadata: its source (what the rollback matches) and the label",
    JSON.stringify(r.metadata) === JSON.stringify({ label: "Founder / Internal Unlimited", source: SOURCE }),
    JSON.stringify(r.metadata),
  );
  t("…and every verification row reads true", allTrue(checks), JSON.stringify(checks));
  t(
    "the verification rows are the four documented checks",
    checks.map((c) => c.check).join(" | ") ===
      "founder workspace holds exactly one active, permanent internal grant | the predicate says the founder workspace is internal unlimited | no other workspace holds an active internal grant | capacity reads internal: serve, publish, no page limit",
    checks.map((c) => c.check).join(" | "),
  );
  t("the founder workspace is internal unlimited", await isInternal(FOUNDER_WS));
  {
    const c = await capacity(FOUNDER_WS);
    t(
      "…its ended trial reads 'internal': serves, publishes, no page limit (2147483647)",
      c.state === "internal" && c.serve && c.publish && c.page_limit === INTERNAL_UNLIMITED_PAGE_LIMIT,
      JSON.stringify(c),
    );
  }
  t("a workspace the platform admin owns is NOT internal", !(await isInternal(ADMIN_WS)));
  t("…and keeps its own facts (a live trial)", (await capacity(ADMIN_WS)).state === "trialing");
  t("a teammate's own workspace is NOT internal (membership in the founder's inherits nothing)", !(await isInternal(TEAMMATE_WS)));
  t("…and its ended trial still reads trial_expired", (await capacity(TEAMMATE_WS)).state === "trial_expired");
  t("the written row is younger than this test (now(), not a fixed date)", before - 60_000 < Date.now());

  // --- a second run writes nothing ----------------------------------------
  {
    const again = await apply();
    t("second run → nothing written: still exactly one internal grant", (await internalRows()).length === 1);
    t("…and the verification still reads true", allTrue(again), JSON.stringify(again));
  }

  // --- the grant drives the spend SQL -------------------------------------
  {
    const call = async (name: string, args: Record<string, unknown>, uid: string) => {
      const q = rpcSql(name, args);
      await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: "service_role", sub: uid })]);
      await db.exec("SET ROLE service_role");
      try {
        return (await db.query<{ result: any }>(q.text, q.values)).rows[0]!.result;
      } finally {
        await db.exec("RESET ROLE");
        await db.query(`SELECT set_config('request.jwt.claims', '', false)`);
      }
    };
    let seq = 0;
    const reserve = (ws: string, uid: string) =>
      call(
        "ai_reserve",
        {
          _workspace_id: ws,
          _request_id: `f0f0f0f0-f0f0-4f0f-8f0f-${String(++seq).padStart(12, "0")}`,
          _user_id: uid,
          _feature: "page_generation",
          _source: "quick_page",
          _model: "gpt-5-nano",
          _max_input_tokens: 1000,
          _max_output_tokens: 6000,
          _max_cost_micros: 3000,
          _max_credits: 1,
          _billing_class: "tenant",
        },
        uid,
      );
    await db.exec("UPDATE public.ai_platform_settings SET workspace_daily_budget_micros = 5000");
    const f1 = await reserve(FOUNDER_WS, OWNER);
    const f2 = await reserve(FOUNDER_WS, OWNER);
    t(
      "ai_reserve: the founder workspace is billed 'internal' (no free-quota unit, no credits) on a tenant route",
      f1?.status === "reserved" && f1?.billing === "internal" && f2?.status === "reserved" && f2?.billing === "internal",
      JSON.stringify([f1, f2]),
    );
    t("…and is exempt from the per-workspace daily cost cap (6000 held against a 5000 cap)", f2?.status === "reserved");
    const a1 = await reserve(ADMIN_WS, GRANTER);
    const a2 = await reserve(ADMIN_WS, GRANTER);
    t(
      "the admin's own workspace is billed as a tenant (free quota) and IS capped",
      a1?.status === "reserved" && a1?.billing === "free_quota" && a2?.status === "workspace_budget_exhausted",
      JSON.stringify([a1, a2]),
    );
    await db.exec("UPDATE public.ai_platform_settings SET workspace_daily_budget_micros = 1000000");
  }

  // --- the rollback: that grant, nothing else -----------------------------
  // Two grants the rollback must not touch: a beta grant on the founder
  // workspace, and an internal grant an admin gave another workspace.
  await db.exec(`
    INSERT INTO public.workspaces (id, name) VALUES ('${OTHER_INTERNAL_WS}', 'Another internal');
    INSERT INTO public.workspace_entitlement_grants (workspace_id, grant_type, page_limit, granted_by, reason)
      VALUES ('${FOUNDER_WS}', 'beta', 50, '${GRANTER}', 'beta alongside'),
             ('${OTHER_INTERNAL_WS}', 'internal', 1000000, '${GRANTER}', 'admin screen');
  `);
  {
    const results = await db.exec(rollback);
    const verify = results.at(-1)!.rows[0] as Record<string, unknown>;
    const all = (
      await db.query<{ workspace_id: string; grant_type: string; revoked: boolean; source: string | null }>(
        `SELECT workspace_id, grant_type, revoked_at IS NOT NULL AS revoked, metadata ->> 'source' AS source
           FROM public.workspace_entitlement_grants ORDER BY created_at, id`,
      )
    ).rows;
    const revoked = all.filter((g) => g.revoked);
    t(
      "rollback: exactly the migration's grant is revoked (revoked_at set; the row is kept as history)",
      revoked.length === 1 && revoked[0]!.workspace_id === FOUNDER_WS && revoked[0]!.grant_type === "internal" && revoked[0]!.source === SOURCE,
      JSON.stringify(all),
    );
    t("…the founder's beta grant and another workspace's internal grant stay active", all.filter((g) => !g.revoked).length === 2);
    t(
      "…its VERIFY reads migration_grant_active 0, active_internal_grants 0, still_internal false",
      Number(verify.migration_grant_active) === 0 && Number(verify.active_internal_grants) === 0 && verify.still_internal === false,
      JSON.stringify(verify),
    );
    t("the founder workspace is no longer internal", !(await isInternal(FOUNDER_WS)));
    const c = await capacity(FOUNDER_WS);
    t(
      "…and falls back to its own facts on the next read: the beta grant (50 pages) over the ended trial",
      c.state === "granted" && c.page_limit === 50 && c.serve && c.publish,
      JSON.stringify(c),
    );
    t("the other internal workspace is untouched", await isInternal(OTHER_INTERNAL_WS));
  }
  {
    const stamp = async () =>
      (await db.query<{ r: string }>(`SELECT revoked_at::text AS r FROM public.workspace_entitlement_grants WHERE metadata ->> 'source' = $1`, [SOURCE])).rows[0]!.r;
    const first = await stamp();
    await db.exec(rollback);
    t("rollback twice: nothing changes (the revocation time stands)", (await stamp()) === first);
  }
  // Re-applying after a rollback grants again (none active): one new row,
  // the revoked one kept.
  {
    const results = await apply();
    const rowsNow = (await internalRows()).filter((g) => g.workspace_id === FOUNDER_WS);
    t(
      "re-applying after the rollback writes one new active grant; the revoked one stays as history",
      rowsNow.length === 2 && rowsNow.filter((g) => g.revoked_at === null).length === 1 && (await isInternal(FOUNDER_WS)),
      JSON.stringify(rowsNow),
    );
    // The other internal workspace (added above) makes the "no other
    // workspace" verification row honest: it reads false now.
    t(
      "…and the verification is honest about another workspace holding an internal grant",
      results[0]!.ok === true && results[1]!.ok === true && results[2]!.ok === false,
      JSON.stringify(results),
    );
  }
  t(
    "the migration is data only: no DDL, no function, no grant change",
    // Statements only: the notices and check labels say "grant" in prose.
    !/^\s*(CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|DELETE)\b/im.test(migration.replace(/--.*$/gm, "")) &&
      (migration.match(/^\s*INSERT INTO /gm) ?? []).length === 1,
  );
  t(
    "the migration derives nothing from an email address or from who is an admin beyond the granter check",
    !/email|@/i.test(migration.replace(/--.*$/gm, "")) && (migration.match(/has_role\(/g) ?? []).length === 1,
  );
  t(
    "the rollback only ever sets revoked_at, on the migration's own grant",
    /UPDATE public\.workspace_entitlement_grants\s+SET revoked_at = now\(\)\s+WHERE workspace_id = '509e5a42-7eb9-4bdb-8b6c-981a15b69dce'\s+AND grant_type = 'internal'\s+AND revoked_at IS NULL\s+AND metadata ->> 'source' = 'migration 20260925000930_founder_internal_unlimited';/.test(
      rollback,
    ) && !/\bDELETE\b/i.test(rollback.replace(/--.*$/gm, "")),
  );
  await db.close();

  // =========================================================================
  console.log("\n=== B. the predicate and the UI fields, on the server, per request ===");
  // =========================================================================
  const WS = "11111111-1111-4111-8111-111111111111";
  const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
  /** A workspace whose trial ended ten days ago (25-page base), optionally with a beta grant. */
  const world = (o: { internal: boolean | "error"; granted?: number }) => {
    backend.reset();
    backend.rest["GET workspaces"] = () => [
      {
        plan: null,
        subscription_status: "trialing",
        trial_ends_at: past,
        current_period_end: null,
        page_limit_base: 25,
        page_limit_addon: 0,
        page_limit_bonus: 0,
        page_bonus_expires_at: null,
      },
    ];
    backend.rpc.workspace_granted_pages = () => (o.internal === true ? 1_000_000 : 0) + (o.granted ?? 0);
    backend.rpc.workspace_is_internal_unlimited = (a: any) =>
      o.internal === "error" ? { status: 500, body: { message: "read exploded" } } : a._workspace_id === WS && o.internal;
    backend.rest["GET workspace_entitlement_grants"] = () =>
      o.granted ? [{ page_limit: o.granted, starts_at: past, expires_at: null, revoked_at: null }] : [];
  };

  world({ internal: true });
  {
    const e = await readEntitlement(WS);
    t(
      "readEntitlement (getPageEntitlement): internal — billingState 'internal', publish, serve, page limit 2147483647",
      e.billingState === "internal" && e.canPublish && e.pagesServe && e.pageLimit === INTERNAL_UNLIMITED_PAGE_LIMIT,
      JSON.stringify(e),
    );
    t(
      "…internalUnlimited true, planLabel 'Founder / Internal Unlimited', revealLaunchHiddenFeatures true",
      e.internalUnlimited === true && e.planLabel === INTERNAL_UNLIMITED_PLAN_LABEL && e.revealLaunchHiddenFeatures === true,
    );
    t("…even though its trial ended ten days ago (no trial expiry while the grant is active)", e.isTrial === true && e.billingState !== "trial_expired");
    t("…decided by THE predicate, for this workspace only", backend.rpcHits("workspace_is_internal_unlimited").map((h) => JSON.stringify(h.body)).join() === JSON.stringify({ _workspace_id: WS }));
  }
  world({ internal: false });
  {
    const e = await readEntitlement(WS);
    t(
      "the same workspace without the grant (or after revocation): trial_expired, no publish, no serve, 0 pages",
      e.billingState === "trial_expired" && !e.canPublish && !e.pagesServe && e.pageLimit === 0,
      JSON.stringify(e),
    );
    t(
      "…internalUnlimited false, planLabel null, revealLaunchHiddenFeatures false",
      e.internalUnlimited === false && e.planLabel === null && e.revealLaunchHiddenFeatures === false,
    );
  }
  world({ internal: false, granted: 50 });
  {
    const e = await readEntitlement(WS);
    t("a beta-granted workspace reads exactly as before ('granted', 50 pages), not internal", e.billingState === "granted" && e.pageLimit === 50 && e.internalUnlimited === false, JSON.stringify(e));
    const b = await readBetaStatus(WS);
    t("…and its beta status is a beta (50 pages), not internal", b.beta === true && b.pageLimit === 50 && b.internalUnlimited === false && b.planLabel === null, JSON.stringify(b));
  }
  world({ internal: "error" });
  {
    let threw = false;
    try {
      await readEntitlement(WS);
    } catch {
      threw = true;
    }
    t("a failed predicate read fails the entitlement read (never 'unlimited', never a wrong number)", threw);
  }
  world({ internal: true });
  {
    const b = await readBetaStatus(WS);
    t(
      "readBetaStatus (getBetaStatus): internal is not a free beta — beta false, with the internal fields",
      b.beta === false && b.pageLimit === 0 && b.internalUnlimited === true && b.planLabel === INTERNAL_UNLIMITED_PLAN_LABEL && b.revealLaunchHiddenFeatures === true,
      JSON.stringify(b),
    );
  }
  world({ internal: "error", granted: 50 });
  {
    const b = await readBetaStatus(WS);
    t("…a failed read there reads 'not internal' (the beta banner still works)", b.beta === true && b.internalUnlimited === false, JSON.stringify(b));
  }
  // No cache: the next read sees the next answer.
  {
    backend.reset();
    let answer = true;
    backend.rpc.workspace_is_internal_unlimited = () => answer;
    const first = await isInternalUnlimited(WS);
    answer = false;
    const second = await isInternalUnlimited(WS);
    answer = true;
    const third = await isInternalUnlimited(WS);
    t("no cache: every call asks the database (true → revoked → granted again)", first && !second && third && backend.rpcHits("workspace_is_internal_unlimited").length === 3);
    for (const [label, v] of [["the string 'true'", "true"], ["1", 1], ["null", null], ["an object", { ok: true }]] as const) {
      backend.rpc.workspace_is_internal_unlimited = () => v;
      t(`only a literal true is internal (${label} is not)`, (await isInternalUnlimited(WS)) === false);
    }
    backend.rpc.workspace_is_internal_unlimited = () => ({ status: 500, body: { message: "read exploded" } });
    let threw = false;
    try {
      await isInternalUnlimited(WS);
    } catch {
      threw = true;
    }
    t("isInternalUnlimited throws on a failed read (each caller picks its direction)", threw);
    t("isInternalUnlimitedOrFalse: a failed read is 'no', logged", (await isInternalUnlimitedOrFalse(WS)) === false && logs.some((l) => l.includes("internal entitlement read failed")));
  }
  {
    const grantsSrc = read("src/lib/entitlement-grants.server.ts");
    const pred = grantsSrc.slice(grantsSrc.indexOf("export async function isInternalUnlimited("), grantsSrc.indexOf("/** isInternalUnlimited for a limit"));
    t(
      "the predicate is keyed by the workspace only: one RPC argument, no user, email, role or client value",
      /client\.rpc\("workspace_is_internal_unlimited", \{\s*_workspace_id: workspaceId,\s*\}\)/.test(pred) && !/email|has_role|is_admin|userId|user_id/i.test(pred),
      pred.slice(0, 200),
    );
    t(
      "no module-level cache in the predicate's module",
      !/^(const|let|var)\s+\w+\s*=\s*new (Map|WeakMap|Set)\(/m.test(grantsSrc) && !/\bcache\b/i.test(grantsSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")),
    );
    const sqlPred = read("supabase/migrations/20260924000700_grant_supersedes_trial.sql");
    const fn = sqlPred.slice(sqlPred.indexOf("CREATE OR REPLACE FUNCTION public.workspace_is_internal_unlimited("), sqlPred.indexOf("CREATE OR REPLACE FUNCTION public.workspace_capacity("));
    t(
      "the SQL predicate reads the grants table only: an active 'internal' grant for that workspace",
      /FROM public\.workspace_entitlement_grants/.test(fn) &&
        /grant_type = 'internal'/.test(fn) &&
        /revoked_at IS NULL/.test(fn) &&
        /starts_at <= now\(\)/.test(fn) &&
        /\(expires_at IS NULL OR expires_at > now\(\)\)/.test(fn) &&
        !/auth\.|email|has_role|user_roles/i.test(fn),
      fn.slice(0, 300),
    );
    t(
      "…and only the service role may call it",
      /REVOKE ALL ON FUNCTION public\.workspace_is_internal_unlimited\(uuid\) FROM PUBLIC, anon, authenticated;/.test(sqlPred) &&
        /GRANT EXECUTE ON FUNCTION public\.workspace_is_internal_unlimited\(uuid\) TO service_role;/.test(sqlPred),
    );
  }
  {
    // The server functions that return the fields: member-only, a workspace id in, the fields computed inside.
    const block = (src: string, name: string) => {
      const at = src.indexOf(`export const ${name} = createServerFn(`);
      const next = src.indexOf("\nexport ", at + 1);
      return at < 0 ? "" : src.slice(at, next < 0 ? undefined : next);
    };
    const ent = read("src/lib/entitlements.functions.ts");
    for (const [name, reader] of [
      ["getPageEntitlement", "readEntitlement"],
      ["getBetaStatus", "readBetaStatus"],
    ] as const) {
      const b = block(ent, name);
      t(
        `${name}: authenticated, a workspace id only, membership checked before the read`,
        /\.middleware\(\[requireSupabaseAuth\]\)/.test(b) &&
          /\.inputValidator\(\(d\) => z\.object\(\{ workspaceId: z\.string\(\)\.uuid\(\) \}\)\.parse\(d\)\)/.test(b) &&
          new RegExp(`if \\(!isMember\\) throw new Error\\("forbidden"\\);\\s*return ${reader}\\(data\\.workspaceId\\);`).test(b),
        b.slice(0, 200),
      );
    }
    t(
      "readEntitlement and readBetaStatus spread the fields from the server predicate only",
      /isInternalUnlimited\(workspaceId\),\s*\]\);/.test(ent) &&
        /\.\.\.internalAccessFields\(internal\),\s*\};\s*\}/.test(ent) &&
        /const internal = await isInternalUnlimitedOrFalse\(workspaceId\);/.test(ent),
    );
    const settings = block(read("src/lib/settings.functions.ts"), "getSettingsContext");
    t(
      "getSettingsContext: membership first, then the predicate for data.workspaceId, the fields spread into the answer",
      settings.indexOf("await assertWorkspaceMember(data.workspaceId, context.userId);") > 0 &&
        settings.indexOf("await assertWorkspaceMember(data.workspaceId, context.userId);") < settings.indexOf("isInternalUnlimitedOrFalse(data.workspaceId)") &&
        /\.\.\.internalAccessFields\(internal\),/.test(settings),
    );
    const allowance = block(read("src/lib/ai-allowance.functions.ts"), "getAiAllowance");
    t("getAiAllowance: membership first (the fields come from readAiAllowance)", /await assertWorkspaceMember\(data\.workspaceId, context\.userId\);\s*return await readAiAllowance\(data\.workspaceId\);/.test(allowance));
    const targets = block(read("src/lib/generation.functions.ts"), "listGenerationTargets");
    t(
      "listGenerationTargets: membership first, internalUnlimited from the predicate",
      targets.indexOf("await assertWorkspaceMember(data.workspaceId, context.userId);") > 0 &&
        targets.indexOf("await assertWorkspaceMember(data.workspaceId, context.userId);") < targets.indexOf("isInternalWorkspace(data.workspaceId)"),
    );
    // Every producer of the fields, across src/: the four readers above (and the definition).
    const walk = (dir: string, out: string[] = []): string[] => {
      if (!existsSync(dir)) return out;
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(name)) out.push(p);
      }
      return out;
    };
    const producers = walk(join(ROOT, "src"))
      .map((f) => relative(ROOT, f))
      .filter((f) => /internalAccessFields\(/.test(read(f)))
      .sort();
    t(
      "the fields are produced in exactly four server modules (and defined in billing-capacity.ts)",
      producers.join() ===
        ["src/lib/ai-allowance.functions.ts", "src/lib/billing-capacity.ts", "src/lib/entitlements.functions.ts", "src/lib/settings.functions.ts"].join(),
      producers.join(", "),
    );
    const clientSide = walk(join(ROOT, "src"))
      .map((f) => relative(ROOT, f))
      .filter((f) => /^src\/(routes|components|hooks)\//.test(f))
      .filter((f) => /workspace_is_internal_unlimited|isInternalUnlimited\(|internalAccessFields\(/.test(read(f)));
    t("no route or component computes the entitlement itself", clientSide.length === 0, clientSide.join(", "));
  }

  // =========================================================================
  console.log("\n=== C. the gates that honour it, and the admin screen ===");
  // =========================================================================
  {
    backend.reset();
    backend.rpc.workspace_is_internal_unlimited = () => true;
    t("affiliate add-on: an internal workspace may use it with no add-on of its own", (await affiliateAddonUsable(WS, "inactive")) === true);
    backend.rpc.workspace_is_internal_unlimited = () => false;
    t("…an ordinary workspace without the add-on may not", (await affiliateAddonUsable(WS, "inactive")) === false);
    backend.reset();
    t("…an active or trialing add-on needs no entitlement read", (await affiliateAddonUsable(WS, "active")) && (await affiliateAddonUsable(WS, "trialing")) && backend.rpcHits("workspace_is_internal_unlimited").length === 0);
    backend.rpc.workspace_is_internal_unlimited = () => ({ status: 500, body: { message: "read exploded" } });
    t("…a failed read is 'no' (fails closed)", (await affiliateAddonUsable(WS, null)) === false);

    const aff = read("src/lib/affiliates.functions.ts");
    const assertAddon = aff.slice(aff.indexOf("async function assertAddon("), aff.indexOf("// ------", aff.indexOf("async function assertAddon(")));
    t(
      "assertAddon: the internal entitlement first (top tier, whatever the add-on row says), else the add-on must be live",
      /if \(await isInternalUnlimitedOrFalse\(workspaceId\)\) return \{ \.\.\.s, addon_tier: "pro" \};\s*if \(s\.addon_status !== "active" && s\.addon_status !== "trialing"\) \{\s*throw new Error\(/.test(assertAddon),
      assertAddon.slice(0, 300),
    );
    for (const [file, re, label] of [
      ["src/lib/affiliate-sync.functions.ts", /if \(!\(await affiliateAddonUsable\(data\.workspaceId, settings\?\.addon_status\)\)\) \{/, "the referral sync"],
      ["src/lib/affiliate-public.functions.ts", /!\(await affiliateAddonUsable\(settings\.workspace_id, settings\.addon_status\)\)/, "the public affiliate form"],
      ["src/lib/sharetribe-sync.server.ts", /if \(await affiliateAddonUsable\(workspaceId, affSettings\?\.addon_status\)\) \{/, "the scheduled referral sync"],
    ] as const) {
      t(`${label} uses the one add-on predicate (add-on live, or internal)`, re.test(read(file)));
    }
    const domains = read("src/lib/admin-domains.functions.ts");
    const allowance = domains.slice(domains.indexOf("async function domainAllowance("));
    t(
      "custom domains: an internal workspace has no domain limit (the predicate first; a failed read keeps the plan's)",
      /if \(await isInternalUnlimitedOrFalse\(workspaceId\)\) \{[\s\S]{0,160}return INTERNAL_UNLIMITED_COUNT;/.test(allowance),
    );
    const opp = read("src/lib/opportunities.functions.ts");
    t(
      "Opportunity Engine: an internal workspace counts as enrolled (driven in tests/ai-flows.test.ts)",
      /if \(data\) return true;\s*const \{ isInternalUnlimitedOrFalse \} = await import\("@\/lib\/entitlement-grants\.server"\);\s*return isInternalUnlimitedOrFalse\(workspaceId\);/.test(opp),
    );
  }
  {
    t("the grant types include 'internal'", (GRANT_TYPES as readonly string[]).includes("internal") && GRANT_TYPES.length === 5);
    t(
      "the admin picker labels it 'Founder / Internal Unlimited'",
      GRANT_TYPE_OPTIONS.find((o) => o.type === "internal")?.label === "Founder / Internal Unlimited" && GRANT_TYPE_OPTIONS.length === 5,
    );
    const base = { workspaceId: WS, pageLimit: 50, noExpiry: true, reason: "founder testing" };
    t("the admin grant input accepts grantType 'internal'", GrantInputSchema.safeParse({ ...base, grantType: "internal" }).success);
    t("…and nothing outside the five types", !GrantInputSchema.safeParse({ ...base, grantType: "unlimited" }).success && !GrantInputSchema.safeParse({ ...base, grantType: "founder" }).success);
    t(
      "an internal grant is always written as the maximum page grant (what the CHECK requires), whatever was typed",
      grantPageLimit("internal", 50) === INTERNAL_GRANT_PAGE_LIMIT && INTERNAL_GRANT_PAGE_LIMIT === 1_000_000 && grantPageLimit("beta", 50) === 50,
    );
    const admin = read("src/lib/admin-entitlement-grants.functions.ts");
    for (const name of ["grantEntitlement", "revokeGrant", "replaceGrant", "listWorkspaceGrants"]) {
      const at = admin.indexOf(`export const ${name} = createServerFn(`);
      const b = admin.slice(at, admin.indexOf("\nexport ", at + 1) < 0 ? undefined : admin.indexOf("\nexport ", at + 1));
      t(`${name}: platform admins only (has_role through the service role, fails closed), checked first`, at > 0 && /\.handler\(async \(\{ data, context \}\)[^{]*\{\s*await assertAdmin\(context\.userId\);/.test(b));
    }
    t(
      "the admin check is has_role 'admin' and fails closed",
      /const \{ data, error \} = await sb\(\)\.rpc\("has_role", \{ _user_id: userId, _role: "admin" \}\);\s*if \(error\) \{[\s\S]*?throw new Error\("forbidden"\);\s*\}\s*if \(!data\) throw new Error\("forbidden"\);/.test(admin),
    );
    t(
      "create and replace write the page limit through grantPageLimit",
      (admin.match(/page_limit: grantPageLimit\(data\.grantType, data\.pageLimit\),/g) ?? []).length === 2,
    );
  }

  {
    const pkg = read("package.json");
    t("this suite is in the test chain", /bun tests\/founder-internal-unlimited\.test\.ts/.test(pkg));
  }
} finally {
  console.error = origError;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(" || "));
  process.exit(1);
}
