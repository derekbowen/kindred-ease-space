/**
 * ROUND-5 SERVER HARDENING. Run: bun tests/r5-server-hardening.test.ts
 *
 *   - security L9: every shared secret the Worker checks (CRON_SECRET on the
 *     Sharetribe sync and canonical-audit hooks, OPS_PROBE_SECRET on the ops
 *     probes) goes through ONE constant-time, digest-based comparison
 *     (src/lib/secret-compare.ts) — executed, then asserted across the
 *     Worker's sources (no === / !== on a secret, no length-gated compare);
 *     the hooks driven: a wrong, missing, prefix or longer secret is 401;
 *   - security L2: the BYOK key test (testAiCredential → runKeyTest) is
 *     throttled per workspace (5 per hour, counted by the database's
 *     check_rate_limit, shared by every Worker isolate); a refused test reads
 *     no key and sends nothing; a failed throttle read fails closed.
 *
 * The other round-5 items are proven beside their code: the briefing's
 * constant-time check, input cap and refresh throttle in
 * tests/coach-briefing.test.ts; the recipient policy in
 * tests/email-recipient-policy.test.ts; the PRNM probe in
 * tests/prnm-isolation.test.ts.
 */
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FakeBackend } from "./_support/fake-backend";

const backend = new FakeBackend();
backend.install();

const { secretsMatch } = await import("../src/lib/secret-compare");
const { opsProbeSecretMatches } = await import("../src/lib/ops-probe-auth");
const { runKeyTest, BYOK_KEY_TESTS_PER_HOUR, KEY_TEST_THROTTLED_MESSAGE } = await import("../src/lib/ai-byok.functions");
const { isCustomerSentence } = await import("../src/lib/user-message");

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

try {
  console.log("\n=== security L9: one constant-time comparison (executed) ===");
  {
    const S = "cron-3f9c1d7e5b2a4c8d9e0f1a2b3c4d5e6f";
    const cases: Array<[string, string | null | undefined, string | null | undefined, boolean]> = [
      ["the same secret", S, S, true],
      ["a different secret of the same length", S.replace(/.$/, "0"), S, false],
      ["a prefix", S.slice(0, -1), S, false],
      ["one character more", `${S}x`, S, false],
      ["empty presented", "", S, false],
      ["nothing presented", null, S, false],
      ["undefined presented", undefined, S, false],
      ["nothing configured", S, "", false],
      ["unset configured", S, undefined, false],
      ["both empty (never a match)", "", "", false],
      ["case differs", S.toUpperCase(), S, false],
      ["unicode, the same", "sécret-ü-🔑", "sécret-ü-🔑", true],
      ["unicode, differs", "sécret-ü-🔑", "secret-u-🔑", false],
    ];
    for (const [label, got, want, expect] of cases) t(`secretsMatch: ${label} → ${expect}`, secretsMatch(got, want) === expect);
    t("the ops probe compare is the same rule (trimmed)", opsProbeSecretMatches(`  ${S} `, S) && !opsProbeSecretMatches("", S) && !opsProbeSecretMatches(S, " "));
    const src = read("src/lib/secret-compare.ts");
    t(
      "it compares fixed-length SHA-256 digests with timingSafeEqual (no length gate, no early exit)",
      /createHash\("sha256"\)\.update\(got, "utf8"\)\.digest\(\)/.test(src) &&
        /createHash\("sha256"\)\.update\(want, "utf8"\)\.digest\(\)/.test(src) &&
        /return timingSafeEqual\(a, b\);/.test(src) &&
        !/\.length\s*(===|!==)/.test(src),
    );
  }

  console.log("\n=== security L9: every Worker secret check goes through it ===");
  {
    const walk = (dir: string, out: string[] = []): string[] => {
      if (!existsSync(dir)) return out;
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(name)) out.push(p);
      }
      return out;
    };
    const src = walk(join(ROOT, "src")).map((f) => relative(ROOT, f));
    // Line comments first: a "// … /api/public/* …" comment must not open a block comment.
    const strip = (s: string) => s.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
    // Files that read a shared secret the caller must present.
    const checkers = src.filter((f) => /process\.env\.(CRON_SECRET|OPS_PROBE_SECRET)\b/.test(strip(read(f))));
    const comparing = checkers.filter((f) => !/cronSecretConfigured|Boolean\(process\.env\.CRON_SECRET\)/.test(strip(read(f))) || /secretsMatch|opsProbeSecretMatches/.test(read(f)));
    t(
      "the Worker files that check CRON_SECRET / OPS_PROBE_SECRET are the two hooks and the ops-probe gate",
      comparing.sort().join() ===
        ["src/lib/coach-briefing.server.ts", "src/lib/ops-probe-auth.ts", "src/routes/api/public/hooks/canonical-audit.ts", "src/routes/api/public/hooks/sync-sharetribe.ts"].sort().join(),
      comparing.join(", "),
    );
    for (const f of ["src/routes/api/public/hooks/canonical-audit.ts", "src/routes/api/public/hooks/sync-sharetribe.ts", "src/lib/ops-probe-auth.ts"]) {
      const code = strip(read(f));
      t(`${f}: compares through secretsMatch`, /secretsMatch\(/.test(code) && /from "@\/lib\/secret-compare"/.test(code));
      t(
        `${f}: no === / !== on a secret, no private timingSafeEqual or safeEqual`,
        !/(expected|secret|presented|provided)\s*(===|!==)|(===|!==)\s*(expected|secret)\b/.test(code) && !/timingSafeEqual|function safeEqual/.test(code),
      );
    }
    t(
      "coach-briefing.server.ts only SENDS the secret (to the cron function), it never compares one",
      !/secretsMatch|===\s*secret|secret\s*===/.test(strip(read("src/lib/coach-briefing.server.ts"))),
    );
    const others = src.filter((f) => /timingSafeEqual/.test(strip(read(f))));
    t(
      "timingSafeEqual appears only in the one compare and the auth-email HMAC check (fixed-length digests)",
      others.sort().join() === ["src/lib/auth-email-hook.ts", "src/lib/secret-compare.ts"].join(),
      others.join(", "),
    );
  }

  console.log("\n=== security L9: the hooks, driven ===");
  {
    const CRON = "cron-secret-for-tests-9f8e7d6c5b4a";
    process.env.CRON_SECRET = CRON;
    const { Route: syncRoute } = await import("../src/routes/api/public/hooks/sync-sharetribe");
    const { Route: auditRoute } = await import("../src/routes/api/public/hooks/canonical-audit");
    const sync = (syncRoute as any).options.server.handlers.POST as (c: { request: Request }) => Promise<Response>;
    const audit = (auditRoute as any).options.server.handlers.POST as (c: { request: Request }) => Promise<Response>;
    const req = (url: string, headers: Record<string, string>) =>
      new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    for (const [label, headers] of [
      ["no secret", {}],
      ["a wrong bearer", { authorization: "Bearer not-the-secret" }],
      ["a prefix of the secret", { authorization: `Bearer ${CRON.slice(0, -1)}` }],
      ["the secret plus one character", { authorization: `Bearer ${CRON}x` }],
      ["a wrong x-cron-secret", { "x-cron-secret": "nope" }],
      ["an empty bearer", { authorization: "Bearer " }],
    ] as const) {
      backend.reset();
      const s = await sync({ request: req("https://www.founders.click/api/public/hooks/sync-sharetribe", headers) });
      const a = await audit({ request: req("https://www.founders.click/api/public/hooks/canonical-audit", headers) });
      t(`${label}: both hooks answer 401, having done nothing`, s.status === 401 && a.status === 401 && backend.hits.length === 0, `${s.status} ${a.status} ${backend.hits.length}`);
    }
    backend.reset();
    const ok = await sync({ request: req("https://www.founders.click/api/public/hooks/sync-sharetribe", { authorization: `Bearer ${CRON}` }) });
    t("the right secret passes the sync hook's gate", ok.status !== 401, String(ok.status));
    delete process.env.CRON_SECRET;
    const unset = await sync({ request: req("https://www.founders.click/api/public/hooks/sync-sharetribe", { authorization: `Bearer ${CRON}` }) });
    const unsetAudit = await audit({ request: req("https://www.founders.click/api/public/hooks/canonical-audit", { authorization: `Bearer ${CRON}` }) });
    t("CRON_SECRET unset on the Worker: refused (never 'no secret needed')", unset.status >= 400 && unsetAudit.status === 401, `${unset.status} ${unsetAudit.status}`);
  }

  console.log("\n=== security L2: the BYOK key test is throttled per workspace ===");
  {
    const WS = "11111111-1111-4111-8111-111111111111";
    t("5 tests per workspace per hour", BYOK_KEY_TESTS_PER_HOUR === 5);
    t("the throttle sentence is a customer sentence", isCustomerSentence(KEY_TEST_THROTTLED_MESSAGE));
    backend.reset();
    backend.rpc.check_rate_limit = () => false;
    {
      const r = await runKeyTest(WS);
      t("throttled: the fixed sentence", r.ok === false && (r as any).error === KEY_TEST_THROTTLED_MESSAGE, JSON.stringify(r));
      t("…the key is never read and nothing is sent", backend.rpcHits("tenant_get_workspace_secret").length === 0 && backend.providerHits().length === 0);
      const args = backend.rpcHits("check_rate_limit")[0]?.body;
      t(
        "…counted by the database, per workspace: bucket byok_key_test:<workspace>, 5 per 3600 s",
        JSON.stringify(args) === JSON.stringify({ _bucket: `byok_key_test:${WS}`, _max: 5, _window_seconds: 3600 }),
        JSON.stringify(args),
      );
    }
    backend.reset();
    backend.rpc.check_rate_limit = () => true;
    backend.openai = () => Response.json({ id: "gpt-5-nano", object: "model", created: 0, owned_by: "openai" });
    {
      const r = await runKeyTest(WS);
      t("under the limit: the key is read and tested with one zero-token call", r.ok === true && backend.rpcHits("tenant_get_workspace_secret").length === 1 && backend.providerHits().length === 1, JSON.stringify(r));
      t("…the throttle is checked BEFORE the key is read", backend.rpcAt("check_rate_limit") < backend.rpcAt("tenant_get_workspace_secret"));
      t("…and the one call is models.retrieve, never a generation", backend.providerHits()[0]?.name === "/v1/models/gpt-5-nano" && backend.providerHits()[0]?.method === "GET");
    }
    backend.reset();
    backend.rpc.check_rate_limit = () => ({ status: 500, body: { message: "rate table exploded" } });
    {
      const r = await runKeyTest(WS);
      t(
        "a failed throttle read fails closed: a customer sentence, no key read, nothing sent",
        r.ok === false && isCustomerSentence((r as any).error) && backend.rpcHits("tenant_get_workspace_secret").length === 0 && backend.providerHits().length === 0,
        JSON.stringify(r),
      );
    }
    // Five in a row pass, the sixth is refused (the database counts; a stand-in counter here).
    backend.reset();
    let n = 0;
    backend.rpc.check_rate_limit = (a: any) => ++n <= a._max;
    backend.openai = () => Response.json({ id: "gpt-5-nano", object: "model", created: 0, owned_by: "openai" });
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await runKeyTest(WS));
    t(
      "five tests run, the sixth in the hour is refused before any key read or request",
      results.slice(0, 5).every((r) => r.ok === true) && results[5]!.ok === false && backend.providerHits().length === 5 && backend.rpcHits("tenant_get_workspace_secret").length === 5,
    );
    const byok = read("src/lib/ai-byok.functions.ts");
    const fn = byok.slice(byok.indexOf("export const testAiCredential"), byok.indexOf("export async function runKeyTest"));
    t("testAiCredential: owner-only, then runKeyTest", /await assertWorkspaceOwner\(data\.workspaceId, context\.userId\);\s*return runKeyTest\(data\.workspaceId\);/.test(fn));
    const sql = read("supabase/migrations/20260825121000_rate_limiting.sql");
    t(
      "check_rate_limit (20260825121000) is the database counter, service-role only",
      /CREATE OR REPLACE FUNCTION public\.check_rate_limit\(\s*_bucket text,\s*_max int,\s*_window_seconds int\s*\)/.test(sql) &&
        /GRANT EXECUTE ON FUNCTION public\.check_rate_limit\(text, int, int\) TO service_role;/.test(sql),
    );
  }

  {
    const pkg = read("package.json");
    t("this suite is in the test chain", /bun tests\/r5-server-hardening\.test\.ts/.test(pkg));
  }
} finally {
  console.error = origError;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(" || "));
  process.exit(1);
}
