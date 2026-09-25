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
 * 401 or 403 (404 = not deployed, also unreachable). Anything else fails the
 * probe with exit code 1.
 *
 * Safety:
 *   - It sends ONLY the customer credentials above. It never sends the
 *     service role key, an admin JWT, a DRIVE_TOKEN or an x-driver-secret
 *     header, and refuses to run if the token it is given is a service-role
 *     token, equals the service role key, or belongs to a platform admin
 *     (checked with has_role through the customer's own token — a read).
 *   - The request bodies are empty objects: even a function that wrongly
 *     accepted the caller would have nothing to generate from.
 *   - It prints statuses only — never a token, a key or a response body.
 */

type Outcome = { fn: string; as: string; status: number | "error"; ok: boolean };

const FUNCTIONS = ["generate-content-batch", "drive-content-generation"] as const;
const UNREACHABLE = new Set([401, 403, 404]);

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
const claims = decodeClaims(jwt);
if (claims.role !== "authenticated" || typeof claims.sub !== "string") {
  fail("CUSTOMER_JWT must be a signed-in customer's token (role authenticated, with a subject)");
}
const pubClaims = publishable.split(".").length === 3 ? decodeClaims(publishable) : null;
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

if (await isAdmin()) fail("CUSTOMER_JWT belongs to a platform admin; use an ordinary customer account");

const results: Outcome[] = [];
for (const fn of FUNCTIONS) {
  for (const as of ["customer", "publishable", "none"] as const) results.push(await call(fn, as));
}
for (const r of results) {
  const note = r.status === 404 ? " (not deployed)" : "";
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.fn} as ${r.as}: ${r.status}${note}`);
}
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} reachable — PRNM isolation is BROKEN` : "\nPRNM functions are unreachable with customer credentials");
process.exit(bad.length ? 1 : 0);
