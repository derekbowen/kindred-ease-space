import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Plug,
  RefreshCw,
  Trash2,
  ShieldCheck,
  KeyRound,
} from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import {
  getSharetribeIntegration,
  connectSharetribe,
  disconnectSharetribe,
  runSharetribeSync,
} from "@/lib/sharetribe-sync.functions";
import { InlineCoach } from "@/components/coach/InlineCoach";
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
  listings_count: number | null;
};

const CONNECT_FAILED =
  "Couldn't save your marketplace connection. Try again, or contact support if it keeps happening.";
const SYNC_FAILED =
  "Couldn't sync your listings. Try again in a minute, or contact support if it keeps happening.";
const DISCONNECT_FAILED =
  "Couldn't disconnect Sharetribe. Try again, or contact support if it keeps happening.";

const MODE_LABEL: Record<AuthMode, string> = {
  marketplace: "Marketplace API (read-only)",
  integration: "Integration API (advanced)",
};

/** Human wording for the last sync outcome — never a raw status code. */
function syncStatusLabel(row: IntegrationRow): { text: string; tone: "ok" | "warn" | "bad" | "muted" } {
  if (!row.last_sync_at) return { text: "Not synced yet", tone: "muted" };
  const when = new Date(row.last_sync_at).toLocaleString();
  switch (row.last_sync_status) {
    case "success":
      return { text: `Last synced ${when}`, tone: "ok" };
    case "warning":
      return { text: `Last synced ${when} with a warning`, tone: "warn" };
    case "failed":
      return { text: `Last sync failed ${when}`, tone: "bad" };
    default:
      return { text: `Last synced ${when}`, tone: "muted" };
  }
}

function SharetribeIntegrationPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(true);
  const [integration, setIntegration] = useState<IntegrationRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [authMode, setAuthMode] = useState<AuthMode>("marketplace");
  const [marketplaceUrl, setMarketplaceUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const fetchIntegration = useServerFn(getSharetribeIntegration);
  const connect = useServerFn(connectSharetribe);
  const disconnect = useServerFn(disconnectSharetribe);
  const sync = useServerFn(runSharetribeSync);
  const loadCtx = useServerFn(getSettingsContext);

  useEffect(() => {
    getMe().then((me) => {
      const wsId = me.memberships[0]?.workspace_id ?? null;
      setWorkspaceId(wsId);
      if (wsId) {
        loadCtx({ data: { workspaceId: wsId } })
          .then((c) => setIsOwner(c.isOwner))
          .catch(() => setIsOwner(me.memberships[0]?.role === "owner"));
      }
    });
  }, [loadCtx]);

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    fetchIntegration({ data: { workspaceId } })
      .then((r) => setIntegration(r.integration as IntegrationRow | null))
      .finally(() => setLoading(false));
  }, [workspaceId, fetchIntegration]);

  async function reload() {
    if (!workspaceId) return;
    const r = await fetchIntegration({ data: { workspaceId } });
    setIntegration(r.integration as IntegrationRow | null);
  }

  const canSubmit =
    marketplaceUrl.trim().length >= 8 &&
    clientId.trim().length >= 8 &&
    (authMode === "marketplace" || clientSecret.length >= 8);

  async function onConnect() {
    if (!workspaceId) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
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
        setMsg(
          r.marketplaceName
            ? `Connected to ${r.marketplaceName}. Run your first sync below.`
            : "Connected. Run your first sync below.",
        );
        setClientSecret("");
        await reload();
      } else {
        setErr(userMessage(r.error, CONNECT_FAILED));
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
    setSyncing(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await sync({ data: { workspaceId } });
      if (r.ok) {
        setMsg(
          `Synced ${r.upserted} listing${r.upserted === 1 ? "" : "s"}` +
            (r.removed ? ` and removed ${r.removed} that are no longer published.` : "."),
        );
      } else {
        setErr(userMessage(r.error, SYNC_FAILED));
      }
      await reload();
    } catch (e) {
      console.error("[sharetribe] sync failed", e);
      setErr(userMessage(e, SYNC_FAILED));
    } finally {
      setSyncing(false);
    }
  }

  async function onDisconnect() {
    if (!workspaceId) return;
    if (!confirm("Disconnect Sharetribe and delete all synced listings?")) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await disconnect({ data: { workspaceId } });
      if (r.ok) {
        setIntegration(null);
        setMsg("Disconnected. Your listings have been removed from founders.click.");
      } else {
        setErr(userMessage(r.error, DISCONNECT_FAILED));
        await reload();
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

  return (
    <div className="max-w-3xl space-y-6 pb-10">
      <SettingsNav />
      <OwnerOnlyBanner isOwner={isOwner} />
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Plug className="h-6 w-6" /> Sharetribe Integration
          </h1>
          <p className="text-muted-foreground mt-1">
            Connect your Sharetribe marketplace so we can import your published listings and build
            SEO pages around them.
          </p>
        </div>
        <InlineCoach
          workspaceId={workspaceId}
          context={{ route: "/app/settings/integrations/sharetribe" }}
          label="Ask coach about sync"
        />
      </header>

      {msg && (
        <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-300 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" /> {msg}
        </div>
      )}
      {err && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300 flex items-center gap-2">
          <AlertCircle className="h-4 w-4" /> {err}
        </div>
      )}

      {integration && statusInfo ? (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{integration.marketplace_name || "Connected"}</CardTitle>
              <Badge variant={integration.status === "connected" ? "default" : "destructive"}>
                {integration.status === "connected"
                  ? "Connected"
                  : integration.status === "error"
                    ? "Needs attention"
                    : "Pending"}
              </Badge>
            </div>
            <CardDescription>{integration.marketplace_url}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
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
                <div className="text-muted-foreground text-xs">Marketplace</div>
                <div>{integration.marketplace_name || "—"}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Listings imported</div>
                <div>{integration.listings_count ?? 0}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Sync status</div>
                <div
                  className={
                    statusInfo.tone === "ok"
                      ? "text-emerald-400"
                      : statusInfo.tone === "warn"
                        ? "text-amber-400"
                        : statusInfo.tone === "bad"
                          ? "text-red-400"
                          : "text-muted-foreground"
                  }
                >
                  {statusInfo.text}
                </div>
              </div>
            </div>
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
            <p className="text-xs text-muted-foreground">
              Listings are refreshed automatically about every 30 minutes. Listings that are no
              longer published on your marketplace are removed on the next sync.
            </p>
            <div className="flex gap-2 pt-2">
              <Button onClick={onSync} disabled={syncing || busy}>
                {syncing ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                Sync now
              </Button>
              <Button
                variant="destructive"
                onClick={onDisconnect}
                disabled={busy || syncing || !isOwner}
              >
                <Trash2 className="h-4 w-4 mr-2" /> Disconnect
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Connect your marketplace</CardTitle>
            <CardDescription>
              Choose how founders.click should read your listings. The Marketplace API is the right
              choice for almost everyone.
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
                    Client ID + Client Secret. Full marketplace access — only if you need it.
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
                  Use it only if you need features that require it. The secret is stored encrypted
                  in Supabase Vault, is never returned to the browser, and is deleted when you
                  disconnect.
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
                The address visitors use to browse your marketplace. Used to link back to each listing.
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
          </CardContent>
        </Card>
      )}
    </div>
  );
}
