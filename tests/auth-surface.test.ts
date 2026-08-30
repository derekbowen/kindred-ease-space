/**
 * AUTHORIZATION SURFACE GUARD.
 *
 * Server functions run with the SERVICE ROLE client, which bypasses RLS
 * entirely. RLS is therefore not a backstop here: if a server function forgets
 * to authorize, there is nothing behind it. That is precisely how the
 * 2026-08-30 entitlement escalation was possible.
 *
 * This test reads the source of every createServerFn in the app and asserts:
 *
 *   1. it requires authentication, OR it is on the explicit public allowlist;
 *   2. if it is authenticated and accepts a workspace id, it performs an
 *      authorization check before touching the database.
 *
 * The allowlist is the point. Making a function public has to be a deliberate,
 * reviewed edit to this file — never a silent omission in a feature PR.
 *
 * Run: bun tests/auth-surface.test.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}\n        ${extra}`); }
}

/**
 * Intentionally unauthenticated. Every entry is reachable by anonymous users,
 * so each must be safe by construction — public content, or a write whose
 * shape cannot leak or corrupt tenant data.
 */
const PUBLIC_ALLOWLIST: Record<string, string> = {
  // Public help centre — published content only.
  getHelpHome: "public help centre",
  getHelpCategory: "public help centre",
  getHelpArticle: "public help centre",
  searchHelp: "public help centre",
  quickSearchHelp: "public help centre",
  submitArticleFeedback: "anonymous article feedback",
  submitSupportTicket: "anonymous support contact form",
  // Public marketing / affiliate signup.
  getPublicAffiliateForm: "public affiliate application form",
  submitAffiliateApplication: "public affiliate application submission",
  // Public page serving on customer domains — resolves by request host and
  // returns only status='published' rows.
  getPublicTenantPage: "serves published tenant pages on customer domains",
  lookupPageByHostname: "edge/public page resolution by hostname",
  // 404 telemetry written while serving a public page.
  logPublic404: "records a 404 seen on a public page",
};

/** Patterns that constitute a real authorization check. */
const AUTHZ = new RegExp(
  [
    "assertWorkspaceMember", "assertWorkspaceOwner", "assertMember",
    "is_workspace_member", "is_workspace_owner",
    "assertInternal", "requireInternal", "assertWorkspaceAdmin", "assertOwner",
  ].join("|"),
);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

type Fn = { name: string; file: string; body: string };
const fns: Fn[] = [];
for (const file of walk("src")) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("createServerFn")) continue;
  for (const part of src.split(/(?=export const \w+ = createServerFn)/)) {
    const m = /^export const (\w+) = createServerFn/.exec(part);
    if (m) fns.push({ name: m[1]!, file, body: part });
  }
}

console.log(`\n=== scanned ${fns.length} server functions ===\n`);
t("the scanner actually found the server functions", fns.length > 50, `found ${fns.length}`);

console.log("\n=== every server function is authenticated or explicitly public ===");
{
  const unguarded = fns.filter(
    (f) => !f.body.split(".handler")[0]!.includes("requireSupabaseAuth"),
  );
  const undeclared = unguarded.filter((f) => !(f.name in PUBLIC_ALLOWLIST));
  t("no server function is unauthenticated without being on the allowlist",
    undeclared.length === 0,
    undeclared.map((f) => `${f.name} (${f.file})`).join("\n        "));

  // Keep the allowlist honest in the other direction too: an entry that has
  // since gained auth should be removed, so the list stays a real inventory of
  // the public surface rather than accumulating stale exemptions.
  const stale = Object.keys(PUBLIC_ALLOWLIST).filter(
    (n) => !unguarded.some((f) => f.name === n),
  );
  t("no stale entries left on the public allowlist", stale.length === 0, stale.join(", "));
}

console.log("\n=== authenticated + workspace-scoped implies an authorization check ===");
{
  // The service-role client bypasses RLS, so accepting a workspaceId from the
  // client and using it without checking membership is a cross-tenant write.
  const risky = fns.filter((f) => {
    const authed = f.body.split(".handler")[0]!.includes("requireSupabaseAuth");
    const admin = /\bsb\(\)|supabaseAdmin/.test(f.body);
    const scoped = /workspaceId|workspaceIdSchema/.test(f.body);
    return authed && admin && scoped && !AUTHZ.test(f.body);
  });
  t("no authenticated workspace-scoped function skips authorization",
    risky.length === 0,
    risky.map((f) => `${f.name} (${f.file})`).join("\n        "));
}

console.log("\n=== the entitlement columns are never written by app code ===");
{
  // Stripe's webhook is the only writer. A server function setting these would
  // reintroduce the escalation the table-level REVOKE closed.
  const ENTITLEMENT_COLS = /page_limit_base|page_limit_addon|page_limit_bonus|subscription_status/;
  const writers = fns.filter(
    (f) => ENTITLEMENT_COLS.test(f.body) && /\.update\(|\.upsert\(|\.insert\(/.test(f.body),
  );
  t("no server function writes entitlement columns",
    writers.length === 0,
    writers.map((f) => `${f.name} (${f.file})`).join("\n        "));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) console.log("FAILED:\n  " + failed.join("\n  ") + "\n");
process.exit(fail ? 1 : 0);
