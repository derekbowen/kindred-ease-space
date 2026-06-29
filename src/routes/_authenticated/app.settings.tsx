import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { CheckCircle2, Plug, Sparkles, KeyRound } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { updateWorkspaceProfile } from "@/lib/workspace.functions";
import { getSettingsContext } from "@/lib/settings.functions";
import { WorkspaceBrandingCard } from "@/components/WorkspaceBrandingCard";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { OwnerOnlyBanner } from "@/components/settings/OwnerOnlyBanner";

export const Route = createFileRoute("/_authenticated/app/settings")({
  head: () => ({ meta: [{ title: "Settings — founders.click" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const [me, setMe] = useState<Awaited<ReturnType<typeof getMe>> | null>(null);
  const [ctx, setCtx] = useState<Awaited<ReturnType<typeof getSettingsContext>> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const saveProfile = useServerFn(updateWorkspaceProfile);
  const loadCtx = useServerFn(getSettingsContext);

  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [saving, setSaving] = useState(false);

  const workspaceId = me?.memberships?.[0]?.workspace_id ?? null;
  const ws = ctx?.workspace ?? me?.memberships?.[0]?.workspaces ?? null;
  const isOwner = ctx?.isOwner ?? me?.memberships?.[0]?.role === "owner";

  useEffect(() => {
    getMe().then(setMe);
  }, [reloadKey]);

  useEffect(() => {
    if (!workspaceId) return;
    loadCtx({ data: { workspaceId } }).then(setCtx).catch(() => setCtx(null));
  }, [workspaceId, loadCtx, reloadKey]);

  useEffect(() => {
    if (ws) {
      setName(ws.name ?? "");
      setDomain(ws.marketplace_domain ?? "");
    }
  }, [ws?.id, ws?.name, ws?.marketplace_domain]);

  const hasVerifiedDomain =
    Boolean(ws?.domain_verified_at) || (ctx?.domains ?? []).some((d) => d.verified);
  const domainConfigured = Boolean(domain.trim());

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ws || !isOwner) return;
    setSaving(true);
    try {
      await saveProfile({ data: { workspaceId: ws.id, name, marketplaceDomain: domain } });
      toast.success("Workspace saved.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Workspace profile, integrations, and API keys.
        </p>
      </div>

      <SettingsNav />
      <OwnerOnlyBanner isOwner={!!isOwner} />

      {ws && isOwner && (
        <WorkspaceBrandingCard
          workspaceId={ws.id}
          initial={{
            brand_name: ws.brand_name ?? null,
            brand_color: ws.brand_color ?? null,
            logo_url: ws.logo_url ?? null,
          }}
          onSaved={() => setReloadKey((k) => k + 1)}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
          <CardDescription>
            Your marketplace name and primary domain. Pages at <code>/p/{"{slug}"}</code> resolve on
            this hostname.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ws-name">Workspace name</Label>
              <Input
                id="ws-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Marketplace"
                minLength={2}
                disabled={!isOwner}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ws-domain">Marketplace domain</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="ws-domain"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="yourmarketplace.com"
                  className="flex-1 min-w-[200px]"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={!isOwner}
                />
                {hasVerifiedDomain ? (
                  <Badge variant="outline" className="gap-1 text-emerald-600 border-emerald-500/30">
                    <CheckCircle2 className="h-3 w-3" /> Verified
                  </Badge>
                ) : domainConfigured ? (
                  <Badge variant="outline">Configured</Badge>
                ) : (
                  <Badge variant="outline">Not set</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Use your bare domain (no https://). For DNS verification and SSL, use{" "}
                <Link to="/app/settings/domains" className="text-primary hover:underline">
                  Custom domains
                </Link>
                .
              </p>
            </div>
            {isOwner && (
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving…" : "Save workspace"}
                </Button>
                <Button type="button" variant="outline" asChild>
                  <Link to="/app/settings/domains">Manage domains</Link>
                </Button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatusCard
          title="Sharetribe"
          ok={ctx?.sharetribeConnected}
          detail={ctx?.sharetribeConnected ? "Connected" : "Not connected"}
          to="/app/settings/integrations/sharetribe"
          icon={Plug}
        />
        <StatusCard
          title="AI providers"
          ok={(ctx?.configuredAiProviders.length ?? 0) > 0}
          detail={
            ctx?.configuredAiProviders.length
              ? `${ctx.configuredAiProviders.length} configured`
              : "Platform quota only"
          }
          to="/app/settings/ai"
          icon={Sparkles}
        />
        <StatusCard
          title="API keys"
          ok={(ctx?.configuredSecretKeys.length ?? 0) > 0}
          detail={
            ctx?.configuredSecretKeys.length
              ? `${ctx.configuredSecretKeys.length} keys`
              : "None configured"
          }
          to="/app/settings/api-keys"
          icon={KeyRound}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>
            <span className="text-muted-foreground">Email:</span> {me?.email}
          </div>
          <div>
            <span className="text-muted-foreground">Name:</span> {me?.profile?.display_name ?? "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Role:</span> {ctx?.role ?? me?.memberships?.[0]?.role ?? "—"}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusCard({
  title,
  ok,
  detail,
  to,
  icon: Icon,
}: {
  title: string;
  ok?: boolean;
  detail: string;
  to: string;
  icon: typeof Plug;
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-start justify-between gap-2">
          <Icon className="h-4 w-4 text-muted-foreground mt-0.5" />
          <Badge variant={ok ? "default" : "secondary"} className="text-[10px]">
            {ok ? "OK" : "Setup"}
          </Badge>
        </div>
        <p className="mt-2 font-medium text-sm">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
        <Button asChild variant="link" size="sm" className="mt-2 h-auto p-0">
          <Link to={to}>Configure →</Link>
        </Button>
      </CardContent>
    </Card>
  );
}