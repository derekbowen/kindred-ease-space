import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { getMe } from "@/lib/auth.functions";
import { updateWorkspaceProfile } from "@/lib/workspace.functions";
import { WorkspaceBrandingCard } from "@/components/WorkspaceBrandingCard";

export const Route = createFileRoute("/_authenticated/app/settings")({
  head: () => ({ meta: [{ title: "Settings — founders.click" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const [me, setMe] = useState<Awaited<ReturnType<typeof getMe>> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const saveProfile = useServerFn(updateWorkspaceProfile);

  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getMe().then(setMe);
  }, [reloadKey]);

  const ws = me?.memberships?.[0]?.workspaces;

  // Seed the editable fields once the workspace loads.
  useEffect(() => {
    if (ws) {
      setName(ws.name ?? "");
      setDomain(ws.marketplace_domain ?? "");
    }
  }, [ws?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ws) return;
    setSaving(true);
    try {
      await saveProfile({ data: { workspaceId: ws.id, name, marketplaceDomain: domain } });
      toast.success("Saved.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold">Settings</h1>

      {ws && (
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
          <CardDescription>Your marketplace details. Optional — fill these in whenever you're ready.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ws-name">Workspace name</Label>
              <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Marketplace" minLength={2} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ws-domain">Marketplace domain</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="ws-domain"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="yourmarketplace.com"
                  className="flex-1"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {ws?.domain_verified_at ? (
                  <Badge variant="outline" className="text-emerald-500 border-emerald-500/30">Verified</Badge>
                ) : (
                  <Badge variant="outline">Not verified</Badge>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
              <Button type="button" variant="outline" asChild>
                <Link to="/app/settings/domains">Manage &amp; verify domains</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div><span className="text-muted-foreground">Email:</span> {me?.email}</div>
          <div><span className="text-muted-foreground">Name:</span> {me?.profile?.display_name ?? "—"}</div>
        </CardContent>
      </Card>
    </div>
  );
}
