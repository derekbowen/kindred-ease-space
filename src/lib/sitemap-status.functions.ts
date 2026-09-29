/**
 * THE SITEMAP SCREEN, server side: status, recheck, download.
 *
 * Everything here reads a workspace's sitemap through the one generator
 * (src/lib/sitemap.server.ts): the counts on the screen, the XML a Recheck
 * validates and the XML a Download returns are the build /a/sitemap.xml
 * serves. Each server function checks membership (assertWorkspaceMember)
 * before it reads anything; reads and the one write (workspace_domains.
 * sitemap_check) use the service role.
 *
 * Honesty rules, enforced by describeSitemapCheck and tested:
 *  - nothing reads as "valid and complete" unless the build was complete, the
 *    generated XML validated, the LIVE https://{host}/a/sitemap.xml answered
 *    200 with valid XML, and its URL set equals the expected set exactly;
 *  - an incomplete read, a failed fetch or a difference is never green;
 *  - nothing claims the sitemap was submitted to a search engine or that a
 *    URL is indexed — we do neither, and cannot know the latter.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "./admin-helpers.functions";
import {
  collectSitemap,
  parseSitemapXml,
  planSitemap,
  resolveTenantHost,
  sitemapDocumentFor,
  sitemapPartUrl,
  utf8Length,
  validateSitemapPlan,
  type ExclusionCounts,
  type ExclusionReason,
  type SitemapDb,
} from "@/lib/sitemap.server";

const adminDb = (): SitemapDb => supabaseAdmin as unknown as SitemapDb;

// ---------------------------------------------------------------------------
// Shared with the screen (pure: no server imports are needed to use these)
// ---------------------------------------------------------------------------

/** Changes reach the live sitemap within this window (SITEMAP_CACHE_SECONDS / 60). */
export const SITEMAP_FRESHNESS_MINUTES = 5;

/** The exclusion reasons in the order the screen lists them. */
export const EXCLUSION_ORDER: readonly ExclusionReason[] = [
  "draft",
  "archived",
  "suspended",
  "noindex",
  "thin",
  "template_unavailable",
  "redirected",
  "duplicate_slug",
  "reserved",
  "invalid_slug",
];

export const EXCLUSION_LABELS: Record<ExclusionReason, { label: string; help: string }> = {
  draft: { label: "Drafts", help: "Not published yet." },
  archived: { label: "Archived", help: "Taken down." },
  suspended: {
    label: "Suspended",
    help: "Paused by your plan's page limit or billing.",
  },
  noindex: {
    label: "Set to noindex",
    help: "Published, but marked to stay out of search results.",
  },
  thin: {
    label: "Thin or no matching listings",
    help: "A city or category page with no published listings that match it, or an article or older page with under 300 characters of text.",
  },
  template_unavailable: {
    label: "Template not available",
    help: "Its template is switched off or can't be shown.",
  },
  redirected: { label: "Redirected", help: "A redirect sends this address to another page." },
  duplicate_slug: {
    label: "Duplicate address",
    help: "Another page already answers at this address.",
  },
  reserved: { label: "Reserved address", help: "founders.click uses this address itself." },
  invalid_slug: {
    label: "Address can't be served",
    help: "Only lowercase letters, numbers and dashes can be served.",
  },
};

export type SitemapCheckStatus =
  | "healthy"
  | "mismatch"
  | "fetch_failed"
  | "invalid"
  | "incomplete"
  | "paused";

/** What a Recheck stores in workspace_domains.sitemap_check. */
export type SitemapCheck = {
  version: 1;
  checked_at: string;
  host: string;
  url: string;
  status: SitemapCheckStatus;
  /** The live sitemap's HTTP status (null: no answer at all). */
  http_status: number | null;
  /** URLs the live sitemap listed (null: it could not be read). */
  included: number | null;
  /** URLs the build chose (null: the build was incomplete). */
  expected: number | null;
  /** Expected URLs the live sitemap lacks — the first 20. */
  missing: string[];
  /** Live URLs the build did not choose — the first 20. */
  unexpected: string[];
  missing_count: number;
  unexpected_count: number;
  /** Plain sentences, at most 10. */
  errors: string[];
  duration_ms: number;
};

const CHECK_STATUSES: readonly SitemapCheckStatus[] = [
  "healthy",
  "mismatch",
  "fetch_failed",
  "invalid",
  "incomplete",
  "paused",
];

/** A stored sitemap_check read back defensively (it is jsonb: anything may be there). */
export function readStoredCheck(raw: unknown): SitemapCheck | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!CHECK_STATUSES.includes(r.status as SitemapCheckStatus)) return null;
  if (typeof r.checked_at !== "string" || !Number.isFinite(Date.parse(r.checked_at))) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const strs = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    version: 1,
    checked_at: r.checked_at,
    host: typeof r.host === "string" ? r.host : "",
    url: typeof r.url === "string" ? r.url : "",
    status: r.status as SitemapCheckStatus,
    http_status: num(r.http_status),
    included: num(r.included),
    expected: num(r.expected),
    missing: strs(r.missing),
    unexpected: strs(r.unexpected),
    missing_count: num(r.missing_count) ?? strs(r.missing).length,
    unexpected_count: num(r.unexpected_count) ?? strs(r.unexpected).length,
    errors: strs(r.errors),
    duration_ms: num(r.duration_ms) ?? 0,
  };
}

export type CheckTone = "ok" | "neutral" | "warn" | "error";

/**
 * The one sentence the screen prints for a check. "ok" (green) only for a
 * healthy check of a sitemap that lists pages and matched exactly.
 */
export function describeSitemapCheck(c: SitemapCheck | null): {
  tone: CheckTone;
  title: string;
  detail: string;
} {
  if (!c) {
    return {
      tone: "neutral",
      title: "Not checked yet",
      detail:
        "Run a check to validate the XML and compare your live sitemap with your published pages.",
    };
  }
  const n = (k: number | null) => (k === null ? "?" : k.toLocaleString("en-US"));
  switch (c.status) {
    case "healthy": {
      const exact =
        c.http_status === 200 &&
        c.missing_count === 0 &&
        c.unexpected_count === 0 &&
        c.errors.length === 0 &&
        c.expected !== null &&
        c.included === c.expected;
      if (exact && (c.expected ?? 0) > 0) {
        return {
          tone: "ok",
          title: "Valid, and matches your published pages",
          detail: `The live sitemap is valid XML and lists exactly the ${n(c.expected)} page${c.expected === 1 ? "" : "s"} we expect.`,
        };
      }
      if (exact) {
        return {
          tone: "neutral",
          title: "Valid — no pages to list yet",
          detail:
            "The live sitemap is valid XML with no URLs, because none of your pages can be listed yet.",
        };
      }
      return {
        tone: "warn",
        title: "Check incomplete",
        detail: "This check didn't finish every step. Run it again.",
      };
    }
    case "paused":
      return {
        tone: "neutral",
        title: "Paused",
        detail:
          "Your pages aren't being served right now (billing), so the sitemap is empty until they are.",
      };
    case "mismatch":
      return {
        tone: "warn",
        title: "Live sitemap differs from your pages",
        detail: `${n(c.missing_count)} expected page${c.missing_count === 1 ? " is" : "s are"} missing and ${n(c.unexpected_count)} unexpected URL${c.unexpected_count === 1 ? " is" : "s are"} listed. Changes can take up to ${SITEMAP_FRESHNESS_MINUTES} minutes to appear.`,
      };
    case "fetch_failed":
      return {
        tone: "error",
        title: "Couldn't fetch your live sitemap",
        detail: c.errors[0] ?? "The sitemap URL didn't answer with the sitemap.",
      };
    case "invalid":
      return {
        tone: "error",
        title: "Sitemap problem found",
        detail: c.errors[0] ?? "The sitemap isn't valid.",
      };
    case "incomplete":
    default:
      return {
        tone: "warn",
        title: "Couldn't finish the check",
        detail: c.errors[0] ?? "Some of your pages couldn't be read. Try again in a minute.",
      };
  }
}

// ---------------------------------------------------------------------------
// Domains: which one is live, or what is left to do
// ---------------------------------------------------------------------------

export type SitemapDomainRow = {
  id: string;
  hostname: string;
  verified: boolean;
  status: string;
  connection_type: string;
  founders_disabled: boolean;
  sitemap_check: unknown;
  created_at: string | null;
};

const DOMAIN_COLUMNS =
  "id, hostname, verified, status, connection_type, founders_disabled, sitemap_check, created_at";

function toDomainRow(r: any): SitemapDomainRow {
  return {
    id: String(r.id),
    hostname: String(r.hostname ?? "").toLowerCase(),
    verified: r.verified === true,
    status: String(r.status ?? (r.verified ? "verified" : "verification_required")),
    connection_type: String(r.connection_type ?? "full_proxy"),
    founders_disabled: r.founders_disabled === true,
    sitemap_check: r.sitemap_check ?? null,
    created_at: r.created_at ?? null,
  };
}

/** A domain whose /a/sitemap.xml is live: ownership proven, connection test passed, Founders pages on. */
export function isSitemapDomainActive(d: SitemapDomainRow): boolean {
  return d.verified && d.status === "active" && !d.founders_disabled;
}

export type DomainStep = {
  code: "connect" | "verify" | "finish_setup" | "point_dns" | "domain_paused";
  hostname: string | null;
  title: string;
  detail: string;
};

const STEP_RANK: Record<string, number> = {
  active: 6,
  ssl_pending: 5,
  provisioning: 5,
  dns_configuration_required: 4,
  verified: 3,
  error: 2,
  verification_required: 1,
  pending: 1,
};

/**
 * The exact step still between this workspace and a live sitemap URL, for the
 * domain furthest along (rows arrive newest first; ties keep the newest).
 */
export function remainingDomainStep(rows: readonly SitemapDomainRow[]): DomainStep {
  const live = rows.filter((r) => r.status !== "disconnected");
  let best: SitemapDomainRow | null = null;
  for (const r of live) {
    if (!best || (STEP_RANK[r.status] ?? 0) > (STEP_RANK[best.status] ?? 0)) best = r;
  }
  if (!best) {
    return {
      code: "connect",
      hostname: null,
      title: "Connect your domain",
      detail:
        rows.length > 0
          ? "Your domain was disconnected. Connect it again in Settings → Domains; your sitemap address appears here once the domain is live."
          : "Add your marketplace's domain in Settings → Domains. Your sitemap address appears here once the domain is live.",
    };
  }
  const h = best.hostname;
  if (best.status === "active" && best.verified && best.founders_disabled) {
    return {
      code: "domain_paused",
      hostname: h,
      title: `Founders pages are switched off on ${h}`,
      detail:
        "All traffic on this domain goes to your own site right now. Contact support to switch Founders pages back on.",
    };
  }
  if (!best.verified || best.status === "verification_required" || best.status === "pending") {
    return {
      code: "verify",
      hostname: h,
      title: `Verify that you own ${h}`,
      detail: "Add the verification record shown in Settings → Domains, then press Verify.",
    };
  }
  if (
    best.status === "dns_configuration_required" ||
    best.status === "provisioning" ||
    best.status === "ssl_pending"
  ) {
    return {
      code: "point_dns",
      hostname: h,
      title: `Point ${h}'s DNS at proxy.founders.click`,
      detail:
        "Add the DNS record shown in Settings → Domains. The certificate is issued automatically once DNS is live, and the connection test then marks the domain active.",
    };
  }
  return {
    code: "finish_setup",
    hostname: h,
    title: `Finish setting up ${h}`,
    detail:
      "Open Settings → Domains and press Retry setup (or run the connection test) — it picks up where it stopped.",
  };
}

/** How search engines can be told about the sitemap. We do not submit it. */
export function sitemapGuidance(
  connectionType: string,
  host: string,
): { robotsLine: string | null } {
  // On a subdomain connection the whole subdomain is ours, and its robots.txt
  // is not a file the owner edits: Search Console is the way in.
  return {
    robotsLine: connectionType === "subdomain" ? null : `Sitemap: https://${host}/a/sitemap.xml`,
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type SitemapDomainView = {
  id: string;
  hostname: string;
  connectionType: string;
  sitemapUrl: string;
  robotsLine: string | null;
  check: SitemapCheck | null;
  /** Files the sitemap needs (1 unless it passes 50,000 URLs or 50 MB); null when the build is incomplete. */
  parts: number | null;
};

export type SitemapBuildView =
  | {
      ok: true;
      included: number;
      excluded: ExclusionCounts;
      warnings: string[];
      /** Set when billing stops the pages serving: the sitemap is empty. */
      paused: { reason: string } | null;
    }
  | { ok: false; problems: string[] };

export type SitemapStatusView = {
  freshnessMinutes: number;
  domains: SitemapDomainView[];
  /** When no domain is live: what is left to do (and no sitemap URL). */
  step: DomainStep | null;
  build: SitemapBuildView;
};

function customerError(message: string): Error {
  const e = new Error(message);
  e.name = "CustomerFacingError";
  (e as Error & { customerFacing: boolean }).customerFacing = true;
  return e;
}

async function readDomains(db: SitemapDb, workspaceId: string): Promise<SitemapDomainRow[]> {
  const { data, error } = await db
    .from("workspace_domains")
    .select(DOMAIN_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[sitemap-status] domain read failed:", workspaceId, error.message);
    throw customerError("Couldn't load your domains. Refresh the page to try again.");
  }
  return ((data ?? []) as any[]).map(toDomainRow);
}

/** The Sitemap screen's data. Call only after checking membership. */
export async function loadSitemapStatus(
  workspaceId: string,
  { db = adminDb() }: { db?: SitemapDb } = {},
): Promise<SitemapStatusView> {
  const [rows, c] = await Promise.all([
    readDomains(db, workspaceId),
    collectSitemap(workspaceId, { db, statusCounts: true }),
  ]);
  const active = rows.filter(isSitemapDomainActive);
  const paused = c.complete && c.serving !== null && !c.serving.serve;
  const build: SitemapBuildView = c.complete
    ? {
        ok: true,
        included: paused ? 0 : c.urls.length,
        excluded: c.excluded,
        warnings: c.warnings,
        paused: paused ? { reason: c.serving!.reason } : null,
      }
    : { ok: false, problems: c.problems };
  return {
    freshnessMinutes: SITEMAP_FRESHNESS_MINUTES,
    domains: active.map((d) => ({
      id: d.id,
      hostname: d.hostname,
      connectionType: d.connection_type,
      sitemapUrl: `https://${d.hostname}/a/sitemap.xml`,
      robotsLine: sitemapGuidance(d.connection_type, d.hostname).robotsLine,
      check: readStoredCheck(d.sitemap_check),
      parts: c.complete ? planSitemap(d.hostname, paused ? [] : c.urls).shards.length : null,
    })),
    step: active.length > 0 ? null : remainingDomainStep(rows),
    build,
  };
}

async function activeDomainOrThrow(
  db: SitemapDb,
  workspaceId: string,
  domainId: string,
): Promise<SitemapDomainRow> {
  const rows = await readDomains(db, workspaceId);
  const d = rows.find((r) => r.id === domainId);
  if (!d) throw customerError("That domain isn't connected to this workspace.");
  if (!isSitemapDomainActive(d)) {
    const step = remainingDomainStep([d]);
    throw customerError(
      `${d.hostname} isn't live yet, so it has no sitemap to check. Next step: ${step.title}.`,
    );
  }
  return d;
}

// ---------------------------------------------------------------------------
// Recheck: the generated XML, then the live one
// ---------------------------------------------------------------------------

export type LiveFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Past this a live sitemap is refused unread (the protocol's 50 MB, plus slack). */
export const LIVE_MAX_BYTES = 52 * 1024 * 1024;
/** Parts of a live index the check reads, at most. */
export const LIVE_MAX_PARTS = 20;
export const LIVE_TIMEOUT_MS = 10_000;

type Fetched = { status: number | null; text: string; error: string | null };

async function fetchText(url: string, fetchImpl: LiveFetch, timeoutMs: number): Promise<Fetched> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: ctrl.signal,
      headers: {
        accept: "application/xml, text/xml;q=0.9, */*;q=0.1",
        "cache-control": "no-cache",
        "user-agent": "founders.click sitemap check",
      },
    });
    if (res.status !== 200) {
      const location = res.headers.get("location");
      try {
        await res.body?.cancel();
      } catch {
        /* nothing to release */
      }
      const error =
        res.status >= 300 && res.status < 400
          ? `${url} redirects (HTTP ${res.status}${location ? ` to ${location}` : ""}) instead of answering with the sitemap.`
          : `${url} answered HTTP ${res.status} instead of 200.`;
      return { status: res.status, text: "", error };
    }
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > LIVE_MAX_BYTES) {
      return { status: 200, text: "", error: `${url} is larger than a sitemap may be (50 MB).` };
    }
    const text = await res.text();
    if (utf8Length(text) > LIVE_MAX_BYTES) {
      return { status: 200, text: "", error: `${url} is larger than a sitemap may be (50 MB).` };
    }
    return { status: 200, text, error: null };
  } catch {
    return {
      status: null,
      text: "",
      error: ctrl.signal.aborted
        ? `${url} didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`
        : `Couldn't reach ${url}. Check that the domain's DNS points at founders.click.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export type LiveSitemap = {
  ok: boolean;
  /** "fetch": no usable answer; "invalid": an answer that isn't a valid sitemap. */
  failure: "fetch" | "invalid" | null;
  httpStatus: number | null;
  locs: string[];
  parts: number;
  errors: string[];
};

/**
 * Fetch https://{host}/a/sitemap.xml as a crawler would (no redirects
 * followed, a timeout per request) and read it with the same parser as the
 * in-process check; an index is followed to each of its parts on this host.
 */
export async function fetchLiveSitemap(
  host: string,
  {
    fetchImpl = fetch as LiveFetch,
    timeoutMs = LIVE_TIMEOUT_MS,
  }: { fetchImpl?: LiveFetch; timeoutMs?: number } = {},
): Promise<LiveSitemap> {
  const url = `https://${host}/a/sitemap.xml`;
  const main = await fetchText(url, fetchImpl, timeoutMs);
  if (main.error) {
    return {
      ok: false,
      failure: "fetch",
      httpStatus: main.status,
      locs: [],
      parts: 0,
      errors: [main.error],
    };
  }
  const invalid = (msg: string): LiveSitemap => ({
    ok: false,
    failure: "invalid",
    httpStatus: 200,
    locs: [],
    parts: 0,
    errors: [msg],
  });
  const parsed = parseSitemapXml(main.text);
  if (parsed.errors.length > 0)
    return invalid(`The live sitemap isn't valid: ${parsed.errors[0]}.`);
  if (parsed.kind === "urlset") {
    return { ok: true, failure: null, httpStatus: 200, locs: parsed.locs, parts: 1, errors: [] };
  }
  if (parsed.locs.length > LIVE_MAX_PARTS) {
    return invalid(
      `The live sitemap index names ${parsed.locs.length} parts; the check reads at most ${LIVE_MAX_PARTS}.`,
    );
  }
  const locs: string[] = [];
  for (let k = 1; k <= parsed.locs.length; k++) {
    const partUrl = parsed.locs[k - 1]!;
    if (partUrl !== sitemapPartUrl(host, k)) {
      return invalid(
        `The live sitemap index names ${partUrl} as part ${k}; expected ${sitemapPartUrl(host, k)}.`,
      );
    }
    const part = await fetchText(partUrl, fetchImpl, timeoutMs);
    if (part.error) {
      return {
        ok: false,
        failure: "fetch",
        httpStatus: part.status,
        locs: [],
        parts: 0,
        errors: [part.error],
      };
    }
    const p = parseSitemapXml(part.text);
    if (p.errors.length > 0 || p.kind !== "urlset") {
      return invalid(
        `Part ${k} of the live sitemap isn't valid: ${p.errors[0] ?? "not a <urlset>"}.`,
      );
    }
    for (const l of p.locs) locs.push(l);
  }
  return { ok: true, failure: null, httpStatus: 200, locs, parts: parsed.locs.length, errors: [] };
}

/** Expected vs live: which URLs are missing, which are unexpected, how many are doubled. */
export function compareSitemapSets(
  expected: readonly string[],
  live: readonly string[],
): { missing: string[]; unexpected: string[]; doubled: number } {
  const want = new Set(expected);
  const got = new Set(live);
  return {
    missing: [...want].filter((u) => !got.has(u)),
    unexpected: [...got].filter((u) => !want.has(u)),
    doubled: live.length - got.size,
  };
}

const SAMPLE = 20;
const MAX_ERRORS = 10;

export type RecheckResult = { check: SitemapCheck; saved: boolean };

/**
 * Recheck one active domain: (a) build the sitemap here and validate it
 * (well-formed, escaped, within both limits, the chosen URL set exactly);
 * (b) fetch the live https://{host}/a/sitemap.xml with a timeout and compare
 * its URL set with the expected one; store the result in
 * workspace_domains.sitemap_check. Call only after checking membership.
 */
export async function runSitemapRecheck(
  workspaceId: string,
  domainId: string,
  {
    db = adminDb(),
    fetchImpl = fetch as LiveFetch,
    timeoutMs = LIVE_TIMEOUT_MS,
    now = () => Date.now(),
  }: { db?: SitemapDb; fetchImpl?: LiveFetch; timeoutMs?: number; now?: () => number } = {},
): Promise<RecheckResult> {
  const d = await activeDomainOrThrow(db, workspaceId, domainId);
  const started = now();
  const host = d.hostname;
  const errors: string[] = [];
  // The first problem found decides the status; later steps still run so the
  // stored errors say everything that is wrong.
  const outcome: { status: SitemapCheckStatus | null } = { status: null };
  const settle = (s: SitemapCheckStatus) => {
    if (outcome.status === null) outcome.status = s;
  };

  // The live route picks the workspace by this exact host; it must be ours.
  const resolution = await resolveTenantHost(host, db);
  if (resolution.kind === "error") {
    settle("incomplete");
    errors.push("Couldn't confirm which workspace this domain belongs to.");
  } else if (resolution.kind !== "tenant" || resolution.workspaceId !== workspaceId) {
    settle("invalid");
    errors.push(
      `${host} doesn't resolve to this workspace, so the sitemap served there isn't yours.`,
    );
  }

  // (a) In process.
  const c = await collectSitemap(workspaceId, { db });
  let expected: string[] | null = null;
  let paused = false;
  if (!c.complete) {
    settle("incomplete");
    errors.push(...c.problems);
  } else {
    paused = c.serving !== null && !c.serving.serve;
    const plan = planSitemap(host, paused ? [] : c.urls);
    expected = plan.entries.map((e) => e.loc);
    const v = validateSitemapPlan(plan, expected);
    if (!v.ok) {
      settle("invalid");
      errors.push(...v.errors.map((e) => `Generated sitemap: ${e}.`));
    }
  }

  // (b) Live.
  const live = await fetchLiveSitemap(host, { fetchImpl, timeoutMs });
  if (!live.ok) {
    settle(live.failure === "invalid" ? "invalid" : "fetch_failed");
    errors.push(...live.errors);
  }

  let missing: string[] = [];
  let unexpected: string[] = [];
  if (expected !== null && live.ok) {
    const cmp = compareSitemapSets(expected, live.locs);
    missing = cmp.missing;
    unexpected = cmp.unexpected;
    if (cmp.doubled > 0) {
      settle("invalid");
      errors.push(
        `The live sitemap lists ${cmp.doubled} URL${cmp.doubled === 1 ? "" : "s"} twice.`,
      );
    }
    if (missing.length > 0 || unexpected.length > 0) {
      settle("mismatch");
      if (missing.length > 0) {
        errors.push(
          `${missing.length} page${missing.length === 1 ? " is" : "s are"} missing from the live sitemap. Changes can take up to ${SITEMAP_FRESHNESS_MINUTES} minutes to appear.`,
        );
      }
      if (unexpected.length > 0) {
        errors.push(
          `The live sitemap lists ${unexpected.length} URL${unexpected.length === 1 ? "" : "s"} we wouldn't list now.`,
        );
      }
    }
  }
  settle(paused ? "paused" : "healthy");

  const check: SitemapCheck = {
    version: 1,
    checked_at: new Date(now()).toISOString(),
    host,
    url: `https://${host}/a/sitemap.xml`,
    status: outcome.status ?? "incomplete",
    http_status: live.httpStatus,
    included: live.ok ? live.locs.length : null,
    expected: expected === null ? null : expected.length,
    missing: missing.slice(0, SAMPLE),
    unexpected: unexpected.slice(0, SAMPLE),
    missing_count: missing.length,
    unexpected_count: unexpected.length,
    errors: errors.slice(0, MAX_ERRORS),
    duration_ms: Math.max(0, now() - started),
  };

  const write = await db
    .from("workspace_domains")
    .update({ sitemap_check: check })
    .eq("id", d.id)
    .eq("workspace_id", workspaceId);
  if (write.error) {
    console.error("[sitemap-status] sitemap_check write failed:", d.id, write.error.message);
  }
  return { check, saved: !write.error };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export type SitemapDownload = { filename: string; xml: string; parts: number };

/** The generated XML for an active domain: the main document, or part `page`. */
export async function buildSitemapDownload(
  workspaceId: string,
  domainId: string,
  page: number | undefined,
  { db = adminDb() }: { db?: SitemapDb } = {},
): Promise<SitemapDownload> {
  const d = await activeDomainOrThrow(db, workspaceId, domainId);
  const c = await collectSitemap(workspaceId, { db });
  if (!c.complete) {
    throw customerError(
      `Couldn't build your sitemap right now: ${c.problems[0] ?? "a read failed."} Try again in a minute.`,
    );
  }
  const paused = c.serving !== null && !c.serving.serve;
  const plan = planSitemap(d.hostname, paused ? [] : c.urls);
  const xml = sitemapDocumentFor(plan, page);
  if (xml === null) throw customerError("That part of the sitemap doesn't exist.");
  return {
    filename: page ? `sitemap-${d.hostname}-part-${page}.xml` : `sitemap-${d.hostname}.xml`,
    xml,
    parts: plan.shards.length,
  };
}

// ---------------------------------------------------------------------------
// Server functions (membership first, always)
// ---------------------------------------------------------------------------

export const getSitemapStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }): Promise<SitemapStatusView> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    return loadSitemapStatus(data.workspaceId);
  });

export const recheckSitemap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, domainId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }): Promise<RecheckResult> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    return runSitemapRecheck(data.workspaceId, data.domainId);
  });

export const downloadSitemapXml = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        domainId: z.string().uuid(),
        page: z.number().int().min(1).max(9999).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<SitemapDownload> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    return buildSitemapDownload(data.workspaceId, data.domainId, data.page);
  });
