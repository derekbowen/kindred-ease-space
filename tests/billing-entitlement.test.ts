/**
 * BILLING ENTITLEMENT REGRESSION TESTS.
 *
 * The rules a paying customer's money depends on. These are integration
 * behaviour — the atomic publish gate lives in Postgres — so they need a real
 * database and cannot be proven with pure logic.
 *
 * SAFE TO RUN: everything happens inside a DISPOSABLE workspace this script
 * creates and deletes. It never touches an existing workspace, and it never
 * calls Stripe. Set TEST_KEEP_WORKSPACE=1 to leave it behind for inspection.
 *
 * Run:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     bun tests/billing-entitlement.test.ts
 *
 * Requires migrations through 20260827060000 (page entitlements + publish
 * gate). Run this against staging, and against production before the first
 * paying customer.
 */

const URL = process.env.SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const KEEP = process.env.TEST_KEEP_WORKSPACE === "1";

if (!URL || !KEY) {
  console.error("Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  console.error("This is an integration test — a skip is NOT a pass.");
  process.exit(2);
}

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

const H = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function rest(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${URL}/rest/v1${path}`, {
    ...init,
    headers: { ...H, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return body;
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<any> {
  return rest(`/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
}

const suffix = Date.now().toString(36);
let workspaceId = "";
let templateId = "";

async function setLimit(base: number) {
  await rest(`/workspaces?id=eq.${workspaceId}`, {
    method: "PATCH",
    body: JSON.stringify({ page_limit_base: base }),
  });
}

async function countPublished(): Promise<number> {
  const rows = await rest(
    `/tenant_pages?workspace_id=eq.${workspaceId}&status=eq.published&select=id`,
  );
  return rows.length;
}

async function makeDrafts(n: number, tag: string): Promise<string[]> {
  const rows = Array.from({ length: n }, (_, i) => ({
    workspace_id: workspaceId,
    template_id: templateId,
    slug: `${tag}-${i}-${suffix}`,
    title: `Test page ${tag} ${i}`,
    status: "draft",
  }));
  const out = await rest("/tenant_pages", { method: "POST", body: JSON.stringify(rows) });
  return (out as Array<{ id: string }>).map((r) => r.id);
}

async function cleanup() {
  if (!workspaceId || KEEP) {
    if (KEEP) console.log(`\n(kept workspace ${workspaceId} for inspection)`);
    return;
  }
  try {
    await rest(`/tenant_pages?workspace_id=eq.${workspaceId}`, { method: "DELETE" });
    await rest(`/workspaces?id=eq.${workspaceId}`, { method: "DELETE" });
  } catch (e) {
    console.error("cleanup failed — remove manually:", workspaceId, String(e));
  }
}

try {
  // ---- setup -------------------------------------------------------------
  const tpl = await rest("/page_templates?select=id&limit=1");
  if (!tpl?.[0]?.id) {
    console.error("No page_templates row exists; cannot create test pages.");
    process.exit(2);
  }
  templateId = tpl[0].id;

  const ws = await rest("/workspaces", {
    method: "POST",
    body: JSON.stringify({
      name: `billing-test-${suffix}`,
      slug: `billing-test-${suffix}`,
      page_limit_base: 5,
      page_limit_addon: 0,
      page_limit_bonus: 0,
      subscription_status: "active",
    }),
  });
  workspaceId = ws[0].id;
  console.log(`\nDisposable workspace: ${workspaceId}\n`);

  // ---- publish cannot exceed entitlement ---------------------------------
  console.log("=== publish cannot exceed entitlement ===");
  {
    const ids = await makeDrafts(8, "over");
    const r = await rpc("publish_tenant_pages", { _workspace_id: workspaceId, _page_ids: ids });
    t("gate publishes only up to the limit", r.published === 5, JSON.stringify(r));
    t("gate reports the rest as denied", r.denied === 3, JSON.stringify(r));
    t("published total equals the limit", (await countPublished()) === 5);
    t("remaining is zero at the cap", r.remaining === 0, JSON.stringify(r));
  }

  // ---- a denied publish consumes nothing ---------------------------------
  console.log("\n=== a failed publish does not consume capacity ===");
  {
    const before = await countPublished();
    const ids = await makeDrafts(3, "denied");
    const r = await rpc("publish_tenant_pages", { _workspace_id: workspaceId, _page_ids: ids });
    t("nothing published when already at the cap", r.published === 0, JSON.stringify(r));
    t("published count unchanged", (await countPublished()) === before);
    const rows = await rest(`/tenant_pages?id=in.(${ids.join(",")})&select=id,status`);
    t("denied pages remain drafts, not lost",
      rows.every((x: any) => x.status === "draft"), JSON.stringify(rows));
  }

  // ---- concurrency -------------------------------------------------------
  console.log("\n=== concurrent publishes cannot oversubscribe ===");
  {
    await setLimit(10); // 5 already live, so exactly 5 slots remain
    const ids = await makeDrafts(20, "race");
    const batches = [ids.slice(0, 7), ids.slice(7, 14), ids.slice(14, 20)];
    const results = await Promise.all(
      batches.map((b) => rpc("publish_tenant_pages", { _workspace_id: workspaceId, _page_ids: b })),
    );
    const totalPublished = results.reduce((n, r) => n + r.published, 0);
    t("parallel batches together publish exactly the remaining slots",
      totalPublished === 5, JSON.stringify(results.map((r) => r.published)));
    t("stored count never exceeds the limit", (await countPublished()) === 10);
  }

  // ---- upgrade -----------------------------------------------------------
  console.log("\n=== plan upgrade changes capacity immediately ===");
  {
    const ids = await makeDrafts(4, "upgrade");
    const denied = await rpc("publish_tenant_pages", { _workspace_id: workspaceId, _page_ids: ids });
    t("blocked before the upgrade", denied.published === 0, JSON.stringify(denied));

    await setLimit(20);
    const after = await rpc("publish_tenant_pages", { _workspace_id: workspaceId, _page_ids: ids });
    t("the same pages publish immediately after the upgrade — no job, no wait",
      after.published === 4, JSON.stringify(after));
    t("new limit is reflected in the gate response", after.limit === 20, JSON.stringify(after));
  }

  // ---- downgrade ---------------------------------------------------------
  console.log("\n=== downgrade does not destroy published content ===");
  {
    const before = await countPublished();
    await setLimit(2); // far below what is live
    const still = await countPublished();
    t("published pages survive a downgrade", still === before, `${before} -> ${still}`);

    const ids = await makeDrafts(1, "postdown");
    const r = await rpc("publish_tenant_pages", { _workspace_id: workspaceId, _page_ids: ids });
    t("but NEW publishing is blocked while over the new limit",
      r.published === 0, JSON.stringify(r));
    t("gate reports zero remaining, not a negative number",
      r.remaining === 0, JSON.stringify(r));

    // Documented gap, asserted so it cannot change unnoticed: the over-limit
    // set is left live. Changing this is a pricing decision, not a bug fix —
    // see POST_LAUNCH_BACKLOG.md.
    t("KNOWN GAP: over-limit pages stay live after downgrade (pricing decision)",
      still > 2, `${still} live against a limit of 2`);
  }

  // ---- unpublish frees capacity -----------------------------------------
  console.log("\n=== unpublishing frees a slot ===");
  {
    await setLimit(11); // 11 live, so full
    const blockedIds = await makeDrafts(1, "afterunpub");
    const blocked = await rpc("publish_tenant_pages", {
      _workspace_id: workspaceId, _page_ids: blockedIds,
    });
    t("full at the limit", blocked.published === 0, JSON.stringify(blocked));

    const live = await rest(
      `/tenant_pages?workspace_id=eq.${workspaceId}&status=eq.published&select=id&limit=1`,
    );
    await rest(`/tenant_pages?id=eq.${live[0].id}`, {
      method: "PATCH", body: JSON.stringify({ status: "draft" }),
    });
    const now = await rpc("publish_tenant_pages", {
      _workspace_id: workspaceId, _page_ids: blockedIds,
    });
    t("the freed slot is immediately reusable", now.published === 1, JSON.stringify(now));
  }

  // ---- suspension preserves URLs ----------------------------------------
  console.log("\n=== billing suspension preserves rows and URLs ===");
  {
    const before = await rest(
      `/tenant_pages?workspace_id=eq.${workspaceId}&status=eq.published&select=id,slug`,
    );
    await rest(`/tenant_pages?workspace_id=eq.${workspaceId}&status=eq.published`, {
      method: "PATCH", body: JSON.stringify({ status: "billing_suspended" }),
    });
    const suspended = await rest(
      `/tenant_pages?workspace_id=eq.${workspaceId}&status=eq.billing_suspended&select=id,slug`,
    );
    t("suspension keeps every row", suspended.length === before.length);
    t("published count drops to zero while suspended", (await countPublished()) === 0);

    await rest(`/tenant_pages?workspace_id=eq.${workspaceId}&status=eq.billing_suspended`, {
      method: "PATCH", body: JSON.stringify({ status: "published" }),
    });
    const after = await rest(
      `/tenant_pages?workspace_id=eq.${workspaceId}&status=eq.published&select=id,slug`,
    );
    const sameSlugs =
      before.map((r: any) => r.slug).sort().join("|") ===
      after.map((r: any) => r.slug).sort().join("|");
    t("reactivation restores the SAME slugs — URLs do not change", sameSlugs);
  }

  // ---- entitlement columns are not client-writable -----------------------
  console.log("\n=== entitlement columns reject non-service writes ===");
  {
    const anon = process.env.SUPABASE_ANON_KEY;
    if (!anon) {
      console.log("  SKIP  (set SUPABASE_ANON_KEY to include this check)");
    } else {
      const res = await fetch(`${URL}/rest/v1/workspaces?id=eq.${workspaceId}`, {
        method: "PATCH",
        headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
        body: JSON.stringify({ page_limit_base: 999999 }),
      });
      t("anonymous cannot raise its own page limit", res.status >= 400, `HTTP ${res.status}`);
      const check = await rest(`/workspaces?id=eq.${workspaceId}&select=page_limit_base`);
      t("page limit is unchanged after the attempt", check[0].page_limit_base !== 999999);
    }
  }
} catch (e) {
  fail++;
  failed.push("harness error");
  console.error("\nHARNESS ERROR:", e instanceof Error ? e.message : String(e));
} finally {
  await cleanup();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) console.log("FAILED:\n  " + failed.join("\n  ") + "\n");
process.exit(fail ? 1 : 0);
