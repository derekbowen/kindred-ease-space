/**
 * The minimum of a Supabase database that the AI spend migrations touch, for
 * PGlite (in-process) and for a real Postgres 16 (tests/ai-concurrency.pg.ts).
 * Plain SQL that runs on both.
 *
 *   - the three API roles with Supabase's default grants (every new table and
 *     function is granted to anon/authenticated/service_role — which is why
 *     the migrations must REVOKE);
 *   - auth.uid() / auth.role() read from request.jwt.claims exactly as
 *     Supabase's own definitions do, so a caller emulating PostgREST sets the
 *     claims per transaction;
 *   - public.is_workspace_member over workspace_members;
 *   - the columns of workspaces, tenant_pages, credit_balances, credit_ledger,
 *     workspace_ai_quota, ai_usage_log, platform_settings and
 *     coach_daily_briefings the functions read and write (definitions follow
 *     the production migrations that created them);
 *   - a pg_cron stand-in (cron.job, cron.schedule, cron.unschedule) with the
 *     same signatures, so the migration's schedule call is real SQL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..");

export const MIGRATION_600 = "supabase/migrations/20260924000600_generation_settlement_and_reservations.sql";
export const MIGRATION_800 = "supabase/migrations/20260925000800_ai_spend_reservations.sql";
export const ROLLBACK_800 = "supabase/rollback/20260925000800_ai_spend_reservations_rollback.sql";

export const readRepo = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

export const SUPABASE_STUBS = `
  DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

  CREATE SCHEMA IF NOT EXISTS auth;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid
  $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
    SELECT nullif(coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'), '')::text
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;

  CREATE SCHEMA IF NOT EXISTS cron;
  CREATE TABLE IF NOT EXISTS cron.job (
    jobid bigserial PRIMARY KEY,
    jobname text UNIQUE,
    schedule text NOT NULL,
    command text NOT NULL,
    active boolean NOT NULL DEFAULT true
  );
  CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
  LANGUAGE sql AS $$
    INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
    ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
    RETURNING jobid
  $$;
  CREATE OR REPLACE FUNCTION cron.unschedule(job_name text) RETURNS boolean
  LANGUAGE plpgsql AS $$
  BEGIN
    DELETE FROM cron.job WHERE jobname = job_name;
    IF NOT FOUND THEN RAISE EXCEPTION 'could not find valid entry for job ''%''', job_name; END IF;
    RETURN true;
  END $$;

  CREATE TABLE IF NOT EXISTS public.workspaces (id uuid PRIMARY KEY, name text);
  CREATE TABLE IF NOT EXISTS public.workspace_members (
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    user_id uuid NOT NULL,
    role text NOT NULL DEFAULT 'member',
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE OR REPLACE FUNCTION public.is_workspace_member(_workspace_id uuid, _user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT EXISTS (SELECT 1 FROM public.workspace_members
                          WHERE workspace_id = _workspace_id AND user_id = _user_id) $$;

  CREATE TABLE IF NOT EXISTS public.tenant_pages (
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
  CREATE UNIQUE INDEX IF NOT EXISTS tenant_pages_generation_request_uidx
    ON public.tenant_pages (workspace_id, generation_request_id)
    WHERE generation_request_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS public.credit_balances (
    workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
    balance integer NOT NULL DEFAULT 0,
    monthly_allowance integer NOT NULL DEFAULT 0,
    lifetime_granted integer NOT NULL DEFAULT 0,
    lifetime_spent integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS public.credit_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    delta integer NOT NULL,
    reason text NOT NULL,
    ai_model text,
    ref_type text,
    ref_id text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS public.workspace_ai_quota (
    workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
    platform_credits_remaining int NOT NULL DEFAULT 20,
    lifetime_platform_used int NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS public.ai_usage_log (
    id bigserial PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    user_id uuid,
    provider text NOT NULL,
    model text NOT NULL,
    feature text,
    prompt_tokens int NOT NULL DEFAULT 0,
    completion_tokens int NOT NULL DEFAULT 0,
    total_tokens int NOT NULL DEFAULT 0,
    cost_usd_micros bigint NOT NULL DEFAULT 0,
    used_byok boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'ok',
    error text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS public.platform_settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  INSERT INTO public.platform_settings (key, value) VALUES
    ('generation_paused', 'false'::jsonb), ('generation_daily_cap', '50'::jsonb)
  ON CONFLICT (key) DO NOTHING;
  -- What the daily briefing reads (coach-briefing-cron).
  ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS subscription_status text DEFAULT 'active';
  ALTER TABLE public.tenant_pages ADD COLUMN IF NOT EXISTS meta_description text;
  ALTER TABLE public.tenant_pages ADD COLUMN IF NOT EXISTS body_markdown text;
  ALTER TABLE public.tenant_pages ADD COLUMN IF NOT EXISTS listing_filter jsonb;
  CREATE TABLE IF NOT EXISTS public.tenant_listings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    title text,
    city text,
    category text,
    state_published boolean NOT NULL DEFAULT true
  );
  CREATE TABLE IF NOT EXISTS public.coach_daily_briefings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    briefing_date date NOT NULL,
    insights jsonb NOT NULL DEFAULT '[]'::jsonb,
    generated_at timestamptz NOT NULL DEFAULT now(),
    viewed_at timestamptz,
    UNIQUE (workspace_id, briefing_date)
  );
`;

/** The last result set of a script (the migrations end with their verification block). */
export type CheckRow = { check: string; ok: boolean | null };

/** The SQL a PostgREST .rpc(name, args) call runs: named arguments, one statement. */
export function rpcSql(name: string, args: Record<string, unknown>): { text: string; values: unknown[] } {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad rpc name ${name}`);
  const keys = Object.keys(args);
  for (const k of keys) if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error(`bad rpc arg ${k}`);
  const values = keys.map((k) => {
    const v = args[k];
    return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
  });
  const list = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
  return { text: `SELECT public.${name}(${list}) AS result`, values };
}

/**
 * A service-role supabase-js stand-in backed by PGlite: .from(table)
 * .select(cols) .eq / .neq .maybeSingle() and .rpc(name, args) — the calls
 * the daily briefing function makes — run as real SQL, so the claim, the
 * reservation and the store are the migration's own functions.
 */
export function pgliteSupabase(db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }) {
  const ident = /^[a-z_][a-z0-9_]*$/;
  class Query implements PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> {
    private cols = "*";
    private filters: Array<[string, string, unknown]> = [];
    private single = false;
    constructor(private table: string) {
      if (!ident.test(table)) throw new Error(`bad table ${table}`);
    }
    select(cols = "*") {
      if (!/^[a-z_*][a-z0-9_, *]*$/.test(cols)) throw new Error(`bad columns ${cols}`);
      this.cols = cols;
      return this;
    }
    eq(col: string, v: unknown) {
      this.filters.push(["=", col, v]);
      return this;
    }
    neq(col: string, v: unknown) {
      this.filters.push(["<>", col, v]);
      return this;
    }
    maybeSingle() {
      this.single = true;
      return this;
    }
    private async run() {
      for (const [, c] of this.filters) if (!ident.test(c)) throw new Error(`bad column ${c}`);
      const where = this.filters.map(([op, c], i) => `${c} ${op} $${i + 1}`).join(" AND ");
      const sql = `SELECT ${this.cols} FROM public.${this.table}${where ? ` WHERE ${where}` : ""}`;
      try {
        const r = await db.query(sql, this.filters.map(([, , v]) => v));
        return { data: this.single ? (r.rows[0] ?? null) : r.rows, error: null };
      } catch (e) {
        const err = e as { message?: string; code?: string };
        return { data: null, error: { message: String(err.message ?? e), code: err.code } };
      }
    }
    then<A = any, B = never>(res?: (v: any) => A | PromiseLike<A>, rej?: (e: unknown) => B | PromiseLike<B>) {
      return this.run().then(res, rej);
    }
  }
  return {
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      try {
        const q = rpcSql(name, args);
        const r = await db.query(q.text, q.values);
        return { data: r.rows[0]?.result ?? null, error: null };
      } catch (e) {
        const err = e as { message?: string; code?: string };
        return { data: null, error: { message: String(err.message ?? e), code: err.code } };
      }
    },
  };
}
