import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/app/billing")({
  head: () => ({ meta: [{ title: "Billing & Credits — founders.click" }] }),
  component: BillingPage,
});

const TIERS = [
  { key: "starter", name: "Starter", price: 99, credits: 500, features: ["AI Page Builder", "Bulk Editor", "GSC sync", "1 marketplace"] },
  { key: "pro", name: "Pro", price: 249, credits: 2500, featured: true, features: ["Everything in Starter", "Competitor Radar", "Rank Tracker", "Lead Inbox", "3 marketplaces"] },
  { key: "scale", name: "Scale", price: 599, credits: 10000, features: ["Everything in Pro", "IG Lead Hunter", "Email Verify", "SEO Coach AI", "Unlimited marketplaces"] },
] as const;

function BillingPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [balance, setBalance] = useState<number>(0);
  const [sub, setSub] = useState<{ plan_tier: string; status: string; current_period_end: string | null } | null>(null);
  const [config, setConfig] = useState<Record<string, string | null>>({});
  const [packQty, setPackQty] = useState(1);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: ws } = await supabase.from("workspaces").select("id").limit(1).maybeSingle();
      if (!ws) return;
      setWorkspaceId(ws.id);
      const [{ data: bal }, { data: subRow }, { data: cfg }] = await Promise.all([
        supabase.from("credit_balances").select("balance").eq("workspace_id", ws.id).maybeSingle(),
        supabase.from("subscriptions").select("plan_tier, status, current_period_end").eq("workspace_id", ws.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("billing_config").select("starter_price_id, pro_price_id, scale_price_id, credit_pack_price_id").eq("id", 1).maybeSingle(),
      ]);
      setBalance(bal?.balance ?? 0);
      setSub(subRow);
      setConfig((cfg ?? {}) as Record<string, string | null>);
    })();
  }, []);

  async function checkout(mode: "subscription" | "credits", priceId: string | null | undefined, quantity = 1) {
    if (!workspaceId) return toast.error("No workspace");
    if (!priceId) return toast.error("Stripe price ID not configured. Set in Settings → Billing.");
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("create-checkout", {
        body: { workspace_id: workspaceId, mode, price_id: priceId, quantity },
      });
      if (error) throw error;
      if (data?.url) window.location.href = data.url;
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function openPortal() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("customer-portal", {
        body: { workspace_id: workspaceId },
      });
      if (error) throw error;
      if (data?.url) window.location.href = data.url;
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Billing & Credits</h1>
        <p className="text-sm text-muted-foreground">Pick a plan. Top up extra credits at $10 per 1,000.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader><CardTitle>Current plan</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold capitalize">{sub?.plan_tier ?? "Trial"}</div>
            <div className="text-xs text-muted-foreground">{sub?.status ?? "trialing"}</div>
            {sub?.current_period_end && (
              <div className="text-xs mt-1">Renews {new Date(sub.current_period_end).toLocaleDateString()}</div>
            )}
            <Button size="sm" variant="outline" className="mt-3" onClick={openPortal} disabled={loading || !sub}>
              Manage billing
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Credit balance</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{balance.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground">credits available</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Top up credits</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-2">
              <Input type="number" min={1} value={packQty} onChange={(e) => setPackQty(Math.max(1, +e.target.value))} className="w-20" />
              <span className="text-sm">× 1,000 credits ($10/pack)</span>
            </div>
            <Button size="sm" className="w-full" onClick={() => checkout("credits", config.credit_pack_price_id, packQty)} disabled={loading}>
              Buy {(packQty * 1000).toLocaleString()} credits
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {TIERS.map((p) => {
          const priceId = config[`${p.key}_price_id` as keyof typeof config] as string | null | undefined;
          const isCurrent = sub?.plan_tier === p.key;
          return (
            <Card key={p.name} className={p.featured ? "border-orange-500/50" : ""}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>{p.name}</CardTitle>
                  {p.featured && <Badge className="bg-orange-500">Popular</Badge>}
                </div>
                <div className="pt-2">
                  <span className="text-3xl font-bold">${p.price}</span>
                  <span className="text-sm text-muted-foreground">/mo</span>
                </div>
                <CardDescription>{p.credits.toLocaleString()} AI credits / month</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {p.features.map((f) => <li key={f}>• {f}</li>)}
                </ul>
                <Button
                  className="w-full mt-4"
                  variant={p.featured ? "default" : "outline"}
                  disabled={loading || isCurrent}
                  onClick={() => checkout("subscription", priceId)}
                >
                  {isCurrent ? "Current plan" : `Choose ${p.name}`}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        <Link to="/app" className="hover:text-foreground">← Back to dashboard</Link>
      </p>
    </div>
  );
}
