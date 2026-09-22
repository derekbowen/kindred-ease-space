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
t("grant loop skips a missing signature with a NOTICE (so every drifted name is reported)", /IF to_regprocedure\(sig\) IS NULL THEN\s+RAISE NOTICE/.test(sql));

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

console.log("\n=== f) drift guard: a signature that does not resolve fails the migration ===");
// The first version wrapped every verification row in coalesce(…, true), so
// a drifted signature was skipped by the grant loops AND reported OK. Now a
// DO block ahead of the verification collects every unresolved name and
// raises, which (one transaction per migration) rolls the whole file back.
const driftAt = sql.indexOf("missing := missing || sig");
t("drift guard collects unresolved signatures", driftAt > 0);
t("drift guard raises with the full list",
  /IF cardinality\(missing\) > 0 THEN\s+RAISE EXCEPTION 'launch_hardening: signature drift[^']*'[\s\S]*?array_to_string\(missing, ', '\)/.test(sql));
const guardBlock = sql.slice(sql.lastIndexOf("DO $$", driftAt), sql.indexOf("END $$;", driftAt));
for (const sig of [
  "public.consume_platform_ai_credit(uuid)",
  ...ANON_REVOKED,
  "public.current_workspace_id_by_host(text)",
  "public.workspace_for_host(text)",
])
  t(`drift guard covers ${sig}`, guardBlock.includes(`'${sig}'`));
t("drift guard runs after the grant loops", driftAt > sql.indexOf("format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig)"));
t("drift guard runs before the verification block", driftAt < raw.indexOf("-- Verification"));
t("verification never treats a missing function as satisfied (no coalesce(…, true))",
  !/coalesce\(\s*(NOT\s+)?has_function_privilege/i.test(sql), "coalesce wrapper still present");

console.log("\n=== g) verification block convention ===");
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

console.log("\n=== h) a reclaimed hostname cannot resolve to its previous claimant (S2) ===");
// addWorkspaceDomain seeds workspaces.marketplace_domain on claim. After a
// reclaim that seed pointed the resolver's legacy branch at the OLD workspace
// while the verified workspace_domains row pointed at the new one, and the
// resolver picked with LIMIT 1 and no ORDER BY.
const addBody = domainsSrc.slice(
  domainsSrc.indexOf("export const addWorkspaceDomain"),
  domainsSrc.indexOf("async function tryFileVerify"),
);
t(
  "reclaim refuses when the race guard deleted nothing (the claimant verified meanwhile)",
  /\.eq\("verified", false\)\s*\.select\("id"\);[\s\S]*?if \(!reclaimed \|\| reclaimed\.length === 0\) \{\s*return \{ ok: false as const, error: ALREADY_CONNECTED_ERROR \};/.test(addBody),
);
const clearAt = addBody.indexOf(".update({ marketplace_domain: null, domain_verified_at: null })");
t("reclaim clears the prior workspace's marketplace_domain AND domain_verified_at", clearAt > 0);
t(
  "…only on the prior workspace, and only when it still carries this hostname",
  /\.update\(\{ marketplace_domain: null, domain_verified_at: null \}\)\s*\.eq\("id", prior\.workspace_id\)\s*\.eq\("marketplace_domain", hostname\)/.test(addBody),
);
t("…after the row is gone, before this workspace's insert",
  clearAt > addBody.indexOf('.eq("verified", false)') && clearAt < addBody.indexOf(".insert({"));
t("…and a failure to clear is logged, not turned into a stranded hostname",
  /if \(clearErr\) \{\s*console\.error\(/.test(addBody) && !/if \(clearErr\) return/.test(addBody));

const verifyBody = domainsSrc.slice(
  domainsSrc.indexOf("export const verifyWorkspaceDomain"),
  domainsSrc.indexOf("export const updateDomainConnection"),
);
t(
  "verifying a domain stamps domain_verified_at only when marketplace_domain is (or becomes) that hostname",
  /const wsPatch: \{ domain_verified_at\?: string; marketplace_domain\?: string \} = \{\};/.test(verifyBody) &&
    /if \(!ws\?\.marketplace_domain\) \{\s*wsPatch\.marketplace_domain = row\.hostname;\s*wsPatch\.domain_verified_at = verifiedAt;\s*\} else if \(String\(ws\.marketplace_domain\)\.toLowerCase\(\) === row\.hostname\) \{\s*wsPatch\.domain_verified_at = verifiedAt;\s*\}/.test(verifyBody),
);
t("…and never unconditionally", !/domain_verified_at: verifiedAt,\s*\};/.test(verifyBody));

const deleteBody = domainsSrc.slice(domainsSrc.indexOf("export const deleteWorkspaceDomain"));
t(
  "deleting a domain clears domain_verified_at when that hostname is the marketplace_domain",
  /\.update\(\{ domain_verified_at: null \}\)\s*\.eq\("id", data\.workspaceId\)\s*\.eq\("marketplace_domain", row\.hostname\)/.test(deleteBody),
);
t("…but leaves the typed marketplace_domain itself", !/marketplace_domain: null/.test(deleteBody));

console.log("\n=== i) the host resolver prefers a verified custom domain (S2, migration 000500) ===");
const MIG5 = resolve(ROOT, "supabase/migrations/20260923000500_host_resolver_prefers_verified_domain.sql");
t("migration 000500 exists", existsSync(MIG5), MIG5);
const raw5 = existsSync(MIG5) ? readFileSync(MIG5, "utf8") : "";
const sql5 = withoutComments(raw5);
t("redefines current_workspace_id_by_host with the same signature",
  sql5.includes("CREATE OR REPLACE FUNCTION public.current_workspace_id_by_host(_host text)"));
t("stays STABLE SECURITY DEFINER with a pinned search_path", /STABLE SECURITY DEFINER\s+SET search_path = public/.test(sql5));
t("normalisation is unchanged from 20260825120000",
  sql5.includes("SELECT lower(regexp_replace(regexp_replace(_host, ':\\d+$', ''), '^www\\.', '')) AS h"));
t("has an explicit ORDER BY: verified custom domain first, newest verification, lowest id",
  sql5.includes("ORDER BY priority ASC, verified_at DESC NULLS LAST, id ASC"));
t("ORDER BY sits before LIMIT 1", sql5.indexOf("ORDER BY priority") < sql5.indexOf("LIMIT 1") && sql5.indexOf("LIMIT 1") > 0);
t("verified workspace_domains rows are priority 0, the legacy branch priority 1",
  /0 AS priority[\s\S]*FROM public\.workspace_domains wd[\s\S]*UNION ALL[\s\S]*1 AS priority[\s\S]*FROM public\.workspaces w/.test(sql5));
t("both branches keep their verification gate",
  sql5.includes("WHERE wd.verified = true") && sql5.includes("AND w.domain_verified_at IS NOT NULL"));
t("keeps the service-role-only grants from 000400",
  sql5.includes("REVOKE EXECUTE ON FUNCTION public.current_workspace_id_by_host(text) FROM PUBLIC, anon, authenticated;") &&
    sql5.includes("GRANT EXECUTE ON FUNCTION public.current_workspace_id_by_host(text) TO service_role;"));
t("does not touch workspace_for_host (it delegates)", !/CREATE OR REPLACE FUNCTION public\.workspace_for_host/.test(sql5));
const verify5At = raw5.indexOf("-- Verification");
t("verification block is last", verify5At > 0 && !/;\s*\S/.test(withoutComments(raw5.slice(verify5At)).replace(/;\s*$/, "")));
t("verification proves the ORDER BY is in the stored body",
  /prosrc LIKE '%ORDER BY priority ASC, verified_at DESC NULLS LAST, id ASC%'/.test(sql5));

const RB5 = resolve(ROOT, "supabase/rollback/20260923000500_host_resolver_prefers_verified_domain_rollback.sql");
t("rollback for 000500 exists", existsSync(RB5), RB5);
const rb5 = existsSync(RB5) ? withoutComments(readFileSync(RB5, "utf8")) : "";
// The function body only: the rollback's VERIFY query names "ORDER BY
// priority" inside a string literal to prove it is gone.
const rb5Body = rb5.slice(rb5.indexOf("AS $$"), rb5.indexOf("$$;"));
t("rollback restores the 20260825120000 body (UNION ALL, LIMIT 1, no ORDER BY)",
  rb5.includes("CREATE OR REPLACE FUNCTION public.current_workspace_id_by_host(_host text)") &&
    rb5Body.includes("UNION ALL") && rb5Body.includes("LIMIT 1;") && !/ORDER BY/.test(rb5Body));
t("rollback VERIFY checks the ORDER BY is gone", /prosrc LIKE '%ORDER BY priority%' AS ordered/.test(rb5));
t("rollback keeps the resolver service-role only",
  rb5.includes("GRANT EXECUTE ON FUNCTION public.current_workspace_id_by_host(text) TO service_role;"));
const rbReadme = readFileSync(resolve(ROOT, "supabase/rollback/README.md"), "utf8");
t("rollback README lists 000500 in the apply order", /000400 → 000500/.test(rbReadme));

console.log("\n=== j) changing marketplace_domain drops its verified flag (S2) ===");
// updateWorkspaceProfile let an owner type any hostname into
// marketplace_domain and keep the domain_verified_at stamped for a different,
// actually verified hostname — pointing public resolution anywhere with no
// challenge.
const wsFnSrc = readFileSync(resolve(ROOT, "src/lib/workspace.functions.ts"), "utf8");
const profileBody = wsFnSrc.slice(
  wsFnSrc.indexOf("export const updateWorkspaceProfile"),
  wsFnSrc.indexOf("export const getWorkspaceOverview"),
);
t("the patch can carry domain_verified_at", /domain_verified_at\?: string \| null;/.test(profileBody));
t("the current value is read before deciding",
  /\.select\("marketplace_domain"\)\s*\.eq\("id", data\.workspaceId\)\s*\.maybeSingle\(\)/.test(profileBody));
t("a CHANGED marketplace_domain resets domain_verified_at to null",
  /if \(\(current\?\.marketplace_domain \?\? null\) !== patch\.marketplace_domain\) \{\s*patch\.domain_verified_at = null;/.test(profileBody));
t("…unless the new value is this workspace's own verified custom domain, whose verified_at is carried",
  /\.from\("workspace_domains"\)\s*\.select\("verified_at"\)\s*\.eq\("workspace_id", data\.workspaceId\)\s*\.eq\("hostname", patch\.marketplace_domain\)\s*\.eq\("verified", true\)/.test(profileBody) &&
    /if \(own\?\.verified_at\) patch\.domain_verified_at = own\.verified_at;/.test(profileBody));
t("a read failure fails the save rather than guessing", /if \(readErr\) throw new Error\(readErr\.message\);/.test(profileBody));
t("only an owner reaches any of this", profileBody.indexOf("is_workspace_owner") > 0 && profileBody.indexOf("is_workspace_owner") < profileBody.indexOf("patch.domain_verified_at"));

console.log("\n=== k) the platform preview is not a way around the billing gate (S8) ===");
// /s/{workspace}/{slug} is a public URL. Exempting it from the billing gate
// kept a lapsed tenant's pages viewable on founders.click, against the
// promise that pages pause when access ends.
const pageSrc = readFileSync(resolve(ROOT, "src/lib/public-tenant-page.functions.ts"), "utf8");
const pageHandler = pageSrc.slice(pageSrc.indexOf("export const getPublicTenantPage"));
t("the billing gate is no longer wrapped in `if (!preview)`", !/if \(!preview\) \{\s*const \{ data: billing/.test(pageHandler));
const billingAt = pageHandler.indexOf('.select("subscription_status, trial_ends_at, current_period_end")');
t("the billing read happens for every resolved workspace", billingAt > 0);
t("a withheld page reports billingBlocked for preview and live alike",
  /return \{ page: null, host, preview, billingBlocked: true \};/.test(pageHandler));
t("the gate still fails open on a billing read error", /billing read failed, serving anyway/.test(pageHandler));
t("the gate still fails open on a grant read failure", /granted !== null && !decision\.serve/.test(pageHandler));
t("the gate runs before any page content is read",
  billingAt < pageHandler.indexOf('.from("tenant_pages")') && billingAt < pageHandler.indexOf('.from("content_pages")'));
const previewRoute = readFileSync(resolve(ROOT, "src/routes/s.$ws.$slug.tsx"), "utf8");
t("the preview route turns page: null into a 404", /if \(!r\.page\) throw notFound\(\);/.test(previewRoute));

finish();
