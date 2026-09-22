/**
 * LAUNCH-PATH HARDENING. Run: bun tests/launch-hardening.test.ts
 *
 * A production audit found four holes on the launch path:
 *   - consume_platform_ai_credit (SECURITY DEFINER, no membership check) was
 *     executable by anon — anyone could drain any workspace's free AI quota.
 *   - The tenant secret writers and workspace provisioning were executable by
 *     anon although only authenticated server functions call them.
 *   - support_tickets accepted unlimited anonymous inserts by policy, while
 *     the app only ever inserts with the service role.
 *   - workspace_domains.hostname is UNIQUE regardless of verification, so an
 *     abandoned unverified claim blocked the real owner forever.
 *
 * The migration is asserted against its text: there is no database here, and
 * a grant test that only runs when someone remembers to point it at a
 * project is a test that never runs. The domain-expiry decision is a pure
 * function and is exercised directly. Nothing in this file touches the
 * network.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  shouldReclaimUnverifiedDomain,
  UNVERIFIED_DOMAIN_CLAIM_TTL_MS,
} from "../src/lib/admin-domains.functions";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

function finish() {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("Failed:\n  " + failed.join("\n  "));
    process.exit(1);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

// Strip `-- ...` comment lines so a prose mention of a function never
// satisfies (or trips) an assertion about SQL.
function withoutComments(sql: string): string {
  return sql
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");
}

const MIGRATION = resolve(ROOT, "supabase/migrations/20260923000400_launch_hardening.sql");

console.log("\n=== migration file ===");
t("migration is readable", existsSync(MIGRATION), MIGRATION);
if (!existsSync(MIGRATION)) finish();
const raw = readFileSync(MIGRATION, "utf8");
const sql = withoutComments(raw);

console.log("\n=== a) consume_platform_ai_credit ===");
t(
  "function is redefined with the same signature",
  sql.includes("CREATE OR REPLACE FUNCTION public.consume_platform_ai_credit(_workspace_id uuid)"),
);
t("stays SECURITY DEFINER with a pinned search_path", /SECURITY DEFINER\s+SET search_path = public/.test(sql));
const guardAt = sql.indexOf(
  "IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN",
);
t("membership guard is present", guardAt >= 0);
t("guard raises 42501 (insufficient_privilege)", /RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'/.test(sql));
const updateAt = sql.indexOf("UPDATE public.workspace_ai_quota");
t("guard runs before the quota UPDATE", guardAt >= 0 && updateAt > guardAt);
t(
  "original quota body is preserved",
  sql.includes("platform_credits_remaining = platform_credits_remaining - 1") &&
    sql.includes("RAISE EXCEPTION 'platform_ai_quota_exhausted' USING ERRCODE = 'P0001'"),
);
t(
  "EXECUTE revoked from PUBLIC, anon and authenticated",
  sql.includes(
    "REVOKE EXECUTE ON FUNCTION public.consume_platform_ai_credit(uuid) FROM PUBLIC, anon, authenticated;",
  ),
);
t(
  "EXECUTE granted to service_role",
  sql.includes("GRANT EXECUTE ON FUNCTION public.consume_platform_ai_credit(uuid) TO service_role;"),
);

// The service-role-only grant is only safe because no app path calls the RPC
// with a user-scoped client. Guard that assumption at the call sites.
const callers = walk(resolve(ROOT, "src"))
  .concat(walk(resolve(ROOT, "supabase/functions")))
  .flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => /rpc\(\s*["']consume_platform_ai_credit["']/.test(l))
      .map((l) => ({ f, l })),
  );
t("consume_platform_ai_credit has app callers", callers.length > 0);
for (const { f, l } of callers) {
  t(
    `service-role caller: ${f.slice(ROOT.length + 1)}`,
    /\b(supabaseAdmin|admin)\s*\.rpc\(/.test(l),
    l.trim(),
  );
}

console.log("\n=== b) anon revoked on tenant + provisioning RPCs ===");
const ANON_REVOKED = [
  "public.provision_workspace_for_user(text,text,text,boolean)",
  "public.tenant_set_ai_credential(uuid,text,text,text,jsonb)",
  "public.tenant_delete_ai_credential(uuid,text)",
  "public.tenant_set_integration_secret(uuid,text)",
  "public.tenant_set_workspace_secret(uuid,text,text)",
  "public.tenant_delete_workspace_secret(uuid,uuid)",
];
for (const sig of ANON_REVOKED) t(`listed for anon revoke: ${sig}`, sql.includes(`'${sig}'`));
t(
  "revoke strips PUBLIC too (anon inherits from PUBLIC otherwise)",
  sql.includes("format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', sig)"),
);
t(
  "authenticated and service_role re-granted explicitly",
  sql.includes("format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', sig)"),
);
t("missing signature is skipped with a NOTICE, not a failure", /IF to_regprocedure\(sig\) IS NULL THEN\s+RAISE NOTICE/.test(sql));

console.log("\n=== c) host resolvers are service-role only ===");
for (const sig of ["public.current_workspace_id_by_host(text)", "public.workspace_for_host(text)"])
  t(`listed for service-role lockdown: ${sig}`, sql.includes(`'${sig}'`));
t(
  "host resolvers revoked from PUBLIC, anon and authenticated",
  sql.includes("format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig)"),
);
t(
  "host resolvers granted to service_role",
  sql.includes("format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig)"),
);
const hostCallers = walk(resolve(ROOT, "src"))
  .concat(walk(resolve(ROOT, "supabase/functions")))
  .flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => /rpc\(\s*["'](current_workspace_id_by_host|workspace_for_host)["']/.test(l))
      .map((l) => ({ f, l })),
  );
for (const { f, l } of hostCallers) {
  // public-tenant-page aliases supabaseAdmin as sb(); either spelling is the service role.
  t(
    `service-role host lookup: ${f.slice(ROOT.length + 1)}`,
    /\b(supabaseAdmin|admin|sb\(\))\s*\.rpc\(/.test(l),
    l.trim(),
  );
}

console.log("\n=== d) support_tickets anon insert policy ===");
t(
  "anon insert policy dropped",
  sql.includes('DROP POLICY IF EXISTS "Anyone can create tickets" ON public.support_tickets;'),
);
t(
  "no replacement policy on support_tickets (app writes with service role)",
  !/CREATE POLICY[^;]*support_tickets/.test(sql),
);
const helpServer = readFileSync(resolve(ROOT, "src/lib/help.server.ts"), "utf8");
const submitBody = helpServer.slice(helpServer.indexOf("export async function submitTicket"));
t("submitTicket exists in help.server.ts", submitBody.length > 0);
t(
  "submitTicket inserts with supabaseAdmin (RLS is not on the app path)",
  /supabaseAdmin\s*\.from\("support_tickets"\)\s*\.insert\(/.test(submitBody),
);

console.log("\n=== e) RLS helper functions untouched ===");
const HELPERS = ["has_role", "is_workspace_member", "is_workspace_owner"];
// Any statement fragment that revokes must not name a helper, and no helper
// may appear as a quoted signature in the revoke lists. Case-sensitive on
// purpose: the verification labels say "anon revoked:" in the same SELECT
// that names the helpers to prove they are still executable.
const revokeFragments = sql.split(";").filter((s) => /\bREVOKE\b/.test(s));
for (const h of HELPERS) {
  t(`no REVOKE names ${h}`, !revokeFragments.some((s) => s.includes(h)));
  t(`${h} is not in a revoke signature list`, !sql.includes(`'public.${h}(`));
}
t(
  "verification block proves the helpers stay executable",
  sql.includes("p.proname IN ('has_role', 'is_workspace_member', 'is_workspace_owner')") &&
    /has_function_privilege\('anon', p\.oid, 'EXECUTE'\)/.test(sql),
);
for (const h of ["help_search_v2", "help_suggest_titles", "count_providers_by_category"])
  t(`${h} is left alone`, !sql.includes(h));

console.log("\n=== f) verification block convention ===");
const verifyAt = raw.indexOf("-- Verification");
t("verification block is last", verifyAt > 0 && !/;\s*\S/.test(withoutComments(raw.slice(verifyAt)).replace(/;\s*$/, "")));
t("verification uses the check/ok shape", /AS check,/.test(sql) && /AS ok\b/.test(sql) && /UNION ALL SELECT/.test(sql));
t(
  "verifies anon cannot execute consume_platform_ai_credit",
  sql.includes("NOT has_function_privilege('anon', 'public.consume_platform_ai_credit(uuid)', 'EXECUTE')"),
);
t(
  "verifies authenticated cannot execute consume_platform_ai_credit",
  sql.includes(
    "NOT has_function_privilege('authenticated', 'public.consume_platform_ai_credit(uuid)', 'EXECUTE')",
  ),
);
for (const sig of ANON_REVOKED)
  t(`verifies anon revoke holds: ${sig}`, sql.includes(`NOT has_function_privilege('anon', to_regprocedure('${sig}'), 'EXECUTE')`));
t(
  "verifies the ticket policy is gone",
  /NOT EXISTS \(SELECT 1 FROM pg_policies[\s\S]*policyname = 'Anyone can create tickets'\)/.test(sql),
);

console.log("\n=== domain claim expiry (pure decision) ===");
const DAY = 24 * 60 * 60 * 1000;
t("claims expire after exactly 7 days", UNVERIFIED_DOMAIN_CLAIM_TTL_MS === 7 * DAY);
const now = new Date("2026-09-22T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
const MINE = "11111111-1111-1111-1111-111111111111";
const THEIRS = "22222222-2222-2222-2222-222222222222";

t(
  "stale unverified claim from another workspace is reclaimed",
  shouldReclaimUnverifiedDomain({ workspace_id: THEIRS, verified: false, created_at: ago(8) }, MINE, now),
);
t(
  "the 7-day boundary itself counts as expired",
  shouldReclaimUnverifiedDomain({ workspace_id: THEIRS, verified: false, created_at: ago(7) }, MINE, now),
);
t(
  "a 6-day-old unverified claim is still honoured",
  !shouldReclaimUnverifiedDomain({ workspace_id: THEIRS, verified: false, created_at: ago(6) }, MINE, now),
);
t(
  "a brand-new unverified claim is honoured",
  !shouldReclaimUnverifiedDomain({ workspace_id: THEIRS, verified: false, created_at: ago(0) }, MINE, now),
);
t(
  "a verified domain is never reclaimed, however old",
  !shouldReclaimUnverifiedDomain({ workspace_id: THEIRS, verified: true, created_at: ago(400) }, MINE, now),
);
t(
  "the same workspace's own stale row is not silently deleted",
  !shouldReclaimUnverifiedDomain({ workspace_id: MINE, verified: false, created_at: ago(30) }, MINE, now),
);
t(
  "an unparseable created_at fails closed",
  !shouldReclaimUnverifiedDomain({ workspace_id: THEIRS, verified: false, created_at: "not a date" }, MINE, now),
);
t(
  "a created_at in the future fails closed",
  !shouldReclaimUnverifiedDomain({ workspace_id: THEIRS, verified: false, created_at: ago(-1) }, MINE, now),
);

// The refusal the customer sees must tell them the claim is temporary.
const domainsSrc = readFileSync(resolve(ROOT, "src/lib/admin-domains.functions.ts"), "utf8");
t(
  "'already connected' refusal explains the 7-day expiry",
  /already connected[^"]*7 days/i.test(domainsSrc),
);
t(
  "handler consults shouldReclaimUnverifiedDomain before inserting",
  domainsSrc.indexOf("shouldReclaimUnverifiedDomain(prior") > 0 &&
    domainsSrc.indexOf("shouldReclaimUnverifiedDomain(prior") <
      domainsSrc.indexOf('.insert({\n        workspace_id: data.workspaceId,\n        hostname,'),
);
t(
  "reclaim deletes only a still-unverified row (race guard)",
  /\.delete\(\)\s*\.eq\("id", prior\.id\)\s*\.eq\("verified", false\)/.test(domainsSrc),
);

finish();
