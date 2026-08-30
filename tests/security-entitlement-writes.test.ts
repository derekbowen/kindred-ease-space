/**
 * PERMANENT SECURITY REGRESSION TEST — 2026-08-30 privilege escalation.
 *
 * An authenticated workspace member could PATCH /rest/v1/workspaces directly
 * with the public anon key and their own JWT, and set:
 *
 *     page_limit_base     -> 999999   unlimited free pages (billing bypass)
 *     subscription_status -> active   paid features without paying
 *     plan                -> agency   raised the per-plan domain allowance
 *     is_internal         -> true     internal/admin navigation
 *
 * workspace_members.role was likewise writable (editor -> owner self-promotion).
 *
 * Root cause: table-level INSERT/UPDATE/DELETE privileges were granted to the
 * `authenticated` role. RLS alone cannot fix this — a row-scoped policy still
 * permits writing ANY column of your own row. Fixed by REVOKE in
 * 20260830010000_lock_entitlement_writes.sql.
 *
 * These assertions must never be removed. If a future migration re-grants
 * write privileges to `authenticated` on an entitlement table, this fails.
 *
 * Run:
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... TEST_EMAIL=... TEST_PASSWORD=... \
 *   TEST_WORKSPACE_ID=... npx tsx tests/security-entitlement-writes.test.ts
 */

const URL = process.env.SUPABASE_URL ?? "";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const EMAIL = process.env.TEST_EMAIL ?? "";
const PASSWORD = process.env.TEST_PASSWORD ?? "";
const WS = process.env.TEST_WORKSPACE_ID ?? "";

if (!URL || !ANON || !EMAIL || !PASSWORD || !WS) {
  console.error(
    "Missing env: SUPABASE_URL, SUPABASE_ANON_KEY, TEST_EMAIL, TEST_PASSWORD, TEST_WORKSPACE_ID",
  );
  process.exit(2);
}

let pass = 0;
let fail = 0;

function assertDenied(name: string, body: unknown) {
  const denied =
    body && typeof body === "object" && !Array.isArray(body) && (body as any).code === "42501";
  if (denied) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  -> ${JSON.stringify(body).slice(0, 160)}`);
  }
}

async function login(): Promise<string> {
  const res = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const json: any = await res.json();
  if (!json.access_token) throw new Error("login failed");
  return json.access_token;
}

async function patch(token: string, path: string, payload: unknown) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({}));
}

async function post(token: string, path: string, payload: unknown) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({}));
}

async function main() {
  const token = await login();

  console.log("\n=== The original exploit: entitlement fields on workspaces ===");
  assertDenied("page_limit_base -> 999999", await patch(token, `workspaces?id=eq.${WS}`, { page_limit_base: 999999 }));
  assertDenied("page_limit_addon -> 5000", await patch(token, `workspaces?id=eq.${WS}`, { page_limit_addon: 5000 }));
  assertDenied("page_limit_bonus -> 5000", await patch(token, `workspaces?id=eq.${WS}`, { page_limit_bonus: 5000 }));
  assertDenied("subscription_status -> active", await patch(token, `workspaces?id=eq.${WS}`, { subscription_status: "active" }));
  assertDenied("plan -> agency", await patch(token, `workspaces?id=eq.${WS}`, { plan: "agency" }));
  assertDenied("is_internal -> true", await patch(token, `workspaces?id=eq.${WS}`, { is_internal: true }));
  assertDenied("trial_ends_at -> 2099", await patch(token, `workspaces?id=eq.${WS}`, { trial_ends_at: "2099-01-01T00:00:00Z" }));
  assertDenied("owner_user_id takeover", await patch(token, `workspaces?id=eq.${WS}`, { owner_user_id: "00000000-0000-0000-0000-000000000001" }));
  assertDenied("INSERT forged workspace", await post(token, "workspaces", { name: "forged", slug: "forged-regression" }));

  console.log("\n=== Member role escalation ===");
  assertDenied("editor -> owner", await patch(token, `workspace_members?workspace_id=eq.${WS}`, { role: "owner" }));
  assertDenied("INSERT forged membership", await post(token, "workspace_members", {
    workspace_id: WS,
    user_id: "00000000-0000-0000-0000-000000000001",
    role: "owner",
  }));

  console.log("\n=== Admin role forgery (the is_internal escalation path) ===");
  assertDenied("INSERT user_roles admin", await post(token, "user_roles", {
    user_id: "00000000-0000-0000-0000-000000000001",
    role: "admin",
  }));

  console.log("\n=== Billing state ===");
  assertDenied("credit_balances self-grant", await patch(token, `credit_balances?workspace_id=eq.${WS}`, { balance: 99999999 }));
  assertDenied("subscriptions self-activate", await patch(token, `subscriptions?workspace_id=eq.${WS}`, { status: "active" }));

  console.log("\n=== Reads must still work (the fix must not break the app) ===");
  const readRes = await fetch(`${URL}/rest/v1/workspaces?id=eq.${WS}&select=plan,page_limit_base`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  const rows: any = await readRes.json();
  if (Array.isArray(rows) && rows.length === 1) {
    pass++;
    console.log("  PASS  workspace still readable by its member");
  } else {
    fail++;
    console.log(`  FAIL  workspace read broken -> ${JSON.stringify(rows).slice(0, 160)}`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
