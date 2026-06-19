import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { getMe } from "@/lib/auth.functions";
import { getAffiliateSettings, updateAffiliateSettings } from "@/lib/affiliates.functions";
import { runAffiliateSync } from "@/lib/affiliate-sync.functions";

export const Route = createFileRoute("/_authenticated/app/affiliates/settings")({
  head: () => ({ meta: [{ title: "Affiliate Settings — founders.click" }] }),
  component: AffiliateSettings,
});

function AffiliateSettings() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [formSlug, setFormSlug] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [param, setParam] = useState("referrerID");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const load = useServerFn(getAffiliateSettings);
  const save = useServerFn(updateAffiliateSettings);
  const sync = useServerFn(runAffiliateSync);

  useEffect(() => {
    getMe().then(async (me) => {
      const ws = me?.memberships?.[0]?.workspace_id ?? null;
      setWorkspaceId(ws);
      if (ws) {
        const r = await load({ data: { workspaceId: ws } });
        const s = r.settings;
        setFormSlug(s.form_slug ?? ""); setBaseUrl(s.marketplace_base_url ?? "");
        setCurrency(s.currency ?? "USD"); setParam(s.referrer_param ?? "referrerID");
      }
    }).catch(() => {});
  }, [load]);

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId) return;
    setSaving(true);
    try {
      await save({ data: { workspaceId, formSlug, marketplaceBaseUrl: baseUrl, currency, referrerParam: param } });
      toast.success("Settings saved.");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Could not save"); }
    finally { setSaving(false); }
  };

  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-2xl font-bold">Affiliate Settings</h1>

      <Card>
        <CardHeader><CardTitle className="text-base">Marketplace & links</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={onSave} className="space-y-4">
            <div className="space-y-1">
              <Label>Sign-up form slug</Label>
              <Input value={formSlug} onChange={(e) => setFormSlug(e.target.value)} placeholder="pool-rental-near-me" />
              <p className="text-xs text-muted-foreground">Public sign-up page: <span className="font-mono">/apply/{formSlug || "{slug}"}</span></p>
            </div>
            <div className="space-y-1">
              <Label>Marketplace base URL</Label>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://yourmarketplace.com" />
              <p className="text-xs text-muted-foreground">Affiliate links append <span className="font-mono">?{param}=CODE</span> to this URL.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>Currency</Label><Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} /></div>
              <div className="space-y-1"><Label>Referral URL parameter</Label><Input value={param} onChange={(e) => setParam(e.target.value)} /></div>
            </div>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save settings"}</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sharetribe referral sync</CardTitle>
          <CardDescription>
            Pulls transactions from your connected Sharetribe marketplace, attributes them to affiliates via the
            <span className="font-mono"> {param}</span> stored in the referred user's private data, and accrues payouts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            disabled={syncing}
            onClick={async () => {
              if (!workspaceId) return;
              setSyncing(true);
              try {
                const r = await sync({ data: { workspaceId } });
                if (r.ok) toast.success(`Synced: ${r.newTransactions} new transactions, ${r.attributed} attributed.`);
                else toast.error(r.error || "Sync failed");
              } catch (err) { toast.error(err instanceof Error ? err.message : "Sync failed"); }
              finally { setSyncing(false); }
            }}
          >
            {syncing ? "Syncing…" : "Run sync now"}
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">Requires the Sharetribe integration to be connected under Settings → Sharetribe.</p>
        </CardContent>
      </Card>
    </div>
  );
}
