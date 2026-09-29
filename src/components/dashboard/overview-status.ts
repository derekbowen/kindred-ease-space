/**
 * THE DASHBOARD'S TWO READINGS OF THE OVERVIEW (getWorkspaceOverview): the
 * setup checklist and the sync health card. Pure — no React, no clock of its
 * own (`now` is passed in) — so the wording is testable offline.
 *
 * The checklist is the MVP journey in four steps: Sharetribe connected →
 * listings synced → domain active → first page published. Each step links to
 * the one screen that completes it (Sharetribe & inventory, Domains, Page
 * Builder).
 */
import { formatPlanDate } from "@/components/billing/plan-status";
import { describeDomainStatus, pickDomainForSettings } from "@/components/settings/domain-status";

export const SHARETRIBE_PATH = "/app/settings/integrations/sharetribe";
export const DOMAINS_PATH = "/app/settings/domains";
export const PAGE_BUILDER_PATH = "/app/pages/new";
export const MY_PAGES_PATH = "/app/pages";
export const OPPORTUNITIES_PATH = "/app/opportunities";

export type OverviewDomain = { hostname: string; status: string; verified: boolean };

export type SetupFacts = {
  sharetribeConnected: boolean;
  syncedListings: number;
  /** The workspace's connected domains, newest first (getWorkspaceOverview). */
  domains: OverviewDomain[];
  /** workspaces.marketplace_domain: which domain row to describe first. */
  marketplaceDomain: string | null | undefined;
  publishedPages: number;
};

export type SetupStepId = "sharetribe" | "listings" | "domain" | "page";

export type SetupStep = {
  id: SetupStepId;
  label: string;
  description: string;
  done: boolean;
  to: string;
  cta: string;
};

/** A domain is active once its certificate is ready and it serves pages. */
export function isDomainActive(domain: Pick<OverviewDomain, "status"> | null | undefined): boolean {
  return (domain?.status ?? "").trim().toLowerCase() === "active";
}

export function setupSteps(f: SetupFacts): SetupStep[] {
  const domain = pickDomainForSettings(f.domains, f.marketplaceDomain);
  const domainActive = isDomainActive(domain);
  return [
    {
      id: "sharetribe",
      label: "Connect Sharetribe",
      description:
        "Read-only: it needs your marketplace's address and the Client ID of a Marketplace API application.",
      done: f.sharetribeConnected,
      to: SHARETRIBE_PATH,
      cta: "Connect",
    },
    {
      id: "listings",
      label: "Sync your listings",
      description:
        "Import your published listings. After the first sync they refresh automatically about every 30 minutes.",
      done: f.syncedListings > 0,
      to: SHARETRIBE_PATH,
      cta: "Sync now",
    },
    {
      id: "domain",
      label: "Activate your domain",
      description: domainActive
        ? `${domain!.hostname} is active.`
        : domain
          ? `${domain.hostname}: ${describeDomainStatus(domain.status, domain.verified).label}.`
          : "Connect your own domain and verify it. Published pages are served on it under /a/.",
      done: domainActive,
      to: DOMAINS_PATH,
      cta: domain ? "Finish setup" : "Add domain",
    },
    {
      id: "page",
      label: "Publish your first page",
      description:
        "Pick an opportunity or a template in the Page Builder, review the draft, then publish it on your domain.",
      done: f.publishedPages > 0,
      to: PAGE_BUILDER_PATH,
      cta: "Open Page Builder",
    },
  ];
}

export type SyncFacts = {
  /** tenant_integrations.status is 'connected'. */
  connected: boolean;
  /** tenant_integrations.status as stored, or null when never connected. */
  integrationStatus: string | null | undefined;
  lastSyncAt: string | null | undefined;
  /** 'success' | 'warning' | 'failed', as the sync wrote it. */
  lastSyncStatus: string | null | undefined;
  /** Listings currently imported (tenant_listings rows). */
  listings: number;
};

export type SyncTone = "ok" | "warn" | "bad" | "muted";

export type SyncHealth = {
  tone: SyncTone;
  /** "Last synced 5 minutes ago", "Last sync failed 2 hours ago", "Not connected", … */
  headline: string;
  /** "125 listings imported" (or what to do next). */
  detail: string;
  cta: { label: string; to: string };
};

/** "just now", "5 minutes ago", "3 hours ago", else "on Sep 28, 2026". "" when unknown. */
export function formatSyncTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const minutes = Math.max(0, Math.floor((now - t) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `on ${formatPlanDate(iso)}`;
}

export function listingsLine(n: number): string {
  const count = Math.max(0, Math.floor(n || 0));
  return `${count.toLocaleString("en-US")} listing${count === 1 ? "" : "s"} imported`;
}

/**
 * The sync health card: the last sync's outcome and time, and how many
 * listings are imported — never a raw status code or an upstream error text
 * (the Sharetribe page explains a failure in customer words).
 */
export function describeSyncHealth(f: SyncFacts, now: number): SyncHealth {
  const status = (f.integrationStatus ?? "").trim().toLowerCase();
  const listings = listingsLine(f.listings);
  const page = { label: "Sharetribe & inventory →", to: SHARETRIBE_PATH };
  if (status === "error") {
    return {
      tone: "bad",
      headline: "Connection needs attention",
      detail: `${listings}. Sharetribe stopped accepting the connection; reconnect to keep syncing.`,
      cta: { label: "Fix the connection →", to: SHARETRIBE_PATH },
    };
  }
  if (!f.connected && status !== "pending") {
    return {
      tone: "muted",
      headline: "Not connected",
      detail: "Connect Sharetribe to import your published listings.",
      cta: { label: "Connect Sharetribe →", to: SHARETRIBE_PATH },
    };
  }
  const when = formatSyncTime(f.lastSyncAt, now);
  if (!when) {
    return {
      tone: "muted",
      headline: "Not synced yet",
      detail: "Run your first sync to import your published listings.",
      cta: { label: "Sync now →", to: SHARETRIBE_PATH },
    };
  }
  switch ((f.lastSyncStatus ?? "").trim().toLowerCase()) {
    case "failed":
      return {
        tone: "bad",
        headline: `Last sync failed ${when}`,
        detail: `${listings}. The Sharetribe page says what went wrong.`,
        cta: { label: "See what went wrong →", to: SHARETRIBE_PATH },
      };
    case "warning":
      return {
        tone: "warn",
        headline: `Last synced ${when} with a warning`,
        detail: listings,
        cta: page,
      };
    case "success":
      return { tone: "ok", headline: `Last synced ${when}`, detail: listings, cta: page };
    default:
      return { tone: "muted", headline: `Last synced ${when}`, detail: listings, cta: page };
  }
}

export function pagesLine(published: number, drafts: number): string {
  const p = Math.max(0, Math.floor(published || 0));
  const d = Math.max(0, Math.floor(drafts || 0));
  return `${p.toLocaleString("en-US")} published · ${d.toLocaleString("en-US")} draft${d === 1 ? "" : "s"}`;
}
