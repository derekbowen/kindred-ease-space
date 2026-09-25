import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { GENERATION_DAILY_CAP } from "@/lib/generation-limits";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { getMe } from "@/lib/auth.functions";
import {
  getPageEntitlement,
  getBetaStatus,
  type PageEntitlement,
  type BetaStatus,
} from "@/lib/entitlements.functions";
import { PAGE_PLANS, PAGE_ADDON, EVERY_PLAN_INCLUDES, TRIAL_PAGE_LIMIT } from "@/lib/plan-catalog";
import { toast } from "sonner";
import { userMessage } from "@/lib/user-message";
import { describePlanStatus, formatPlanDate } from "@/components/billing/plan-status";

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
  const [beta, setBeta] = useState<BetaStatus | null>(null);
  const [addonQty, setAddonQty] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadBilling = useCallback(async (wsId: string) => {
    // The grant is read separately so the "what's free" section can say when
    // beta access ends; the entitlement only knows the page total.
    const [e, b] = await Promise.all([
      getPageEntitlement({ data: { workspaceId: wsId } }),
      getBetaStatus({ data: { workspaceId: wsId } }).catch(() => null),
    ]);
    setEnt(e);
    setBeta(b);
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
        const msg = userMessage(
          e,
          "Couldn't load your billing details. Refresh the page to try again.",
        );
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
      toast.error(
        userMessage(
          e,
          "Couldn't start checkout. Try again, or contact support if it keeps happening.",
        ),
      );
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
      toast.error(
        userMessage(
          e,
          "Couldn't open the billing portal. Try again, or contact support if it keeps happening.",
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  const hasPlan = Boolean(ent && !ent.isTrial && ent.planKey);
  // "Free beta" only when the grant IS the entitlement. A paying customer with a
  // promotional grant on top is not in a free beta and must not be told so.
  const inBeta = Boolean(beta?.beta && ent && ent.billingState === "granted");
  // Plan/trial wording from the server's own verdict (billingState): an
  // expired trial still reads subscription_status 'trialing', so the raw
  // status and "Trial ends <date>" are never printed for it.
  const planStatus = ent
    ? describePlanStatus({
        subscriptionStatus: ent.subscriptionStatus,
        trialEndsAt: ent.trialEndsAt,
        currentPeriodEnd: ent.currentPeriodEnd,
        planKey: ent.planKey,
        inBeta,
        betaExpiresAt: beta?.expiresAt ?? null,
        billingState: ent.billingState,
      })
    : null;
  const cheapest = PAGE_PLANS[0];
  const dearest = PAGE_PLANS[PAGE_PLANS.length - 1];
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
            <div className="text-2xl font-bold">{planStatus?.planLabel ?? "—"}</div>
            <div className="text-xs text-muted-foreground">
              {/* A trial has no price. `plan` is written as 'starter' at
                  provisioning, so showing its price here told every trial
                  user they were already paying $29/month. */}
              {planStatus?.kind === "paid" && ent?.monthlyPrice ? `$${ent.monthlyPrice}/month · ` : ""}
              {planStatus?.statusLine ?? ""}
            </div>
            {/* The date that matters for this state: a beta tenant's grant end
                (their trial date is irrelevant), a running trial's end, a live
                plan's renewal. An ended trial's date is in the line above. */}
            {planStatus?.dateLine && <div className="text-xs mt-1">{planStatus.dateLine}</div>}
            {/* When pages have stopped serving, the billing page is where the
                customer comes to find out why. Say it plainly rather than
                leaving them to infer it from a dead site. */}
            {ent && !ent.pagesServe && (
              <div className="text-xs mt-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive">
                {planStatus?.kind === "trial_ended"
                  ? "Your published pages are paused, not deleted. Choose a plan below and every page comes back at its original URL."
                  : `Your published pages are not being served. ${ent.billingReason}`}
              </div>
            )}
            {ent && ent.pagesServe && !ent.canPublish && (
              <div className="text-xs mt-2 rounded border border-amber-500/40 bg-amber-500/5 p-2">
                {ent.billingReason}
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
              <div className="mt-1 text-xs text-muted-foreground">{capacityParts.join(" + ")}</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>AI generation</CardTitle>
            <CardDescription>
              {inBeta ? "Included in your beta grant" : "Included with every plan"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {/* Nothing resets on a calendar: the trial seeds credits once, a
                beta grant is unmetered, and paid plans receive an additive
                grant on each invoice — so this card names no billing period.
                A beta tenant is bounded by the fair-use cap, not a balance,
                and the cap is a platform_settings knob, hence "currently". */}
            {inBeta ? (
              <>
                <div className="text-2xl font-bold">Included</div>
                <div className="text-xs text-muted-foreground">
                  AI page generation is part of your beta grant, within a fair-use cap (currently{" "}
                  {GENERATION_DAILY_CAP} generated pages per workspace per day).
                </div>
              </>
            ) : (
              <>
                <div className="text-2xl font-bold tabular-nums">
                  {ent?.aiBalance.toLocaleString() ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground">generation credits available</div>
              </>
            )}
            {/* Credits are INTERNAL metering, not a SKU. Selling them here
                contradicted the product decision that capacity is what the
                customer buys (docs/SOURCE_OF_TRUTH.md), and gave the billing
                page two competing units. The balance is still worth showing
                — it is what the plan includes — but it is not for sale.
                More capacity is bought as pages, below. */}
            <div className="text-xs text-muted-foreground pt-1">
              Included with your plan. Need more pages? Upgrade below.
            </div>
          </CardContent>
        </Card>
      </div>

      {/* The numbers here come from plan-catalog and the live grant, never
          from prose, so this section cannot drift from what checkout charges. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">What's free, what costs money</CardTitle>
          <CardDescription>
            Plain answers, so nothing about your bill is a surprise.{" "}
            <Link to="/beta" className="underline underline-offset-2 hover:text-foreground">
              Full beta terms
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm md:grid-cols-3">
          <div>
            <div className="font-medium">What's free</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {inBeta
                ? `Your beta grant: ${beta!.pageLimit.toLocaleString()} published page${
                    beta!.pageLimit === 1 ? "" : "s"
                  } at no charge, ${
                    beta!.expiresAt
                      ? `until ${formatPlanDate(beta!.expiresAt)}`
                      : "with no end date set"
                  }.`
                : `The trial: up to ${TRIAL_PAGE_LIMIT} published pages, no card required.`}{" "}
              Drafts are always free and unlimited.{" "}
              {inBeta
                ? `AI page generation is included with your beta grant, within a fair-use cap (currently ${GENERATION_DAILY_CAP} generated pages per workspace per day).`
                : `AI page generation is included with every plan, within a fair-use cap (currently ${GENERATION_DAILY_CAP} generated pages per workspace per day); the trial starts with a starter allowance.`}
            </p>
          </div>
          <div>
            <div className="font-medium">What costs money</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Only a paid plan, and only if you choose one: ${cheapest.monthlyPrice} to $
              {dearest.monthlyPrice} per month for {cheapest.includedPages.toLocaleString()} to{" "}
              {dearest.includedPages.toLocaleString()} published pages, plus optional extra capacity
              at ${PAGE_ADDON.monthlyPrice}/month per {PAGE_ADDON.pagesPerUnit.toLocaleString()}{" "}
              pages. Optional add-ons (Affiliate Programs, DM Champ) are priced separately on the
              Add-ons page and only start after a checkout you complete. Nothing is charged
              without a checkout you complete yourself.
            </p>
          </div>
          <div>
            <div className="font-medium">When access ends</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {inBeta
                ? "If your beta grant ends without a plan, "
                : "When the trial ends without a plan, "}
              published pages pause (they stop being served) — nothing is deleted. Drafts and
              settings are kept, you can export your data at any time, and picking a plan later
              brings every page back at its original URL.
            </p>
          </div>
        </CardContent>
      </Card>

      <div>
        <h2 className="text-lg font-semibold mb-1">Plans</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Every plan unlocks every core feature — pick one for how many pages you publish. Add-ons
          are priced separately.
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
                    onClick={() => (hasPlan ? openPortal() : checkout("subscription", 1, p.key))}
                  >
                    {isCurrent
                      ? "Current plan"
                      : hasPlan
                        ? "Switch via portal"
                        : `Choose ${p.name}`}
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
