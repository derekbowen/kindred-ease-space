import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { getMe } from "@/lib/auth.functions";
import { WorkspaceBrandingCard } from "@/components/WorkspaceBrandingCard";

export const Route = createFileRoute("/_authenticated/app/settings")({
  head: () => ({ meta: [{ title: "Settings — founders.click" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const [me, setMe] = useState<Awaited<ReturnType<typeof getMe>> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    getMe().then(setMe);
  }, [reloadKey]);

  const ws = me?.memberships?.[0]?.workspaces;

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
          <CardDescription>Basic details about your marketplace.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Workspace name</Label>
            <Input defaultValue={ws?.name ?? ""} disabled />
          </div>
          <div className="space-y-2">
            <Label>Marketplace domain</Label>
            <div className="flex items-center gap-2">
              <Input defaultValue={ws?.marketplace_domain ?? ""} disabled className="flex-1" />
              {ws?.domain_verified_at ? (
                <Badge variant="outline" className="text-emerald-500 border-emerald-500/30">Verified</Badge>
              ) : (
                <Badge variant="outline">Not verified</Badge>
              )}
            </div>
          </div>
          <Button
            variant="outline"
            disabled
            onClick={() => toast.info("Domain verification ships next.")}
          >
            Verify with DNS TXT
          </Button>
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
