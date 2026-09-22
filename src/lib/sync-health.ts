/**
 * SHARETRIBE SYNC HEALTH — is the advertised automation actually running?
 *
 * The welcome email tells every customer their listings sync "automatically
 * every 30 min". For an unknown period that was false in production: the
 * Worker had no CRON_SECRET, so pg_cron's every-30-minute POST hit
 * `500 server misconfigured` and returned without doing anything. Nothing
 * surfaced it. The sync writes a perfectly good durable record on every run —
 * `tenant_integrations.last_sync_at / last_sync_status / last_sync_error /
 * listings_count` — but that record was only readable from inside an
 * authenticated session, so a run that never happened left no trace anywhere
 * an operator would look.
 *
 * This module is the reading of that record. It is deliberately pure: no
 * database, no network, no clock of its own. The endpoint fetches rows and
 * passes them here with an explicit `now`, so the logic that decides "this
 * platform's sync is broken" is testable without a Supabase project.
 *
 * THE DISTINCTION THAT MATTERS. "No workspace has synced" and "no workspace
 * has ever connected" look identical in a naive count and mean opposite
 * things — one is a broken platform, the other is a platform with no
 * customers yet. They are separate verdicts here, because paging someone at
 * 3am over a product that simply has no customers is how alerts get ignored.
 */

/** One row of `tenant_integrations`, as the sync writes it. */
export type IntegrationRow = {
  workspace_id: string;
  status: string | null;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  listings_count: number | null;
};

export type WorkspaceHealth = {
  workspaceId: string;
  status: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  /** Truncated; the sync already caps stored errors at 500 chars. */
  lastSyncError: string | null;
  listingsCount: number;
  minutesSinceSync: number | null;
  state: "fresh" | "late" | "stale" | "failing" | "never";
};

export type SyncHealthReport = {
  /**
   * healthy       — every connected workspace synced recently.
   * no_customers  — nothing is connected. Not a fault.
   * degraded      — some workspaces are late or failing.
   * broken        — connected workspaces exist and NONE has synced recently.
   * never_run     — connected workspaces exist and none has EVER synced.
   */
  verdict: "healthy" | "no_customers" | "degraded" | "broken" | "never_run";
  cronSecretConfigured: boolean;
  connectedWorkspaces: number;
  freshWorkspaces: number;
  failingWorkspaces: number;
  neverSyncedWorkspaces: number;
  /** The most recent successful sync anywhere on the platform. */
  lastSuccessfulSyncAt: string | null;
  totalListings: number;
  workspaces: WorkspaceHealth[];
  findings: string[];
  checkedAt: string;
};

/** The advertised cadence. Everything below is expressed in multiples of it. */
export const SYNC_CADENCE_MINUTES = 30;
/** One missed run is normal jitter; this is where "late" begins. */
export const LATE_AFTER_MINUTES = SYNC_CADENCE_MINUTES * 2;
/** Three consecutive missed runs is not jitter. */
export const STALE_AFTER_MINUTES = SYNC_CADENCE_MINUTES * 3;

function minutesBetween(thenIso: string | null, now: Date): number | null {
  if (!thenIso) return null;
  const t = Date.parse(thenIso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / 60000));
}

function stateFor(row: IntegrationRow, mins: number | null): WorkspaceHealth["state"] {
  // A recorded failure outranks freshness: a workspace failing every 30
  // minutes has a very recent last_sync_at and is not healthy.
  if (row.last_sync_status === "failed") return "failing";
  if (mins === null) return "never";
  if (mins <= LATE_AFTER_MINUTES) return "fresh";
  if (mins <= STALE_AFTER_MINUTES) return "late";
  return "stale";
}

/**
 * Assess platform-wide sync health from the integration rows.
 *
 * `cronSecretConfigured` is passed in rather than read here so this stays
 * pure — but it is part of the verdict, because a platform whose scheduler
 * cannot authenticate is broken even in the instant after a manual sync made
 * every row look fresh.
 */
export function assessSyncHealth(
  rows: IntegrationRow[],
  opts: { now: Date; cronSecretConfigured: boolean },
): SyncHealthReport {
  const { now, cronSecretConfigured } = opts;
  const findings: string[] = [];

  // "Connected" is what the cron itself selects on, so health is measured
  // over exactly the set the scheduler would try to sync.
  const connected = rows.filter((r) => r.status === "connected" || r.status === "pending");

  const workspaces: WorkspaceHealth[] = connected.map((r) => {
    const minutesSinceSync = minutesBetween(r.last_sync_at, now);
    return {
      workspaceId: r.workspace_id,
      status: r.status,
      lastSyncAt: r.last_sync_at,
      lastSyncStatus: r.last_sync_status,
      lastSyncError: r.last_sync_error,
      listingsCount: r.listings_count ?? 0,
      minutesSinceSync,
      state: stateFor(r, minutesSinceSync),
    };
  });

  const fresh = workspaces.filter((w) => w.state === "fresh").length;
  const failing = workspaces.filter((w) => w.state === "failing").length;
  const never = workspaces.filter((w) => w.state === "never").length;

  const successful = connected
    .filter((r) => r.last_sync_status === "success" && r.last_sync_at)
    .map((r) => r.last_sync_at as string)
    .sort();
  const lastSuccessfulSyncAt = successful.length ? successful[successful.length - 1]! : null;

  let verdict: SyncHealthReport["verdict"];
  if (connected.length === 0) {
    verdict = "no_customers";
    findings.push(
      "No workspace has a connected Sharetribe integration, so there is nothing to sync. " +
        "This is not a fault — but it also means a working sync has never been demonstrated.",
    );
  } else if (never === connected.length) {
    verdict = "never_run";
    findings.push(
      `${connected.length} workspace(s) are connected and NONE has ever synced. The scheduled ` +
        `sync has never completed successfully for any customer.`,
    );
  } else if (fresh === 0) {
    verdict = "broken";
    findings.push(
      `${connected.length} workspace(s) are connected and none has synced within ` +
        `${LATE_AFTER_MINUTES} minutes. The ${SYNC_CADENCE_MINUTES}-minute sync promised to ` +
        `customers is not running.`,
    );
  } else if (fresh < connected.length) {
    verdict = "degraded";
    findings.push(
      `${fresh} of ${connected.length} connected workspace(s) synced within ` +
        `${LATE_AFTER_MINUTES} minutes; the rest are late, stale or failing.`,
    );
  } else {
    verdict = "healthy";
  }

  // The scheduler's own credential. Checked independently of row freshness,
  // because a manual "Run sync now" makes rows fresh while the automation
  // stays dead — which is precisely how this failure stayed invisible.
  if (!cronSecretConfigured) {
    findings.push(
      "CRON_SECRET is not configured on this Worker, so every scheduled sync request is " +
        "rejected before it starts. Any recent sync was triggered by hand, not by the schedule.",
    );
    if (verdict === "healthy" || verdict === "no_customers") verdict = "degraded";
  }

  for (const w of workspaces) {
    if (w.state === "failing" && w.lastSyncError) {
      findings.push(`Workspace ${w.workspaceId} last failed: ${w.lastSyncError}`);
    }
  }

  if (verdict === "healthy" && findings.length === 0) {
    findings.push(
      `All ${connected.length} connected workspace(s) synced within the last ` +
        `${LATE_AFTER_MINUTES} minutes.`,
    );
  }

  return {
    verdict,
    cronSecretConfigured,
    connectedWorkspaces: connected.length,
    freshWorkspaces: fresh,
    failingWorkspaces: failing,
    neverSyncedWorkspaces: never,
    lastSuccessfulSyncAt,
    totalListings: workspaces.reduce((n, w) => n + w.listingsCount, 0),
    workspaces,
    findings,
    checkedAt: now.toISOString(),
  };
}
