import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Info,
  Plug,
  RefreshCw,
  Trash2,
  ShieldCheck,
  KeyRound,
  Link2,
  ExternalLink,
} from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import {
  getSharetribeIntegration,
  getListingDataGaps,
  connectSharetribe,
  disconnectSharetribe,
  runSharetribeSync,
  checkSharetribeListingLinks,
} from "@/lib/sharetribe-sync.functions";
import { getSettingsContext } from "@/lib/settings.functions";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { OwnerOnlyBanner } from "@/components/settings/OwnerOnlyBanner";
import { userMessage } from "@/lib/user-message";

export const Route = createFileRoute("/_authenticated/app/settings/integrations/sharetribe")({
  head: () => ({ meta: [{ title: "Sharetribe Integration — founders.click" }] }),
  component: SharetribeIntegrationPage,
});

type AuthMode = "marketplace" | "integration";

type IntegrationRow = {
  id: string;
  marketplace_url: string;
  marketplace_id: string;
  marketplace_name: string | null;
  client_id: string;
  auth_mode: AuthMode | null;
  status: string;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  last_success_at: string | null;
  listings_count: number | null;
  upstream_total: number | null;
  sync_lease_until: string | null;
  sync_progress: unknown;
  certification_status: string | null;
  certified_at: string | null;
  certification_error: string | null;
  certification_detail: unknown;
};

type Gaps = { published: number; missingCity: number; missingCategory: number };
type Tone = "ok" | "warn" | "bad" | "muted";
type Notice = { text: string; tone: "ok" | "warn" | "info" };

const CONNECT_FAILED =
  "Couldn't save your marketplace connection. Try again, or contact support if it keeps happening.";
const SYNC_FAILED =
  "Couldn't sync your listings. Try again in a minute, or contact support if it keeps happening.";
const SYNC_DONE = "The sync finished. The results are shown below.";
const SYNC_RUNNING = "A sync is already running. Its progress is shown below.";
const DISCONNECT_FAILED =
  "Couldn't disconnect Sharetribe. Try again, or contact support if it keeps happening.";
const LOAD_FAILED = "Couldn't load your Sharetribe connection. Reload the page to try again.";
const LINK_CHECK_FAILED = "Couldn't check your listing links. Try again in a minute.";
const LINK_FALLBACK = "We couldn't confirm that listing links open the right listing.";

const MODE_LABEL: Record<AuthMode, string> = {
  marketplace: "Marketplace API (read-only)",
  integration: "Integration API (advanced)",
};

const TONE_CLASS: Record<Tone, string> = {
  ok: "text-emerald-400",
  warn: "text-amber-400",
  bad: "text-red-400",
  muted: "text-muted-foreground",
};

const fmt = (n: number) => n.toLocaleString("en-US");
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Human wording for the last sync attempt — never a raw status code. */
function syncStatusLabel(row: IntegrationRow): { text: string; tone: Tone } {
  if (!row.last_sync_at) return { text: "Not synced yet", tone: "muted" };
  const at = when(row.last_sync_at);
  switch (row.last_sync_status) {
    case "success":
      return { text: `Last synced ${at}`, tone: "ok" };
    case "warning":
      return { text: `Last synced ${at} with a warning`, tone: "warn" };
    case "partial":
      return { text: `Last sync ${at} was incomplete`, tone: "warn" };
    case "failed":
      return { text: `Last sync failed ${at}`, tone: "bad" };
    default:
      return { text: `Last synced ${at}`, tone: "muted" };
  }
}

const LINK_LABEL: Record<string, { text: string; tone: Tone }> = {
  ok: { text: "Listing links work", tone: "ok" },
  auth_required: { text: "Not checked: your marketplace asks for a password", tone: "warn" },
  error: { text: "Not checked: we couldn't reach your marketplace", tone: "warn" },
  not_found: { text: "A synced listing didn't open", tone: "bad" },
  redirected: { text: "Listing links lead to a different page", tone: "bad" },
};

/** The recorded listing-link check (certification_detail.listing_link). */
function linkCheckOf(detail: unknown): { result: string; checkedAt: string | null; url: string | null } | null {
  if (!detail || typeof detail !== "object") return null;
  const link = (detail as Record<string, unknown>).listing_link;
  if (!link || typeof link !== "object") return null;
  const l = link as Record<string, unknown>;
  if (typeof l.result !== "string") return null;
  return {
    result: l.result,
    checkedAt: typeof l.checked_at === "string" ? l.checked_at : null,
    url: typeof l.url === "string" ? l.url : null,
  };
}

function SyncProgress({ progress }: { progress: unknown }) {
  const p = progress && typeof progress === "object" ? (progress as Record<string, unknown>) : {};
  const fetched = num(p.fetched) ?? 0;
  const total = num(p.total);
  const pct = total && total > 0 ? Math.min(100, Math.round((fetched / total) * 100)) : null;
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin text-primary" /> Syncing listings from Sharetribe…
      </div>
      {pct !== null ? <Progress value={pct} className="h-1.5" /> : null}
      <div className="text-xs text-muted-foreground">
        {total !== null && total > 0
          ? `${fmt(fetched)} of ${fmt(total)} listings read`
          : fetched > 0
            ? `${fmt(fetched)} listings read`
            : "Starting…"}
      </div>
    </div>
  );
}

function SharetribeIntegrationPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(true);
  const [integration, setIntegration] = useState<IntegrationRow | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [gaps, setGaps] = useState<Gaps | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [authMode, setAuthMode] = useState<AuthMode>("marketplace");
  const [marketplaceUrl, setMarketplaceUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const fetchIntegration = useServerFn(getSharetribeIntegration);
  const fetchGaps = useServerFn(getListingDataGaps);
  const connect = useServerFn(connectSharetribe);
  const disconnect = useServerFn(disconnectSharetribe);
  const sync = useServerFn(runSharetribeSync);
  const checkLinks = useServerFn(checkSharetribeListingLinks);
  const loadCtx = useServerFn(getSettingsContext);

  useEffect(() => {
    getMe()
      .then((me) => {
        const wsId = me.memberships[0]?.workspace_id ?? null;
        setWorkspaceId(wsId);
        if (!wsId) setLoading(false);
        if (wsId) {
          loadCtx({ data: { workspaceId: wsId } })
            .then((c) => setIsOwner(c.isOwner))
            .catch(() => setIsOwner(me.memberships[0]?.role === "owner"));
        }
      })
      .catch((e) => {
        console.error("[sharetribe] session load failed", e);
        setErr(userMessage(e, LOAD_FAILED));
        setLoading(false);
      });
  }, [loadCtx]);

  const reload = useCallback(
    async (ws: string) => {
      const r = await fetchIntegration({ data: { workspaceId: ws } });
      setIntegration(r.integration as IntegrationRow | null);
      setSyncing(r.syncing);
      return r;
    },
    [fetchIntegration],
  );

  const reloadGaps = useCallback(
    async (ws: string) => {
      try {
        setGaps(await fetchGaps({ data: { workspaceId: ws } }));
      } catch (e) {
        console.error("[sharetribe] listing counts failed", e);
        setGaps(null);
      }
    },
    [fetchGaps],
  );

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    reload(workspaceId)
      .then((r) => {
        if (r.integration) void reloadGaps(workspaceId);
      })
      .catch((e) => {
        console.error("[sharetribe] load failed", e);
        setErr(userMessage(e, LOAD_FAILED));
      })
      .finally(() => setLoading(false));
  }, [workspaceId, reload, reloadGaps]);

  // Live progress: poll the row while a sync holds the lease, or while this
  // page is waiting on a connect / sync / disconnect call.
  const pollBusy = useRef(false);
  const watching = syncing || syncBusy || busy;
  useEffect(() => {
    if (!workspaceId || !watching) return;
    const t = setInterval(async () => {
      if (pollBusy.current) return;
      pollBusy.current = true;
      try {
        await reload(workspaceId);
      } catch {
        /* next tick */
      } finally {
        pollBusy.current = false;
      }
    }, 2000);
    return () => clearInterval(t);
  }, [workspaceId, watching, reload]);

  // A sync this page watched has ended (a scheduled one too): refresh the counts.
  const wasSyncing = useRef(false);
  useEffect(() => {
    if (wasSyncing.current && !syncing && workspaceId) void reloadGaps(workspaceId);
    wasSyncing.current = syncing;
  }, [syncing, workspaceId, reloadGaps]);

  const canSubmit =
    marketplaceUrl.trim().length >= 8 &&
    clientId.trim().length >= 8 &&
    (authMode === "marketplace" || clientSecret.length >= 8);

  async function onConnect() {
    if (!workspaceId) return;
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await connect({
        data: {
          workspaceId,
          marketplaceUrl,
          authMode,
          clientId: clientId.trim(),
          clientSecret: authMode === "integration" ? clientSecret : undefined,
        },
      });
      if (r.ok) {
        setClientSecret("");
        const who = r.marketplaceName ? `Connected to ${r.marketplaceName}.` : "Connected.";
        const first = userMessage(r.sync.sentence, SYNC_DONE);
        setNotice({ text: `${who} ${first}`, tone: r.sync.status === "success" ? "ok" : "warn" });
        await reload(workspaceId);
        await reloadGaps(workspaceId);
      } else {
        setErr(userMessage(r.error, CONNECT_FAILED));
        await reload(workspaceId).catch(() => undefined);
      }
    } catch (e) {
      console.error("[sharetribe] connect failed", e);
      setErr(userMessage(e, CONNECT_FAILED));
    } finally {
      setBusy(false);
    }
  }

  async function onSync() {
    if (!workspaceId) return;
    setSyncBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await sync({ data: { workspaceId } });
      if (r.ok) {
        setNotice({ text: userMessage(r.sentence, SYNC_DONE), tone: r.status === "success" ? "ok" : "warn" });
      } else if (r.status === "already_running") {
        setNotice({ text: userMessage(r.error, SYNC_RUNNING), tone: "info" });
      } else {
        setErr(userMessage(r.error, SYNC_FAILED));
      }
      await reload(workspaceId);
      await reloadGaps(workspaceId);
    } catch (e) {
      console.error("[sharetribe] sync failed", e);
      setErr(userMessage(e, SYNC_FAILED));
    } finally {
      setSyncBusy(false);
    }
  }

  async function onCheckLinks() {
    if (!workspaceId) return;
    setLinkBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await checkLinks({ data: { workspaceId } });
      setNotice({ text: userMessage(r.sentence, LINK_CHECK_FAILED), tone: r.ok ? "ok" : "warn" });
      await reload(workspaceId);
    } catch (e) {
      console.error("[sharetribe] link check failed", e);
      setErr(userMessage(e, LINK_CHECK_FAILED));
    } finally {
      setLinkBusy(false);
    }
  }

  async function onDisconnect() {
    if (!workspaceId) return;
    if (!confirm("Disconnect Sharetribe and delete all synced listings?")) return;
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await disconnect({ data: { workspaceId } });
      if (r.ok) {
        setIntegration(null);
        setSyncing(false);
        setGaps(null);
        setNotice({ text: "Disconnected. Your listings have been removed from founders.click.", tone: "ok" });
      } else {
        setErr(userMessage(r.error, DISCONNECT_FAILED));
        await reload(workspaceId).catch(() => undefined);
      }
    } catch (e) {
      console.error("[sharetribe] disconnect failed", e);
      setErr(userMessage(e, DISCONNECT_FAILED));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const statusInfo = integration ? syncStatusLabel(integration) : null;
  const connectedMode: AuthMode = integration?.auth_mode === "marketplace" ? "marketplace" : "integration";
  const linkCheck = integration ? linkCheckOf(integration.certification_detail) : null;
  const linkLabel = linkCheck ? LINK_LABEL[linkCheck.result] : null;
  const upstreamTotal = integration ? num(integration.upstream_total) : null;
  const syncDisabled = syncing || syncBusy || busy;

  return (
    <div className="max-w-3xl space-y-6 pb-10">
      <SettingsNav />
      <OwnerOnlyBanner isOwner={isOwner} />
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Plug className="h-6 w-6" /> Sharetribe Integration
        </h1>
        <p className="text-muted-foreground mt-1">
          Connect your Sharetribe marketplace so we can import your published listings and build SEO
          pages around them.
        </p>
      </header>

      {notice && (
        <div
          className={`rounded-md border px-3 py-2 text-sm flex items-center gap-2 ${
            notice.tone === "ok"
              ? "border-green-500/30 bg-green-500/10 text-green-300"
              : notice.tone === "warn"
                ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                : "border-sky-500/30 bg-sky-500/10 text-sky-200"
          }`}
        >
          {notice.tone === "ok" ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : notice.tone === "warn" ? (
            <AlertTriangle className="h-4 w-4 shrink-0" />
          ) : (
            <Info className="h-4 w-4 shrink-0" />
          )}
          {notice.text}
        </div>
      )}
      {err && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" /> {err}
        </div>
      )}

      {integration && statusInfo ? (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>{integration.marketplace_name || "Your marketplace"}</CardTitle>
              <Badge variant={integration.status === "connected" ? "default" : "destructive"}>
                {integration.status === "connected"
                  ? "Connected"
                  : integration.status === "error"
                    ? "Needs attention"
                    : "Pending"}
              </Badge>
            </div>
            <CardDescription>
              <a
                href={integration.marketplace_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:underline"
              >
                {integration.marketplace_url} <ExternalLink className="h-3 w-3" />
              </a>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="text-muted-foreground text-xs">Marketplace</div>
                <div>{integration.marketplace_name || "—"}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Marketplace ID</div>
                <div className="font-mono text-xs break-all">{integration.marketplace_id}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Connection</div>
                <div className="flex items-center gap-1.5">
                  {connectedMode === "marketplace" ? (
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <KeyRound className="h-3.5 w-3.5 text-amber-500" />
                  )}
                  {MODE_LABEL[connectedMode]}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Listings imported</div>
                <div>
                  {fmt(num(integration.listings_count) ?? 0)}
                  {upstreamTotal !== null ? (
                    <span className="text-muted-foreground">
                      {" "}
                      of {fmt(upstreamTotal)} published on Sharetribe
                    </span>
                  ) : null}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Last successful sync</div>
                <div>{when(integration.last_success_at) ?? "Not yet"}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Sync status</div>
                <div className={TONE_CLASS[statusInfo.tone]}>{statusInfo.text}</div>
              </div>
            </div>

            {syncing ? <SyncProgress progress={integration.sync_progress} /> : null}

            {integration.last_sync_error && (
              <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-200 flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  {userMessage(
                    integration.last_sync_error,
                    "The last sync didn't finish. Run a sync again, or contact support if it keeps happening.",
                  )}
                </span>
              </div>
            )}

            {gaps && gaps.published > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <div className="text-muted-foreground text-xs">Listings without a city</div>
                  <div className={gaps.missingCity ? "text-amber-400" : undefined}>{fmt(gaps.missingCity)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Listings without a category</div>
                  <div className={gaps.missingCategory ? "text-amber-400" : undefined}>
                    {fmt(gaps.missingCategory)}
                  </div>
                </div>
                {gaps.missingCity || gaps.missingCategory ? (
                  <p className="sm:col-span-2 text-xs text-muted-foreground">
                    A listing appears on city or category pages only when its public data in Sharetribe
                    names a city or a category. We never guess one.
                  </p>
                ) : null}
              </div>
            ) : null}

            <p className="text-xs text-muted-foreground">
              Listings are refreshed automatically about every 30 minutes. Listings that are no longer
              published on your marketplace are removed by the next sync that reads your whole
              catalogue; a sync that couldn't read everything keeps what it read and removes nothing.
            </p>

            <div className="rounded-md border p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 font-medium">
                  <Link2 className="h-4 w-4" /> Listing links
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onCheckLinks}
                  disabled={linkBusy || syncing || syncBusy || busy}
                >
                  {linkBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Check listing links
                </Button>
              </div>
              {linkCheck && linkLabel ? (
                <div className="space-y-1">
                  <div className={TONE_CLASS[linkLabel.tone]}>
                    {linkLabel.text}
                    {linkCheck.checkedAt ? (
                      <span className="text-muted-foreground"> · checked {when(linkCheck.checkedAt)}</span>
                    ) : null}
                  </div>
                  {linkCheck.result !== "ok" ? (
                    <p className="text-xs text-muted-foreground">
                      {userMessage(integration.certification_error, LINK_FALLBACK)} This is a warning;
                      it doesn&apos;t stop you publishing pages.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Not checked yet. We open one of your synced listings at the address your pages link
                  to, and confirm it is that listing.
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <Button onClick={onSync} disabled={syncDisabled}>
                {syncing || syncBusy ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                Sync now
              </Button>
              <Button variant="destructive" onClick={onDisconnect} disabled={busy || syncBusy || !isOwner}>
                <Trash2 className="h-4 w-4 mr-2" /> Disconnect
              </Button>
            </div>
            {syncing && !syncBusy ? (
              <p className="text-xs text-muted-foreground">
                A sync is running. Sync now is available again when it finishes.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Connect your marketplace</CardTitle>
            <CardDescription>
              Choose how founders.click should read your listings. The Marketplace API is the right
              choice for almost everyone. Connecting runs your first sync straight away.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <RadioGroup
              value={authMode}
              onValueChange={(v) => setAuthMode(v as AuthMode)}
              className="grid gap-3"
              disabled={!isOwner}
            >
              <label
                htmlFor="mode-marketplace"
                className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer ${
                  authMode === "marketplace" ? "border-primary bg-primary/5" : "border-border"
                }`}
              >
                <RadioGroupItem id="mode-marketplace" value="marketplace" className="mt-0.5" />
                <div className="space-y-1">
                  <div className="text-sm font-medium flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-500" />
                    Marketplace API
                    <Badge variant="secondary" className="text-[10px]">
                      Recommended
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Read-only access to public listing data. Needs only a Client ID — no secret.
                  </p>
                </div>
              </label>
              <label
                htmlFor="mode-integration"
                className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer ${
                  authMode === "integration" ? "border-primary bg-primary/5" : "border-border"
                }`}
              >
                <RadioGroupItem id="mode-integration" value="integration" className="mt-0.5" />
                <div className="space-y-1">
                  <div className="text-sm font-medium flex items-center gap-2">
                    <KeyRound className="h-4 w-4 text-amber-500" />
                    Integration API
                    <Badge variant="outline" className="text-[10px]">
                      Advanced
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Client ID + Client Secret. Full marketplace access — use it only if you already rely
                    on an Integration API application. We still read only public listing fields.
                  </p>
                </div>
              </label>
            </RadioGroup>

            {authMode === "marketplace" ? (
              <ol className="list-decimal pl-5 space-y-1 text-sm text-muted-foreground">
                <li>
                  Open your Sharetribe Console and go to <span className="text-foreground">Build → Applications</span>.
                </li>
                <li>
                  Create an application (any name works, e.g. <span className="text-foreground">founders.click</span>) and copy its{" "}
                  <span className="text-foreground">Client ID</span>.
                </li>
                <li>Paste it below, together with your marketplace address.</li>
              </ol>
            ) : (
              <ol className="list-decimal pl-5 space-y-1 text-sm text-muted-foreground">
                <li>
                  Open your Sharetribe Console and go to <span className="text-foreground">Build → Applications</span>.
                </li>
                <li>
                  Create an <span className="text-foreground">Integration API</span> application and copy its{" "}
                  <span className="text-foreground">Client ID</span> and <span className="text-foreground">Client Secret</span>.
                </li>
                <li>Paste both below, together with your marketplace address.</li>
              </ol>
            )}

            {authMode === "marketplace" ? (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-200 flex items-start gap-2">
                <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  This grants read-only access to the same public listing data your marketplace
                  already shows visitors. Nothing is written to your marketplace.
                </span>
              </div>
            ) : (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  An Integration API secret grants full read and write access to your marketplace.
                  Use it only if you need it. The secret is stored encrypted in Supabase Vault, is
                  never returned to the browser, and is deleted when you disconnect.
                </span>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="mu">Marketplace URL</Label>
              <Input
                id="mu"
                placeholder="https://your-marketplace.com"
                value={marketplaceUrl}
                onChange={(e) => setMarketplaceUrl(e.target.value)}
                disabled={!isOwner}
              />
              <p className="text-xs text-muted-foreground">
                The address visitors use to browse your marketplace. Used to link back to each
                listing. Connecting doesn't verify a domain — custom domains are verified separately,
                under Domains.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cid">Client ID</Label>
              <Input
                id="cid"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                disabled={!isOwner}
                autoComplete="off"
              />
            </div>
            {authMode === "integration" && (
              <div className="space-y-1.5">
                <Label htmlFor="cs">Client Secret</Label>
                <Input
                  id="cs"
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  disabled={!isOwner}
                  autoComplete="off"
                />
              </div>
            )}
            <Button onClick={onConnect} disabled={busy || !isOwner || !canSubmit} className="w-full">
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Validate &amp; Connect
            </Button>
            {busy ? (
              <p className="text-xs text-muted-foreground text-center">
                Checking your Client ID, then importing your published listings. This can take a
                minute for a large marketplace.
              </p>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
