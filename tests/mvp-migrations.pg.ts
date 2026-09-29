/**
 * THE MVP MIGRATIONS ON REAL POSTGRESQL 16. Run: AI_PG_URL=postgres://… bun tests/mvp-migrations.pg.ts
 *
 * Part of `npm run test:pg` (not the offline chain: it needs a throwaway
 * PostgreSQL 16 superuser URL; it creates and drops its own database, and
 * without a URL it SKIPS loudly — SKIPPED is not PASS).
 *
 * Applies 20260929000100 (targets, sync lease, templates) and 20260929000200
 * (domain write lock, exact host) over stubs carrying production's columns,
 * indexes and policies, then proves on real racing connections:
 *   - both files apply, re-apply, and every verification row reads true;
 *   - one sync run per workspace: 20 runs racing claim_listing_sync → one;
 *     a lost lease can't report progress or reconcile (nothing deleted);
 *   - reconcile removes exactly the rows the complete snapshot didn't restamp;
 *   - one live page per target: 20 racing inserts → one; archived pages don't
 *     block; the status CHECK holds;
 *   - inventory_coverage_groups reports exact totals, including rows not yet
 *     keyed;
 *   - an owner's session can no longer write domain rows (verified included);
 *   - www.example.com never resolves to example.com's owner;
 *   - 20260929000400: a page goes live only while it is still the draft at
 *     the version that was validated; 20 drafts racing for 5 slots → 5; 10
 *     racing publishes of one draft → one; archived / suspended never;
 *   - 20260929000500: a member's session reads its pages but can no longer
 *     insert, update or delete them; the service role still writes;
 *   - the rollbacks undo the files and the files apply again after them.
 */
import { Pool, type PoolClient } from "pg";
import { readRepo } from "./_support/ai-db";

const URL_ = process.env.AI_PG_URL ?? process.env.TEST_PG_URL ?? "";
if (!URL_) {
  console.log("\n" + "!".repeat(78));
  console.log("!!  SKIPPED: tests/mvp-migrations.pg.ts needs a real PostgreSQL 16.");
  console.log("!!  Set AI_PG_URL=postgres://postgres@127.0.0.1:<port>/postgres and re-run");
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

const M100 = "supabase/migrations/20260929000100_mvp_targets_sync_templates.sql";
const M200 = "supabase/migrations/20260929000200_domain_write_lock_and_exact_host.sql";
const R100 = "supabase/rollback/20260929000100_mvp_targets_sync_templates_rollback.sql";
const R200 = "supabase/rollback/20260929000200_domain_write_lock_and_exact_host_rollback.sql";
const M400 = "supabase/migrations/20260929000400_mvp_publish_checked.sql";
const R400 = "supabase/rollback/20260929000400_mvp_publish_checked_rollback.sql";
const M500 = "supabase/migrations/20260929000500_mvp_tenant_pages_server_writes.sql";
const R500 = "supabase/rollback/20260929000500_mvp_tenant_pages_server_writes_rollback.sql";

// Production's columns for the tables these files touch (information_schema,
// 2026-09-28), the policies they replace, and the helpers they call.
const STUBS = `
  DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE SCHEMA IF NOT EXISTS auth;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.workspaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, marketplace_domain text,
    domain_verified_at timestamptz, created_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.workspace_members (workspace_id uuid, user_id uuid, role text);
  CREATE FUNCTION public.is_workspace_owner(_ws uuid, _uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = _ws AND m.user_id = _uid AND m.role = 'owner')
  $$;
  CREATE FUNCTION public.is_workspace_member(_ws uuid, _uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = _ws AND m.user_id = _uid)
  $$;

  CREATE TABLE public.tenant_listings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
    sharetribe_listing_id uuid, title text, city text, state text, country text, category text,
    price_amount integer, price_currency text, state_published boolean DEFAULT true,
    synced_at timestamptz DEFAULT now(), UNIQUE (workspace_id, sharetribe_listing_id)
  );
  CREATE TABLE public.tenant_integrations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, provider text NOT NULL,
    status text, last_sync_at timestamptz, last_sync_status text, last_sync_error text,
    listings_count integer, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.page_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE, name text, description text,
    config_schema jsonb NOT NULL DEFAULT '{}', is_active boolean DEFAULT true
  );
  INSERT INTO public.page_templates (slug, name, is_active, config_schema) VALUES
    ('city_hub', 'City Hub', true, '{}'), ('category_page', 'Category Page', false, '{"placeholder":true}'),
    ('neighborhood', 'Neighborhood', false, '{"placeholder":true}'), ('comparison', 'Comparison', false, '{"placeholder":true}'),
    ('resource_article', 'Resource Article', false, '{"placeholder":true}');
  CREATE TABLE public.tenant_pages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
    template_id uuid NOT NULL REFERENCES public.page_templates(id), slug text NOT NULL,
    title text NOT NULL, status text DEFAULT 'draft', listing_filter jsonb,
    published_at timestamptz,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    UNIQUE (workspace_id, slug)
  );
  -- Production's member policies on tenant_pages (the first schema, narrowed
  -- to draft/archived by 20260827050000), which 000500 removes.
  ALTER TABLE public.tenant_pages ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "members read tenant_pages" ON public.tenant_pages FOR SELECT
    USING (public.is_workspace_member(workspace_id, auth.uid()));
  CREATE POLICY "members insert tenant_pages" ON public.tenant_pages FOR INSERT
    WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()) AND status IN ('draft', 'archived'));
  CREATE POLICY "members update tenant_pages" ON public.tenant_pages FOR UPDATE
    USING (public.is_workspace_member(workspace_id, auth.uid()))
    WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()) AND status IN ('draft', 'archived'));
  CREATE POLICY "members delete tenant_pages" ON public.tenant_pages FOR DELETE
    USING (public.is_workspace_member(workspace_id, auth.uid()));
  -- workspace_capacity() as publish_tenant_pages reads it (page_limit, publish),
  -- driven by a table the test sets.
  CREATE TABLE public.capacity_stub (workspace_id uuid PRIMARY KEY, page_limit integer, publish boolean);
  CREATE FUNCTION public.workspace_capacity(_ws uuid) RETURNS TABLE (page_limit integer, publish boolean)
  LANGUAGE sql STABLE AS $$ SELECT c.page_limit, c.publish FROM public.capacity_stub c WHERE c.workspace_id = _ws $$;
  CREATE TABLE public.workspace_domains (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, hostname text NOT NULL,
    verified boolean DEFAULT false, verified_at timestamptz, status text, created_at timestamptz DEFAULT now()
  );
  ALTER TABLE public.workspace_domains ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "owners read domains" ON public.workspace_domains FOR SELECT TO authenticated
    USING (public.is_workspace_owner(workspace_id, auth.uid()));
  CREATE POLICY "owners write domains" ON public.workspace_domains FOR ALL TO authenticated
    USING (public.is_workspace_owner(workspace_id, auth.uid()))
    WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));
  CREATE FUNCTION public.current_workspace_id_by_host(_host text) RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT NULL::uuid
  $$;
`;

const admin = new Pool({ connectionString: URL_, max: 2 });
const dbName = `mvp_migrations_${Date.now()}`;
await admin.query(`CREATE DATABASE ${dbName}`);
const target = new URL(URL_);
target.pathname = `/${dbName}`;
const pool = new Pool({ connectionString: target.toString(), max: 40 });
console.log(`\nServer: ${(await pool.query<{ v: string }>("SELECT version() AS v")).rows[0]!.v}`);
console.log(`Database: ${dbName} (created for this run, dropped at the end)`);

const q = async <T = any>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows as T[];
const q1 = async <T = any>(sql: string, params: unknown[] = []) =>
  (await q<T>(sql, params))[0] as T;
/** Rows of the file's trailing verification SELECT, all expected true. */
async function applyAndVerify(file: string): Promise<{ allTrue: boolean; rows: any[] }> {
  const res: any = await pool.query(readRepo(file));
  const results = Array.isArray(res) ? res : [res];
  const last = results[results.length - 1];
  const rows = last.rows ?? [];
  return { allTrue: rows.length > 0 && rows.every((r: any) => r.ok === true), rows };
}
async function asRole<T>(
  claims: Record<string, unknown>,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `SET LOCAL ROLE ${claims.role === "service_role" ? "service_role" : claims.role === "anon" ? "anon" : "authenticated"}`,
    );
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
const svc = <T>(fn: (c: PoolClient) => Promise<T>) => asRole({ role: "service_role" }, fn);

try {
  await pool.query(STUBS);

  console.log("\n1. The files apply, re-apply, and verify");
  {
    const a = await applyAndVerify(M100);
    t(
      "20260929000100 applies; every verification row reads true",
      a.allTrue,
      JSON.stringify(a.rows.filter((r) => r.ok !== true)),
    );
    const b = await applyAndVerify(M200);
    t(
      "20260929000200 applies; every verification row reads true",
      b.allTrue,
      JSON.stringify(b.rows.filter((r) => r.ok !== true)),
    );
    const c = await applyAndVerify(M400);
    t(
      "20260929000400 applies; its verification row reads true",
      c.allTrue,
      JSON.stringify(c.rows.filter((r) => r.ok !== true)),
    );
    const a2 = await applyAndVerify(M100);
    const b2 = await applyAndVerify(M200);
    const c2 = await applyAndVerify(M400);
    t(
      "all three re-apply without error and still verify (idempotent)",
      a2.allTrue && b2.allTrue && c2.allTrue,
    );
  }

  const WS = (
    await q1<{ id: string }>("INSERT INTO public.workspaces (name) VALUES ('A') RETURNING id")
  ).id;
  const WS2 = (
    await q1<{ id: string }>("INSERT INTO public.workspaces (name) VALUES ('B') RETURNING id")
  ).id;
  await q(
    "INSERT INTO public.tenant_integrations (workspace_id, provider, status) VALUES ($1,'sharetribe','connected'), ($2,'sharetribe','connected')",
    [WS, WS2],
  );

  console.log("\n2. One sync run per workspace");
  {
    const runs = Array.from({ length: 20 }, () => crypto.randomUUID());
    const won = await Promise.all(
      runs.map((r) =>
        svc((c) =>
          c
            .query("SELECT public.claim_listing_sync($1,$2,300) AS ok", [WS, r])
            .then((x) => x.rows[0].ok as boolean),
        ),
      ),
    );
    const winners = runs.filter((_, i) => won[i]);
    t(
      "20 runs race for the lease → exactly one wins",
      winners.length === 1,
      `${winners.length} won`,
    );
    const holder = winners[0]!;
    const loser = runs.find((r) => r !== holder)!;
    const touchLoser = await svc((c) =>
      c.query("SELECT public.touch_listing_sync($1,$2,'{\"pages\":1}'::jsonb,300) AS ok", [
        WS,
        loser,
      ]),
    );
    const touchHolder = await svc((c) =>
      c.query("SELECT public.touch_listing_sync($1,$2,'{\"pages\":1}'::jsonb,300) AS ok", [
        WS,
        holder,
      ]),
    );
    t(
      "a run without the lease cannot report progress; the holder can",
      touchLoser.rows[0].ok === false && touchHolder.rows[0].ok === true,
    );
    const other = await svc((c) =>
      c.query("SELECT public.claim_listing_sync($1,$2,300) AS ok", [WS2, crypto.randomUUID()]),
    );
    t("another workspace's lease is independent", other.rows[0].ok === true);

    // Reconcile: 3 rows restamped by this run, 2 older ones not seen.
    const runStart = new Date();
    await q(
      `INSERT INTO public.tenant_listings (workspace_id, sharetribe_listing_id, city, synced_at) VALUES
        ($1, gen_random_uuid(), 'Old 1', $2::timestamptz - interval '1 hour'),
        ($1, gen_random_uuid(), 'Old 2', $2::timestamptz - interval '2 hours'),
        ($1, gen_random_uuid(), 'Seen 1', $2), ($1, gen_random_uuid(), 'Seen 2', $2::timestamptz + interval '1 second'),
        ($1, gen_random_uuid(), 'Seen 3', $2::timestamptz + interval '2 seconds'),
        ($3, gen_random_uuid(), 'Other ws old', $2::timestamptz - interval '1 hour')`,
      [WS, runStart.toISOString(), WS2],
    );
    const removedByLoser = await svc((c) =>
      c.query("SELECT public.reconcile_listing_sync($1,$2,$3) AS n", [
        WS,
        loser,
        runStart.toISOString(),
      ]),
    );
    t(
      "a run without the lease reconciles nothing (-1)",
      removedByLoser.rows[0].n === -1 &&
        Number(
          (
            await q1("SELECT count(*) AS n FROM public.tenant_listings WHERE workspace_id = $1", [
              WS,
            ])
          ).n,
        ) === 5,
    );
    const removed = await svc((c) =>
      c.query("SELECT public.reconcile_listing_sync($1,$2,$3) AS n", [
        WS,
        holder,
        runStart.toISOString(),
      ]),
    );
    const left = await q<{ city: string }>(
      "SELECT city FROM public.tenant_listings WHERE workspace_id = $1 ORDER BY city",
      [WS],
    );
    t(
      "the holder's reconcile removes exactly the 2 rows the snapshot didn't restamp",
      removed.rows[0].n === 2 && left.map((r) => r.city).join(",") === "Seen 1,Seen 2,Seen 3",
      JSON.stringify(left),
    );
    t(
      "…and never another workspace's rows",
      Number(
        (
          await q1("SELECT count(*) AS n FROM public.tenant_listings WHERE workspace_id = $1", [
            WS2,
          ])
        ).n,
      ) === 1,
    );

    const finished = await svc((c) =>
      c.query("SELECT public.finish_listing_sync($1,$2,$3::jsonb) AS ok", [
        WS,
        holder,
        JSON.stringify({ success: true, status: "success", listings_count: 3, upstream_total: 3 }),
      ]),
    );
    const row = await q1(
      "SELECT sync_lease_until, last_success_at, listings_count, upstream_total, last_sync_status FROM public.tenant_integrations WHERE workspace_id = $1",
      [WS],
    );
    t(
      "finish releases the lease and records the success",
      finished.rows[0].ok === true &&
        row.sync_lease_until === null &&
        row.last_success_at !== null &&
        row.listings_count === 3 &&
        row.upstream_total === 3 &&
        row.last_sync_status === "success",
    );

    // Lease expiry: a crashed run's lease lapses and a new run takes over;
    // the crashed run can then neither progress nor reconcile.
    const crashed = crypto.randomUUID();
    const c1 = await svc((c) =>
      c.query("SELECT public.claim_listing_sync($1,$2,300) AS ok", [WS, crashed]),
    );
    await q(
      "UPDATE public.tenant_integrations SET sync_lease_until = now() - interval '1 second' WHERE workspace_id = $1",
      [WS],
    );
    const fresh = crypto.randomUUID();
    const c2 = await svc((c) =>
      c.query("SELECT public.claim_listing_sync($1,$2,300) AS ok", [WS, fresh]),
    );
    const crashedTouch = await svc((c) =>
      c.query("SELECT public.touch_listing_sync($1,$2,NULL,300) AS ok", [WS, crashed]),
    );
    const crashedRecon = await svc((c) =>
      c.query("SELECT public.reconcile_listing_sync($1,$2,now()) AS n", [WS, crashed]),
    );
    t(
      "an expired lease is taken over; the old run can neither progress nor reconcile",
      c1.rows[0].ok &&
        c2.rows[0].ok &&
        crashedTouch.rows[0].ok === false &&
        crashedRecon.rows[0].n === -1,
    );
    const finishOld = await svc((c) =>
      c.query("SELECT public.finish_listing_sync($1,$2,'{\"success\":true}'::jsonb) AS ok", [
        WS,
        crashed,
      ]),
    );
    t("…and cannot finish (record success) over the new run", finishOld.rows[0].ok === false);
  }

  console.log("\n3. One live page per target");
  {
    const tpl = (
      await q1<{ id: string }>("SELECT id FROM public.page_templates WHERE slug = 'city_hub'")
    ).id;
    const key = "city_hub::country=us|region=tx|city=austin";
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        svc((c) =>
          c.query(
            "INSERT INTO public.tenant_pages (workspace_id, template_id, slug, title, status, target_key) VALUES ($1,$2,$3,'Austin','draft',$4)",
            [WS, tpl, `austin-${i}`, key],
          ),
        ),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const dupes = results.filter(
      (r) =>
        r.status === "rejected" && String((r as PromiseRejectedResult).reason?.code) === "23505",
    ).length;
    t(
      "20 racing inserts for one target → exactly one page, 19 unique violations",
      ok === 1 && dupes === 19,
      `${ok} ok, ${dupes} dupes`,
    );
    await q(
      "UPDATE public.tenant_pages SET status = 'archived' WHERE workspace_id = $1 AND target_key = $2",
      [WS, key],
    );
    const again = await svc((c) =>
      c.query(
        "INSERT INTO public.tenant_pages (workspace_id, template_id, slug, title, status, target_key) VALUES ($1,$2,'austin-new','Austin','draft',$3) RETURNING id",
        [WS, tpl, key],
      ),
    );
    t("an archived page does not block a new one for its target", again.rows.length === 1);
    let otherWs = false;
    try {
      await svc((c) =>
        c.query(
          "INSERT INTO public.tenant_pages (workspace_id, template_id, slug, title, status, target_key) VALUES ($1,$2,'austin','Austin','draft',$3)",
          [WS2, tpl, key],
        ),
      );
      otherWs = true;
    } catch {}
    t("the same target in another workspace is its own page", otherWs);
    let badStatus = false;
    try {
      await q(
        "INSERT INTO public.tenant_pages (workspace_id, template_id, slug, title, status) VALUES ($1,$2,'x','x','live')",
        [WS, tpl],
      );
    } catch (e) {
      badStatus = String((e as { code?: string }).code) === "23514";
    }
    t("an unknown status is refused by the CHECK", badStatus);
  }

  console.log("\n4. Exact coverage totals");
  {
    await q("DELETE FROM public.tenant_listings");
    await q(
      `INSERT INTO public.tenant_listings (workspace_id, city, state, country, category, city_key, region_key, country_key, category_key, price_amount, price_currency, state_published) VALUES
        ($1,'Austin','TX','US','Pool','austin','tx','us','pool',1000,'USD',true),
        ($1,'austin','Texas','USA','Pool','austin','tx','us','pool',2000,'USD',true),
        ($1,'Austin','TX','US','Hot tub','austin','tx','us','hot-tub',NULL,NULL,true),
        ($1,'Portland','ME','US','Pool','portland','me','us','pool',500,'EUR',true),
        ($1,'Portland','OR','US','Pool',NULL,NULL,NULL,NULL,500,'USD',true),
        ($1,'Hidden','TX','US','Pool','hidden','tx','us','pool',500,'USD',false),
        ($2,'Austin','TX','US','Pool','austin','tx','us','pool',100,'USD',true)`,
      [WS, WS2],
    );
    const groups = await svc((c) =>
      c.query(
        "SELECT * FROM public.inventory_coverage_groups($1) ORDER BY city_key NULLS LAST, category_key",
        [WS],
      ),
    );
    const byKey = new Map(groups.rows.map((g: any) => [`${g.city_key}|${g.category_key}`, g]));
    const austinPool = byKey.get("austin|pool") as any;
    t(
      "Austin/Pool counts both spellings of the same place (2), with 2 priced, USD",
      austinPool &&
        Number(austinPool.listing_count) === 2 &&
        Number(austinPool.priced_count) === 2 &&
        JSON.stringify(austinPool.currencies) === '["USD"]',
    );
    t(
      "unpublished listings and other workspaces are not counted",
      !byKey.has("hidden|pool") &&
        groups.rows.reduce((s: number, g: any) => s + Number(g.listing_count), 0) === 5,
    );
    const unkeyed = groups.rows.find((g: any) => g.city_key === null) as any;
    t(
      "rows not yet keyed are reported as needing a resync",
      unkeyed && Number(unkeyed.unkeyed_count) === 1,
    );
  }

  console.log("\n5. Domain rows: the server writes, owners read");
  {
    const OWNER = crypto.randomUUID();
    await q(
      "INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
      [WS, OWNER],
    );
    await q(
      "INSERT INTO public.workspace_domains (workspace_id, hostname, verified, verified_at, status) VALUES ($1,'example.com',true,now(),'active'), ($2,'www.example.com',true,now() - interval '1 day','active')",
      [WS, WS2],
    );
    const read = await asRole({ role: "authenticated", sub: OWNER }, (c) =>
      c.query("SELECT hostname FROM public.workspace_domains"),
    );
    t(
      "an owner reads their own domain rows (and only theirs)",
      read.rows.length === 1 && read.rows[0].hostname === "example.com",
    );
    const attempts = [
      "UPDATE public.workspace_domains SET verified = true, status = 'active'",
      `INSERT INTO public.workspace_domains (workspace_id, hostname, verified) VALUES ('${WS}', 'victim.com', true)`,
      "DELETE FROM public.workspace_domains",
    ];
    const refused: boolean[] = [];
    for (const sql of attempts) {
      try {
        await asRole({ role: "authenticated", sub: OWNER }, (c) => c.query(sql));
        refused.push(false);
      } catch (e) {
        refused.push(String((e as { code?: string }).code) === "42501");
      }
    }
    t(
      "an owner's session cannot insert, update (verified!) or delete domain rows",
      refused.every(Boolean),
      JSON.stringify(refused),
    );

    const r1 = await svc((c) =>
      c.query("SELECT public.current_workspace_id_by_host('www.example.com') AS ws"),
    );
    const r2 = await svc((c) =>
      c.query("SELECT public.current_workspace_id_by_host('Example.COM:443') AS ws"),
    );
    const r3 = await svc((c) =>
      c.query("SELECT public.current_workspace_id_by_host('shop.example.com') AS ws"),
    );
    t("www.example.com resolves to ITS verified owner, not example.com's", r1.rows[0].ws === WS2);
    t("example.com resolves exactly (case and port ignored)", r2.rows[0].ws === WS);
    t("an unknown host resolves to nobody", r3.rows[0].ws === null);
  }

  console.log("\n6. Publishing exactly the validated draft");
  {
    const tpl = (
      await q1<{ id: string }>("SELECT id FROM public.page_templates WHERE slug = 'city_hub'")
    ).id;
    const WS3 = (
      await q1<{ id: string }>("INSERT INTO public.workspaces (name) VALUES ('C') RETURNING id")
    ).id;
    await q("INSERT INTO public.capacity_stub VALUES ($1, 5, true)", [WS3]);
    const mk = async (slug: string, status = "draft", version = 2) =>
      (
        await q1<{ id: string }>(
          "INSERT INTO public.tenant_pages (workspace_id, template_id, slug, title, status, content_version) VALUES ($1,$2,$3,$3,$4,$5) RETURNING id",
          [WS3, tpl, slug, status, version],
        )
      ).id;
    const pub = async (id: string, v: number, ws = WS3) =>
      (
        await svc((c) =>
          c.query("SELECT public.publish_tenant_page_checked($1,$2,$3) AS r", [ws, id, v]),
        )
      ).rows[0].r as { result: string };

    const a = await mk("a");
    t(
      "a stale version is refused (the text changed after validation)",
      (await pub(a, 1)).result === "version_conflict",
    );
    t("the validated version goes live", (await pub(a, 2)).result === "published");
    const row = await q1("SELECT status, published_at FROM public.tenant_pages WHERE id = $1", [a]);
    t(
      "…with status published and a publish date",
      row.status === "published" && row.published_at !== null,
    );
    t(
      "publishing again answers already_published",
      (await pub(a, 2)).result === "already_published",
    );
    t(
      "an archived page is never published",
      (await pub(await mk("arch", "archived"), 2)).result === "not_draft",
    );
    t(
      "a suspended page is never published",
      (await pub(await mk("susp", "billing_suspended"), 2)).result === "not_draft",
    );
    t(
      "another workspace's page is not found",
      (await pub(await mk("mine"), 2, WS)).result === "not_found",
    );

    await q("UPDATE public.tenant_pages SET status = 'draft' WHERE workspace_id = $1", [WS3]);
    await q("DELETE FROM public.tenant_pages WHERE workspace_id = $1", [WS3]);
    const drafts = await Promise.all(Array.from({ length: 20 }, (_, i) => mk(`race-${i}`)));
    const results = await Promise.all(drafts.map((id) => pub(id, 2)));
    const live = await q1(
      "SELECT count(*)::int AS n FROM public.tenant_pages WHERE workspace_id = $1 AND status = 'published'",
      [WS3],
    );
    t(
      "20 drafts racing for 5 slots → exactly 5 published, 15 limit_reached",
      live.n === 5 &&
        results.filter((r) => r.result === "published").length === 5 &&
        results.filter((r) => r.result === "limit_reached").length === 15,
      JSON.stringify(live),
    );

    await q("DELETE FROM public.tenant_pages WHERE workspace_id = $1", [WS3]);
    const one = await mk("one");
    const same = await Promise.all(Array.from({ length: 10 }, () => pub(one, 2)));
    t(
      "10 racing publishes of one draft → one published, nine already_published",
      same.filter((r) => r.result === "published").length === 1 &&
        same.filter((r) => r.result === "already_published").length === 9,
    );

    await q("UPDATE public.capacity_stub SET publish = false WHERE workspace_id = $1", [WS3]);
    t(
      "a workspace that may not publish is refused",
      (await pub(await mk("nope"), 2)).result === "not_entitled",
    );
    let anonDenied = false;
    try {
      await asRole({ role: "authenticated", sub: crypto.randomUUID() }, (c) =>
        c.query("SELECT public.publish_tenant_page_checked($1,$2,2)", [WS3, one]),
      );
    } catch (e) {
      anonDenied = String((e as { code?: string }).code) === "42501";
    }
    t("a signed-in session cannot call it (service role only)", anonDenied);
  }

  console.log("\n6b. Page rows: the server writes, members read");
  {
    const MEMBER = crypto.randomUUID();
    const WS4 = (
      await q1<{ id: string }>("INSERT INTO public.workspaces (name) VALUES ('D') RETURNING id")
    ).id;
    await q(
      "INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'member')",
      [WS4, MEMBER],
    );
    const tpl = (
      await q1<{ id: string }>("SELECT id FROM public.page_templates WHERE slug = 'city_hub'")
    ).id;
    const page = (
      await q1<{ id: string }>(
        "INSERT INTO public.tenant_pages (workspace_id, template_id, slug, title, status) VALUES ($1,$2,'mine','Mine','draft') RETURNING id",
        [WS4, tpl],
      )
    ).id;
    const insertSql = `INSERT INTO public.tenant_pages (workspace_id, template_id, slug, title, status) VALUES ('${WS4}', '${tpl}', 'direct', 'Direct', 'draft')`;
    // Before 000500: the member path exists (what the migration closes).
    let before = false;
    try {
      await asRole({ role: "authenticated", sub: MEMBER }, (c) => c.query(insertSql));
      before = true;
    } catch {
      before = false;
    }
    t("before 000500 a member's session could write a draft page directly", before);
    await q("DELETE FROM public.tenant_pages WHERE slug = 'direct'");

    const m = await applyAndVerify(M500);
    t(
      "20260929000500 applies; every verification row reads true",
      m.allTrue,
      JSON.stringify(m.rows.filter((r) => r.ok !== true)),
    );
    t("…and re-applies (idempotent)", (await applyAndVerify(M500)).allTrue);
    const read = await asRole({ role: "authenticated", sub: MEMBER }, (c) =>
      c.query("SELECT id FROM public.tenant_pages"),
    );
    t(
      "a member still reads their own workspace's pages (and only those)",
      read.rows.length === 1 && read.rows[0].id === page,
    );
    const attempts = [
      insertSql,
      `UPDATE public.tenant_pages SET title = 'changed', listing_filter = '{}' WHERE id = '${page}'`,
      `DELETE FROM public.tenant_pages WHERE id = '${page}'`,
    ];
    const refused: boolean[] = [];
    for (const sql of attempts) {
      try {
        await asRole({ role: "authenticated", sub: MEMBER }, (c) => c.query(sql));
        refused.push(false);
      } catch (e) {
        refused.push(String((e as { code?: string }).code) === "42501");
      }
    }
    t(
      "a member's session can no longer insert, update or delete page rows",
      refused.every(Boolean),
      JSON.stringify(refused),
    );
    const svcWrite = await svc((c) =>
      c.query("UPDATE public.tenant_pages SET title = 'server' WHERE id = $1 RETURNING id", [page]),
    );
    t("the service role still writes them", svcWrite.rows.length === 1);
  }

  console.log("\n7. Rollback, then forward again");
  {
    await pool.query(readRepo(R500));
    const restored = await q1(
      "SELECT count(*) AS n FROM pg_policy WHERE polname IN ('members insert tenant_pages','members update tenant_pages','members delete tenant_pages')",
    );
    t("the 000500 rollback restores the member write policies", Number(restored.n) === 3);
    await pool.query(readRepo(R400));
    const gone = await q1(
      "SELECT to_regprocedure('public.publish_tenant_page_checked(uuid,uuid,integer)') IS NULL AS ok",
    );
    t("the 000400 rollback removes the checked publish", gone.ok === true);
    await pool.query(readRepo(R200));
    await pool.query(readRepo(R100));
    const cols = await q1(
      "SELECT count(*) AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='tenant_listings' AND column_name='city_key'",
    );
    const pol = await q1(
      "SELECT count(*) AS n FROM pg_policy WHERE polname = 'owners write domains'",
    );
    t(
      "the rollbacks remove the columns and restore the old policy",
      Number(cols.n) === 0 && Number(pol.n) === 1,
    );
    await q("UPDATE public.tenant_pages SET status = 'draft'");
    const a = await applyAndVerify(M100);
    const b = await applyAndVerify(M200);
    const c = await applyAndVerify(M400);
    const d = await applyAndVerify(M500);
    t(
      "the files apply again after the rollback",
      a.allTrue && b.allTrue && c.allTrue && d.allTrue,
    );
  }
} finally {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
