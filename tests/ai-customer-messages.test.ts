/**
 * EVERY AI CUSTOMER SENTENCE PASSES THE CONTRACT. Run: bun tests/ai-customer-messages.test.ts
 *
 * The TanStack serializer carries only `message` to the browser, and the UI
 * shows a server message only when isCustomerSentence (src/lib/user-message.ts)
 * accepts it: at most 200 characters, a capital or digit first, more than one
 * word, and free of code, database, provider and transport text (no braces,
 * brackets, backticks or backslashes; no snake_case or ENV_VAR identifiers;
 * no "null"/"undefined"; no "HTTP 500"; no "gateway" or "API key"; no
 * OpenAI, OpenRouter, Anthropic, Gemini or Lovable).
 *
 * Every sentence the AI paths can put in a CustomerFacingError, a
 * customerMessage fallback or an { ok: false, error } — the fixed ones
 * (imported) and the literals in the AI sources (scanned, with sample values
 * for template fields) — is run through the real isCustomerSentence, so a
 * sentence the UI would replace with a generic fallback fails here first.
 */
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

const { isCustomerSentence } = await import("../src/lib/user-message");
const { AI_MESSAGES } = await import("../src/lib/ai/customer-error");
const { RESERVE_STATUSES, refusalMessage, failureMessage } = await import("../src/lib/ai/spend.server");
const gen = await import("../src/lib/generation.server");
const { BRIEFING_FAILED_MESSAGE } = await import("../src/lib/coach-briefing.server");
const { PAGE_NOT_FOUND_MESSAGE } = await import("../src/lib/admin-page-auditor.functions");
const { AI_ALLOWANCE_MESSAGES, AI_ALLOWANCE_UNAVAILABLE_MESSAGE, generationSentence } = await import(
  "../src/lib/ai-allowance.functions"
);

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

/** The contract, stated once more independently of the implementation. */
function contract(s: string): string | null {
  if (s.length > 200) return "longer than 200 characters";
  if (!/^[A-Z0-9]/.test(s)) return "does not start with a capital or a digit";
  if (!/\s/.test(s.trim())) return "one word";
  if (/[{}[\]<>`\\]/.test(s)) return "code characters";
  if (/\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b/.test(s)) return "snake_case identifier";
  if (/\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/.test(s)) return "ENV_VAR identifier";
  if (/\b(null|undefined)\b/.test(s)) return "null / undefined";
  if (/\bHTTP\s*\d{3}\b|\b[45]\d\d\b(?! (pages|characters|words))/.test(s)) return "status code";
  if (/\bgateway\b|\bapi[ _-]?key\b/i.test(s)) return "gateway / API key";
  if (/\b(OpenAI|OpenRouter|Anthropic|Gemini|Lovable)\b/i.test(s)) return "provider name";
  return null;
}

const sentences = new Map<string, string>(); // text → where it comes from
const labels: string[] = [];
const add = (where: string, text: string) => {
  labels.push(where);
  if (!sentences.has(text)) sentences.set(text, where);
};
/** Success statuses the publish flow reports next to its errors: not error text. */
const NOT_ERRORS = new Set(["Published.", "Already live."]);

// ---- the fixed sentences --------------------------------------------------------
for (const [k, v] of Object.entries(AI_MESSAGES)) add(`AI_MESSAGES.${k}`, v);
for (const s of RESERVE_STATUSES) if (s !== "reserved") add(`refusalMessage(${s})`, refusalMessage(s));
add("refusalMessage(mark_refused)", refusalMessage("mark_refused"));
for (const k of [
  "incomplete",
  "refusal",
  "malformed",
  "schema_mismatch",
  "empty",
  "failed",
  "auth",
  "bad_request",
  "rate_limited",
  "server_error",
  "timeout",
  "network",
  "unknown",
] as const) {
  add(`failureMessage(${k})`, failureMessage(k));
}
for (const k of [
  "GENERATION_UNAVAILABLE_MESSAGE",
  "GENERATION_IN_PROGRESS_MESSAGE",
  "GENERATION_ALREADY_USED_MESSAGE",
  "GENERATION_PAUSED_MESSAGE",
  "PAGE_TITLE_INVALID_MESSAGE",
  "PAGE_SLUG_UNDERIVABLE_MESSAGE",
  "PROVIDER_ERROR_MESSAGE",
  "PROVIDER_TIMEOUT_MESSAGE",
  "ATTEMPTS_EXHAUSTED_MESSAGE",
] as const) {
  add(`generation.${k}`, (gen as any)[k]);
}
add("outOfCreditsMessage()", gen.outOfCreditsMessage());
for (const [cap, left] of [
  [50, 0],
  [50, 1],
  [50, 7],
  [1, 0],
]) {
  add(`dailyCapMessage(${cap}, ${left})`, gen.dailyCapMessage(cap, left));
}
add("BRIEFING_FAILED_MESSAGE", BRIEFING_FAILED_MESSAGE);
add("PAGE_NOT_FOUND_MESSAGE", PAGE_NOT_FOUND_MESSAGE);
for (const [k, v] of Object.entries(AI_ALLOWANCE_MESSAGES)) add(`AI_ALLOWANCE_MESSAGES.${k}`, v);
add("AI_ALLOWANCE_UNAVAILABLE_MESSAGE", AI_ALLOWANCE_UNAVAILABLE_MESSAGE);
add("generationSentence(12, 50)", generationSentence(12, 50, false));
add("generationSentence(paused)", generationSentence(3, 50, true));
add("generationSentence(cap 0)", generationSentence(0, 0, false));

// ---- the literals in the AI sources -----------------------------------------------
const SAMPLE: Record<string, string> = {
  city: "Austin",
  "existing.slug": "boats-in-austin",
  n: "212",
  MAX_ITEM_ATTEMPTS: "3",
};
const fill = (tpl: string) => tpl.replace(/\$\{([^}]+)\}/g, (_, expr: string) => SAMPLE[expr.trim()] ?? "12");
const AI_SOURCES = [
  "src/lib/ai/spend.server.ts",
  "src/lib/ai/customer-error.ts",
  "src/lib/generation.server.ts",
  "src/lib/generation.functions.ts",
  "src/lib/admin-quick-page.functions.ts",
  "src/lib/coach-actions.functions.ts",
  "src/lib/admin-seo-coach.functions.ts",
  "src/lib/admin-page-auditor.functions.ts",
  "src/lib/ai-byok.functions.ts",
  "src/lib/coach-briefing.server.ts",
  "src/lib/ai-allowance.functions.ts",
];
const PATTERNS: RegExp[] = [
  /new CustomerFacingError\(\s*"([^"]+)"/g,
  /new CustomerFacingError\(\s*`([^`]+)`/g,
  /customerMessage\(\s*e,\s*"([^"]+)"\s*\)/g,
  /error: "([^"]+)"/g,
  /message: "([^"]+)"/g,
  /message: `([^`]+)`/g,
  /const (?:SAVE_FAILED|DELETE_FAILED|NOT_FOUND) =\s*"([^"]+)"/g,
  /\? "([A-Z][^"]+)"\s*:/g,
  /:\s*"([A-Z][^"]{10,})";/g,
];
let scanned = 0;
for (const rel of AI_SOURCES) {
  const src = read(rel);
  for (const re of PATTERNS) {
    for (const m of src.matchAll(re)) {
      const text = fill(m[1]!);
      // Log-only strings and codes are not customer sentences.
      if (/^\[|failed: \$|^ai_|^[a-z_]+$/.test(m[1]!) || NOT_ERRORS.has(m[1]!)) continue;
      add(`${rel} literal`, text);
      scanned++;
    }
  }
}
// approveOpportunity is an AI route (it generates a page): its refusals too.
{
  const opp = read("src/lib/opportunities.functions.ts");
  const approve = opp.slice(opp.indexOf("export async function runApproveOpportunity("), opp.indexOf("export const skipOpportunity"));
  for (const m of approve.matchAll(/error: "([^"]+)"/g)) add("approveOpportunity literal", m[1]!);
}

console.log(`\n=== ${sentences.size} sentences (${scanned} scanned from the AI sources) ===`);
t("the scan found the source literals it should", scanned >= 25, String(scanned));
t(
  "the refusal and failure tables are covered in full",
  labels.filter((w) => /^refusalMessage/.test(w)).length === RESERVE_STATUSES.length &&
    labels.filter((w) => /^failureMessage/.test(w)).length === 13,
);
for (const [text, where] of sentences) {
  const why = contract(text);
  t(`${where}: "${text}"`, isCustomerSentence(text) && why === null, why ?? "isCustomerSentence rejected it");
}

{
  const pkg = read("package.json");
  t("this suite is in the test chain", /bun tests\/ai-customer-messages\.test\.ts/.test(pkg));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(" || "));
  process.exit(1);
}
