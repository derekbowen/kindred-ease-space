/**
 * THE 000600 SQL, EXECUTED. Run: bun tests/generation-sql.test.ts
 *
 * tests/generation.test.ts pins the migration's text; this suite runs it. The
 * whole of supabase/migrations/20260924000600_generation_settlement_and_reservations.sql
 * is loaded into PGlite (Postgres compiled to WASM, in-process, no server)
 * on top of the minimum it touches: the Supabase roles with Supabase's
 * default grants, auth.uid() / auth.role() read from settings the test
 * controls, public.is_workspace_member over a members table, and the
 * workspaces / tenant_pages / credit_ledger / workspace_ai_quota columns the
 * functions read and write. Then it drives the functions the app calls:
 *
 *   - reserve_generation_slot: 'reserved' / 'cap_reached' / 'in_progress' /
 *     'consumed', the stale retake, the 24-hour window;
 *   - mark_generation_provider_called: once, and only once;
 *   - release_generation_slot: only before the provider call;
 *   - generation_consumed_last_24h: reservations only, whatever happens to
 *     pages (a deleted draft frees nothing);
 *   - the tenant_pages pin trigger: members cannot rewrite created_at,
 *     generation_request_id or generation_billing_mode; the service role can;
 *   - settle_generation_free_quota: the ledger row first, one per page;
 *   - the migration's own verification block, a re-run, the rollback and a
 *     re-apply.
 *
 * Not covered: two concurrent transactions racing for the advisory lock
 * (PGlite is a single connection). The lock's position before the count is
 * pinned by text in tests/generation.test.ts and by the verification block.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

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
const MIGRATION = readFileSync(
  join(ROOT, "supabase/migrations/20260924000600_generation_settlement_and_reservations.sql"),
  "utf8",
);
const ROLLBACK = readFileSync(
  join(ROOT, "supabase/rollback/20260924000600_generation_settlement_and_reservations_rollback.sql"),
  "utf8",
);

const WS = "11111111-1111-4111-8111-111111111111";
const WS2 = "22222222-2222-4222-8222-222222222222";
const MEMBER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STRANGER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let seq = 0;
/** A fresh v4-shaped request id per call. */
const rid = () => `cccccccc-cccc-4ccc-8ccc-${String(++seq).padStart(12, "0")}`;

const db = await PGlite.create();

// ---- The minimum the migration touches -------------------------------------
await db.exec(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  -- Supabase grants every new table and function in public to these roles by
  -- default; that is exactly why the migration must REVOKE.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

  CREATE SCHEMA auth;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  -- The JWT claims, as settings this suite controls.
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('test.role', true), '') $$;
  GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;

  CREATE TABLE public.workspaces (id uuid PRIMARY KEY);
  CREATE TABLE public.test_members (workspace_id uuid NOT NULL, user_id uuid NOT NULL);
  CREATE FUNCTION public.is_workspace_member(_workspace_id uuid, _user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT EXISTS (SELECT 1 FROM public.test_members
                          WHERE workspace_id = _workspace_id AND user_id = _user_id) $$;

  CREATE TABLE public.tenant_pages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    slug text NOT NULL,
    title text NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    generation_request_id uuid,
    UNIQUE (workspace_id, slug)
  );
  CREATE UNIQUE INDEX tenant_pages_generation_request_uidx
    ON public.tenant_pages (workspace_id, generation_request_id)
    WHERE generation_request_id IS NOT NULL;

  CREATE TABLE public.credit_ledger (
    id bigserial PRIMARY KEY,
    workspace_id uuid NOT NULL,
    delta int NOT NULL,
    reason text NOT NULL,
    ai_model text,
    ref_type text,
    ref_id text,
    metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.workspace_ai_quota (
    workspace_id uuid PRIMARY KEY,
    platform_credits_remaining int NOT NULL DEFAULT 20,
    lifetime_platform_used int NOT NULL DEFAULT 0
  );

  INSERT INTO public.workspaces VALUES ('${WS}'), ('${WS2}');
  INSERT INTO public.test_members VALUES ('${WS}', '${MEMBER}');
`);

// ---- Helpers ------------------------------------------------------------------
type Role = "service_role" | "authenticated" | "anon";

/** Run one statement as `role`, with auth.role() = role and auth.uid() = uid. */
async function as<T = Record<string, unknown>>(
  role: Role | null,
  sql: string,
  params: unknown[] = [],
  uid: string | null = null,
): Promise<T[]> {
  await db.query(`SELECT set_config('test.role', $1, false), set_config('test.uid', $2, false)`, [
    role ?? "",
    uid ?? "",
  ]);
  if (role) await db.exec(`SET ROLE ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    if (role) await db.exec("RESET ROLE");
    await db.query(`SELECT set_config('test.role', '', false), set_config('test.uid', '', false)`);
  }
}

/** The error a statement raises (message + SQLSTATE), or null. */
async function raises(
  role: Role | null,
  sql: string,
  params: unknown[] = [],
  uid: string | null = null,
): Promise<{ message: string; code?: string } | null> {
  try {
    await as(role, sql, params, uid);
    return null;
  } catch (e) {
    const err = e as { message?: string; code?: string };
    return { message: String(err.message ?? e), code: err.code };
  }
}

const reserve = async (ws: string, id: string, cap: number | null) =>
  (
    await as<{ r: string }>("service_role", "SELECT public.reserve_generation_slot($1, $2, $3) AS r", [
      ws,
      id,
      cap,
    ])
  )[0]!.r;
const mark = async (ws: string, id: string) =>
  (
    await as<{ r: boolean }>(
      "service_role",
      "SELECT public.mark_generation_provider_called($1, $2) AS r",
      [ws, id],
    )
  )[0]!.r;
const release = async (ws: string, id: string) =>
  (await as<{ r: boolean }>("service_role", "SELECT public.release_generation_slot($1, $2) AS r", [ws, id]))[0]!
    .r;
const consumed = async (ws: string) =>
  (await as<{ n: number }>("service_role", "SELECT public.generation_consumed_last_24h($1) AS n", [ws]))[0]!.n;
const row = async (ws: string, id: string) =>
  (
    await db.query<{ created_at: string; provider_called_at: string | null; age_s: number }>(
      `SELECT created_at, provider_called_at, extract(epoch FROM now() - created_at)::int AS age_s
         FROM public.generation_reservations WHERE workspace_id = $1 AND request_id = $2`,
      [ws, id],
    )
  ).rows[0] ?? null;
/** Move a reservation into the past (the suite's clock). */
const age = (ws: string, id: string, interval: string) =>
  db.query(
    `UPDATE public.generation_reservations SET created_at = now() - $3::interval
      WHERE workspace_id = $1 AND request_id = $2`,
    [ws, id, interval],
  );
const clearWorkspace = async (ws: string) => {
  await db.query("DELETE FROM public.generation_reservations WHERE workspace_id = $1", [ws]);
  await db.query("DELETE FROM public.tenant_pages WHERE workspace_id = $1", [ws]);
};

async function verificationRows(): Promise<Array<{ check: string; ok: boolean | null }>> {
  const results = await db.exec(MIGRATION);
  return (results[results.length - 1]?.rows ?? []) as Array<{ check: string; ok: boolean | null }>;
}

// ---------------------------------------------------------------------------
console.log("\n=== the migration loads, verifies itself, and re-runs harmlessly ===");
{
  const first = await verificationRows();
  t("the verification block returned its rows", first.length >= 20, String(first.length));
  const bad = first.filter((r) => r.ok !== true);
  t("every verification row reads true", bad.length === 0, JSON.stringify(bad));
  const second = await verificationRows();
  t(
    "re-running the whole file is harmless (still every row true)",
    second.length === first.length && second.every((r) => r.ok === true),
    JSON.stringify(second.filter((r) => r.ok !== true)),
  );
  const overloads = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'generation_consumed_last_24h'",
  );
  t("one generation_consumed_last_24h, no leftover overload", overloads.rows[0]!.n === 1);
}

// ---------------------------------------------------------------------------
console.log("\n=== grant hygiene: service role only, despite Supabase's default grants ===");
{
  const fns: Array<[string, unknown[]]> = [
    ["SELECT public.reserve_generation_slot($1, $2, 5)", [WS, rid()]],
    ["SELECT public.mark_generation_provider_called($1, $2)", [WS, rid()]],
    ["SELECT public.release_generation_slot($1, $2)", [WS, rid()]],
    ["SELECT public.generation_consumed_last_24h($1)", [WS]],
    ["SELECT public.settle_generation_free_quota($1, 'quick_page', 'x')", [WS]],
  ];
  for (const role of ["authenticated", "anon"] as const) {
    for (const [sql, params] of fns) {
      const err = await raises(role, sql, params, MEMBER);
      const fn = sql.match(/public\.(\w+)/)![1];
      t(`${role} cannot execute ${fn} (even as a member)`, !!err && /permission denied/.test(err.message), err?.message);
    }
    const tableErr = await raises(role, "SELECT count(*) FROM public.generation_reservations");
    t(`${role} cannot read generation_reservations`, !!tableErr && /permission denied/.test(tableErr.message), tableErr?.message);
  }
  t("the service role can", (await reserve(WS, rid(), 5)) === "reserved");
  await clearWorkspace(WS);
  // The membership guard, for a caller that carries a user id.
  const stranger = await raises(
    null,
    "SELECT public.reserve_generation_slot($1, $2, 5)",
    [WS, rid()],
    STRANGER,
  );
  t("a user id that is not a member of the workspace is refused (42501)", stranger?.code === "42501", JSON.stringify(stranger));
  const member = await raises(null, "SELECT public.reserve_generation_slot($1, $2, 5)", [WS, rid()], MEMBER);
  t("a member's own workspace passes the guard", member === null, JSON.stringify(member));
  const nullId = await raises("service_role", "SELECT public.reserve_generation_slot($1, NULL, 5)", [WS]);
  t("a NULL request id is refused (22023), never reserved", nullId?.code === "22023", JSON.stringify(nullId));
  await clearWorkspace(WS);
}

// ---------------------------------------------------------------------------
console.log("\n=== one id, one provider call: reserved → in_progress → consumed ===");
{
  await clearWorkspace(WS);
  const id = rid();
  t("a new id is 'reserved'", (await reserve(WS, id, 5)) === "reserved");
  t("…and counted at once", (await consumed(WS)) === 1);
  t(
    "the same id again while it is young is 'in_progress' — no second slot, no second call",
    (await reserve(WS, id, 5)) === "in_progress" && (await consumed(WS)) === 1,
  );
  t("marking the provider call succeeds once", (await mark(WS, id)) === true);
  t("a second mark is refused (another request already owns the call)", (await mark(WS, id)) === false);
  t("marking an id that holds no reservation is refused", (await mark(WS, rid())) === false);
  t("still young after the call: 'in_progress'", (await reserve(WS, id, 5)) === "in_progress");
  await age(WS, id, "16 minutes");
  t("older than 15 minutes with the provider called: 'consumed'", (await reserve(WS, id, 5)) === "consumed");
  t("…and still counted (the call was paid for)", (await consumed(WS)) === 1);
  await age(WS, id, "30 hours");
  t("a spent id stays 'consumed' after the window: the id is finished for good", (await reserve(WS, id, 5)) === "consumed");
  t("…while the 24-hour count lets it go", (await consumed(WS)) === 0);
}

// ---------------------------------------------------------------------------
console.log("\n=== a page carrying the id is 'consumed' ===");
{
  await clearWorkspace(WS);
  const id = rid();
  t("reserved", (await reserve(WS, id, 5)) === "reserved");
  await mark(WS, id);
  await db.query(
    "INSERT INTO public.tenant_pages (workspace_id, slug, title, generation_request_id, generation_billing_mode) VALUES ($1, 'p1', 'P1', $2, 'platform')",
    [WS, id],
  );
  t("a young row whose page exists is 'consumed' (the caller returns the page)", (await reserve(WS, id, 5)) === "consumed");
  const orphan = rid();
  await db.query(
    "INSERT INTO public.tenant_pages (workspace_id, slug, title, generation_request_id) VALUES ($1, 'p2', 'P2', $2)",
    [WS, orphan],
  );
  t("a page with the id and no reservation at all is 'consumed' too", (await reserve(WS, orphan, 5)) === "consumed");
  t("…and takes no slot", (await consumed(WS)) === 1);
}

// ---------------------------------------------------------------------------
console.log("\n=== a stale reservation whose provider was never called is retaken ===");
{
  await clearWorkspace(WS);
  const id = rid();
  await reserve(WS, id, 5);
  await age(WS, id, "20 minutes");
  const before = await row(WS, id);
  t("the stale row is 20 minutes old, never marked", !!before && before.age_s >= 1199 && before.provider_called_at === null);
  t("the same id is 'reserved' again (the request died before spending anything)", (await reserve(WS, id, 5)) === "reserved");
  const after = await row(WS, id);
  t("…with a fresh created_at", !!after && after.age_s <= 5, JSON.stringify(after));
  t("…and counted once, not twice", (await consumed(WS)) === 1);

  // At the cap, the stale row itself is not counted against its own retake.
  await clearWorkspace(WS);
  const lone = rid();
  await reserve(WS, lone, 1);
  await age(WS, lone, "20 minutes");
  t("cap 1, the only reservation is the stale one: its retake is allowed", (await reserve(WS, lone, 1)) === "reserved");
  await clearWorkspace(WS);
  const staleAtCap = rid();
  await reserve(WS, staleAtCap, 2);
  await age(WS, staleAtCap, "20 minutes");
  await reserve(WS, rid(), 2);
  t(
    "cap 1 with another reservation in the window: the retake is 'cap_reached'",
    (await reserve(WS, staleAtCap, 1)) === "cap_reached",
  );
  t("…and the refused retake left the stale row untouched", ((await row(WS, staleAtCap))?.age_s ?? 0) >= 1199);
  await clearWorkspace(WS);
  const ancient = rid();
  await reserve(WS, ancient, 5);
  await age(WS, ancient, "30 hours");
  await reserve(WS, rid(), 5);
  t(
    "a stale row outside the window counts as a new slot: at cap 1 its retake is 'cap_reached'",
    (await reserve(WS, ancient, 1)) === "cap_reached",
  );
  t("…at cap 2 it is 'reserved' and counted again", (await reserve(WS, ancient, 2)) === "reserved" && (await consumed(WS)) === 2);
}

// ---------------------------------------------------------------------------
console.log("\n=== release: only before the provider call ===");
{
  await clearWorkspace(WS);
  const unmarked = rid();
  await reserve(WS, unmarked, 5);
  t("an unmarked reservation is released", (await release(WS, unmarked)) === true);
  t("…and no longer counted", (await consumed(WS)) === 0 && (await row(WS, unmarked)) === null);
  t("…so the same id can reserve afresh", (await reserve(WS, unmarked, 5)) === "reserved");
  const spent = rid();
  await reserve(WS, spent, 5);
  await mark(WS, spent);
  t("a reservation whose provider was called cannot be released", (await release(WS, spent)) === false);
  t("…it is still there and still counted", (await row(WS, spent)) !== null && (await consumed(WS)) === 2);
  t("releasing an id with no reservation is a harmless no", (await release(WS, rid())) === false);
  t("a release never reaches another workspace's row", (await release(WS2, spent)) === false && (await row(WS, spent)) !== null);
}

// ---------------------------------------------------------------------------
console.log("\n=== the cap ===");
{
  await clearWorkspace(WS);
  t("cap 2: the first id is reserved", (await reserve(WS, rid(), 2)) === "reserved");
  t("cap 2: the second id is reserved", (await reserve(WS, rid(), 2)) === "reserved");
  const third = rid();
  t("cap 2: the third id is 'cap_reached'", (await reserve(WS, third, 2)) === "cap_reached");
  t("…and took nothing", (await consumed(WS)) === 2 && (await row(WS, third)) === null);
  t("cap 0 refuses", (await reserve(WS, rid(), 0)) === "cap_reached");
  t("a negative cap refuses", (await reserve(WS, rid(), -5)) === "cap_reached");
  t("a NULL cap refuses (never uncapped)", (await reserve(WS, rid(), null)) === "cap_reached");
  t("another workspace has its own cap", (await reserve(WS2, rid(), 2)) === "reserved" && (await consumed(WS2)) === 1);
  // Only reservations inside the window count.
  const rows = await db.query<{ request_id: string }>(
    "SELECT request_id FROM public.generation_reservations WHERE workspace_id = $1",
    [WS],
  );
  for (const r of rows.rows) await age(WS, r.request_id, "25 hours");
  t("reservations older than 24 hours no longer count", (await consumed(WS)) === 0);
  t("…so the cap has room again", (await reserve(WS, rid(), 2)) === "reserved");
  await db.query("DELETE FROM public.generation_reservations WHERE workspace_id = $1", [WS2]);
}

// ---------------------------------------------------------------------------
console.log("\n=== reservations count whatever happens to pages ===");
{
  await clearWorkspace(WS);
  const id = rid();
  await reserve(WS, id, 5);
  await mark(WS, id);
  await db.query(
    "INSERT INTO public.tenant_pages (workspace_id, slug, title, generation_request_id, generation_billing_mode) VALUES ($1, 'austin', 'Austin', $2, 'platform')",
    [WS, id],
  );
  t("a generated page and its reservation count once, not twice", (await consumed(WS)) === 1);
  // A member edits the page's columns through PostgREST: pinned, and the
  // count never read them anyway.
  await as(
    "authenticated",
    "UPDATE public.tenant_pages SET created_at = now() - interval '3 days', generation_request_id = NULL WHERE workspace_id = $1",
    [WS],
    MEMBER,
  );
  t("editing the page's created_at / request id frees nothing", (await consumed(WS)) === 1);
  await db.query("DELETE FROM public.tenant_pages WHERE workspace_id = $1", [WS]);
  t("deleting the draft frees nothing", (await consumed(WS)) === 1);
  t("…and does not make the id generatable again ('consumed' once it is old)", await (async () => {
    await age(WS, id, "16 minutes");
    return (await reserve(WS, id, 5)) === "consumed";
  })());
  await db.query(
    "INSERT INTO public.tenant_pages (workspace_id, slug, title, generation_request_id) VALUES ($1, 'handmade', 'Hand-made', $2)",
    [WS, rid()],
  );
  t("a page with a request id but no reservation does not count", (await consumed(WS)) === 1);
}

// ---------------------------------------------------------------------------
console.log("\n=== the pin trigger on tenant_pages ===");
{
  await clearWorkspace(WS);
  const reqId = rid();
  await db.query(
    "INSERT INTO public.tenant_pages (workspace_id, slug, title, created_at, generation_request_id, generation_billing_mode) VALUES ($1, 'pinned', 'Before', now() - interval '1 hour', $2, 'platform')",
    [WS, reqId],
  );
  const read = async () =>
    (
      await db.query<{
        title: string;
        request: string | null;
        mode: string | null;
        age_min: number;
      }>(
        "SELECT title, generation_request_id AS request, generation_billing_mode AS mode, round(extract(epoch FROM now() - created_at) / 60)::int AS age_min FROM public.tenant_pages WHERE workspace_id = $1 AND slug = 'pinned'",
        [WS],
      )
    ).rows[0]!;
  await as(
    "authenticated",
    "UPDATE public.tenant_pages SET title = 'Edited', created_at = now() - interval '5 days', generation_request_id = NULL, generation_billing_mode = 'byok' WHERE workspace_id = $1 AND slug = 'pinned'",
    [WS],
    MEMBER,
  );
  const afterMember = await read();
  t("a member's edit to other columns lands", afterMember.title === "Edited");
  t(
    "…but created_at, generation_request_id and generation_billing_mode keep their values",
    afterMember.request === reqId && afterMember.mode === "platform" && afterMember.age_min === 60,
    JSON.stringify(afterMember),
  );
  await as(
    null,
    "UPDATE public.tenant_pages SET generation_billing_mode = 'granted', generation_request_id = NULL WHERE workspace_id = $1 AND slug = 'pinned'",
    [WS],
  );
  const afterNoJwt = await read();
  t(
    "a session with no JWT at all is pinned too (fail closed)",
    afterNoJwt.mode === "platform" && afterNoJwt.request === reqId,
    JSON.stringify(afterNoJwt),
  );
  await as(
    "service_role",
    "UPDATE public.tenant_pages SET generation_billing_mode = 'byok', created_at = now() - interval '2 hours' WHERE workspace_id = $1 AND slug = 'pinned'",
    [WS],
  );
  const afterService = await read();
  t(
    "the service role's writes are unaffected",
    afterService.mode === "byok" && afterService.age_min === 120,
    JSON.stringify(afterService),
  );
  const ddl = await db.query<{ tgname: string; timing: string }>(
    `SELECT tgname, CASE WHEN tgtype & 2 = 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing
       FROM pg_trigger WHERE tgrelid = 'public.tenant_pages'::regclass AND NOT tgisinternal`,
  );
  t(
    "the trigger fires BEFORE UPDATE",
    ddl.rows.some((r) => r.tgname === "tenant_pages_pin_generation_columns" && r.timing === "BEFORE"),
  );
}

// ---------------------------------------------------------------------------
console.log("\n=== settle_generation_free_quota: the ledger row first, one per page ===");
{
  await db.query("DELETE FROM public.credit_ledger");
  await db.query("DELETE FROM public.workspace_ai_quota");
  const settle = (ref: string) =>
    as<{ r: number }>("service_role", "SELECT public.settle_generation_free_quota($1, 'quick_page', $2, 'm') AS r", [
      WS,
      ref,
    ]);
  const first = await settle("page-1");
  t("the first settlement spends one free credit (20 → 19)", first[0]?.r === 19);
  const dup = await raises("service_role", "SELECT public.settle_generation_free_quota($1, 'quick_page', 'page-1', 'm')", [WS]);
  t("a second settlement for the same page fails on the settlement index (23505)", dup?.code === "23505", JSON.stringify(dup));
  const q = await db.query<{ remaining: number }>(
    "SELECT platform_credits_remaining AS remaining FROM public.workspace_ai_quota WHERE workspace_id = $1",
    [WS],
  );
  t("…before a single free credit moved", q.rows[0]?.remaining === 19);
  await db.query("UPDATE public.workspace_ai_quota SET platform_credits_remaining = 0 WHERE workspace_id = $1", [WS]);
  const exhausted = await raises("service_role", "SELECT public.settle_generation_free_quota($1, 'quick_page', 'page-2', 'm')", [WS]);
  t("an exhausted quota raises platform_ai_quota_exhausted", /platform_ai_quota_exhausted/.test(exhausted?.message ?? ""), JSON.stringify(exhausted));
  const rows = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM public.credit_ledger WHERE ref_id = 'page-2'",
  );
  t("…and rolls its ledger row back with it (the page is not settled)", rows.rows[0]?.n === 0);
  const coach = await db.query(
    "INSERT INTO public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id) VALUES ($1, -1, 'ai_usage', 'coach', 'conv-1'), ($1, -1, 'ai_usage', 'coach', 'conv-1') RETURNING id",
    [WS],
  );
  t("coach-chat's many rows per conversation are outside the settlement index", coach.rows.length === 2);
}

// ---------------------------------------------------------------------------
console.log("\n=== the rollback, then a re-apply ===");
{
  const results = await db.exec(ROLLBACK);
  const leftovers = results[results.length - 1]?.rows ?? [];
  t("the rollback's VERIFY returns no leftovers", leftovers.length === 0, JSON.stringify(leftovers));
  const pages = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.tenant_pages");
  t("…and never touched the pages", pages.rows[0]!.n > 0);
  // The trigger read generation_billing_mode; dropped in the wrong order an
  // UPDATE here would fail with "record new has no field".
  let updateErr: string | null = null;
  try {
    await as("authenticated", "UPDATE public.tenant_pages SET title = title || '!'", [], MEMBER);
  } catch (e) {
    updateErr = String((e as Error).message ?? e);
  }
  t("tenant_pages updates still work once the trigger and its column are gone", updateErr === null, updateErr ?? "");
  const again = await verificationRows();
  t(
    "re-applying 000600 after the rollback verifies clean",
    again.length > 0 && again.every((r) => r.ok === true),
    JSON.stringify(again.filter((r) => r.ok !== true)),
  );
}

await db.close();
t(
  "this suite is in the test chain",
  /bun tests\/generation-sql\.test\.ts/.test(readFileSync(join(ROOT, "package.json"), "utf8")),
);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
