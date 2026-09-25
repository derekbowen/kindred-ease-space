/**
 * userMessage: what a customer reads when something fails.
 * Run: bun tests/user-message.test.ts
 *
 * The failure being regression-tested: TanStack's server-fn transport keeps
 * only an Error's `message`, and the UI printed it verbatim. Production showed
 * a customer the raw zod issue array a server-fn input validator throws:
 *   [{"validation":"uuid","code":"invalid_string","message":"Invalid uuid","path":["marketplaceId"]}]
 * Database, provider and transport text reached the screen the same way.
 *
 * userMessage(e, fallback) (src/lib/user-message.ts) must turn validation
 * issues into one plain sentence, replace database/provider/transport text
 * with the call site's fallback, and let the server's own customer sentences
 * through. Offline; the server's messages are copied here as literals so this
 * suite does not depend on server modules.
 */
import { z } from "zod";
import {
  userMessage,
  humanizeFieldName,
  isCustomerSentence,
  describeValidationIssues,
  NETWORK_ERROR_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
  NO_PERMISSION_MESSAGE,
  OWNER_ONLY_MESSAGE,
  MAX_PASS_THROUGH_LENGTH,
} from "../src/lib/user-message";

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
const eq = (name: string, got: string, want: string) =>
  t(name, got === want, `got ${JSON.stringify(got)}`);

const FB =
  "Couldn't save your marketplace connection. Try again, or contact support if it keeps happening.";

/** The error a server-fn input validator produces on the wire: zod's message (the issue JSON). */
function wireError(schema: z.ZodTypeAny, input: unknown): Error {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("fixture parsed; it must fail");
  return new Error(r.error.message);
}
function zodError(schema: z.ZodTypeAny, input: unknown): z.ZodError {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("fixture parsed; it must fail");
  return r.error;
}
/** Nothing internal survives: no JSON, brackets, zod codes or raw paths. */
function clean(s: string): boolean {
  return (
    !/[[\]{}]/.test(s) &&
    !/"code"|"path"|invalid_string|invalid_type|too_small|too_big|invalid_enum_value|marketplaceId|marketplaceUrl|clientId|client_id/.test(
      s,
    )
  );
}

// ---------------------------------------------------------------------------
console.log("\nthe live production example");

const LIVE =
  '[{"validation":"uuid","code":"invalid_string","message":"Invalid uuid","path":["marketplaceId"]}]';
eq(
  "an Error carrying the live issue JSON",
  userMessage(new Error(LIVE), FB),
  "Marketplace ID isn't a valid ID.",
);
eq(
  "the same text as a returned r.error string",
  userMessage(LIVE, FB),
  "Marketplace ID isn't a valid ID.",
);
eq(
  "the same issue pretty-printed, as zod's own message spells it",
  userMessage(new Error(JSON.stringify(JSON.parse(LIVE), null, 2)), FB),
  "Marketplace ID isn't a valid ID.",
);
eq(
  "the real validator's error for the same input",
  userMessage(
    wireError(z.object({ marketplaceId: z.string().uuid().optional() }), { marketplaceId: "abc" }),
    FB,
  ),
  "Marketplace ID isn't a valid ID.",
);
t("the result shows no JSON, code or path", clean(userMessage(new Error(LIVE), FB)));

// ---------------------------------------------------------------------------
console.log("\nzod issues become one plain sentence");

eq(
  "url → doesn't look like a web address",
  userMessage(
    wireError(z.object({ marketplaceUrl: z.string().url() }), { marketplaceUrl: "nope" }),
    FB,
  ),
  "Marketplace URL doesn't look like a web address.",
);
eq(
  "email → doesn't look like an email address",
  userMessage(wireError(z.object({ email: z.string().email() }), { email: "x" }), FB),
  "Email doesn't look like an email address.",
);
eq(
  "too_small string (min 1) → can't be empty",
  userMessage(wireError(z.object({ clientId: z.string().min(1) }), { clientId: "" }), FB),
  "Client ID can't be empty.",
);
eq(
  "too_small string → the limit, in characters",
  userMessage(wireError(z.object({ clientId: z.string().trim().min(8) }), { clientId: "abc" }), FB),
  "Client ID must be at least 8 characters long.",
);
eq(
  "too_big string → the limit, in characters",
  userMessage(wireError(z.object({ title: z.string().max(140) }), { title: "x".repeat(141) }), FB),
  "Title can't be longer than 140 characters.",
);
eq(
  "exact length",
  userMessage(wireError(z.object({ code: z.string().length(6) }), { code: "12" }), FB),
  "Code must be exactly 6 characters long.",
);
eq(
  "too_small number",
  userMessage(wireError(z.object({ payoutValue: z.number().min(1) }), { payoutValue: 0 }), FB),
  "Payout value must be at least 1.",
);
eq(
  "too_big number, with thousands separators",
  userMessage(wireError(z.object({ rows: z.number().max(5000) }), { rows: 9000 }), FB),
  "Rows can't be more than 5,000.",
);
eq(
  "positive() → must be more than 0",
  userMessage(wireError(z.object({ quantity: z.number().positive() }), { quantity: 0 }), FB),
  "Quantity must be more than 0.",
);
eq(
  "too_small array (min 1) → can't be empty",
  userMessage(
    wireError(z.object({ targetKeys: z.array(z.string()).min(1) }), { targetKeys: [] }),
    FB,
  ),
  "Target keys can't be empty.",
);
eq(
  "too_small array → the limit, in items",
  userMessage(wireError(z.object({ cities: z.array(z.string()).min(3) }), { cities: ["a"] }), FB),
  "Cities must have at least 3 items.",
);
eq(
  "a plural field name takes a plural verb",
  userMessage(wireError(z.object({ targetKeys: z.array(z.string()) }), {}), FB),
  "Target keys are required.",
);
eq(
  "an issue on one list element says 'one of the …'",
  userMessage(
    wireError(z.object({ pageIds: z.array(z.string().uuid()) }), {
      pageIds: ["7d1c1f0e-4c1b-4a8e-9f57-2d8b6c1e9a10", "nope"],
    }),
    FB,
  ),
  "One of the page IDs isn't a valid ID.",
);
eq(
  "too_big array",
  userMessage(
    wireError(z.object({ pageIds: z.array(z.string()).max(2) }), { pageIds: ["a", "b", "c"] }),
    FB,
  ),
  "Page IDs can't have more than 2 items.",
);
eq(
  "invalid_enum_value → isn't one of the allowed options (the options are not listed)",
  userMessage(
    wireError(z.object({ authMode: z.enum(["marketplace", "integration"]) }), { authMode: "x" }),
    FB,
  ),
  "Auth mode isn't one of the allowed options.",
);
eq(
  "missing field → is required",
  userMessage(wireError(z.object({ marketplaceUrl: z.string() }), {}), FB),
  "Marketplace URL is required.",
);
eq(
  "wrong type → says the type in words",
  userMessage(wireError(z.object({ limit: z.number() }), { limit: "ten" }), FB),
  "Limit must be a number.",
);
eq(
  "a regex with the author's message keeps that advice",
  userMessage(
    wireError(
      z.object({ brandColor: z.string().regex(/^#[0-9a-f]{6}$/i, "Use a hex color like #1e90ff") }),
      {
        brandColor: "red",
      },
    ),
    FB,
  ),
  "Brand color isn't in the right format — use a hex color like #1e90ff.",
);
eq(
  "a regex with zod's default message says the format is wrong",
  userMessage(wireError(z.object({ slug: z.string().regex(/^[a-z-]+$/) }), { slug: "A B" }), FB),
  "Slug isn't in the right format.",
);
eq(
  "a refine() message written for people passes as it is",
  userMessage(
    wireError(
      z
        .object({ authMode: z.string(), clientSecret: z.string().optional() })
        .refine((d) => d.authMode !== "integration" || !!d.clientSecret, {
          message: "The Integration API needs a Client Secret.",
          path: ["clientSecret"],
        }),
      { authMode: "integration" },
    ),
    FB,
  ),
  "The Integration API needs a Client Secret.",
);
eq(
  "a refine() that kept zod's default message names the field",
  userMessage(
    wireError(
      z.object({ city: z.string() }).refine(() => false, { path: ["city"] }),
      { city: "x" },
    ),
    FB,
  ),
  "City isn't valid.",
);
eq(
  "snake_case keys read as words",
  userMessage(wireError(z.object({ client_id: z.string().uuid() }), { client_id: "x" }), FB),
  "Client ID isn't a valid ID.",
);
eq(
  "a nested path names the innermost field",
  userMessage(
    wireError(z.object({ rows: z.array(z.object({ slug: z.string().min(1) })) }), {
      rows: [{ slug: "a" }, { slug: "" }],
    }),
    FB,
  ),
  "Slug can't be empty.",
);
eq(
  "startsWith keeps the prefix",
  userMessage(
    wireError(z.object({ website: z.string().startsWith("https://") }), { website: "http://x" }),
    FB,
  ),
  'Website must start with "https://".',
);
eq(
  "a date lower bound is a calendar date",
  userMessage(
    wireError(z.object({ expiresOn: z.date().min(new Date("2026-01-01T00:00:00Z")) }), {
      expiresOn: new Date("2025-01-01T00:00:00Z"),
    }),
    FB,
  ),
  "Expires on must be on or after 2026-01-01.",
);

console.log("\nmultiple issues: the first two, then 'and N more'");
const many = wireError(
  z.object({
    marketplaceId: z.string().uuid(),
    marketplaceUrl: z.string().url(),
    clientId: z.string().min(8),
    email: z.string().email(),
    name: z.string().min(2),
  }),
  { marketplaceId: "x", marketplaceUrl: "y", clientId: "z", email: "q", name: "" },
);
eq(
  "five issues",
  userMessage(many, FB),
  "Marketplace ID isn't a valid ID, Marketplace URL doesn't look like a web address, and 3 more problems.",
);
eq(
  "three issues say '1 more problem'",
  userMessage(
    wireError(z.object({ a: z.string().uuid(), b: z.string().url(), c: z.string().email() }), {
      a: "1",
      b: "2",
      c: "3",
    }),
    FB,
  ),
  "A isn't a valid ID, B doesn't look like a web address, and 1 more problem.",
);
eq(
  "two issues are both named",
  userMessage(
    wireError(z.object({ marketplaceId: z.string().uuid(), clientId: z.string().min(1) }), {
      marketplaceId: "x",
      clientId: "",
    }),
    FB,
  ),
  "Marketplace ID isn't a valid ID, and Client ID can't be empty.",
);
eq(
  "identical issues are counted once",
  describeValidationIssues([
    {
      code: "invalid_string",
      validation: "uuid",
      path: ["marketplaceId"],
      message: "Invalid uuid",
    },
    {
      code: "invalid_string",
      validation: "uuid",
      path: ["marketplaceId"],
      message: "Invalid uuid",
    },
  ]) ?? "",
  "Marketplace ID isn't a valid ID.",
);
t("no multi-issue sentence leaks JSON or codes", clean(userMessage(many, FB)));

console.log("\nZodError instances (client-side parses)");
eq(
  "a ZodError instance",
  userMessage(
    zodError(z.object({ marketplaceId: z.string().uuid() }), { marketplaceId: "nope" }),
    FB,
  ),
  "Marketplace ID isn't a valid ID.",
);
eq(
  "a ZodError with several issues",
  userMessage(
    zodError(z.object({ title: z.string().min(3), city: z.string() }), { title: "ab" }),
    FB,
  ),
  "Title must be at least 3 characters long, and City is required.",
);
eq(
  "an issue nobody can fix (unknown keys) → the fallback",
  userMessage(zodError(z.object({ a: z.string() }).strict(), { a: "x", extra: 1 }), FB),
  FB,
);
eq(
  "a malformed request (the whole payload missing) → the fallback",
  userMessage(zodError(z.object({ a: z.string() }), undefined), FB),
  FB,
);

console.log("\nzod 4 issue shapes read the same way");
eq(
  "invalid_format uuid",
  userMessage(
    JSON.stringify([
      {
        origin: "string",
        code: "invalid_format",
        format: "uuid",
        path: ["workspaceId"],
        message: "Invalid UUID",
      },
    ]),
    FB,
  ),
  "Workspace ID isn't a valid ID.",
);
eq(
  "too_small with origin",
  userMessage(
    JSON.stringify([
      {
        origin: "string",
        code: "too_small",
        minimum: 3,
        inclusive: true,
        path: ["title"],
        message: "Too small: expected string to have >=3 characters",
      },
    ]),
    FB,
  ),
  "Title must be at least 3 characters long.",
);
eq(
  "invalid_type without `received` (message says undefined) → required",
  userMessage(
    JSON.stringify([
      {
        expected: "string",
        code: "invalid_type",
        path: ["marketplaceUrl"],
        message: "Invalid input: expected string, received undefined",
      },
    ]),
    FB,
  ),
  "Marketplace URL is required.",
);
eq(
  "invalid_value → allowed options",
  userMessage(
    JSON.stringify([
      { code: "invalid_value", values: ["a", "b"], path: ["mode"], message: "Invalid option" },
    ]),
    FB,
  ),
  "Mode isn't one of the allowed options.",
);

// ---------------------------------------------------------------------------
console.log("\nfield names in words");
for (const [key, want] of [
  ["marketplaceId", "Marketplace ID"],
  ["marketplaceUrl", "Marketplace URL"],
  ["clientId", "Client ID"],
  ["client_id", "Client ID"],
  ["seoTitle", "SEO title"],
  ["page_ids", "Page IDs"],
  ["brandColor", "Brand color"],
  ["HTMLBody", "HTML body"],
  ["workspace-id", "Workspace ID"],
  ["email", "Email"],
] as const) {
  eq(`${key} → ${want}`, humanizeFieldName(key), want);
}

// ---------------------------------------------------------------------------
console.log("\ndatabase text never reaches a customer");
for (const raw of [
  'duplicate key value violates unique constraint "tenant_pages_workspace_id_slug_key"',
  'new row violates row-level security policy for table "tenant_pages"',
  'insert or update on table "affiliates" violates foreign key constraint "affiliates_program_id_fkey"',
  'null value in column "slug" of relation "tenant_pages" violates not-null constraint',
  'relation "public.coach_messages" does not exist',
  "column workspaces.brand_colour does not exist",
  "permission denied for table workspace_members",
  "JWT expired",
  "PGRST116: JSON object requested, multiple (or no) rows returned",
  "JSON object requested, multiple (or no) rows returned",
  "Results contain 2 rows, application/vnd.pgrst.object+json requires 1 row",
  'invalid input syntax for type uuid: "abc"',
  "Could not find the 'brand_colour' column of 'workspaces' in the schema cache",
  "canceling statement due to statement timeout",
  "value too long for type character varying(255)",
  "Database error saving new user",
  "grant failed: duplicate key value violates unique constraint",
  "code 23505: duplicate",
  "Save failed (42P01)",
  "Workspace has no marketplace_domain set.",
  "reserve_generation_slot failed: timeout",
  "integration_not_found",
]) {
  const out = userMessage(new Error(raw), FB);
  t(`→ fallback: ${raw.slice(0, 60)}`, out === FB, out);
}
t(
  "a Supabase error object (not an Error) is read, and replaced",
  userMessage(
    {
      message: 'duplicate key value violates unique constraint "x"',
      code: "23505",
      details: null,
      hint: null,
    },
    FB,
  ) === FB,
);

console.log("\nprovider and transport dumps never reach a customer");
for (const raw of [
  'AI gateway 500: {"error":{"message":"upstream"}}',
  "AI gateway 429: rate limited",
  "OpenRouter 401: invalid key",
  "OpenAI 500: server error",
  "fetch failed",
  "HTTP 500",
  "HTTP 502: Bad Gateway",
  "500 Internal Server Error",
  "Internal Server Error",
  "Request failed with status code 502",
  "Edge Function returned a non-2xx status code",
  "Edge provisioning failed: 1414: Custom hostname already exists",
  "connect ECONNREFUSED 127.0.0.1:5432",
  "TypeError: Cannot read properties of undefined (reading 'id')\n    at Object.<anonymous> (app.js:1:2)",
  "Error: boom\n    at handler (/srv/index.js:10:5)",
  "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
  "<!DOCTYPE html><html><body>Error 1101</body></html>",
  "{}",
  "[object Object]",
  "undefined",
  "Missing API key 'OPENAI_API_KEY' for this workspace. Add it under Settings → API Keys.",
  "edge provisioning not configured (CLOUDFLARE_API_TOKEN/ZONE_ID)",
  "Unexpected failure, please check server logs for more information",
  "Auth session missing!",
  "x".repeat(MAX_PASS_THROUGH_LENGTH + 1),
]) {
  const out = userMessage(new Error(raw), FB);
  t(`→ fallback: ${raw.slice(0, 60).replace(/\n/g, "\\n")}`, out === FB, out);
}
eq("a JS runtime error is never shown", userMessage(new TypeError("x is not a function"), FB), FB);
eq(
  "a TypeError with sentence-like text is still a bug, not a message",
  userMessage(new TypeError("Something odd happened here"), FB),
  FB,
);

console.log("\nnetwork failures say so");
for (const raw of [
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
  "Load failed",
  "Network request failed",
  "Failed to fetch dynamically imported module: https://founders.click/assets/x.js",
]) {
  eq(
    `${raw.slice(0, 40)} → connection sentence`,
    userMessage(new TypeError(raw), FB),
    NETWORK_ERROR_MESSAGE,
  );
}
t(
  "the connection sentence names the site and the fix",
  /founders\.click/.test(NETWORK_ERROR_MESSAGE) && /connection/.test(NETWORK_ERROR_MESSAGE),
);

console.log("\nsession and permission wording");
eq(
  "401 from the auth middleware → sign in again",
  userMessage(new Error("Unauthorized: No authorization header provided"), FB),
  SESSION_EXPIRED_MESSAGE,
);
eq("'forbidden' → no permission", userMessage(new Error("forbidden"), FB), NO_PERMISSION_MESSAGE);
eq(
  "'Forbidden — workspace owner only' → owner only",
  userMessage(new Error("Forbidden — workspace owner only"), FB),
  OWNER_ONLY_MESSAGE,
);
eq(
  "'Forbidden — not a member …' → no permission",
  userMessage(new Error("Forbidden — not a member of this workspace"), FB),
  NO_PERMISSION_MESSAGE,
);

// ---------------------------------------------------------------------------
console.log("\nmessages already written for customers pass through");
for (const msg of [
  // server customer sentences (copied from src/lib at the time of writing)
  "Generation is temporarily unavailable. Please try again in a few minutes.",
  "This page is still being generated. Refresh in a minute.",
  "The AI provider returned an error; try again or contact support.",
  "The AI provider took too long to respond. Try again in a minute.",
  "This workspace has used up its included AI generation. Contact support to continue generating pages.",
  "You've hit today's limit of 50 generated pages. Try again in 24 hours.",
  "You can generate 3 more pages in the next 24 hours (limit 50 per day). Pick 3 or fewer cities.",
  "A page title needs 3 to 140 characters.",
  "Could not derive a page address from that slug or title: use letters or numbers (for example boat-rentals-austin).",
  "AI response was not valid JSON",
  "Job was cancelled",
  "Sharetribe is not answering right now. Try again in a minute.",
  "Sharetribe didn't accept that Client ID. Copy the Client ID of a Marketplace API application from Console → Build → Applications.",
  "Sharetribe returned an unexpected response (HTTP 502). Try again, and contact support if it keeps happening.",
  "That Client ID belongs to a different marketplace than the Marketplace ID you entered. Leave the Marketplace ID blank or use the application from the right marketplace.",
  "Sharetribe returned no published listings, so we kept your last synced catalog instead of deleting it. Run a sync again once your listings are back, or disconnect to clear them.",
  "Invalid domain — use a hostname like yourmarketplace.com",
  "Your plan includes 1 connected domain. Upgrade to connect more.",
  "The Affiliate add-on isn't active. Start the free trial or subscribe on the Add-ons page.",
  'Page not found for "/a/boat-rentals-austin".',
  "A page for Austin already exists (/a/boat-rentals-austin). Review it from Pages.",
  "Too many requests. Please try again in a minute.",
  // Supabase Auth, as customers should read it
  "Invalid login credentials",
  "Email not confirmed",
  "User already registered",
  "Password should be at least 6 characters.",
  "For security purposes, you can only request this after 42 seconds.",
]) {
  eq(`passes: ${msg.slice(0, 60)}`, userMessage(new Error(msg), FB), msg);
}
eq(
  "a returned r.error string passes the same way",
  userMessage("We couldn't save the connection. Try again.", FB),
  "We couldn't save the connection. Try again.",
);
eq(
  "a server-fn result object is read through its error",
  userMessage({ ok: false, error: "We couldn't save the connection. Try again." }, FB),
  "We couldn't save the connection. Try again.",
);
const exactly = `${"a".repeat(MAX_PASS_THROUGH_LENGTH - 2)} b`;
eq(
  `exactly ${MAX_PASS_THROUGH_LENGTH} characters still passes`,
  userMessage(new Error(`A${exactly.slice(1)}`), FB),
  `A${exactly.slice(1)}`,
);

console.log("\ncustomer-facing errors always pass through");
class CustomerFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerFacingError";
  }
}
eq(
  "name === 'CustomerFacingError' passes even text the rules would refuse",
  userMessage(new CustomerFacingError("Pick 3 or fewer cities {limit}"), FB),
  "Pick 3 or fewer cities {limit}",
);
eq(
  "a customerFacing: true flag passes",
  userMessage(
    Object.assign(new Error("HTTP 402 means your plan is out of pages"), { customerFacing: true }),
    FB,
  ),
  "HTTP 402 means your plan is out of pages",
);
eq(
  "a CustomerFacingError with no text → fallback",
  userMessage(new CustomerFacingError("   "), FB),
  FB,
);

console.log("\ncodes, fragments and nothing at all → the fallback");
for (const [label, value] of [
  ["null", null],
  ["undefined", undefined],
  ["empty string", ""],
  ["whitespace", "   "],
  ["a number", 500],
  ["a boolean", false],
  ["an empty object", {}],
  ["an Error with no message", new Error("")],
  ["a single lowercase code", "rate_limited"],
  ["a lowercase fragment", "domain not found"],
  ["one word", "Failed"],
  ["a Response object", new Response("nope", { status: 500 })],
] as const) {
  eq(label, userMessage(value, FB), FB);
}
t(
  "an empty fallback still yields a sentence",
  /contact support/.test(userMessage(new Error("duplicate key value"), "")),
);
t("isCustomerSentence refuses JSON", !isCustomerSentence('{"a":1}'));
t("isCustomerSentence accepts a sentence", isCustomerSentence("Your page was saved as a draft."));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
