import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { getMe } from "@/lib/auth.functions";
import { getPageEntitlement, type PageEntitlement } from "@/lib/entitlements.functions";
import { PAGE_PLANS, PAGE_ADDON, EVERY_PLAN_INCLUDES } from "@/lib/plan-catalog";
import { toast } from "sonner";

const billingSearchSchema = z.object({
  success: z.coerce.string().optional(),
  canceled: z.coerce.string().optional(),
  session_id: z.string().optional(),
});

export const Route = createFileRoute("/_authenticated/app/billing")({
  head: () => ({ meta: [{ title: "Billing — founders.click" }] }),
  validateSearch: billingSearchSchema,
  component: BillingPage,
});

function BillingPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/_authenticated/app/billing" });
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [ent, setEnt] = useState<PageEntitlement | null>(null);
  const [addonQty, setAddonQty] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadBilling = useCallback(async (wsId: string) => {
    const e = await getPageEntitlement({ data: { workspaceId: wsId } });
    setEnt(e);
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

  // Returning from Stripe: the webhook that activates the plan lags the
  // redirect by a few seconds — refetch twice once the workspace is known.
  const [pendingRefresh, setPendingRefresh] = useState(false);
  useEffect(() => {
    if (search.success) {
      toast.success("Payment received — your plan will activate in a few seconds.");
      setPendingRefresh(true);
      navigate({ to: "/app/billing", search: {}, replace: true });
    } else if (search.canceled) {
      toast.info("Checkout canceled.");
      navigate({ to: "/app/billing", search: {}, replace: true });
    }
  }, [search.success, search.canceled, navigate]);
  useEffect(() => {
    if (!pendingRefresh || !workspaceId) return;
    loadBilling(workspaceId).catch(() => {});
    const timer = setTimeout(() => {
      loadBilling(workspaceId).catch(() => {});
      setPendingRefresh(false);
    }, 5000);
    return () => clearTimeout(timer);
  }, [pendingRefresh, workspaceId, loadBilling]);

  async function checkout(
    // "credits" is deliberately absent: AI credit packs were withdrawn as a
    // customer-facing SKU and create-checkout answers 410 for them. Leaving the
    // literal in this union kept a removed product one call site from returning.
    mode: "subscription" | "page_addon",
    quantity = 1,
    tier?: string,
  ) {
    if (!workspaceId) return toast.error("No workspace");
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("create-checkout", {
        body: { workspace_id: workspaceId, mode, quantity, tier },
      });
      if (error) throw error;
      if (data?.url) window.location.href = data.url;
      else if (data?.message) throw new Error(data.message);
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
      else throw new Error("Couldn't open the billing portal");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't open the billing portal");
    } finally {
      setLoading(false);
    }
  }

  const hasPlan = Boolean(ent && !ent.isTrial && ent.planKey);
  const usagePct = ent && ent.pageLimit > 0 ? (ent.publishedPages / ent.pageLimit) * 100 : 0;
  const usageTone =
    usagePct >= 100 ? "text-red-500" : usagePct >= 90 ? "text-amber-500" : "text-emerald-500";
  const barTone = usagePct >= 100 ? "bg-red-500" : usagePct >= 90 ? "bg-amber-500" : "bg-primary";

  // Only ever break capacity into parts that are ACTUALLY IN FORCE. The stored
  // columns outlive a lapsed subscription, so printing "100 plan + 50 extra
  // capacity" beside a limit of 0 tells the customer they have capacity they do
  // not have — the same mistake, in the UI, that this release fixed in the gate.
  // `pageLimit` is the one number that decides anything; this only explains it.
  const capacityParts: string[] = [];
  if (ent?.canPublish) {
    if (ent.billingState !== "granted") {
      // 'granted' means Stripe refused and the grant is the whole allowance, so
      // the paid columns contribute nothing and must not be listed.
      if (ent.pageLimitAddon > 0) {
        capacityParts.push(`${ent.pageLimitBase.toLocaleString()} plan`);
        capacityParts.push(`${ent.pageLimitAddon.toLocaleString()} extra capacity`);
      }
      if (ent.pageLimitBonus > 0) {
        capacityParts.push(`${ent.pageLimitBonus.toLocaleString()} bonus`);
      }
    }
    if (ent.pageLimitGranted > 0) {
      capacityParts.push(`${ent.pageLimitGranted.toLocaleString()} complimentary`);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Your plan is publishing capacity — pages stay live while your subscription is active.
        </p>
        {loadError && <p className="text-sm text-destructive mt-2">{loadError}</p>}
      </div>

      {ent && usagePct >= 80 && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            usagePct >= 100
              ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
              : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          }`}
        >
          {usagePct >= 100
            ? `You've reached your ${ent.pageLimit.toLocaleString()}-page publishing limit. Upgrade your plan to publish additional pages.`
            : `You've published ${ent.publishedPages.toLocaleString()} of your ${ent.pageLimit.toLocaleString()} included pages.`}
        </div>
      )}

      {ent && ent.suspendedPages > 0 && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {ent.suspendedPages.toLocaleString()} of your pages are unpublished because the
          subscription is inactive. Your content is safe — reactivate your plan and every page
          returns at its original URL.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Current plan</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{ent?.isTrial ? "Free trial" : (ent?.planName ?? "—")}</div>
            <div className="text-xs text-muted-foreground capitalize">
              {/* A trial has no price. `plan` is written as 'starter' at
                  provisioning, so showing its price here told every trial
                  user they were already paying $29/month. */}
              {!ent?.isTrial && ent?.monthlyPrice ? `$${ent.monthlyPrice}/month · ` : ""}
              {ent?.subscriptionStatus ?? ""}
            </div>
            {ent?.isTrial && ent?.trialEndsAt && (
              <div className="text-xs mt-1">
                Trial ends {new Date(ent.trialEndsAt).toLocaleDateString()}
              </div>
            )}
            {!ent?.isTrial && ent?.currentPeriodEnd && (
              <div className="text-xs mt-1">
                Renews {new Date(ent.currentPeriodEnd).toLocaleDateString()}
              </div>
            )}
            {/* When pages have stopped serving, the billing page is where the
                customer comes to find out why. Say it plainly rather than
                leaving them to infer it from a dead site. */}
            {ent && !ent.pagesServe && (
              <div className="text-xs mt-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive">
                Your published pages are not being served. {ent.billingReason}
              </div>
            )}
            {ent && ent.pagesServe && !ent.canPublish && (
              <div className="text-xs mt-2 rounded border border-amber-500/40 bg-amber-500/5 p-2">
                {ent.billingReason}
              </div>
            )}
            {ent?.isTrial && ent?.trialEndsAt && (
              <div className="text-xs mt-1">
                Trial ends {new Date(ent.trialEndsAt).toLocaleDateString()}
              </div>
            )}
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={openPortal}
              disabled={loading || !hasPlan}
            >
              Manage billing
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Page usage</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-1">
              <span className={`text-2xl font-bold tabular-nums ${usageTone}`}>
                {ent?.publishedPages.toLocaleString() ?? "—"}
              </span>
              <span className="text-sm text-muted-foreground">
                / {ent?.pageLimit.toLocaleString() ?? "—"} pages published
              </span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${barTone}`}
                style={{ width: `${Math.min(usagePct, 100)}%` }}
              />
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              {ent ? `${ent.remaining.toLocaleString()} publishing slots remaining` : ""}
              {ent && ent.draftPages > 0 && ` · ${ent.draftPages.toLocaleString()} drafts (free)`}
            </div>
            {capacityParts.length > 0 && (
              <div className="mt-1 text-xs text-muted-foreground">
                {capacityParts.join(" + ")}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>AI generation</CardTitle>
            <CardDescription>Included with every plan</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-2xl font-bold tabular-nums">
              {ent?.aiBalance.toLocaleString() ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground">
              generation credits remaining this month
            </div>
            {/* Credits are INTERNAL metering, not a SKU. Selling them here
                contradicted the product decision that capacity is what the
                customer buys (docs/SOURCE_OF_TRUTH.md), and gave the billing
                page two competing units. The allowance is still worth showing
                — it is what the plan includes — but it is not for sale.
                More capacity is bought as pages, below. */}
            <div className="text-xs text-muted-foreground pt-1">
              Included with your plan. Need more pages? Upgrade below.
            </div>
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-1">Plans</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Every plan unlocks every feature — pick one for how many pages you publish.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {PAGE_PLANS.map((p) => {
            const isCurrent = hasPlan && ent?.planKey === p.key;
            return (
              <Card key={p.key} className={p.featured ? "border-orange-500/50" : ""}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{p.name}</CardTitle>
                    {p.featured && <Badge className="bg-orange-500">Popular</Badge>}
                  </div>
                  <div className="pt-1">
                    <span className="text-2xl font-bold">${p.monthlyPrice}</span>
                    <span className="text-xs text-muted-foreground">/mo</span>
                  </div>
                  <CardDescription className="text-orange-500 font-medium">
                    {p.includedPages.toLocaleString()} published pages
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground min-h-8">{p.blurb}</p>
                  <Button
                    className="w-full mt-3"
                    size="sm"
                    variant={p.featured ? "default" : "outline"}
                    disabled={loading || isCurrent}
                    onClick={() =>
                      hasPlan
                        ? openPortal()
                        : checkout("subscription", 1, p.key)
                    }
                  >
                    {isCurrent ? "Current plan" : hasPlan ? "Switch via portal" : `Choose ${p.name}`}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Every plan includes: {EVERY_PLAN_INCLUDES.join(" · ")}
        </p>
      </div>

      {hasPlan && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Need more pages without changing plans?</CardTitle>
            <CardDescription>
              Add recurring page capacity on top of your plan — ${PAGE_ADDON.monthlyPrice}/month per{" "}
              {PAGE_ADDON.pagesPerUnit.toLocaleString()} pages.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={10}
              value={addonQty}
              onChange={(e) => setAddonQty(Math.max(1, Math.min(10, +e.target.value)))}
              className="w-16 h-8"
            />
            <Button
              size="sm"
              onClick={() => checkout("page_addon", addonQty)}
              disabled={loading || (ent?.pageLimitAddon ?? 0) > 0}
            >
              Add {(addonQty * PAGE_ADDON.pagesPerUnit).toLocaleString()} pages ($
              {addonQty * PAGE_ADDON.monthlyPrice}/mo)
            </Button>
            {(ent?.pageLimitAddon ?? 0) > 0 && (
              <span className="text-xs text-muted-foreground">
                You have extra capacity active — adjust it in Manage billing.
              </span>
            )}
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        <Link to="/app" className="hover:text-foreground">
          ← Back to dashboard
        </Link>
      </p>
    </div>
  );
}
