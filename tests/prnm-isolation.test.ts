/**
 * PRNM ISOLATION. Run: bun tests/prnm-isolation.test.ts
 *
 * Two functions deployed on the same Supabase project but NOT in this repo —
 * generate-content-batch and drive-content-generation (PRNM content tooling)
 * — still spend AI on the platform's OpenRouter key. They must be unreachable
 * through founders.click. Production facts (owner, 2026-09-25):
 * generate-content-batch requires a user_roles 'admin' row (or an
 * x-driver-secret equal to the service role key); drive-content-generation
 * requires DRIVE_TOKEN (≥ 32 characters, constant-time compare);
 * public.user_roles has RLS on with two policies — "Admins can manage all
 * roles" (ALL, authenticated, has_role(auth.uid(),'admin')) and "Users can
 * view their own roles" (SELECT own); one admin exists.
 *
 * So the isolation rests on three things, each asserted here:
 *   a) nothing founders.click ships references or invokes the two functions,
 *      and no Worker or function code sends an x-driver-secret header (the
 *      service-role bypass) or calls another function with the service key;
 *   b) a customer cannot make themselves an admin: user_roles cannot be
 *      written by an authenticated non-admin or by anon. user_roles and
 *      has_role predate this repo's migration chain (no migration here
 *      creates or alters them), so they are reconstructed from the facts
 *      above plus the repo's own grant migration (20260827000000) and run in
 *      PGlite as the roles PostgREST would use;
 *   c) scripts/probe-prnm-isolation.ts checks the DEPLOYED functions with a
 *      customer's JWT (operator-run, never here) and can only ever send
 *      customer credentials.
 */
import { PGlite } from "@electric-sql/pglite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SUPABASE_STUBS, readRepo } from "./_support/ai-db";

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
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "_build") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (f: string) => relative(ROOT, f);
const PRNM = /generate-content-batch|drive-content-generation/;
const PROBE = "scripts/probe-prnm-isolation.ts";

// ---------------------------------------------------------------------------
console.log("\n=== a) founders.click never reaches the PRNM functions ===");
{
  // Everything that is built or deployed: the Worker (src/, wrangler.jsonc,
  // vite.config.ts), the Supabase functions and config, the migrations, the
  // scripts and the CI workflows.
  const shipped = [
    ...walk(join(ROOT, "src")),
    ...walk(join(ROOT, "supabase")),
    ...walk(join(ROOT, "scripts")),
    ...walk(join(ROOT, ".github")),
    join(ROOT, "wrangler.jsonc"),
    join(ROOT, "vite.config.ts"),
    join(ROOT, "package.json"),
  ]
    .filter((f) => existsSync(f))
    .map(rel)
    .filter((f) => f !== PROBE && !f.startsWith("supabase/.temp"));
  t("the scan covers the shipped tree", shipped.length > 300, String(shipped.length));
  const refs = shipped.filter((f) => PRNM.test(read(f)));
  t("no shipped file references generate-content-batch or drive-content-generation", refs.length === 0, refs.join(", "));
  t(
    "neither function exists in this repo's supabase/functions",
    !existsSync(join(ROOT, "supabase/functions/generate-content-batch")) &&
      !existsSync(join(ROOT, "supabase/functions/drive-content-generation")),
  );
  const config = read("supabase/config.toml");
  t("config.toml configures neither", !PRNM.test(config));

  const code = shipped.filter((f) => /\.(ts|tsx|js|mjs|sql|toml|ya?ml|jsonc?)$/.test(f));
  const driver = code.filter((f) => /x-driver-secret/i.test(read(f)));
  t("no shipped code mentions the x-driver-secret header at all", driver.length === 0, driver.join(", "));
  // The service key is the supabase-js client's credential. Nothing puts it
  // in a request header to another function.
  const fnCalls = code.filter((f) => /functions\/v1\//.test(read(f)) && /(SERVICE_ROLE_KEY|serviceKey|SERVICE_KEY)[\s\S]{0,400}functions\/v1\/|functions\/v1\/[\s\S]{0,400}(SERVICE_ROLE_KEY|serviceKey|SERVICE_KEY)/.test(read(f)));
  t("no Worker or function code calls another function with the service role key", fnCalls.length === 0, fnCalls.join(", "));
  const briefing = read("src/lib/coach-briefing.server.ts");
  t(
    "the one function the Worker calls (coach-briefing-cron) gets the publishable key and the cron secret, never the service key",
    /apikey: process\.env\.SUPABASE_PUBLISHABLE_KEY/.test(briefing) && !/SERVICE_ROLE/.test(briefing),
  );

  // .lovable/ keeps archived bundles that include copies of both functions.
  // It is not an input to any build or deploy: the Worker builds from src/
  // (tsconfig include, wrangler main), functions deploy from
  // supabase/functions, and no workflow, config or script names it.
  const include = read("tsconfig.json").match(/"include":\s*\[([^\]]*)\]/)?.[1] ?? "";
  t("tsconfig compiles src/ only (not .lovable/)", /src\/\*\*/.test(include) && !include.includes(".lovable"), include);
  t("the Worker's entry is src/server.ts", /"main":\s*"src\/server\.ts"/.test(read("wrangler.jsonc")));
  const lovableRefs = shipped.filter((f) => /\.lovable\//.test(read(f)));
  t("no workflow, config, script or source reads .lovable/", lovableRefs.length === 0, lovableRefs.join(", "));
  const userRoleWriters = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "supabase/functions"))]
    .map(rel)
    .filter((f) => /from\(\s*["']user_roles["']\s*\)/.test(read(f)));
  t("no app or function code touches user_roles directly (admin checks are has_role reads)", userRoleWriters.length === 0, userRoleWriters.join(", "));
  const migrations = walk(join(ROOT, "supabase/migrations")).map(rel);
  const roleDdl = migrations.filter((f) => /\buser_roles\b/.test(read(f)));
  t(
    "no migration in this repo creates, alters, grants or re-policies user_roles (its definition predates the chain)",
    roleDdl.length === 0,
    roleDdl.join(", "),
  );
}

// ---------------------------------------------------------------------------
console.log("\n=== b) a customer cannot become an admin ===");
const ADMIN = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const CUSTOMER = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const OTHER = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
const db = await PGlite.create();
await db.exec(SUPABASE_STUBS);
// The production definition, reconstructed (see the header).
await db.exec(`
  CREATE TYPE public.app_role AS ENUM ('admin', 'editor', 'user');
  CREATE TABLE public.user_roles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    role public.app_role NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, role)
  );
  ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
  CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
  CREATE POLICY "Admins can manage all roles" ON public.user_roles FOR ALL TO authenticated
    USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
  CREATE POLICY "Users can view their own roles" ON public.user_roles FOR SELECT
    USING (auth.uid() = user_id);
  INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}', 'admin'), ('${CUSTOMER}', 'user');
`);
// The repo's own migration that touches has_role's privileges.
await db.exec(readRepo("supabase/migrations/20260827000000_grant_rls_helper_execute.sql"));

type Role = "authenticated" | "anon";
async function as(role: Role, uid: string | null, sql: string): Promise<{ rows: any[]; affected: number; error: { code?: string; message: string } | null }> {
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify(uid ? { role, sub: uid } : { role })]);
  await db.exec(`SET ROLE ${role}`);
  try {
    const r = await db.query<any>(sql);
    return { rows: r.rows, affected: r.affectedRows ?? 0, error: null };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { rows: [], affected: 0, error: { code: err.code, message: String(err.message ?? e) } };
  } finally {
    await db.exec("RESET ROLE");
    await db.query(`SELECT set_config('request.jwt.claims', '', false)`);
  }
}
const admins = async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.user_roles WHERE role = 'admin'")).rows[0]!.n;
const isAdmin = async (uid: string) => (await db.query<{ ok: boolean }>(`SELECT public.has_role('${uid}', 'admin') AS ok`)).rows[0]!.ok;
{
  t("setup: exactly one admin, and the customer is not one", (await admins()) === 1 && !(await isAdmin(CUSTOMER)));

  const ins = await as("authenticated", CUSTOMER, `INSERT INTO public.user_roles (user_id, role) VALUES ('${CUSTOMER}', 'admin')`);
  t("a customer cannot INSERT an admin row for themselves (RLS, 42501)", ins.error?.code === "42501", JSON.stringify(ins.error));
  const insOther = await as("authenticated", CUSTOMER, `INSERT INTO public.user_roles (user_id, role) VALUES ('${OTHER}', 'admin')`);
  t("…nor for anyone else", insOther.error?.code === "42501", JSON.stringify(insOther.error));
  const upd = await as("authenticated", CUSTOMER, `UPDATE public.user_roles SET role = 'admin' WHERE user_id = '${CUSTOMER}'`);
  t("a customer cannot UPDATE their own row to admin (no row is writable)", upd.error !== null || upd.affected === 0, JSON.stringify(upd));
  const steal = await as("authenticated", CUSTOMER, `UPDATE public.user_roles SET user_id = '${CUSTOMER}' WHERE role = 'admin'`);
  t("a customer cannot move the admin row onto themselves", steal.error !== null || steal.affected === 0, JSON.stringify(steal));
  const del = await as("authenticated", CUSTOMER, `DELETE FROM public.user_roles WHERE role = 'admin'`);
  t("a customer cannot DELETE the admin row", del.error !== null || del.affected === 0, JSON.stringify(del));
  const upsert = await as(
    "authenticated",
    CUSTOMER,
    `INSERT INTO public.user_roles (user_id, role) VALUES ('${CUSTOMER}', 'user') ON CONFLICT (user_id, role) DO UPDATE SET role = 'admin'`,
  );
  t("a customer cannot upsert their way to admin", upsert.error !== null || upsert.affected === 0, JSON.stringify(upsert));

  for (const [label, sql] of [
    ["INSERT", `INSERT INTO public.user_roles (user_id, role) VALUES ('${OTHER}', 'admin')`],
    ["UPDATE", `UPDATE public.user_roles SET role = 'admin'`],
    ["DELETE", `DELETE FROM public.user_roles`],
  ] as const) {
    const r = await as("anon", null, sql);
    t(`anon cannot ${label} user_roles`, r.error !== null || r.affected === 0, JSON.stringify(r));
  }

  t("after every attempt: still exactly one admin, and the customer is not one", (await admins()) === 1 && !(await isAdmin(CUSTOMER)) && !(await isAdmin(OTHER)));
  const seen = await as("authenticated", CUSTOMER, "SELECT user_id::text, role::text FROM public.user_roles");
  t(
    "a customer sees only their own role row",
    seen.error === null && seen.rows.length === 1 && seen.rows[0].user_id === CUSTOMER && seen.rows[0].role === "user",
    JSON.stringify(seen),
  );
  const anonSeen = await as("anon", null, "SELECT count(*)::int AS n FROM public.user_roles");
  t("anon sees no role rows", anonSeen.error !== null || anonSeen.rows[0]?.n === 0, JSON.stringify(anonSeen));
  // Sanity: the policies are the working ones, not merely a blanket deny.
  const grant = await as("authenticated", ADMIN, `INSERT INTO public.user_roles (user_id, role) VALUES ('${OTHER}', 'editor')`);
  t("the admin CAN manage roles (the policy works as designed)", grant.error === null && grant.affected === 1, JSON.stringify(grant));
  await db.exec(`DELETE FROM public.user_roles WHERE user_id = '${OTHER}'`);
}

// ---------------------------------------------------------------------------
console.log("\n=== c) the probe can only send customer credentials ===");
{
  t("scripts/probe-prnm-isolation.ts exists", existsSync(join(ROOT, PROBE)));
  const probe = read(PROBE);
  const code = probe.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  t("it calls exactly the two PRNM functions, under functions/v1", /FUNCTIONS = \["generate-content-batch", "drive-content-generation"\] as const;/.test(code) && /\$\{base\}\/functions\/v1\/\$\{fn\}/.test(code));
  t("it never sets an x-driver-secret header or reads DRIVE_TOKEN", !/x-driver-secret/i.test(code) && !/DRIVE_TOKEN/.test(code));
  const headerWrites = [...code.matchAll(/headers\.(\w+)\s*=/g)].map((m) => m[1]);
  t(
    "the only credentials it sends are the publishable key and the customer JWT",
    headerWrites.join() === "apikey,Authorization" && /headers\.Authorization = `Bearer \$\{jwt\}`;/.test(code) && /headers\.apikey = publishable;/.test(code),
    headerWrites.join(),
  );
  t(
    "the service role key is only ever compared, to refuse — never sent",
    (code.match(/SUPABASE_SERVICE_ROLE_KEY/g) ?? []).length === 1 && /if \(serviceKey && \(jwt === serviceKey \|\| publishable === serviceKey\)\) fail\(/.test(code),
  );
  t("it refuses a token that is not a signed-in customer's", /claims\.role !== "authenticated"/.test(code));
  t("it refuses a platform admin's token (has_role, read through the customer's own token)", /if \(await isAdmin\(\)\) fail\(/.test(code) && /rpc\/has_role/.test(code));
  t("only 401 / 403 (or 404, not deployed) count as unreachable", /new Set\(\[401, 403, 404\]\)/.test(code));
  t("it prints statuses only, never a token or a response body", !/console\.(log|error)\([^)]*\b(jwt|publishable|serviceKey)\b/.test(code) && /res\.body\?\.cancel\(\)/.test(code));
  const runners = [...walk(join(ROOT, ".github")), join(ROOT, "package.json")].filter((f) => existsSync(f) && /probe-prnm-isolation/.test(readFileSync(f, "utf8")));
  t("no CI workflow or npm script runs it (operator-only)", runners.length === 0, runners.map(rel).join(", "));
}

{
  const pkg = read("package.json");
  t("this suite is in the test chain", /bun tests\/prnm-isolation\.test\.ts/.test(pkg));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
