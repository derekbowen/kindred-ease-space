/**
 * PRNM ISOLATION PROBE — run by an operator, never by CI or tests.
 *
 *   CUSTOMER_JWT=<a founders.click customer's access token> \
 *   SUPABASE_URL=https://<project>.supabase.co \
 *   SUPABASE_PUBLISHABLE_KEY=<the anon / publishable key> \
 *   bun scripts/probe-prnm-isolation.ts
 *
 * Proves that the two deployed-only PRNM functions that spend AI on the
 * platform's OpenRouter key — generate-content-batch and
 * drive-content-generation — cannot be reached with founders.click customer
 * credentials. Each is called three ways: with the customer's JWT, with the
 * publishable key alone, and with no credential at all. Every answer must be
 * 401 or 403. A 404 does NOT pass for them: they are deployed, so a 404 can
 * only be the function itself answering after accepting the caller.
 *
 * Also proves that the four retired AI functions — ai-proxy, coach-chat,
 * help-assistant-chat, help-assistant-embed — are deleted: one OPTIONS
 * request each (no credential, no body: a preflight never runs a handler's
 * work), which must be 401, 403, or the GATEWAY's own 404 ("Requested
 * function was not found"). A 404 counts as a pass only for these four, and
 * only with that body. Anything else fails the probe with exit code 1.
 *
 * Safety:
 *   - It sends ONLY the customer credentials above. It never sends the
 *     service role key, an admin JWT, a DRIVE_TOKEN or an x-driver-secret
 *     header, and refuses to run if the token it is given is a service-role
 *     token, equals the service role key, or belongs to a platform admin
 *     (checked with has_role through the customer's own token — a read).
 *     SUPABASE_PUBLISHABLE_KEY must be an sb_publishable_… key or a JWT whose
 *     role is anon; an sb_secret_… key or any other role is refused before a
 *     single request is sent.
 *   - The request bodies are empty objects: even a function that wrongly
 *     accepted the caller would have nothing to generate from.
 *   - It prints statuses only — never a token, a key or a response body.
 */

type Outcome = { fn: string; as: string; status: number | "error"; ok: boolean; note?: string };

const FUNCTIONS = ["generate-content-batch", "drive-content-generation"] as const;
/** Deployed PRNM functions: only a refusal is unreachable. */
const UNREACHABLE = new Set([401, 403]);
/** Retired AI functions: deleted means the gateway's own 404. */
const LEGACY_FUNCTIONS = ["ai-proxy", "coach-chat", "help-assistant-chat", "help-assistant-embed"] as const;

/**
 * Is this 404 body the Supabase gateway saying the function does not exist —
 * {"code":"NOT_FOUND","message":"Requested function was not found"} — rather
 * than a function answering 404 itself? The message must match exactly; a
 * code, when present, must be NOT_FOUND.
 */
function isGatewayNotFound(body: string): boolean {
  try {
    const j = JSON.parse(body) as { code?: unknown; message?: unknown };
    return (
      (j.code === undefined || j.code === "NOT_FOUND") &&
      /^requested function was not found\.?$/i.test(String(j.message ?? "").trim())
    );
  } catch {
    return false;
  }
}

function fail(msg: string): never {
  console.error(`probe refused: ${msg}`);
  process.exit(2);
}

function decodeClaims(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) fail("CUSTOMER_JWT is not a JWT");
  try {
    return JSON.parse(Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    fail("CUSTOMER_JWT has an unreadable payload");
  }
}

const jwt = (process.env.CUSTOMER_JWT ?? "").trim();
const base = (process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
const publishable = (process.env.SUPABASE_PUBLISHABLE_KEY ?? "").trim();
if (!jwt || !base || !publishable) fail("set CUSTOMER_JWT, SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY");
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base)) fail("SUPABASE_URL must be https://<project>.supabase.co");

// Never an elevated credential.
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (serviceKey && (jwt === serviceKey || publishable === serviceKey)) fail("a service role key was supplied");
if (/^sb_secret_/i.test(jwt) || /^sb_secret_/i.test(publishable)) fail("a secret (sb_secret_) key was supplied");
const claims = decodeClaims(jwt);
if (claims.role !== "authenticated" || typeof claims.sub !== "string") {
  fail("CUSTOMER_JWT must be a signed-in customer's token (role authenticated, with a subject)");
}
const isJwt = publishable.split(".").length === 3;
if (!isJwt && !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishable)) {
  fail("SUPABASE_PUBLISHABLE_KEY must be an sb_publishable_ key or the anon JWT");
}
const pubClaims = isJwt ? decodeClaims(publishable) : null;
if (pubClaims && pubClaims.role !== "anon") fail("SUPABASE_PUBLISHABLE_KEY is not the anon key");

async function isAdmin(): Promise<boolean> {
  const res = await fetch(`${base}/rest/v1/rpc/has_role`, {
    method: "POST",
    headers: { apikey: publishable, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ _user_id: claims.sub, _role: "admin" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) fail(`has_role check answered ${res.status}; cannot confirm the token is not an admin's`);
  return (await res.json()) === true;
}

async function call(fn: string, as: "customer" | "publishable" | "none"): Promise<Outcome> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (as !== "none") headers.apikey = publishable;
  if (as === "customer") headers.Authorization = `Bearer ${jwt}`;
  try {
    const res = await fetch(`${base}/functions/v1/${fn}`, {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel().catch(() => {});
    return { fn, as, status: res.status, ok: UNREACHABLE.has(res.status) };
  } catch {
    return { fn, as, status: "error", ok: false };
  }
}

/** One preflight to a retired function: deleted = 401/403 or the gateway's own 404. */
async function callLegacy(fn: string): Promise<Outcome> {
  try {
    const res = await fetch(`${base}/functions/v1/${fn}`, {
      method: "OPTIONS",
      signal: AbortSignal.timeout(15_000),
    });
    const body = res.status === 404 ? await res.text().catch(() => "") : "";
    if (res.status !== 404) await res.body?.cancel().catch(() => {});
    const deleted = res.status === 404 && isGatewayNotFound(body);
    return {
      fn,
      as: "preflight",
      status: res.status,
      ok: UNREACHABLE.has(res.status) || deleted,
      note: res.status === 404 ? (deleted ? "deleted" : "a 404 that is not the gateway's") : undefined,
    };
  } catch {
    return { fn, as: "preflight", status: "error", ok: false };
  }
}

if (await isAdmin()) fail("CUSTOMER_JWT belongs to a platform admin; use an ordinary customer account");

const results: Outcome[] = [];
for (const fn of FUNCTIONS) {
  for (const as of ["customer", "publishable", "none"] as const) results.push(await call(fn, as));
}
for (const fn of LEGACY_FUNCTIONS) results.push(await callLegacy(fn));
for (const r of results) {
  const note = r.note ? ` (${r.note})` : r.status === 404 ? " (a 404 from a deployed function is not a refusal)" : "";
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.fn} as ${r.as}: ${r.status}${note}`);
}
const bad = results.filter((r) => !r.ok);
console.log(
  bad.length
    ? `\n${bad.length} check(s) failed — a PRNM function is reachable with customer credentials, or a retired AI function is still deployed`
    : "\nPRNM functions are unreachable with customer credentials; the four retired AI functions are deleted",
);
process.exit(bad.length ? 1 : 0);
