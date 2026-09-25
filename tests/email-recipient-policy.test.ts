/**
 * Recipient policy: reserved and automated-test addresses never reach Emailit.
 *
 * Background (2026-09-24): scheduled smoke tests signed up
 * smoke<epoch>@example.com on production every six hours; every confirmation
 * email bounced. These tests prove, without any network, that such addresses
 * are (1) classified as blocked, (2) dropped by sendEmail() before the
 * provider is called, and (3) refused by the auth send-email hook before it
 * builds a message.
 *
 * Run: bun tests/email-recipient-policy.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RESERVED_DOMAINS,
  RESERVED_TLDS,
  classifyRecipient,
  isBlockedTestRecipient,
  normalizeRecipient,
  partitionRecipients,
  describeBlocked,
} from "../src/lib/email-recipient-policy";

let passed = 0;
let failed = 0;
function t(name: string, cond: unknown, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

// ---------------------------------------------------------------------------
console.log("\n=== 1. the incident addresses are blocked ===");
// ---------------------------------------------------------------------------
{
  // Exact shapes observed in auth.users during the incident (epoch local parts)
  // and in the repository's own E2E scripts.
  const incident = [
    "smoke1790285685@example.com",
    "smoke1790285332@example.com",
    "smoke1789700470@example.com",
    "audit-weak@example.com", // tests/e2e/public-journeys.py
    "nobody-9f3a@example.com", // tests/e2e/public-journeys.py
    "smoke+1758000000@founders.click", // the older smoke.py address form
  ];
  for (const a of incident) t(`blocked: ${a}`, isBlockedTestRecipient(a), classifyRecipient(a));
}

// ---------------------------------------------------------------------------
console.log("\n=== 2. every rule the incident brief requires ===");
// ---------------------------------------------------------------------------
{
  const blocked: Array<[string, string]> = [
    ["ends in @example.com", "someone@example.com"],
    ["ends in @example.org", "someone@example.org"],
    ["ends in @example.net", "someone@example.net"],
    ["subdomain of example.com", "someone@mail.example.com"],
    ["ends in .test", "someone@founders.test"],
    ["ends in .invalid", "smoke-probe@smoke-probe.invalid"],
    ["ends in .localhost", "root@dev.localhost"],
    ["bare localhost", "root@localhost"],
    ["ends in .example", "a@b.example"],
    ["begins with smoke", "smoke@gmail.com"],
    ["begins with smoke + digits", "smoke1790285685@gmail.com"],
    ["begins with smoke-test", "smoke-test@gmail.com"],
    ["begins with smoketest", "smoketest7@gmail.com"],
    ["begins with smoke+tag", "smoke+ci@gmail.com"],
    ["begins with test-smoke", "test-smoke@gmail.com"],
    ["begins with test_smoke", "test_smoke-3@gmail.com"],
    ["e2e token", "e2e@gmail.com"],
    ["e2e-run token", "e2e-run-42@gmail.com"],
    ["playwright token", "playwright@gmail.com"],
    ["cypress token", "cypress-9@gmail.com"],
    ["autotest token", "autotest@gmail.com"],
    ["testuser shape", "testuser@gmail.com"],
    ["test-user shape", "test-user-12@gmail.com"],
    ["test_account shape", "test_account@gmail.com"],
    ["+smoke plus-tag on a real mailbox", "jane.doe+smoke@gmail.com"],
    ["+e2e plus-tag on a real mailbox", "jane.doe+e2e-3@gmail.com"],
    ["display-name form", "Smoke Test <smoke1790285685@example.com>"],
    ["upper case", "SMOKE1790285685@EXAMPLE.COM"],
    ["surrounding whitespace", "  smoke1@example.com  "],
    ["trailing dot domain", "smoke1@example.com."],
    ["not an address at all", "not-an-email"],
    ["empty", ""],
  ];
  for (const [rule, a] of blocked) t(`blocks — ${rule}: ${a}`, isBlockedTestRecipient(a), classifyRecipient(a));

  const allowed: Array<[string, string]> = [
    ["a customer", "derek@founders.click"],
    ["gmail", "jane.doe@gmail.com"],
    ["bare test@ is a real person's choice", "test@gmail.com"],
    ["word containing test", "contest-entries@gmail.com"],
    ["latest", "latest.news@gmail.com"],
    ["smokey is a name", "smokey.robinson@gmail.com"],
    ["smokehouse is a business", "smokehouse-bbq@gmail.com"],
    ["e2eco is not e2e", "e2eco@gmail.com"],
    ["exampleco is not example.com", "hello@exampleco.com"],
    ["example as a label, not the TLD", "hello@example.founders.click"],
    ["plus-tag that is not a test marker", "jane+newsletter@gmail.com"],
    ["testimonials", "testimonials@founders.click"],
    ["support inbox", "support@founders.click"],
  ];
  for (const [why, a] of allowed) t(`allows — ${why}: ${a}`, !isBlockedTestRecipient(a), classifyRecipient(a));

  t("reserved domain list is exactly the RFC 2606 set (+edu)", [...RESERVED_DOMAINS].sort().join() === "example.com,example.edu,example.net,example.org");
  t("reserved TLD list covers test/invalid/localhost/example", [...RESERVED_TLDS].sort().join() === "example,invalid,localhost,test");
  t("normalize strips display name and lowercases", normalizeRecipient("Jane <JANE@Example.COM>") === "jane@example.com");
  t("normalize returns null without an @", normalizeRecipient("nobody") === null);
  const v = classifyRecipient("smoke1790285685@example.com");
  t("verdict carries a reason", !v.deliverable && /reserved domain example\.com/.test(v.reason), v);
  t("describeBlocked never includes the local part", !describeBlocked({ address: "smoke1790285685@example.com", reason: "x" }).includes("smoke1790285685"));
  const part = partitionRecipients(["derek@founders.click", "smoke1@example.com", "jane@gmail.com"]);
  t("partition keeps deliverable order", part.deliverable.join() === "derek@founders.click,jane@gmail.com", part);
  t("partition reports the blocked one", part.blocked.length === 1 && part.blocked[0]!.address === "smoke1@example.com", part);
}

// ---------------------------------------------------------------------------
console.log("\n=== 2b. one recipient per string (round-3 F6 / round-4 security L7) ===");
// ---------------------------------------------------------------------------
{
  const notOne: Array<[string, string]> = [
    ["comma list", "jane@gmail.com,derek@founders.click"],
    ["comma list with a space", "jane@gmail.com, derek@founders.click"],
    ["semicolon list", "jane@gmail.com;derek@founders.click"],
    ["a list hiding a test address", "jane@gmail.com,smoke1@example.com"],
    ["a trailing comma", "jane@gmail.com,"],
    ["whitespace inside", "jane doe@gmail.com"],
    ["whitespace around the @", "jane @gmail.com"],
    ["two addresses separated by a space", "jane@gmail.com derek@founders.click"],
    ["a tab", "jane@gmail.com\tderek@founders.click"],
    ["a newline (header injection)", "jane@gmail.com\nBcc: victim@gmail.com"],
    ["a carriage return", "jane@gmail.com\r\nBcc: victim@gmail.com"],
    ["two @", "jane@x@gmail.com"],
    ["a quote", '"jane"@gmail.com'],
    ["angle brackets inside the address", "jane<x>@gmail.com"],
    ["a display name carrying another address", "derek@founders.click <jane@gmail.com>"],
    ["a list inside the angle brackets", "Jane <jane@gmail.com,derek@founders.click>"],
    ["an unbalanced bracket", "Jane <jane@gmail.com"],
    ["nothing before the @", "@gmail.com"],
    ["nothing after the @", "jane@"],
  ];
  for (const [why, raw] of notOne) {
    const v = classifyRecipient(raw);
    t(`refused — ${why}`, normalizeRecipient(raw) === null && !v.deliverable && v.reason === "not a single email address", v);
    t(`…and the refusal never echoes the raw string — ${why}`, v.address === "", v);
  }
  const stillOne: Array<[string, string, string]> = [
    ["a plain address", "jane.doe@gmail.com", "jane.doe@gmail.com"],
    ["surrounding whitespace is trimmed", "  jane.doe@gmail.com  ", "jane.doe@gmail.com"],
    ["a display name", "Jane Doe <Jane.Doe@Gmail.com>", "jane.doe@gmail.com"],
    ["an apostrophe (a real mailbox)", "o'brien@gmail.com", "o'brien@gmail.com"],
    ["a plus-tag", "jane+news@gmail.com", "jane+news@gmail.com"],
  ];
  for (const [why, raw, want] of stillOne) {
    t(`one address — ${why}`, normalizeRecipient(raw) === want && classifyRecipient(raw).address === want, classifyRecipient(raw));
  }
  const p = partitionRecipients(["Jane Doe <Jane.Doe@Gmail.com>", "a@gmail.com,b@gmail.com", "derek@founders.click"]);
  t(
    "partition hands on the NORMALISED addresses only, and drops the list string whole",
    JSON.stringify(p.deliverable) === JSON.stringify(["jane.doe@gmail.com", "derek@founders.click"]) &&
      p.blocked.length === 1 && p.blocked[0]!.address === "" && p.blocked[0]!.reason === "not a single email address",
    p,
  );
  t("describeBlocked of a refused string names no address at all", describeBlocked(p.blocked[0]!) === "@(no domain) (not a single email address)", describeBlocked(p.blocked[0]!));
}

// ---------------------------------------------------------------------------
console.log("\n=== 3. sendEmail() never calls Emailit for a blocked recipient (stubbed fetch) ===");
// ---------------------------------------------------------------------------
{
  // email.server.ts imports the service-role client; give it inert values so
  // the import cannot touch a real project. Nothing here performs I/O.
  process.env.SUPABASE_URL ||= "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-a-real-key-tests-only";
  const { sendEmail } = await import("../src/lib/email.server");

  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "null")), headers: init?.headers ?? {} });
    return new Response(JSON.stringify({ id: "em_test_only" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const originalKey = process.env.EMAILIT_API_KEY;
  try {
    // (a) With a key configured, a blocked recipient is suppressed and fetch is never called.
    process.env.EMAILIT_API_KEY = "test-key-not-real";
    const r1 = await sendEmail({ to: "smoke1790285685@example.com", subject: "Confirm your email", text: "x" });
    t("blocked recipient → ok:true, suppressed:true", r1.ok === true && r1.suppressed === true, r1);
    t("blocked recipient → no provider call", calls.length === 0, calls);

    // (b) Even without a key the guard runs first (no "not configured" error, no call).
    delete process.env.EMAILIT_API_KEY;
    const r2 = await sendEmail({ to: "e2e-42@founders.test", subject: "Welcome", html: "<p>x</p>" });
    t("blocked recipient without a key → still suppressed, not an error", r2.ok === true && r2.suppressed === true && !r2.error, r2);
    t("blocked recipient without a key → no provider call", calls.length === 0);

    // (c) A deliverable recipient still goes out — the guard is not a kill switch.
    process.env.EMAILIT_API_KEY = "test-key-not-real";
    const r3 = await sendEmail({ to: "jane.doe@gmail.com", subject: "Welcome", text: "x" });
    t("deliverable recipient → sent", r3.ok === true && !r3.suppressed && r3.id === "em_test_only", r3);
    t("deliverable recipient → exactly one provider call", calls.length === 1);
    t("provider call goes to the Emailit endpoint", calls[0]!.url === "https://api.emailit.com/v2/emails", calls[0]?.url);
    t("provider body carries only the deliverable address", calls[0]!.body.to === "jane.doe@gmail.com", calls[0]?.body);

    // (d) A mixed list loses only the blocked entries.
    const r4 = await sendEmail({ to: ["jane.doe@gmail.com", "smoke9@example.com", "derek@founders.click"], subject: "Digest", text: "x" });
    t("mixed list → sent to the deliverable ones", r4.ok === true && !r4.suppressed, r4);
    t("mixed list → blocked address stripped from the provider body", JSON.stringify(calls[1]!.body.to) === JSON.stringify(["jane.doe@gmail.com", "derek@founders.click"]), calls[1]?.body);
    t("mixed list → no blocked address anywhere in the request", !JSON.stringify(calls[1]!.body).includes("example.com"));

    // (e) An all-blocked list is suppressed as a whole.
    const r5 = await sendEmail({ to: ["smoke1@example.com", "playwright@example.org"], subject: "x", text: "x" });
    t("all-blocked list → suppressed, no call", r5.suppressed === true && calls.length === 2, r5);

    // (f) Round-4 security L7: a string carrying a list is never forwarded.
    const r6 = await sendEmail({ to: "jane.doe@gmail.com,victim@gmail.com", subject: "x", text: "x" });
    t("a comma list in one string → suppressed, no provider call", r6.ok === true && r6.suppressed === true && calls.length === 2, r6);
    const r7 = await sendEmail({ to: "jane.doe@gmail.com\nBcc: victim@gmail.com", subject: "x", text: "x" });
    t("a header-injection string → suppressed, no provider call", r7.suppressed === true && calls.length === 2, r7);
    const r8 = await sendEmail({ to: ["jane.doe@gmail.com; victim@gmail.com", "derek@founders.click"], subject: "x", text: "x" });
    t(
      "a list string inside a list is dropped, the single address still goes out",
      r8.ok === true && !r8.suppressed && calls.length === 3 && JSON.stringify(calls[2]!.body.to) === JSON.stringify(["derek@founders.click"]),
      calls[2]?.body,
    );
    const r9 = await sendEmail({ to: "Jane Doe <Jane.Doe@Gmail.com>", subject: "x", text: "x" });
    t(
      "what reaches the provider is the NORMALISED bare address, never the caller's raw string",
      r9.ok === true && calls.length === 4 && calls[3]!.body.to === "jane.doe@gmail.com",
      calls[3]?.body,
    );
  } finally {
    globalThis.fetch = realFetch;
    if (originalKey === undefined) delete process.env.EMAILIT_API_KEY;
    else process.env.EMAILIT_API_KEY = originalKey;
  }
}

// ---------------------------------------------------------------------------
console.log("\n=== 4. the auth send-email hook refuses before building a message (source guards) ===");
// ---------------------------------------------------------------------------
{
  const hook = read("src/routes/api/public/hooks/auth-send-email.ts");
  const handler = hook.slice(hook.indexOf("POST: async"));
  t("hook imports the policy", /from "@\/lib\/email-recipient-policy"/.test(hook));
  const guardAt = handler.indexOf("classifyRecipient(to)");
  const sendAt = handler.indexOf("await sendEmail("); // the call, not the comment that mentions it
  const copyAt = handler.indexOf("copyFor(");
  t("hook classifies the recipient", guardAt > 0);
  t("hook refuses BEFORE building copy", guardAt > 0 && copyAt > 0 && guardAt < copyAt, { guardAt, copyAt });
  t("hook refuses BEFORE calling sendEmail", guardAt > 0 && sendAt > 0 && guardAt < sendAt, { guardAt, sendAt });
  const refusal = handler.slice(guardAt, sendAt);
  t("refusal answers 200 with an empty body so the signup itself completes", /status: 200/.test(refusal) && /JSON\.stringify\(\{\}\)/.test(refusal));
  t("refusal logs the domain and reason, never the mailbox", /@\$\{domain\}/.test(refusal) && !/\$\{to\}/.test(refusal));

  const mail = read("src/lib/email.server.ts");
  const fn = mail.slice(mail.indexOf("export async function sendEmail("));
  const policyAt = fn.indexOf("partitionRecipients(params.to)");
  const keyAt = fn.indexOf("process.env.EMAILIT_API_KEY");
  const fetchAt = fn.indexOf("fetch(EMAILIT_API_URL");
  t("sendEmail partitions recipients before reading the API key", policyAt > 0 && keyAt > 0 && policyAt < keyAt, { policyAt, keyAt });
  t("sendEmail partitions recipients before any fetch", policyAt > 0 && fetchAt > 0 && policyAt < fetchAt);
  t("sendEmail sends to the filtered list, never params.to", /to,\n    subject: params\.subject/.test(fn) && !/to: params\.to,/.test(fn));
  t("sendEmail is the only Emailit call site in src/", (() => {
    // Every other module must send through sendEmail so the guard is total.
    const { execSync } = require("node:child_process");
    const out = String(execSync("grep -rl 'api.emailit.com' src/ || true", { cwd: join(import.meta.dir, "..") }));
    return out.trim() === "src/lib/email.server.ts";
  })());
}

// ---------------------------------------------------------------------------
console.log("\n=== 5. the scheduled smoke run is gone ===");
// ---------------------------------------------------------------------------
{
  const wf = read(".github/workflows/smoke.yml");
  t("smoke.yml has no schedule trigger", !/^\s*schedule:/m.test(wf));
  t("smoke.yml has no push trigger", !/^\s*push:/m.test(wf));
  t("smoke.yml keeps manual dispatch", /workflow_dispatch:/.test(wf));
  t("smoke.yml says why", /Emailit bounce containment/.test(wf));
  const pkg = read("package.json");
  t("this suite is in the test chain", /bun tests\/email-recipient-policy\.test\.ts/.test(pkg));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
