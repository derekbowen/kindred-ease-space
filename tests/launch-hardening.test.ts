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
  ALREADY_CONNECTED_ERROR,
  DOMAIN_RECLAIMED_ERROR,
  domainRowStillHeld,
  reclaimStaleDomainClaim,
  shouldReclaimUnverifiedDomain,
  UNVERIFIED_DOMAIN_CLAIM_TTL_MS,
} from "../src/lib/admin-domains.functions";
import { preferredHostMatch, type HostMatch } from "../src/lib/sitemap.server";

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
//
// Source shape first, then the step itself is driven against an in-memory
// pair of tables and BOTH resolver branches are evaluated over the resulting
// state with the same two predicates the SQL function and workspaceIdForHost
// use. If the previous tenant can still be named for the hostname, it fails.
const reclaimBody = domainsSrc.slice(
  domainsSrc.indexOf("export async function reclaimStaleDomainClaim"),
  domainsSrc.indexOf("async function dohQuery"),
);
const clearAt = reclaimBody.indexOf(".update({ marketplace_domain: null, domain_verified_at: null })");
t("reclaim clears the prior workspace's marketplace_domain AND domain_verified_at", clearAt > 0);
t(
  "…only on the prior workspace, and only when it still carries this hostname",
  /\.update\(\{ marketplace_domain: null, domain_verified_at: null \}\)\s*\.eq\("id", prior\.workspace_id\)\s*\.eq\("marketplace_domain", hostname\)/.test(reclaimBody),
);
t("…BEFORE the row is deleted, so the hostname never changes hands while the seed can still match",
  clearAt > 0 && clearAt < reclaimBody.indexOf(".delete()"));
t("a failed clear is a refusal, never a log-and-continue",
  /if \(clearErr\) \{\s*return \{\s*ok: false,/.test(reclaimBody) && !/if \(clearErr\) \{\s*console\.error/.test(reclaimBody));
t("a delete that removed nothing (claimant verified in the window) is refused with the standard message",
  /if \(Array\.isArray\(deleted\) && deleted\.length > 0\) return \{ ok: true \};[\s\S]*return \{ ok: false, error: ALREADY_CONNECTED_ERROR \};/.test(reclaimBody));
t("…and the seed it cleared is put back from the now-verified row",
  /\.update\(\{ marketplace_domain: hostname, domain_verified_at: live\?\.verified_at \?\? null \}\)\s*\.eq\("id", prior\.workspace_id\)\s*\.is\("marketplace_domain", null\)/.test(reclaimBody));
const addBody = domainsSrc.slice(
  domainsSrc.indexOf("export const addWorkspaceDomain"),
  domainsSrc.indexOf("async function tryFileVerify"),
);
t("the handler runs the reclaim step and stops on its refusal, before inserting",
  /const reclaimed = await reclaimStaleDomainClaim\(sb\(\), prior, hostname\);\s*if \(!reclaimed\.ok\) return \{ ok: false as const, error: reclaimed\.error \};/.test(addBody) &&
    addBody.indexOf("reclaimStaleDomainClaim(sb()") < addBody.indexOf(".insert({"));

type DomainRow = { id: string; workspace_id: string; hostname: string; verified: boolean; verified_at: string | null };
type WsRow = { id: string; marketplace_domain: string | null; domain_verified_at: string | null };
type Tables = { workspace_domains: DomainRow[]; workspaces: WsRow[] };

/** Just enough of the supabase query builder for the reclaim step, applied
 * to plain arrays. `failing` names "<table>.<op>" calls that return an error. */
function fakeDb(state: Tables, failing: Set<string> = new Set()) {
  const ops: string[] = [];
  class Q {
    table: keyof Tables;
    op = "select";
    payload: Record<string, unknown> | null = null;
    filters: Array<[string, unknown]> = [];
    single = false;
    constructor(table: keyof Tables) {
      this.table = table;
    }
    select() { return this; }
    update(p: Record<string, unknown>) { this.op = "update"; this.payload = p; return this; }
    delete() { this.op = "delete"; return this; }
    eq(c: string, v: unknown) { this.filters.push([c, v]); return this; }
    is(c: string, v: unknown) { this.filters.push([c, v]); return this; }
    maybeSingle() { this.single = true; return this; }
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(res, rej);
    }
    run() {
      const key = `${this.table}.${this.op}`;
      ops.push(key);
      if (failing.has(key)) return { data: null, error: { message: "boom" } };
      const all = state[this.table] as Array<Record<string, unknown>>;
      const rows = all.filter((r) => this.filters.every(([c, v]) => r[c] === v));
      if (this.op === "update") for (const r of rows) Object.assign(r, this.payload);
      if (this.op === "delete") (state as Record<string, unknown[]>)[this.table] = all.filter((r) => !rows.includes(r));
      const out = rows.map((r) => ({ ...r }));
      return { data: this.single ? (out[0] ?? null) : out, error: null };
    }
  }
  return { db: { from: (table: string) => new Q(table as keyof Tables) }, ops };
}

/** Both resolver branches over the fake state: exactly the two predicates of
 * current_workspace_id_by_host (20260923000500) and workspaceIdForHost. */
function candidatesFor(state: Tables, host: string): HostMatch[] {
  const h = host.toLowerCase().replace(/^www\./, "");
  return [
    ...state.workspace_domains
      .filter((d) => d.verified && d.hostname.toLowerCase() === h)
      .map((d) => ({ workspaceId: d.workspace_id, source: "workspace_domains" as const, verifiedAt: d.verified_at })),
    ...state.workspaces
      .filter((w) => w.marketplace_domain === h && w.domain_verified_at !== null)
      .map((w) => ({ workspaceId: w.id, source: "marketplace_domain" as const, verifiedAt: w.domain_verified_at })),
  ];
}
const H = "customer.com";
const PRIOR = { id: "row-theirs", workspace_id: THEIRS };
const fresh = (): Tables => ({
  workspace_domains: [{ id: "row-theirs", workspace_id: THEIRS, hostname: H, verified: false, verified_at: null }],
  // The worst case the coordinator asked about: the previous workspace still
  // carries the seed AND a stamped domain_verified_at (from an older
  // verification of some other hostname).
  workspaces: [
    { id: THEIRS, marketplace_domain: H, domain_verified_at: "2026-03-01T00:00:00Z" },
    { id: MINE, marketplace_domain: null, domain_verified_at: null },
  ],
});
const resolves = (state: Tables) => preferredHostMatch(candidatesFor(state, H))?.workspaceId ?? null;
const errorOf = (r: { ok: boolean; error?: string }) => ("error" in r ? String(r.error) : "");

t("before the reclaim, seed + stale stamp resolve the hostname to the previous tenant (the hole)", resolves(fresh()) === THEIRS);

{
  const s = fresh();
  const { db, ops } = fakeDb(s);
  const r = await reclaimStaleDomainClaim(db, PRIOR, H);
  t("reclaim succeeds", r.ok, errorOf(r));
  t("the seed is cleared BEFORE the row is deleted, and nothing else is touched",
    ops.join(" > ") === "workspaces.update > workspace_domains.delete", ops.join(" > "));
  const a = s.workspaces.find((w) => w.id === THEIRS)!;
  t("the previous tenant's marketplace_domain and domain_verified_at are both cleared",
    a.marketplace_domain === null && a.domain_verified_at === null, JSON.stringify(a));
  t("its row is gone", !s.workspace_domains.some((d) => d.id === "row-theirs"));
  t("the hostname resolves to NOBODY through either branch — never the previous tenant", resolves(s) === null, String(resolves(s)));
  // The new claimant claims (which seeds its marketplace_domain) and verifies.
  s.workspace_domains.push({ id: "row-mine", workspace_id: MINE, hostname: H, verified: true, verified_at: "2026-09-22T00:00:00Z" });
  s.workspaces.find((w) => w.id === MINE)!.marketplace_domain = H;
  t("once the new claimant verifies, the hostname resolves to it", resolves(s) === MINE, String(resolves(s)));
  // Even a domain_verified_at that somehow reappears on the previous tenant
  // (a later verification of a different domain under old code) has no seed
  // to attach to.
  a.domain_verified_at = "2026-12-01T00:00:00Z";
  t("a re-stamped domain_verified_at on the previous tenant changes nothing without the seed", resolves(s) === MINE);
  t("the other workspace is untouched", s.workspaces.find((w) => w.id === MINE)!.domain_verified_at === null);
}

{
  const s = fresh();
  const { db, ops } = fakeDb(s, new Set(["workspaces.update"]));
  const r = await reclaimStaleDomainClaim(db, PRIOR, H);
  t("when the clear fails the reclaim is refused", !r.ok && /release the previous claim/.test(errorOf(r)), errorOf(r));
  t("…and the row is NOT deleted", ops.length === 1 && s.workspace_domains.length === 1, ops.join(" > "));
  t("…so nothing changed hands: the state is exactly as before", resolves(s) === THEIRS && s.workspaces[0]!.marketplace_domain === H);
}

{
  const s = fresh();
  const failing = new Set(["workspace_domains.delete"]);
  const { db } = fakeDb(s, failing);
  const r1 = await reclaimStaleDomainClaim(db, PRIOR, H);
  t("when the delete fails after the clear, the reclaim is refused", !r1.ok, errorOf(r1));
  t("…with the row still present and the seed already cleared",
    s.workspace_domains.length === 1 && s.workspaces[0]!.marketplace_domain === null);
  t("…which already stops the previous tenant resolving the hostname", resolves(s) === null);
  failing.clear();
  const r2 = await reclaimStaleDomainClaim(db, PRIOR, H);
  t("a retry completes from that state", r2.ok && s.workspace_domains.length === 0, errorOf(r2));
}

{
  // The race: the claimant verified between our read and the delete.
  const s = fresh();
  s.workspace_domains[0]!.verified = true;
  s.workspace_domains[0]!.verified_at = "2026-09-21T00:00:00Z";
  const { db, ops } = fakeDb(s);
  const r = await reclaimStaleDomainClaim(db, PRIOR, H);
  t("a claimant that verified in the window keeps the hostname", !r.ok && errorOf(r) === ALREADY_CONNECTED_ERROR, errorOf(r));
  t("its row is untouched", s.workspace_domains.length === 1 && s.workspace_domains[0]!.verified);
  const a = s.workspaces.find((w) => w.id === THEIRS)!;
  t("the seed the clear took is restored from the now-verified row",
    a.marketplace_domain === H && a.domain_verified_at === "2026-09-21T00:00:00Z", JSON.stringify(a));
  t("and the hostname resolves to it — the rightful, verified owner", resolves(s) === THEIRS);
  t("the restore is a second workspaces update, nothing more",
    ops.filter((o) => o === "workspaces.update").length === 2 && !ops.includes("workspace_domains.update"), ops.join(" > "));
}

{
  const s = fresh();
  s.workspaces[0]!.marketplace_domain = "other.example";
  const { db } = fakeDb(s);
  const r = await reclaimStaleDomainClaim(db, PRIOR, H);
  t("a prior workspace whose marketplace_domain is a different hostname keeps it and its stamp",
    r.ok && s.workspaces[0]!.marketplace_domain === "other.example" && s.workspaces[0]!.domain_verified_at === "2026-03-01T00:00:00Z");
  t("…and the reclaimed hostname still resolves to nobody", resolves(s) === null);
}

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

console.log("\n=== l) a claim never inherits a stale verified stamp (B2) ===");
// addWorkspaceDomain seeds marketplace_domain when it is empty. The resolver's
// legacy branch treats domain_verified_at as "marketplace_domain is verified",
// so a stamp left over from an earlier hostname vouched for the new,
// unverified one the moment it was claimed.
const seedAt = addBody.indexOf(".update({ marketplace_domain: hostname, domain_verified_at: null })");
t("the seed writes marketplace_domain WITH domain_verified_at cleared", seedAt > 0);
t("…and never the hostname alone", !/\.update\(\{ marketplace_domain: hostname \}\)/.test(addBody));
t("…on this workspace only",
  /\.update\(\{ marketplace_domain: hostname, domain_verified_at: null \}\)\s*\.eq\("id", data\.workspaceId\)/.test(addBody));
const seedGuardAt = addBody.indexOf("if (!ws?.marketplace_domain) {");
t("…still only when marketplace_domain is unset", seedGuardAt > 0 && seedGuardAt < seedAt);
t("…after the row insert, as before", addBody.indexOf(".insert({") > 0 && addBody.indexOf(".insert({") < seedAt);
t("…and the comment names the resolver branch that trusts the stamp", /resolver's legacy branch/.test(addBody.slice(0, seedAt)));

console.log("\n=== m) verification notices a row removed or reclaimed mid-flight (B3) ===");
// verifyWorkspaceDomain runs across several PostgREST calls and two slow
// network steps. Its unverified row can be deleted by the owner, or reclaimed
// for another workspace (delete + insert under a new id) by
// reclaimStaleDomainClaim, at any point in between. The verified UPDATE then
// matched no row and nobody noticed, the edge was provisioned for a hostname
// this workspace no longer held, and the workspace was stamped as verified
// for it.
t("the message tells the owner what happened and what to do",
  DOMAIN_RECLAIMED_ERROR === "This domain was removed or claimed by another workspace while verifying. Add it again to retry.");
t("the verified UPDATE is keyed on the workspace too, and reports the rows it matched",
  /\.update\(\{\s*verified: true,[\s\S]*?\}\)\s*\.eq\("id", row\.id\)\s*\.eq\("workspace_id", data\.workspaceId\)\s*\.select\("id"\);/.test(verifyBody));
t("zero rows matched is a refusal with that message",
  /if \(!Array\.isArray\(proven\) \|\| proven\.length === 0\) \{\s*return \{ ok: false as const, error: DOMAIN_RECLAIMED_ERROR \};/.test(verifyBody));
t("a failed UPDATE is still its own error", /if \(upErr\) return \{ ok: false as const, error: upErr\.message \};/.test(verifyBody));
const provisionAt = verifyBody.indexOf("provisionDomainAtEdge(row.hostname)");
const heldAt = verifyBody.search(/domainRowStillHeld\(sb\(\), row, data\.workspaceId, \{\s*verified: false,?\s*\}\)/);
t("the row is re-read (id + workspace) before the edge is provisioned", heldAt > 0 && provisionAt > heldAt);
t("…and a missing row stops the flow with the same message",
  /const held = await domainRowStillHeld\(sb\(\), row, data\.workspaceId, \{\s*verified: false,?\s*\}\);\s*if \(!held\.ok\) return \{ ok: false as const, error: held\.error \};/.test(verifyBody));
const unconfiguredAt = verifyBody.indexOf("if (!isEdgeProvisioningConfigured()) {");
t("the edge-unconfigured block is untouched and still comes first",
  unconfiguredAt > 0 && unconfiguredAt < heldAt && /BLOCKED: edge provisioning unconfigured; refusing to advance/.test(verifyBody) &&
    /\.update\(\{ status: "error", last_error: blocked \}\)\s*\.eq\("id", row\.id\);\s*return \{ ok: false as const, error: blocked \};/.test(verifyBody));
const stampCheckAt = verifyBody.search(/domainRowStillHeld\(sb\(\), row, data\.workspaceId, \{\s*verified: true,?\s*\}\)/);
const stampReadAt = verifyBody.indexOf('.select("marketplace_domain")');
const wsPatchAt = verifyBody.indexOf("const wsPatch:");
t("the row is re-read again — verified, same hostname — after provisioning and before the workspace stamp",
  stampCheckAt > provisionAt && stampCheckAt < stampReadAt && stampReadAt < wsPatchAt);
t("…and the stamp is skipped when it no longer holds",
  /if \(!stillVerified\.ok\) return \{ ok: false as const, error: stillVerified\.error \};/.test(verifyBody));
t("retry semantics unchanged: verified + provisioned returns early, verified-only skips the ownership checks",
  /if \(row\.verified && edgeProvisioned\) return \{ ok: true as const, method: "already" as const \};/.test(verifyBody) && /if \(!row\.verified\) \{/.test(verifyBody));
t("a provisioning failure still parks the row in error with its message",
  /status: "error", last_error: `Edge provisioning failed: \$\{msg\}`/.test(verifyBody));

// The re-read itself, driven against the in-memory tables.
{
  const ROW = { id: "row-mine", hostname: H };
  const s: Tables = {
    workspace_domains: [{ id: "row-mine", workspace_id: MINE, hostname: H, verified: true, verified_at: "2026-09-22T00:00:00Z" }],
    workspaces: [],
  };
  const { db, ops } = fakeDb(s);
  t("a row still held by the workspace passes", (await domainRowStillHeld(db, ROW, MINE, { verified: false })).ok);
  t("…verified, for the same hostname, it passes the stamp check too", (await domainRowStillHeld(db, ROW, MINE, { verified: true })).ok);
  t("the check is a read, nothing else", ops.length === 2 && ops.every((o) => o === "workspace_domains.select"), ops.join(" > "));
  s.workspace_domains[0]!.verified = false;
  t("an unverified row fails the stamp check…", !(await domainRowStillHeld(db, ROW, MINE, { verified: true })).ok);
  t("…but still counts as held for provisioning", (await domainRowStillHeld(db, ROW, MINE, { verified: false })).ok);
  s.workspace_domains[0]!.verified = true;
  s.workspace_domains[0]!.hostname = "other.example";
  const renamed = await domainRowStillHeld(db, ROW, MINE, { verified: true });
  t("a row that now carries a different hostname is not vouched for", !renamed.ok && errorOf(renamed) === DOMAIN_RECLAIMED_ERROR);
  // Reclaimed: the row is gone and the hostname lives under another workspace with a new id.
  s.workspace_domains = [{ id: "row-theirs-2", workspace_id: THEIRS, hostname: H, verified: false, verified_at: null }];
  const gone = await domainRowStillHeld(db, ROW, MINE, { verified: false });
  t("a reclaimed row (new id, other workspace) is reported gone with the reclaimed message", !gone.ok && errorOf(gone) === DOMAIN_RECLAIMED_ERROR);
  // The same id under another workspace cannot happen with uuids; the predicate must not rely on that.
  s.workspace_domains = [{ id: "row-mine", workspace_id: THEIRS, hostname: H, verified: true, verified_at: null }];
  t("the same id under another workspace is not ours", !(await domainRowStillHeld(db, ROW, MINE, { verified: true })).ok);
  s.workspace_domains = [];
  t("a removed row is gone", !(await domainRowStillHeld(db, ROW, MINE, { verified: false })).ok);
  const { db: failingDb } = fakeDb({ workspace_domains: [], workspaces: [] }, new Set(["workspace_domains.select"]));
  const failedRead = await domainRowStillHeld(failingDb, ROW, MINE, { verified: false });
  t("a read error is reported as such, not as a reclaim", !failedRead.ok && errorOf(failedRead) === "boom");
}

console.log("\n=== n) rollback scripts: refuse rather than destroy, and re-run cleanly (B6) ===");
const RB1 = resolve(ROOT, "supabase/rollback/20260923000100_marketplace_api_connection_rollback.sql");
t("rollback for 000100 exists", existsSync(RB1), RB1);
const rb1raw = existsSync(RB1) ? readFileSync(RB1, "utf8") : "";
const rb1 = withoutComments(rb1raw);
// It used to DELETE every auth_mode = 'marketplace' connection inside the
// transaction so the restored NOT NULL would hold — destroying customer
// connections to make a rollback go through.
t("000100 rollback no longer DELETEs anything", !/\bDELETE\b/i.test(rb1));
t("…it refuses while marketplace-mode connections exist, naming how many",
  /RAISE EXCEPTION 'rollback refused: % marketplace-mode connections exist; migrate them first', n;/.test(rb1));
t("…from a DO block that counts them",
  /DO \$\$[\s\S]*SELECT count\(\*\) INTO n FROM public\.tenant_integrations WHERE auth_mode = 'marketplace';\s*IF n > 0 THEN\s*RAISE EXCEPTION[\s\S]*END \$\$;/.test(rb1));
t("…before any schema change", rb1.indexOf("RAISE EXCEPTION 'rollback refused") < rb1.indexOf("ALTER TABLE"));
t("…inside the transaction, so the failure leaves nothing changed",
  rb1.indexOf("BEGIN;") < rb1.indexOf("DO $$") && rb1.indexOf("DO $$") < rb1.indexOf("COMMIT;"));
t("the NOT NULL restore and the column drops are kept",
  rb1.includes("ALTER COLUMN client_secret_vault_id SET NOT NULL") && rb1.includes("DROP COLUMN IF EXISTS auth_mode") && rb1.includes("DROP COLUMN IF EXISTS marketplace_name"));
t("the VERIFY queries are kept",
  /information_schema\.columns[\s\S]*column_name IN \('auth_mode','marketplace_name'\)/.test(rb1) &&
    /pg_constraint WHERE conname = 'tenant_integrations_provider_marketplace_id_key'/.test(rb1));
const rb1header = rb1raw.slice(0, rb1raw.indexOf("BEGIN;"));
t("the header says the script refuses, and how to clear the way", /REFUSES/.test(rb1header) && /migrate/i.test(rb1header) && !/\bDELETE\b/.test(rb1header));

const RB4 = resolve(ROOT, "supabase/rollback/20260923000400_launch_hardening_rollback.sql");
t("rollback for 000400 exists", existsSync(RB4), RB4);
const rb4 = existsSync(RB4) ? withoutComments(readFileSync(RB4, "utf8")) : "";
const dropAt = rb4.indexOf('DROP POLICY IF EXISTS "Anyone can create tickets" ON public.support_tickets;');
const createAt = rb4.indexOf('CREATE POLICY "Anyone can create tickets" ON public.support_tickets FOR INSERT TO public WITH CHECK (true);');
t("000400 rollback drops the ticket policy before recreating it (re-runnable)", dropAt > 0 && createAt > dropAt);
t("…inside the transaction", rb4.indexOf("BEGIN;") < dropAt && createAt < rb4.indexOf("COMMIT;"));
t("…keeping every grant it restores", (rb4.match(/GRANT EXECUTE ON FUNCTION/g) ?? []).length === 9);
t("…and its VERIFY query",
  /has_function_privilege\('anon','public\.consume_platform_ai_credit\(uuid\)','EXECUTE'\) AS anon_credit/.test(rb4) &&
    /pg_policies WHERE tablename='support_tickets' AND policyname='Anyone can create tickets'/.test(rb4));

finish();
