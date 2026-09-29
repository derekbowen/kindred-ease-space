import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertWorkspaceOwner } from "./admin-helpers.functions";
import {
  validateSharetribeCredentials,
  runSharetribeSyncForWorkspace,
  type SharetribeAuthMode,
  type SyncRunResult,
} from "./sharetribe-sync.server";
import {
  checkListingLinks,
  checkListingLinksIfNeverChecked,
  type ListingLinkCheck,
} from "./marketplace/certification.server";

const sb = () => supabaseAdmin as any;

async function assertMember(workspaceId: string, userId: string) {
  const { data, error } = await (supabaseAdmin as any).rpc("is_workspace_member", {
    _workspace_id: workspaceId,
    _user_id: userId,
  });
  if (error || !data) throw new Error("forbidden");
}

/** What the Sharetribe page shows. Never the secret (it lives in Vault). */
const INTEGRATION_VIEW_COLUMNS = [
  "id",
  "marketplace_url",
  "marketplace_id",
  "marketplace_name",
  "client_id",
  "auth_mode",
  "status",
  "last_sync_at",
  "last_sync_status",
  "last_sync_error",
  "last_success_at",
  "listings_count",
  "upstream_total",
  "sync_started_at",
  "sync_lease_until",
  "sync_progress",
  "certification_status",
  "certified_at",
  "certification_error",
  "certification_detail",
  "created_at",
  "updated_at",
].join(", ");

/** Is a sync holding the lease right now (by the server's clock)? */
export function syncLeaseActive(row: { sync_lease_until?: string | null } | null | undefined, now = Date.now()): boolean {
  const until = row?.sync_lease_until ? Date.parse(row.sync_lease_until) : NaN;
  return Number.isFinite(until) && until > now;
}

export const getSharetribeIntegration = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);
    const { data: row, error } = await sb()
      .from("tenant_integrations")
      .select(INTEGRATION_VIEW_COLUMNS)
      .eq("workspace_id", data.workspaceId)
      .eq("provider", "sharetribe")
      .maybeSingle();
    if (error) {
      // Never "not connected" because the read failed.
      console.error("[getSharetribeIntegration] read failed", error.message);
      throw new Error("We couldn't load your Sharetribe connection. Try again in a minute.");
    }
    return { integration: row ?? null, syncing: syncLeaseActive(row) };
  });

/**
 * Exact counts of this workspace's published listings that cannot be placed
 * on a city page (no city key) or a category page (no category key). Count
 * queries — never a capped read. Throws a customer sentence on a failed count.
 */
export async function countListingDataGaps(
  workspaceId: string,
): Promise<{ published: number; missingCity: number; missingCategory: number }> {
  const published = () =>
    sb()
      .from("tenant_listings")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("state_published", true);
  const [all, noCity, noCategory] = await Promise.all([
    published(),
    published().is("city_key", null),
    published().is("category_key", null),
  ]);
  const failed = [all, noCity, noCategory].find((r: any) => r.error || typeof r.count !== "number");
  if (failed) {
    console.error("[getListingDataGaps] count failed", failed.error?.message ?? "no count");
    throw new Error("We couldn't count your listings. Try again in a minute.");
  }
  return {
    published: all.count as number,
    missingCity: noCity.count as number,
    missingCategory: noCategory.count as number,
  };
}

export const getListingDataGaps = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);
    return countListingDataGaps(data.workspaceId);
  });

/**
 * Shown when the marketplace is already connected elsewhere. It names no
 * other workspace, no owner and no marketplace — connect is an owner-only
 * call, but "is marketplace X connected to somebody?" is still a question a
 * stranger with any workspace could otherwise ask one connect attempt at a
 * time.
 */
export const MARKETPLACE_ALREADY_CONNECTED_ERROR =
  "This marketplace is already connected to another founders.click workspace. If it is yours, contact support.";

/**
 * Did a tenant_integrations write hit the one-workspace-per-marketplace rule?
 * The upsert resolves its own (workspace_id, provider) conflict in ON
 * CONFLICT, so a unique violation (SQLSTATE 23505) that still surfaces is the
 * (provider, marketplace_id) constraint from 20260923000100. Matched on the
 * SQLSTATE first and the standard message second, because supabase-js
 * carries the code on some paths and only the text on others.
 */
export function isMarketplaceTakenError(
  err: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!err) return false;
  if (err.code === "23505") return true;
  return /duplicate key value violates unique constraint/i.test(err.message ?? "");
}

const connectInput = z
  .object({
    workspaceId: z.string().uuid(),
    marketplaceUrl: z.string().min(8).max(500),
    authMode: z.enum(["marketplace", "integration"]).default("marketplace"),
    clientId: z.string().trim().min(8).max(200),
    // Only the Integration API needs a secret. Marketplace API applications
    // authenticate with the Client ID alone (public-read scope).
    clientSecret: z.string().min(8).max(500).optional(),
    // Optional cross-check: if the owner pastes their Marketplace ID it must
    // match what the API reports for the given credentials.
    marketplaceId: z.string().uuid().optional(),
  })
  .refine((d) => d.authMode !== "integration" || !!d.clientSecret, {
    message: "The Integration API needs a Client Secret.",
    path: ["clientSecret"],
  });

export type ConnectInput = z.infer<typeof connectInput>;

/**
 * The marketplace's public address, normalised: http(s) only, a real host
 * name (no IP address, no localhost — the link check fetches it), no
 * credentials, query or fragment. null when it isn't one.
 */
export function normalizeMarketplaceUrl(raw: string): string | null {
  let s = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (
    !host.includes(".") ||
    host.endsWith(".localhost") ||
    host.startsWith("[") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  ) {
    return null;
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/** Sync bookkeeping reset when a workspace switches to a different marketplace. */
const FRESH_SYNC_STATE = {
  sync_run_id: null,
  sync_started_at: null,
  sync_lease_until: null,
  sync_progress: null,
  sync_state: {},
  last_sync_at: null,
  last_sync_status: null,
  last_success_at: null,
  listings_count: 0,
  upstream_total: null,
} as const;

const FRESH_CERTIFICATION = {
  certification_status: "UNCERTIFIED",
  certified_at: null,
  certification_error: null,
  certification_detail: {},
} as const;

export const CONNECT_SENTENCES = {
  badUrl: "That doesn't look like a valid marketplace URL.",
  otherMarketplace:
    "That Client ID belongs to a different marketplace than the Marketplace ID you entered. Leave the Marketplace ID blank or use the application from the right marketplace.",
  readFailed: "We couldn't read your current connection. Try again.",
  saveFailed: "We couldn't save the connection. Try again.",
  switchCleanupFailed:
    "We couldn't remove the previous marketplace's listings, so the connection needs attention. Connect again to finish switching.",
  secretStoreFailed: "We couldn't store the Client Secret securely. Try again.",
  secretStoreFailedRow: "We couldn't store the Client Secret securely. Connect again to finish setting up.",
  secretCleanupFailed: "We couldn't remove the previous Integration API secret. Try again.",
  secretCleanupFailedRow:
    "We couldn't remove the previous Integration API secret. Connect again to finish setting up.",
  markFailed: "We couldn't finish saving the connection. Try again.",
} as const;

/** The first sync's outcome, as the connect and Sync now replies carry it. */
export type SyncSummary = {
  status: SyncRunResult["status"];
  sentence: string;
  upserted: number;
  removed: number;
  listingsCount: number | null;
  upstreamTotal: number | null;
};

export const summarizeSync = (r: SyncRunResult): SyncSummary => ({
  status: r.status,
  sentence: r.sentence,
  upserted: r.upserted,
  removed: r.removed,
  listingsCount: r.listingsCount,
  upstreamTotal: r.upstreamTotal,
});

export type ConnectResult =
  | { ok: false; error: string }
  | {
      ok: true;
      marketplaceName: string | null;
      marketplaceId: string;
      authMode: SharetribeAuthMode;
      marketplaceChanged: boolean;
      sync: SyncSummary;
      linkCheck: { result: ListingLinkCheck["result"]; sentence: string } | null;
    };

export type ConnectDeps = {
  validate?: typeof validateSharetribeCredentials;
  runSync?: (workspaceId: string) => Promise<SyncRunResult>;
  checkLinks?: (workspaceId: string) => Promise<ListingLinkCheck | null>;
};

/**
 * Connect (or re-connect) a workspace's Sharetribe marketplace, then run the
 * first sync. Order, so that no failure leaves a secret and a Client ID that
 * do not belong together looking healthy:
 *
 *   validate the credentials and resolve the marketplace's identity
 *   → upsert the integration row (status "pending")
 *   → a different marketplace than before: remove the old marketplace's
 *     listings and reset sync state and the link check
 *   → Integration API only: store the secret in Vault (or, switching to the
 *     Marketplace API, delete the old one)
 *   → mark "connected" → first sync → link check after a successful sync.
 *
 * A failure after the row write leaves status "error" with a sentence saying
 * what to do. A working Client ID proves nothing about who owns a domain:
 * nothing here reads or writes domain verification (workspace_domains).
 */
export async function connectSharetribeForWorkspace(
  args: {
    workspaceId: string;
    input: ConnectInput;
    /** Stores the secret in Vault as the owner; returns the vault id or null. */
    storeSecret: (secret: string) => Promise<string | null>;
  },
  deps: ConnectDeps = {},
): Promise<ConnectResult> {
  const { workspaceId, input } = args;
  const authMode: SharetribeAuthMode = input.authMode;
  const marketplaceUrl = normalizeMarketplaceUrl(input.marketplaceUrl);
  if (!marketplaceUrl) return { ok: false, error: CONNECT_SENTENCES.badUrl };

  const v = await (deps.validate ?? validateSharetribeCredentials)({
    mode: authMode,
    clientId: input.clientId,
    clientSecret: authMode === "integration" ? input.clientSecret : undefined,
  });
  if (!v.ok) return { ok: false, error: v.error };
  if (input.marketplaceId && v.marketplaceId !== input.marketplaceId) {
    return { ok: false, error: CONNECT_SENTENCES.otherMarketplace };
  }

  const { data: existing, error: existingErr } = await sb()
    .from("tenant_integrations")
    .select("id, marketplace_id, marketplace_url, client_secret_vault_id")
    .eq("workspace_id", workspaceId)
    .eq("provider", "sharetribe")
    .maybeSingle();
  if (existingErr) {
    console.error("[connectSharetribe] current row read failed", existingErr.message);
    return { ok: false, error: CONNECT_SENTENCES.readFailed };
  }

  // ONE WORKSPACE PER MARKETPLACE. Validation above proved the Client ID
  // works, not that this owner owns the marketplace, so without this any
  // workspace could connect a marketplace another workspace already has and
  // publish pages against its listings. The database constraint
  // (20260923000100) is the authority; this read only spares the writes
  // below when the answer is already no. The reply names nobody.
  const { data: heldElsewhere, error: heldErr } = await sb()
    .from("tenant_integrations")
    .select("id")
    .eq("provider", "sharetribe")
    .eq("marketplace_id", v.marketplaceId)
    .neq("workspace_id", workspaceId)
    .limit(1)
    .maybeSingle();
  if (heldErr) {
    // Not fatal: the constraint still decides at the upsert.
    console.error("[connectSharetribe] marketplace ownership check failed", heldErr.message);
  } else if (heldElsewhere) {
    return { ok: false, error: MARKETPLACE_ALREADY_CONNECTED_ERROR };
  }

  const marketplaceChanged = !!existing && existing.marketplace_id !== v.marketplaceId;
  const urlChanged = !!existing && existing.marketplace_url !== marketplaceUrl;
  const row: Record<string, unknown> = {
    workspace_id: workspaceId,
    provider: "sharetribe",
    marketplace_url: marketplaceUrl,
    marketplace_id: v.marketplaceId,
    marketplace_name: v.name ?? null,
    client_id: input.clientId,
    // Set again once the secret is stored (Integration API only).
    client_secret_vault_id: null,
    auth_mode: authMode,
    status: "pending",
    last_sync_error: null,
  };
  if (marketplaceChanged) Object.assign(row, FRESH_SYNC_STATE, FRESH_CERTIFICATION);
  else if (urlChanged) Object.assign(row, FRESH_CERTIFICATION);

  const { error: upsertErr } = await sb()
    .from("tenant_integrations")
    .upsert(row, { onConflict: "workspace_id,provider" });
  if (upsertErr) {
    if (isMarketplaceTakenError(upsertErr)) {
      // Lost the race with another workspace since the check above, or the
      // check itself failed. The details carry the key; log the code only.
      console.error("[connectSharetribe] marketplace already connected elsewhere", upsertErr.code);
      return { ok: false, error: MARKETPLACE_ALREADY_CONNECTED_ERROR };
    }
    console.error("[connectSharetribe] upsert error", upsertErr.message);
    return { ok: false, error: CONNECT_SENTENCES.saveFailed };
  }

  const markError = async (sentence: string) => {
    const { error } = await sb()
      .from("tenant_integrations")
      .update({ status: "error", last_sync_error: sentence })
      .eq("workspace_id", workspaceId)
      .eq("provider", "sharetribe");
    if (error) console.error("[connectSharetribe] could not record the error state", error.message);
  };

  if (marketplaceChanged) {
    // The old marketplace's listings must not stand in for the new one's.
    // The row above already reset the lease, so an old run stops at its next
    // page and removes nothing.
    const { error: clearErr } = await sb().from("tenant_listings").delete().eq("workspace_id", workspaceId);
    if (clearErr) {
      console.error("[connectSharetribe] previous marketplace's listings not removed", clearErr.message);
      await markError(CONNECT_SENTENCES.switchCleanupFailed);
      return { ok: false, error: CONNECT_SENTENCES.switchCleanupFailed };
    }
  }

  let vaultId: string | null = null;
  if (authMode === "integration") {
    let id: string | null = null;
    try {
      id = await args.storeSecret(input.clientSecret as string);
    } catch (e) {
      console.error("[connectSharetribe] vault error", e instanceof Error ? e.message : e);
    }
    if (!id) {
      await markError(CONNECT_SENTENCES.secretStoreFailedRow);
      return { ok: false, error: CONNECT_SENTENCES.secretStoreFailed };
    }
    vaultId = id;
  } else if (existing?.client_secret_vault_id) {
    // Switching an Integration API connection to the Marketplace API: the
    // old secret is no longer needed, so it must not stay decryptable.
    const { error: secretErr } = await sb().rpc("tenant_delete_integration_secret", {
      _workspace_id: workspaceId,
    });
    if (secretErr) {
      console.error("[connectSharetribe] vault secret cleanup failed", secretErr.message);
      await markError(CONNECT_SENTENCES.secretCleanupFailedRow);
      return { ok: false, error: CONNECT_SENTENCES.secretCleanupFailed };
    }
  }

  const { error: markErr } = await sb()
    .from("tenant_integrations")
    .update({ status: "connected", client_secret_vault_id: vaultId, last_sync_error: null })
    .eq("workspace_id", workspaceId)
    .eq("provider", "sharetribe");
  if (markErr) {
    console.error("[connectSharetribe] mark connected failed", markErr.message);
    return { ok: false, error: CONNECT_SENTENCES.markFailed };
  }

  // Straight into the first sync; the page shows its outcome.
  const sync = await (deps.runSync ?? ((id: string) => runSharetribeSyncForWorkspace(id)))(workspaceId);
  let linkCheck: ListingLinkCheck | null = null;
  if (sync.status === "success") {
    linkCheck = await (deps.checkLinks ?? ((id: string) => checkListingLinksIfNeverChecked(id)))(workspaceId);
  }
  return {
    ok: true,
    marketplaceName: v.name ?? null,
    marketplaceId: v.marketplaceId,
    authMode,
    marketplaceChanged,
    sync: summarizeSync(sync),
    linkCheck: linkCheck ? { result: linkCheck.result, sentence: linkCheck.sentence } : null,
  };
}

export const connectSharetribe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => connectInput.parse(d))
  .handler(async ({ data, context }) => {
    // Connecting rotates/overwrites stored credentials — owner-only.
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    return connectSharetribeForWorkspace({
      workspaceId: data.workspaceId,
      input: data,
      // The Vault helper runs as the user (it re-checks ownership itself).
      storeSecret: async (secret) => {
        const { data: id, error } = await (context.supabase as any).rpc("tenant_set_integration_secret", {
          _workspace_id: data.workspaceId,
          _client_secret: secret,
        });
        if (error || !id) {
          console.error("[connectSharetribe] vault error", error?.message ?? "no id");
          return null;
        }
        return id as string;
      },
    });
  });

/**
 * Disconnect: listings, then the row, then a second sweep of listings, then
 * the Vault secret.
 *
 * LISTINGS FIRST, ROW LAST. The row is what the Settings page keys the
 * Disconnect button on: with the row deleted first, a failed listings delete
 * left the UI showing the connect form, orphaned listings, and no control
 * that could retry. In this order any failure leaves the connection visibly
 * in place with Disconnect still there to press again, and a second press
 * after a complete first one is a no-op (a delete that matches nothing is not
 * an error), so the call is idempotent.
 *
 * A sync running at that moment loses its lease with the row (its next
 * touch fails, so it stops) and, finding the row gone at the end, deletes
 * what it wrote; the sweep after the row delete makes that certain.
 */
export async function disconnectSharetribeForWorkspace(
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error: listErr } = await sb().from("tenant_listings").delete().eq("workspace_id", workspaceId);
  if (listErr) {
    console.error("[disconnectSharetribe] listings delete failed", listErr.message);
    return {
      ok: false,
      error:
        "We couldn't remove the synced listings, so the connection is still in place. Try Disconnect again.",
    };
  }
  const { error: intErr } = await sb()
    .from("tenant_integrations")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("provider", "sharetribe");
  if (intErr) {
    console.error("[disconnectSharetribe] integration delete failed", intErr.message);
    return {
      ok: false,
      error: "The synced listings were removed, but the connection could not be. Try Disconnect again.",
    };
  }
  const { error: sweepErr } = await sb().from("tenant_listings").delete().eq("workspace_id", workspaceId);
  if (sweepErr) console.error("[disconnectSharetribe] listings sweep failed", sweepErr.message);
  // Remove the client secret from Vault — leaving a disconnected customer's
  // credential decryptable forever is a liability. Marketplace API
  // connections never stored one, so the delete is a no-op for them.
  const { error: secretErr } = await sb().rpc("tenant_delete_integration_secret", {
    _workspace_id: workspaceId,
  });
  if (secretErr) {
    console.error("[disconnectSharetribe] vault secret cleanup failed", secretErr.message);
  }
  return { ok: true };
}

export const disconnectSharetribe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    // Disconnecting hard-deletes the integration AND every synced listing — owner-only.
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    return disconnectSharetribeForWorkspace(data.workspaceId);
  });

export type SyncNowReply =
  | ({ ok: true } & SyncSummary)
  | { ok: false; status: SyncRunResult["status"]; error: string };

/** Sync now's reply: the run's own sentence, whatever happened. */
export function syncNowReply(r: SyncRunResult): SyncNowReply {
  if (r.status === "success" || r.status === "partial" || r.status === "warning") {
    return { ok: true, ...summarizeSync(r) };
  }
  return { ok: false, status: r.status, error: r.sentence };
}

export const runSharetribeSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<SyncNowReply> => {
    // Members may sync; the lease refuses a second run politely (no writes).
    await assertMember(data.workspaceId, context.userId);
    const r = await runSharetribeSyncForWorkspace(data.workspaceId);
    if (r.status === "success") await checkListingLinksIfNeverChecked(data.workspaceId);
    return syncNowReply(r);
  });

/**
 * "Check listing links": open one real synced listing at the URL pages link
 * to and record whether it is that listing (see certification.server.ts).
 * A warning when unverified, never a publish blocker.
 */
export const checkSharetribeListingLinks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);
    const r = await checkListingLinks(data.workspaceId);
    return {
      ok: r.result === "ok",
      result: r.result,
      sentence: r.sentence,
      url: r.url,
      checkedAt: r.checkedAt,
      saved: r.saved,
    };
  });
