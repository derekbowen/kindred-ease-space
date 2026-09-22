/**
 * Sharetribe sync health. Run: bun tests/sync-health.test.ts
 *
 * The failure being regression-tested: production's Worker had no CRON_SECRET,
 * so the every-30-minute sync POST returned 500 and did nothing, for an
 * unknown period, while the welcome email promised customers the opposite.
 * Nothing surfaced it.
 *
 * The subtlest case here — and the one that would let it happen again — is
 * "every workspace looks freshly synced, but the scheduler cannot
 * authenticate". A health check that only reads row freshness calls that
 * healthy. It is not: somebody clicked "Run sync now" by hand.
 */
import {
  assessSyncHealth,
  LATE_AFTER_MINUTES,
  STALE_AFTER_MINUTES,
  SYNC_CADENCE_MINUTES,
  type IntegrationRow,
} from "../src/lib/sync-health";

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

const NOW = new Date("2026-09-14T12:00:00.000Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

const row = (o: Partial<IntegrationRow> & { workspace_id: string }): IntegrationRow => ({
  status: "connected",
  last_sync_at: null,
  last_sync_status: null,
  last_sync_error: null,
  listings_count: 0,
  ...o,
});

const assess = (rows: IntegrationRow[], cronSecretConfigured = true) =>
  assessSyncHealth(rows, { now: NOW, cronSecretConfigured });

console.log("\n=== the cadence constants match what customers are promised ===");
{
  t("cadence is 30 minutes", SYNC_CADENCE_MINUTES === 30, String(SYNC_CADENCE_MINUTES));
  t("late begins after two missed runs", LATE_AFTER_MINUTES === 60, String(LATE_AFTER_MINUTES));
  t("stale begins after three", STALE_AFTER_MINUTES === 90, String(STALE_AFTER_MINUTES));
}

console.log("\n=== no customers is not a fault ===");
{
  const r = assess([]);
  t("verdict is no_customers, not broken", r.verdict === "no_customers", r.verdict);
  t("zero connected", r.connectedWorkspaces === 0);
  t(
    "but it says a working sync was never demonstrated",
    r.findings.some((f) => /never been demonstrated/i.test(f)),
    r.findings.join(" | "),
  );
}

console.log("\n=== connected but never synced — the production state ===");
{
  const r = assess([row({ workspace_id: "ws-1" }), row({ workspace_id: "ws-2" })]);
  t("verdict is never_run", r.verdict === "never_run", r.verdict);
  t("counts both as never-synced", r.neverSyncedWorkspaces === 2);
  t("no successful sync anywhere", r.lastSuccessfulSyncAt === null);
  t(
    "the finding is unambiguous about customer impact",
    r.findings.some((f) => /NONE has ever synced/.test(f)),
    r.findings.join(" | "),
  );
}

console.log("\n=== the trap: fresh rows, dead scheduler ===");
{
  // Somebody clicked "Run sync now". Every row looks perfect. The automation
  // is still completely dead, and a freshness-only check would say healthy.
  const rows = [
    row({ workspace_id: "ws-1", last_sync_at: minsAgo(5), last_sync_status: "success", listings_count: 42 }),
  ];

  const withSecret = assess(rows, true);
  t("with the scheduler able to authenticate: healthy", withSecret.verdict === "healthy",
    withSecret.verdict);

  const withoutSecret = assess(rows, false);
  t("WITHOUT CRON_SECRET the same rows are NOT healthy", withoutSecret.verdict === "degraded",
    withoutSecret.verdict);
  t("cronSecretConfigured is reported", withoutSecret.cronSecretConfigured === false);
  t(
    "and it says the recent sync was manual",
    withoutSecret.findings.some((f) => /triggered by hand, not by the schedule/i.test(f)),
    withoutSecret.findings.join(" | "),
  );
}

console.log("\n=== a missing scheduler secret is not masked by having no customers either ===");
{
  const r = assess([], false);
  t("no_customers is downgraded to degraded", r.verdict === "degraded", r.verdict);
  t("because the scheduler still cannot authenticate",
    r.findings.some((f) => /CRON_SECRET is not configured/.test(f)), r.findings.join(" | "));
}

console.log("\n=== freshness boundaries ===");
{
  const at = (m: number) =>
    assess([row({ workspace_id: "w", last_sync_at: minsAgo(m), last_sync_status: "success" })])
      .workspaces[0]!.state;

  t("just synced is fresh", at(1) === "fresh", at(1));
  t(`${LATE_AFTER_MINUTES}m (two missed runs) is still fresh`, at(LATE_AFTER_MINUTES) === "fresh",
    at(LATE_AFTER_MINUTES));
  t(`${LATE_AFTER_MINUTES + 1}m is late`, at(LATE_AFTER_MINUTES + 1) === "late",
    at(LATE_AFTER_MINUTES + 1));
  t(`${STALE_AFTER_MINUTES + 1}m is stale`, at(STALE_AFTER_MINUTES + 1) === "stale",
    at(STALE_AFTER_MINUTES + 1));
  t("minutes since sync is reported",
    assess([row({ workspace_id: "w", last_sync_at: minsAgo(45), last_sync_status: "success" })])
      .workspaces[0]!.minutesSinceSync === 45);
}

console.log("\n=== a workspace failing every 30 minutes is not 'fresh' ===");
{
  // last_sync_at is 2 minutes old because it just failed again. Ranking
  // recency above outcome would report this as healthy.
  const r = assess([
    row({
      workspace_id: "ws-broken",
      last_sync_at: minsAgo(2),
      last_sync_status: "failed",
      last_sync_error: "auth_failed:401:invalid_client",
    }),
  ]);
  t("state is failing, not fresh", r.workspaces[0]!.state === "failing", r.workspaces[0]!.state);
  t("verdict is broken (no workspace is actually fresh)", r.verdict === "broken", r.verdict);
  t("the failure reason is surfaced",
    r.findings.some((f) => /auth_failed:401:invalid_client/.test(f)), r.findings.join(" | "));
  t("no successful sync is claimed", r.lastSuccessfulSyncAt === null);
}

console.log("\n=== partial failure across the fleet ===");
{
  const r = assess([
    row({ workspace_id: "a", last_sync_at: minsAgo(10), last_sync_status: "success", listings_count: 100 }),
    row({ workspace_id: "b", last_sync_at: minsAgo(10), last_sync_status: "success", listings_count: 25 }),
    row({ workspace_id: "c", last_sync_at: minsAgo(3), last_sync_status: "failed", last_sync_error: "listings_query_failed:429" }),
    row({ workspace_id: "d", last_sync_at: minsAgo(400), last_sync_status: "success", listings_count: 7 }),
  ]);
  t("verdict is degraded", r.verdict === "degraded", r.verdict);
  t("two fresh", r.freshWorkspaces === 2, String(r.freshWorkspaces));
  t("one failing", r.failingWorkspaces === 1, String(r.failingWorkspaces));
  t("listings are totalled across the fleet", r.totalListings === 132, String(r.totalListings));
  t("last successful sync is the most recent success, not the most recent row",
    r.lastSuccessfulSyncAt === minsAgo(10), String(r.lastSuccessfulSyncAt));
}

console.log("\n=== only workspaces the scheduler would sync are measured ===");
{
  // runSharetribeSyncAll selects status in (connected, pending). A disconnected
  // or errored workspace must not drag the platform verdict down.
  const r = assess([
    row({ workspace_id: "live", last_sync_at: minsAgo(5), last_sync_status: "success" }),
    row({ workspace_id: "gone", status: "disconnected", last_sync_at: minsAgo(99999) }),
    row({ workspace_id: "err", status: "error", last_sync_at: null }),
  ]);
  t("only the connected one is counted", r.connectedWorkspaces === 1, String(r.connectedWorkspaces));
  t("verdict is healthy", r.verdict === "healthy", r.verdict);
  t("the excluded ones are absent from the detail", r.workspaces.length === 1);

  const withPending = assess([row({ workspace_id: "p", status: "pending" })]);
  t("pending IS measured, because the cron tries to sync it",
    withPending.connectedWorkspaces === 1);
}

console.log("\n=== malformed timestamps do not throw or fake freshness ===");
{
  const r = assess([row({ workspace_id: "w", last_sync_at: "not-a-date", last_sync_status: "success" })]);
  t("unparseable last_sync_at reads as never", r.workspaces[0]!.state === "never",
    r.workspaces[0]!.state);
  t("minutesSinceSync is null, not NaN", r.workspaces[0]!.minutesSinceSync === null);
  t("verdict is never_run", r.verdict === "never_run", r.verdict);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("Failed: " + failed.join(", ")); process.exit(1); }
