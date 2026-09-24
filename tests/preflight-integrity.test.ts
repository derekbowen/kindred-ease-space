/**
 * Do the preflights actually run? Run: bun tests/preflight-integrity.test.ts
 *
 * Three gates in this repo have reported success while checking nothing. The
 * shape is always the same: the check cannot read its input, the failure is
 * swallowed, a loop iterates zero times, and the absence of findings is
 * printed as a pass. Two of the three were caused by the app moving under
 * apps/ and a path that used to be right.
 *
 * These tests assert the opposite property directly: given a broken input,
 * each gate must EXIT NON-ZERO. A test that only checks the happy path would
 * have passed throughout the entire period both gates were inert.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { namesIn } from "../scripts/check-required-secrets.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = APP;

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

/**
 * Run a command and report its exit code rather than throwing. stdout and
 * stderr are both captured on every path: these gates report warnings and
 * errors on stderr, and a test that read only stdout would miss exactly the
 * output that distinguishes a real check from an inert one.
 */
function run(cmd: string, args: string[], cwd?: string): { code: number; out: string } {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { code: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** Every env name referenced anywhere in the app, for the "is it used?" check. */
function execSyncSafe(): string {
  const r = spawnSync(
    "grep",
    ["-rhoE", "(process\\.env|Deno\\.env\\.get\\()[.\"]?[A-Z_0-9]+", "src", "supabase"],
    { cwd: APP, encoding: "utf8" },
  );
  return r.stdout ?? "";
}

const temps: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "preflight-"));
  temps.push(d);
  return d;
};

// ---------------------------------------------------------------------------
console.log("\n=== canonical audit: a missing source directory is a failure ===");
{
  // The audit resolves its tree from its own location, so placing it in bin/
  // makes <tmp> the root — with neither src/ nor scripts/ present.
  const root = temp();
  mkdirSync(join(root, "bin"));
  cpSync(join(APP, "scripts/audit-canonical-urls.ts"), join(root, "bin/audit-canonical-urls.ts"));

  const r = run("bun", [join(root, "bin/audit-canonical-urls.ts")], root);
  t("exits non-zero when src/ does not exist", r.code !== 0, `exit ${r.code}: ${r.out.slice(0, 160)}`);
  t("says it cannot scan, rather than printing a tick",
    /cannot scan/i.test(r.out) && !/0 violations/.test(r.out), r.out.slice(0, 200));
}

console.log("\n=== canonical audit: scanning zero files is a failure ===");
{
  // Both directories exist and are readable. They are simply empty, which is
  // the state that printed "✅ 0 violations, exit 0" from the repo root.
  const root = temp();
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "scripts"));
  cpSync(join(APP, "scripts/audit-canonical-urls.ts"), join(root, "bin/audit-canonical-urls.ts"));

  const r = run("bun", [join(root, "bin/audit-canonical-urls.ts")], root);
  t("exits non-zero after scanning 0 files", r.code !== 0, `exit ${r.code}: ${r.out.slice(0, 160)}`);
  t("says nothing was checked", /scanned 0 files|nothing was checked/i.test(r.out), r.out.slice(0, 200));
  t("does not print a clean verdict", !/✅/.test(r.out), r.out.slice(0, 200));
}

console.log("\n=== canonical audit: a real tree is scanned and counted ===");
{
  // The positive control. Without it, "exits non-zero" could be satisfied by
  // a script that is simply broken. Run from a DIFFERENT cwd on purpose: the
  // original bug was cwd-dependence.
  const r = run("bun", [join(APP, "scripts/audit-canonical-urls.ts")], REPO);
  t("exits 0 from an unrelated cwd", r.code === 0, `exit ${r.code}: ${r.out.slice(0, 200)}`);
  const m = r.out.match(/0 violations across (\d+) files/);
  t("reports the number of files it examined", !!m, r.out.trim().slice(0, 200));
  t("that number is not zero", Number(m?.[1] ?? 0) > 0, m?.[1] ?? "none");
}

// ---------------------------------------------------------------------------
const SECRETS = join(APP, "scripts/check-required-secrets.mjs");
const MANIFEST = join(APP, "scripts/required-secrets.txt");
// Derived from the manifest, never hardcoded: a literal list silently goes
// stale the moment a secret is promoted, and then the happy-path test fails
// for a reason that has nothing to do with what it is testing.
const MANIFEST_TEXT = readFileSync(MANIFEST, "utf8");
const REQUIRED = namesIn(MANIFEST_TEXT, "required");
const RECOMMENDED = namesIn(MANIFEST_TEXT, "recommended");
const allRequired = JSON.stringify(REQUIRED.map((name) => ({ name })));

console.log("\n=== secrets preflight: a missing manifest is a failure ===");
{
  const d = temp();
  const secrets = join(d, "secrets.json");
  writeFileSync(secrets, allRequired);

  const r = run("node", [SECRETS, join(d, "does-not-exist.txt"), secrets]);
  t("exits 2 (the check could not run)", r.code === 2, `exit ${r.code}: ${r.out.slice(0, 160)}`);
  t("does not report a pass", !/all required secrets present/.test(r.out), r.out.slice(0, 200));
  t("names the unreadable manifest", /not readable/i.test(r.out), r.out.slice(0, 200));
}

console.log("\n=== secrets preflight: an empty [required] section is a failure ===");
{
  // The manifest is readable but yields no names — the exact state the inline
  // awk produced, from which it printed "all required secrets present".
  const d = temp();
  const manifest = join(d, "manifest.txt");
  writeFileSync(manifest, "# only comments\n\n[recommended]\nFROM_EMAIL   has a default\n");
  const secrets = join(d, "secrets.json");
  writeFileSync(secrets, "[]");

  const r = run("node", [SECRETS, manifest, secrets]);
  t("exits 2", r.code === 2, `exit ${r.code}: ${r.out.slice(0, 160)}`);
  t("refuses to report a pass", /Refusing to report a pass/i.test(r.out), r.out.slice(0, 200));
}

console.log("\n=== secrets preflight: an unreadable secret list is a failure ===");
{
  const d = temp();
  const notJson = join(d, "secrets.json");
  writeFileSync(notJson, "wrangler: command not found");
  const r1 = run("node", [SECRETS, MANIFEST, notJson]);
  t("unparseable JSON exits 2", r1.code === 2, `exit ${r1.code}`);

  const notArray = join(d, "object.json");
  writeFileSync(notArray, JSON.stringify({ secrets: [] }));
  const r2 = run("node", [SECRETS, MANIFEST, notArray]);
  t("a JSON object rather than a list exits 2", r2.code === 2, `exit ${r2.code}`);
  t("neither reports a pass",
    !/all required secrets present/.test(r1.out + r2.out), (r1.out + r2.out).slice(0, 200));
}

console.log("\n=== secrets preflight: it actually detects a missing secret ===");
{
  const d = temp();
  const secrets = join(d, "secrets.json");
  // Everything except EMAILIT_API_KEY — the one whose absence explains mail
  // that never sends, and which the inert gate would have waved through.
  writeFileSync(
    secrets,
    JSON.stringify(
      JSON.parse(allRequired).filter((s: { name: string }) => s.name !== "EMAILIT_API_KEY"),
    ),
  );

  const r = run("node", [SECRETS, MANIFEST, secrets]);
  t("exits 1 (a required secret is missing)", r.code === 1, `exit ${r.code}: ${r.out.slice(0, 160)}`);
  t("names EMAILIT_API_KEY", /EMAILIT_API_KEY/.test(r.out), r.out.slice(0, 240));
}

console.log("\n=== secrets preflight: the happy path, and the real manifest ===");
{
  const d = temp();
  const secrets = join(d, "secrets.json");
  writeFileSync(secrets, allRequired);

  const r = run("node", [SECRETS, MANIFEST, secrets]);
  t("exits 0 when every required secret is present", r.code === 0, `exit ${r.code}: ${r.out.slice(0, 200)}`);
  t("reports how many it checked — 0 would mean it did nothing",
    r.out.includes(`checking ${REQUIRED.length} required and ${RECOMMENDED.length} recommended`),
    r.out.slice(0, 200));
  t("warns about the recommended ones", /Not set \(code has defaults\)/.test(r.out), r.out.slice(0, 240));
}

console.log("\n=== the manifest classifies the secrets that actually block a launch ===");
{
  // CRON_SECRET sat in [recommended] with the note "Unset is SAFE — the hooks
  // fail closed with 401". Both halves were false: sync-sharetribe returns 500,
  // and unset silently disables the every-30-minute sync the welcome email
  // promises. The repaired gate would STILL have shipped that deploy, because
  // [recommended] only warns. This test is the thing that stops it returning
  // to [recommended] by a well-meaning edit.
  const manifest = MANIFEST_TEXT;
  const required = REQUIRED;
  const recommended = RECOMMENDED;

  t("CRON_SECRET is REQUIRED, so a deploy without it fails", required.includes("CRON_SECRET"),
    required.join(" "));
  t("and is not also listed as merely recommended", !recommended.includes("CRON_SECRET"),
    recommended.join(" "));
  // The manifest still quotes both disproven claims — on purpose, to explain
  // why they were wrong. So assert they appear only as a refuted quotation,
  // never as a live statement about how the hook behaves.
  const quotesOldClaim = /fail closed with 401|Unset is SAFE/i.test(manifest);
  t("if the disproven claims appear, they are marked as wrong",
    !quotesOldClaim || /Both halves were wrong/.test(manifest), "claim present without refutation");
  t("the manifest records the promotion, so the reason survives an edit",
    /PROMOTED FROM \[recommended\]/.test(manifest));

  // The other secrets whose absence breaks a customer-visible path outright.
  for (const name of [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "EMAILIT_API_KEY",
    "OPENROUTER_API_KEY",
    "LOVABLE_API_KEY",
  ]) {
    t(`${name} is required`, required.includes(name), required.join(" "));
  }

  // LOVABLE_API_KEY is read only through the process.env[name] indirection in
  // workspace-secrets.server.ts, so the literal grep the manifest's header
  // describes never found it and it was left out. The preflight then passed a
  // Worker on which every Daily Briefing "do it" action, the page auditor and
  // the SEO coach failed. The manifest must keep saying why, and the three
  // consumers must really read it through that fallback — otherwise the gate
  // is blocking deploys over a name nothing consumes.
  t("LOVABLE_API_KEY is not also listed as merely recommended",
    !recommended.includes("LOVABLE_API_KEY"), recommended.join(" "));
  const lovStart = manifest.indexOf("\nLOVABLE_API_KEY");
  const lovableNote = lovStart >= 0
    ? manifest.slice(lovStart, manifest.indexOf("\n[recommended]", lovStart))
    : "";
  t("the manifest explains the indirection that hid LOVABLE_API_KEY",
    /workspace-secrets\.server\.ts/.test(lovableNote) && /process\.env\[name\]/.test(lovableNote),
    lovableNote.slice(0, 200));
  t("the manifest names its three consumers",
    ["coach-actions.functions.ts", "admin-page-auditor.functions.ts", "admin-seo-coach.functions.ts"]
      .every((f) => lovableNote.includes(f)),
    lovableNote.slice(0, 200));
  t("the manifest says the help-assistant copy lives in Supabase function secrets, not the Worker",
    /help-assistant/.test(lovableNote) && /function secrets/i.test(lovableNote));
  for (const f of [
    "src/lib/coach-actions.functions.ts",
    "src/lib/admin-page-auditor.functions.ts",
    "src/lib/admin-seo-coach.functions.ts",
  ]) {
    const consumer = readFileSync(join(APP, f), "utf8");
    t(`${f} reads LOVABLE_API_KEY through the env fallback`,
      /"LOVABLE_API_KEY",\s*"LOVABLE_API_KEY",?\s*\)/.test(consumer), "no (keyName, envFallback) pair");
  }

  // Every name the manifest lists must actually be read by the code, or the
  // gate blocks deploys over configuration nothing consumes.
  const src = execSyncSafe();
  for (const name of required) {
    t(`${name} is actually read somewhere in the app`, src.includes(name), "not referenced");
  }
}

console.log("\n=== the workflow passes a path that exists ===");
{
  // The original bug in one assertion: the deploy workflow named a manifest
  // path that was correct before the app moved and nonexistent afterwards.
  const wf = readFileSync(join(REPO, ".github/workflows/deploy-app.yml"), "utf8");
  // Executable lines only. Comments in this file deliberately quote the OLD,
  // wrong path to explain the bug, and that prose must not be asserted against.
  const refs = wf
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .flatMap((l) => [...l.matchAll(/\$GITHUB_WORKSPACE\/([^\s"'\\]+)/g)].map((m) => m[1]!))
    .map((r) => r.replace(/[),;.]+$/, ""));
  t("the workflow references at least one workspace path", refs.length > 0, String(refs.length));
  for (const ref of [...new Set(refs)]) {
    let exists = true;
    try {
      readFileSync(join(REPO, ref));
    } catch {
      exists = false;
    }
    t(`$GITHUB_WORKSPACE/${ref} exists in the repo`, exists);
  }
}

for (const d of temps) rmSync(d, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("Failed: " + failed.join(", ")); process.exit(1); }
