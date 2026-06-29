import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { getMe } from "@/lib/auth.functions";
import { toast } from "sonner";

const billingSearchSchema = z.object({
  success: z.coerce.string().optional(),
  canceled: z.coerce.string().optional(),
  session_id: z.string().optional(),
});

export const Route = createFileRoute("/_authenticated/app/billing")({
  head: () => ({ meta: [{ title: "Billing & Credits — founders.click" }] }),
  validateSearch: billingSearchSchema,
  component: BillingPage,
});

type Tier = { key: "starter" | "pro" | "scale"; name: string; price: number; credits: number; featured?: boolean; features: string[] };
const TIERS: Tier[] = [
  { key: "starter", name: "Starter", price: 99, credits: 500, features: ["AI Page Builder", "Bulk Editor", "GSC sync", "1 marketplace"] },
  { key: "pro", name: "Pro", price: 249, credits: 2500, featured: true, features: ["Everything in Starter", "Competitor Radar", "Rank Tracker", "Lead Inbox", "3 marketplaces"] },
  { key: "scale", name: "Scale", price: 599, credits: 10000, features: ["Everything in Pro", "IG Lead Hunter", "Email Verify", "SEO Coach AI", "Unlimited marketplaces"] },
];

function BillingPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/_authenticated/app/billing" });
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [balance, setBalance] = useState<number>(0);
  const [sub, setSub] = useState<{ plan_tier: string; status: string; current_period_end: string | null } | null>(null);
  const [packQty, setPackQty] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadBilling = useCallback(async (wsId: string) => {
    const [{ data: bal, error: balErr }, { data: subRow, error: subErr }] = await Promise.all([
      supabase.from("credit_balances").select("balance").eq("workspace_id", wsId).maybeSingle(),
      supabase.from("subscriptions").select("plan_tier, status, current_period_end").eq("workspace_id", wsId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (balErr) throw balErr;
    if (subErr) throw subErr;
    setBalance(bal?.balance ?? 0);
    setSub(subRow);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const me = await getMe();
        const wsId = me.memberships?.[0]?.workspace_id ?? null;
        if (!wsId) {
          setLoadError("No workspace found for your account.");
          return;
        }
        setWorkspaceId(wsId);
        await loadBilling(wsId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to load billing";
        setLoadError(msg);
        toast.error(msg);
      }
    })();
  }, [loadBilling]);

  useEffect(() => {
    if (search.success) {
      toast.success("Payment received — your plan or credits will update shortly.");
      if (workspaceId) loadBilling(workspaceId).catch(() => {});
      navigate({ to: "/app/billing", search: {}, replace: true });
    } else if (search.canceled) {
      toast.info("Checkout canceled.");
      navigate({ to: "/app/billing", search: {}, replace: true });
    }
  }, [search.success, search.canceled, workspaceId, loadBilling, navigate]);

  async function checkout(mode: "subscription" | "credits", quantity = 1, tier?: Tier["key"]) {
    if (!workspaceId) return toast.error("No workspace");
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("create-checkout", {
        body: { workspace_id: workspaceId, mode, quantity, tier },
      });
      if (error) throw error;
      if (data?.url) window.location.href = data.url;
      else throw new Error("No checkout URL returned");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Checkout failed");
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
      else throw new Error("No checkout URL returned");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Checkout failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Billing & Credits</h1>
        <p className="text-sm text-muted-foreground">Pick a plan. Top up extra credits at $10 per 1,000.</p>
        {loadError && <p className="text-sm text-destructive mt-2">{loadError}</p>}
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
            <Button size="sm" className="w-full" onClick={() => checkout("credits", packQty)} disabled={loading}>
              Buy {(packQty * 1000).toLocaleString()} credits
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {TIERS.map((p) => {
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
                  onClick={() => checkout("subscription", 1, p.key)}
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
