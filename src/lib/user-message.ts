/**
 * userMessage(e, fallback): the one place the customer UI turns something a
 * server function, Supabase or fetch threw (or returned as `error`) into text
 * a customer may read.
 *
 * Why it exists: TanStack's transport serialises only an Error's `message`
 * (router-core's ShallowErrorPlugin), so whatever a server fn throws reaches
 * the browser as bare text — the JSON issue array a zod input validator
 * throws, PostgREST/Postgres wording ("duplicate key value violates unique
 * constraint …"), a provider's status dump. The UI used to print it verbatim;
 * production showed a customer
 *   [{"validation":"uuid","code":"invalid_string","message":"Invalid uuid","path":["marketplaceId"]}]
 *
 * The rules, in order:
 *  1. An error marked for the customer (name "CustomerFacingError", or a
 *     `customerFacing: true` flag) passes through. The name only survives
 *     in-process — over the wire it is lost — so rule 6 must let the server's
 *     own customer sentences through on their merits too.
 *  2. Zod issues (a ZodError, or an Error whose message is the serialised
 *     issue array) become one sentence naming the field in words and the
 *     problem in plain language: the first two issues, then "and N more".
 *  3. A lost connection ("Failed to fetch" and friends) says so.
 *  4. 401/403 wording becomes "sign in again" / "no permission".
 *  5. Database, provider and transport text, stack traces, JSON, internal
 *     identifiers, or anything over 200 characters → `fallback`.
 *  6. What is left passes through only if it reads like a sentence.
 *
 * Pure and dependency-free (no zod import): safe in the browser, in SSR and
 * in tests. Keep logging (console.error) at the call site — this function
 * only decides what the customer reads.
 */

export const NETWORK_ERROR_MESSAGE =
  "Couldn't reach founders.click — check your connection and try again.";
export const SESSION_EXPIRED_MESSAGE = "Your session has expired. Sign in again to continue.";
export const NO_PERMISSION_MESSAGE = "You don't have permission to do that.";
export const OWNER_ONLY_MESSAGE = "Only the workspace owner can do that.";

/** Longest server text that may reach a customer verbatim. */
export const MAX_PASS_THROUGH_LENGTH = 200;

/** Used only when a call site passes an empty fallback. */
const GENERIC_FALLBACK =
  "Something went wrong. Try again, or contact support if it keeps happening.";

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null;
}

export function userMessage(e: unknown, fallback: string): string {
  const fb = typeof fallback === "string" && fallback.trim() ? fallback.trim() : GENERIC_FALLBACK;
  if (e === null || e === undefined) return fb;

  // 1. Written for the customer by the server.
  if (isRecord(e) && (e.name === "CustomerFacingError" || e.customerFacing === true)) {
    const own = typeof e.message === "string" ? e.message.trim() : "";
    return own || fb;
  }

  // 2a. A ZodError instance (a client-side parse, or in-process).
  if (isRecord(e) && (e.name === "ZodError" || isIssueList(e.issues)) && Array.isArray(e.issues)) {
    return describeValidationIssues(e.issues) ?? fb;
  }

  const raw = rawMessage(e);
  if (raw === null) return fb;
  const text = raw.trim();
  if (!text) return fb;

  // 3. The request never reached us (or the answer never came back).
  if (NETWORK_PATTERNS.some((re) => re.test(text))) return NETWORK_ERROR_MESSAGE;

  // 2b. The issue array a server-fn input validator threw, as JSON text.
  const issues = parseIssueList(text);
  if (issues) return describeValidationIssues(issues) ?? fb;

  // 4. Auth middleware and permission checks.
  const access = accessMessage(text);
  if (access) return access;

  // A JS runtime error (TypeError, ReferenceError, …) is a bug on our side,
  // never something to show.
  if (isRecord(e) && typeof e.name === "string" && RUNTIME_ERROR_NAMES.has(e.name)) return fb;

  // 5 + 6.
  return isCustomerSentence(text) ? text : fb;
}

/**
 * True when `text` can be shown to a customer as it is: short, free of
 * database/provider/transport/code text, and shaped like a sentence (a
 * capital or digit first, more than one word — "forbidden", "rate_limited"
 * and "not found" are codes, not messages).
 */
export function isCustomerSentence(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > MAX_PASS_THROUGH_LENGTH) return false;
  if (LEAK_PATTERNS.some((re) => re.test(t))) return false;
  return /^[\p{Lu}\d"'“‘(]/u.test(t) && /\s/.test(t);
}

function rawMessage(e: unknown): string | null {
  if (typeof e === "string") return e;
  if (!isRecord(e)) return null;
  if (typeof e.message === "string") return e.message;
  // A server-fn result ({ ok: false, error }) or a Supabase { error } pair.
  if (typeof e.error === "string") return e.error;
  if (isRecord(e.error) && typeof e.error.message === "string") return e.error.message;
  return null;
}

const NETWORK_PATTERNS: RegExp[] = [
  /^failed to fetch\b/i, // Chrome, Edge (and a stale chunk after a deploy)
  /^networkerror\b/i, // Firefox: "NetworkError when attempting to fetch resource."
  /^load failed$/i, // Safari
  /^network (request )?failed\b/i,
  /^(a )?network error( occurred)?\b/i,
  /\bnetwork connection was lost\b/i,
  /\binternet connection appears to be offline\b/i,
  /\bnet::ERR_[A-Z_]+/,
];

const RUNTIME_ERROR_NAMES = new Set([
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "RangeError",
  "EvalError",
  "URIError",
  "InternalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
]);

function accessMessage(text: string): string | null {
  // requireSupabaseAuth answers 401 "Unauthorized: …" when the token is
  // missing or expired; the fetcher turns that body into the message.
  if (/^unauthori[sz]ed\b/i.test(text)) return SESSION_EXPIRED_MESSAGE;
  // "forbidden", "Forbidden — workspace owner only", "Forbidden — not a member …"
  if (/^forbidden\b/i.test(text)) {
    return /\bowner\b/i.test(text) ? OWNER_ONLY_MESSAGE : NO_PERMISSION_MESSAGE;
  }
  return null;
}

/** Text that must never reach a customer, whatever else it says. */
const LEAK_PATTERNS: RegExp[] = [
  // JSON, markup, code, escapes
  /[{}[\]<>`\\]/,
  /::|=>/,
  /\[object \w+\]/,
  /\b(undefined|null|NaN)\b/,
  // Postgres / PostgREST / Supabase
  /\bSQLSTATE\b/i,
  /\bPGRST\w*/i,
  /\bpostgre(s|sql|st)\b/i,
  /\bpg_\w+/i,
  /\bplpgsql\b/i,
  /\bsupabase\b/i,
  /\bsql\b/i,
  /\bviolates\b/i,
  /\b(unique|foreign key|check|not-null|exclusion) constraint\b/i,
  /\bduplicate key\b/i,
  /\b(relation|column|function|table|schema|type|operator|role|database|extension|sequence|index|constraint|trigger|policy)\b[^.]*\bdoes not exist\b/i,
  /\b(table|column|relation|constraint|schema|trigger|policy|function|index|sequence|enum|type)\s+"[^"]+"/i,
  /\bpermission denied for\b/i,
  /\bmust be owner of\b/i,
  /\brow[- ]level security\b/i,
  /\bRLS\b/,
  /\bschema cache\b/i,
  /\binvalid input (syntax|value)\b/i,
  /\bnull value in column\b/i,
  /\bvalue too long for type\b/i,
  /\bout of range for type\b/i,
  /\bmalformed \w+ literal\b/i,
  /\bsyntax error at\b/i,
  /\bcolumn reference\b/i,
  /\bon conflict\b/i,
  /\brows? returned\b/i,
  /\bJSON object requested\b/i,
  /\bresults? contains? \d+ rows?\b/i,
  /\bcoerce the result\b/i,
  /\b(statement timeout|canceling statement)\b/i,
  /\bdeadlock detected\b/i,
  /\bcould not serialize\b/i,
  /\binfinite recursion\b/i,
  /\bdatabase error\b/i,
  /\b(too many (clients|connections)|remaining connection slots)\b/i,
  /\bauth session missing\b/i,
  /\bjwt\b/i,
  /\bJWS\w*/,
  /(?:^|[\s"'(,:;=])(?:public|auth|storage|extensions|pg_catalog|information_schema|vault|net|cron)\.[a-z_]\w*/,
  // SQLSTATE-like codes: "code 23505", "(23505)", 42P01, P0001, XX000
  /\b(?:[Cc]ode|SQLSTATE|sqlstate|errcode)\b\W{0,3}(?=[0-9A-Z]*\d)[0-9A-Z]{5}\b/,
  /\(\s*\d{5}\s*\)/,
  /\b\d{2}[A-Z]\d{2}\b/,
  /\b(?:P0|XX|HV|F0)\d{3}\b/,
  /\b(ERROR|DETAIL|HINT|CONTEXT):\s/,
  // Internal identifiers: snake_case columns/functions/codes, ENV_VAR names
  /(?:^|[\s"'(,:;=])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?=$|[\s"'),.:;=!?])/,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/,
  // Providers and transport
  /\bgateway\b/i,
  /\b(OpenRouter|OpenAI|Anthropic|Gemini|Lovable|Firecrawl|SerpApi|Emailit|Deno)\b/i,
  /\bedge (function|provisioning)\b/i,
  /\bnon-2xx\b/i,
  /\bfetch failed\b/i,
  /\bE(CONNREFUSED|CONNRESET|TIMEDOUT|NOTFOUND|AI_AGAIN|PIPE|HOSTUNREACH|NETUNREACH)\b/,
  /\bsocket hang up\b/i,
  /\bstatus code\b/i,
  /\bstatus\s*[:=]\s*\d{3}\b/i,
  /\b\d{3,}:(\s|$)/, // "AI gateway 500: …", Cloudflare "1414: …"
  /\bHTTP(?:\/\d(?:\.\d)?)?\s*\d{3}\b(?!\))/i, // "HTTP 500", but not "(HTTP 502)" inside a sentence
  /\b[1-5]\d\d\s+(Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Conflict|Too Many Requests|Unprocessable (Entity|Content)|Payment Required|Request Timeout)\b/i,
  /^(Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|Bad Request|Not Found|Method Not Allowed|Unprocessable Entity|Payment Required|Request Timeout)\.?$/i,
  /\brequest failed\b/i,
  /\bapi[ _-]?key\b/i,
  // Stack traces and JS runtime text
  /\n\s*at\s/,
  /\bat\s+\S+\s+\(?\S+:\d+:\d+\)?/,
  /\.(?:m?js|cjs|tsx?|jsx):\d+/,
  /^(?:[A-Z]\w*)?(?:Error|Exception):/,
  /\b(TypeError|ReferenceError|SyntaxError|RangeError)\b/,
  /\bis not (a function|defined|iterable)\b/i,
  /\bcannot (read|set) propert/i,
  /\bundefined is not\b/i,
  /\bunexpected (token|end of (json|input)|identifier|character)\b/i,
  /\bin JSON at position\b/i,
  /\binvariant\b/i,
  /\bserver ?fn\b/i,
  /\bseroval\b/i,
  /\bserver logs?\b/i,
  /\bunexpected failure\b/i,
  /\bstack trace\b/i,
];

// ---------------------------------------------------------------------------
// Validation issues (zod 3, and zod 4's renamed codes)

function isIssueList(v: unknown): v is Rec[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (i) =>
        isRecord(i) &&
        Array.isArray(i.path) &&
        (typeof i.code === "string" || typeof i.message === "string"),
    )
  );
}

function parseIssueList(text: string): Rec[] | null {
  if (!/^[[{]/.test(text)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (isIssueList(parsed)) return parsed;
  if (isRecord(parsed) && isIssueList(parsed.issues)) return parsed.issues;
  return null;
}

/**
 * One customer sentence for a list of validation issues, or null when none
 * of them is something the customer can fix (e.g. only unrecognized keys).
 */
export function describeValidationIssues(issues: readonly unknown[]): string | null {
  const phrases: string[] = [];
  for (const issue of issues) {
    if (!isRecord(issue)) continue;
    const phrase = describeIssue(issue);
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  if (phrases.length === 0) return null;
  const [first, second] = phrases;
  const more = phrases.length - 2;
  let sentence: string;
  if (phrases.length === 1) sentence = first;
  else if (more <= 0) sentence = `${first}, and ${second}`;
  else sentence = `${first}, ${second}, and ${more} more ${more === 1 ? "problem" : "problems"}`;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** Who the sentence is about, and whether its verb is plural ("Target keys are required"). */
type Subject = { text: string; plural: boolean };

function describeIssue(issue: Rec): string | null {
  const code = typeof issue.code === "string" ? issue.code : "";
  const field = subjectOf(issue.path);
  const s = field ?? { text: "One of the values", plural: false };
  const is = s.plural ? "are" : "is";
  const isnt = s.plural ? "aren't" : "isn't";
  const custom = customMessage(issue.message);
  switch (code) {
    case "invalid_type":
      // A missing or mistyped top-level value is a malformed request, not
      // something the customer typed.
      if (!field) return null;
      if (isMissing(issue)) return `${s.text} ${is} required`;
      return `${s.text} ${expectedPhrase(issue.expected) ?? `${isnt} valid`}`;
    case "invalid_string":
    case "invalid_format":
      return `${s.text} ${formatPhrase(issue, custom, s)}`;
    case "too_small":
      return `${s.text} ${sizePhrase(issue, "min", s)}`;
    case "too_big":
      return `${s.text} ${sizePhrase(issue, "max", s)}`;
    case "invalid_enum_value":
    case "invalid_value":
    case "invalid_union_discriminator":
      return `${s.text} ${isnt} one of the allowed options`;
    case "invalid_literal":
      return `${s.text} ${isnt} an allowed value`;
    case "invalid_date":
      return `${s.text} ${isnt} a valid date`;
    case "not_multiple_of": {
      const n = toNumber(issue.multipleOf ?? issue.divisor);
      return n === null
        ? `${s.text} ${isnt} a valid number`
        : `${s.text} must be a multiple of ${formatNumber(n)}`;
    }
    case "not_finite":
      return `${s.text} must be a number`;
    case "custom":
      return custom ?? `${s.text} ${isnt} valid`;
    case "unrecognized_keys":
    case "invalid_arguments":
    case "invalid_return_type":
    case "invalid_intersection_types":
      return null;
    default:
      return `${s.text} ${isnt} valid`;
  }
}

const FIELD_ACRONYMS: Record<string, string> = {
  id: "ID",
  ids: "IDs",
  uuid: "ID",
  url: "URL",
  urls: "URLs",
  uri: "URI",
  api: "API",
  seo: "SEO",
  ai: "AI",
  gsc: "GSC",
  csv: "CSV",
  html: "HTML",
  css: "CSS",
  json: "JSON",
  dns: "DNS",
  ip: "IP",
  utm: "UTM",
  cta: "CTA",
  sku: "SKU",
  og: "OG",
  faq: "FAQ",
  sms: "SMS",
  pdf: "PDF",
  ssl: "SSL",
  txt: "TXT",
  cname: "CNAME",
  smtp: "SMTP",
  vat: "VAT",
  h1: "H1",
};

/** marketplaceId → "Marketplace ID", client_id → "Client ID", seoTitle → "SEO title". */
export function humanizeFieldName(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return "This field";
  return words
    .map((w, i) => FIELD_ACRONYMS[w] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * The innermost named key: ["rows", 2, "slug"] → "Slug". An issue on a list
 * element (["pageIds", 1]) is about one of them: "One of the page IDs".
 */
function subjectOf(path: unknown): Subject | null {
  if (!Array.isArray(path)) return null;
  for (let i = path.length - 1; i >= 0; i--) {
    const seg = path[i];
    if (typeof seg === "string" && /[A-Za-z]/.test(seg)) {
      const label = humanizeFieldName(seg);
      if (i < path.length - 1 && typeof path[path.length - 1] === "number") {
        return { text: `One of the ${lowerFirst(label)}`, plural: false };
      }
      return { text: label, plural: isPluralLabel(label) };
    }
  }
  return null;
}

function isPluralLabel(label: string): boolean {
  const last = label.split(" ").pop() ?? "";
  if (/^[A-Z]+s$/.test(last)) return true; // IDs, URLs
  return /s$/i.test(last) && !/(ss|us|is|ics)$/i.test(last);
}

function isMissing(issue: Rec): boolean {
  if (issue.received === "undefined" || issue.received === "null") return true;
  const m = typeof issue.message === "string" ? issue.message : "";
  return m === "Required" || /received (undefined|null)\b/i.test(m);
}

/** "must be …" for the types a customer can recognise; null for the rest. */
function expectedPhrase(expected: unknown): string | null {
  switch (expected) {
    case "number":
    case "integer":
    case "int":
    case "float":
    case "bigint":
    case "nan":
      return "must be a number";
    case "string":
      return "must be text";
    case "date":
      return "must be a date";
    case "array":
    case "tuple":
    case "set":
      return "must be a list";
    default:
      return null;
  }
}

const ID_FORMATS = new Set(["uuid", "guid", "cuid", "cuid2", "ulid", "nanoid", "xid", "ksuid"]);

function formatPhrase(issue: Rec, custom: string | null, s: Subject): string {
  const isnt = s.plural ? "aren't" : "isn't";
  const doesnt = s.plural ? "don't" : "doesn't";
  const v = issue.validation ?? issue.format;
  // zod 3 puts the argument inside `validation`, zod 4 next to `format`.
  const arg = (key: string, v4Key: string): string | null => {
    const raw = isRecord(v) ? v[key] : issue[v4Key];
    return typeof raw === "string" && raw.length > 0 && raw.length <= 20 && !/["{}[\]<>]/.test(raw)
      ? raw
      : null;
  };
  if (isRecord(v) || v === "starts_with" || v === "ends_with" || v === "includes") {
    const starts = arg("startsWith", "prefix");
    if (starts) return `must start with "${starts}"`;
    const ends = arg("endsWith", "suffix");
    if (ends) return `must end with "${ends}"`;
    const includes = arg("includes", "includes");
    if (includes) return `must include "${includes}"`;
  }
  const name = typeof v === "string" ? v : "";
  if (ID_FORMATS.has(name)) return `${isnt} a valid ID`;
  switch (name) {
    case "url":
    case "uri":
      return `${doesnt} look like a web address`;
    case "email":
      return `${doesnt} look like an email address`;
    case "datetime":
    case "date":
      return `${isnt} a valid date`;
    case "time":
      return `${isnt} a valid time`;
    case "duration":
      return `${isnt} a valid duration`;
    case "ip":
    case "ipv4":
    case "ipv6":
    case "cidr":
    case "cidrv4":
    case "cidrv6":
      return `${isnt} a valid IP address`;
    default:
      return custom
        ? `${isnt} in the right format — ${lowerFirst(custom)}`
        : `${isnt} in the right format`;
  }
}

function sizePhrase(issue: Rec, dir: "min" | "max", s: Subject): string {
  const is = s.plural ? "are" : "is";
  const kind = String(issue.type ?? issue.origin ?? "");
  const n = toNumber(dir === "min" ? issue.minimum : issue.maximum);
  const exact = issue.exact === true;
  const inclusive = issue.inclusive !== false;
  if (n === null) return dir === "min" ? `${is} too short` : `${is} too long`;
  const num = formatNumber(n);
  switch (kind) {
    case "string":
      if (exact) return `must be exactly ${num} ${plural(n, "character")} long`;
      if (dir === "min")
        return n <= 1 ? "can't be empty" : `must be at least ${num} characters long`;
      return `can't be longer than ${num} ${plural(n, "character")}`;
    case "number":
    case "int":
    case "bigint":
      if (dir === "min") return inclusive ? `must be at least ${num}` : `must be more than ${num}`;
      return inclusive ? `can't be more than ${num}` : `must be less than ${num}`;
    case "array":
    case "set":
      if (exact) return `must have exactly ${num} ${plural(n, "item")}`;
      if (dir === "min") return n <= 1 ? "can't be empty" : `must have at least ${num} items`;
      return `can't have more than ${num} ${plural(n, "item")}`;
    case "date": {
      const d = new Date(n);
      if (Number.isNaN(d.getTime())) return dir === "min" ? `${is} too early` : `${is} too late`;
      const day = d.toISOString().slice(0, 10);
      if (dir === "min") return inclusive ? `must be on or after ${day}` : `must be after ${day}`;
      return inclusive ? `must be on or before ${day}` : `must be before ${day}`;
    }
    default:
      return dir === "min" ? `${is} too small` : `${is} too large`;
  }
}

/** zod's own wording ("Invalid uuid", "Required", "String must contain …") is never shown. */
const ZOD_DEFAULT_MESSAGE =
  /^(Invalid\b|Required$|Expected\b|(String|Number|Array|Set|Date|BigInt|File) must\b|Too (small|big)\b|Unrecognized key|Input not instance)/i;

/** A message the schema author wrote for people, if it is safe to show. */
function customMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const m = message.trim().replace(/[.!\s]+$/, "");
  if (!m || ZOD_DEFAULT_MESSAGE.test(m)) return null;
  return isCustomerSentence(m) ? m : null;
}

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-US") : String(n);
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
