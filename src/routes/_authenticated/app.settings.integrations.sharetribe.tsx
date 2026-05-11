import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, AlertCircle, Plug, RefreshCw, Trash2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import {
  getSharetribeIntegration,
  connectSharetribe,
  disconnectSharetribe,
  runSharetribeSync,
} from "@/lib/sharetribe-sync.functions";
import { InlineCoach } from "@/components/coach/InlineCoach";

export const Route = createFileRoute("/_authenticated/app/settings/integrations/sharetribe")({
  head: () => ({ meta: [{ title: "Sharetribe Integration — founders.click" }] }),
  component: SharetribeIntegrationPage,
});

type IntegrationRow = {
  id: string;
  marketplace_url: string;
  marketplace_id: string;
  client_id: string;
  status: string;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  listings_count: number | null;
};

function SharetribeIntegrationPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [integration, setIntegration] = useState<IntegrationRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [marketplaceUrl, setMarketplaceUrl] = useState("");
  const [marketplaceId, setMarketplaceId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const fetchIntegration = useServerFn(getSharetribeIntegration);
  const connect = useServerFn(connectSharetribe);
  const disconnect = useServerFn(disconnectSharetribe);
  const sync = useServerFn(runSharetribeSync);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);

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

  async function onConnect() {
    if (!workspaceId) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await connect({
        data: { workspaceId, marketplaceUrl, marketplaceId, clientId, clientSecret },
      });
      if (r.ok) {
        setMsg("Connected. Run an initial sync below.");
        setClientSecret("");
        await reload();
      } else {
        setErr(r.error);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to connect");
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
        setMsg(`Synced ${r.upserted} listings (${r.removed} removed).`);
        await reload();
      } else {
        setErr(r.error);
      }
    } finally {
      setSyncing(false);
    }
  }

  async function onDisconnect() {
    if (!workspaceId) return;
    if (!confirm("Disconnect Sharetribe and delete all synced listings?")) return;
    setBusy(true);
    try {
      await disconnect({ data: { workspaceId } });
      setIntegration(null);
      setMsg("Disconnected.");
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

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Plug className="h-6 w-6" /> Sharetribe Integration
        </h1>
        <p className="text-muted-foreground mt-1">
          Connect your Sharetribe Flex marketplace so we can sync listings and render SEO pages.
        </p>
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

      {integration ? (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Connected</CardTitle>
              <Badge
                variant={integration.status === "connected" ? "default" : "destructive"}
              >
                {integration.status}
              </Badge>
            </div>
            <CardDescription>{integration.marketplace_url}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-muted-foreground text-xs">Marketplace ID</div>
                <div className="font-mono">{integration.marketplace_id}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Client ID</div>
                <div className="font-mono truncate">{integration.client_id}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Listings synced</div>
                <div>{integration.listings_count ?? 0}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Last sync</div>
                <div>
                  {integration.last_sync_at
                    ? new Date(integration.last_sync_at).toLocaleString()
                    : "Never"}{" "}
                  {integration.last_sync_status && (
                    <span className="text-muted-foreground">({integration.last_sync_status})</span>
                  )}
                </div>
              </div>
            </div>
            {integration.last_sync_error && (
              <div className="rounded border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-300">
                {integration.last_sync_error}
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <Button onClick={onSync} disabled={syncing}>
                {syncing ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                Sync now
              </Button>
              <Button variant="destructive" onClick={onDisconnect} disabled={busy}>
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
              Get these values from your Sharetribe Console → Build → Integrations.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="mu">Marketplace URL</Label>
              <Input
                id="mu"
                placeholder="https://your-marketplace.sharetribe.com"
                value={marketplaceUrl}
                onChange={(e) => setMarketplaceUrl(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mid">Marketplace ID (UUID)</Label>
              <Input
                id="mid"
                placeholder="00000000-0000-0000-0000-000000000000"
                value={marketplaceId}
                onChange={(e) => setMarketplaceId(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cid">Integration API Client ID</Label>
              <Input
                id="cid"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cs">Integration API Client Secret</Label>
              <Input
                id="cs"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Stored encrypted in Supabase Vault. Never sent back to the browser.
              </p>
            </div>
            <Button onClick={onConnect} disabled={busy} className="w-full">
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Validate &amp; Connect
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
