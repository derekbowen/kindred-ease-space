import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  creditsForTier,
  resolvePlanTierFromPrice,
  ADDON_CATALOG,
  isAddonKey,
} from "../_shared/stripe-catalog.ts";

Deno.serve(async (req) => {
  // Initialize per-request, not at module scope. A missing/rotated
  // STRIPE_SECRET_KEY at module scope crashes worker cold-start with an
  // opaque error instead of returning a clean 500 per request.
  const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const sig = req.headers.get("stripe-signature");
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const body = await req.text();

  let event: Stripe.Event;
  try {
    if (!sig || !secret) throw new Error("missing signature/secret");
    event = await stripe.webhooks.constructEventAsync(body, sig, secret);
  } catch (e) {
    console.error("webhook verify failed", e);
    return new Response(JSON.stringify({ error: "Invalid webhook signature" }), { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const workspace_id = s.metadata?.workspace_id;
        const mode = s.metadata?.mode;
        if (!workspace_id) break;

        if (mode === "credits") {
          const lineItems = await stripe.checkout.sessions.listLineItems(s.id);
          const qty = lineItems.data[0]?.quantity ?? 1;
          const creditsPerPack = Number(s.metadata?.credits_per_pack ?? 1000);
          const credits = creditsPerPack * qty;
          const { error: purchaseErr } = await admin.from("credit_purchases").insert({
            workspace_id,
            stripe_session_id: s.id,
            stripe_payment_intent_id: s.payment_intent as string,
            credits,
            amount_cents: s.amount_total ?? 0,
            currency: s.currency ?? "usd",
            status: "completed",
          });
          if (purchaseErr) {
            // Duplicate webhook delivery hits the unique stripe_session_id constraint.
            if (purchaseErr.code === "23505") break;
            throw purchaseErr;
          }
          await admin.rpc("grant_credits", {
            _workspace_id: workspace_id,
            _amount: credits,
            _reason: "topup_purchase",
            _ref_type: "stripe_session",
            _ref_id: s.id,
            _metadata: {},
          });
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const workspace_id = sub.metadata?.workspace_id;
        if (!workspace_id) break;

        // Add-on subscriptions set entitlement instead of plan credits.
        const addonKey = sub.metadata?.addon_key;
        if (addonKey && isAddonKey(addonKey)) {
          const entitled = ["active", "trialing", "past_due"].includes(sub.status);
          if (addonKey.startsWith("affiliate")) {
            await admin.from("workspace_affiliate_settings").upsert(
              {
                workspace_id,
                addon_status:
                  sub.status === "trialing" ? "trialing" : entitled ? "active" : "canceled",
                addon_tier: sub.metadata?.addon_tier || "standard",
              },
              { onConflict: "workspace_id" },
            );
          } else {
            const status = entitled ? "active" : "canceled";
            const { data: existing } = await admin
              .from("addon_requests")
              .select("id")
              .eq("workspace_id", workspace_id)
              .eq("addon_key", addonKey)
              .limit(1)
              .maybeSingle();
            if (existing) {
              await admin.from("addon_requests").update({ status }).eq("id", existing.id);
            } else {
              await admin.from("addon_requests").insert({
                workspace_id,
                addon_key: addonKey,
                addon_name: ADDON_CATALOG[addonKey].name,
                price_cents: ADDON_CATALOG[addonKey].priceCents,
                status,
              });
            }
          }
          break;
        }

        const priceId = sub.items.data[0]?.price.id ?? null;
        const tier = sub.metadata?.plan_tier ?? (await resolvePlanTierFromPrice(stripe, priceId));
        // current_period_end can be absent on some subscription states; guard
        // against new Date(NaN) which would throw and force endless Stripe retries.
        const periodEnd =
          typeof sub.current_period_end === "number"
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null;
        await admin.from("subscriptions").upsert(
          {
            workspace_id,
            stripe_subscription_id: sub.id,
            stripe_price_id: priceId,
            plan_tier: tier,
            status: sub.status,
            current_period_end: periodEnd,
            cancel_at_period_end: sub.cancel_at_period_end,
          },
          { onConflict: "stripe_subscription_id" },
        );
        await admin
          .from("workspaces")
          .update({
            plan: tier,
            subscription_status: sub.status,
            current_period_end: periodEnd,
          })
          .eq("id", workspace_id);
        break;
      }
      case "invoice.paid": {
        const inv = event.data.object as Stripe.Invoice;
        const subId = inv.subscription as string | null;
        if (!subId) break;

        // Resolve workspace + tier from our local row, but fall back to Stripe
        // directly when the subscription.created event hasn't been processed yet
        // (Stripe does not guarantee event ordering) — otherwise the first
        // month's credits would be silently lost.
        let workspace_id: string | null = null;
        let plan_tier: string | null = null;
        const { data: sub } = await admin
          .from("subscriptions")
          .select("workspace_id, plan_tier")
          .eq("stripe_subscription_id", subId)
          .maybeSingle();
        if (sub?.workspace_id) {
          workspace_id = sub.workspace_id;
          plan_tier = sub.plan_tier;
        } else {
          const stripeSub = await stripe.subscriptions.retrieve(subId);
          // Add-on subscriptions don't grant credits.
          if (stripeSub.metadata?.addon_key) break;
          workspace_id = stripeSub.metadata?.workspace_id ?? null;
          const priceId = stripeSub.items.data[0]?.price.id ?? null;
          plan_tier =
            stripeSub.metadata?.plan_tier ?? (await resolvePlanTierFromPrice(stripe, priceId));
        }
        if (!workspace_id) break;

        // Skip proration/update invoices — only grant on normal cycle or first invoice.
        const billingReason = inv.billing_reason;
        if (
          billingReason &&
          billingReason !== "subscription_cycle" &&
          billingReason !== "subscription_create"
        ) {
          break;
        }

        const credits = creditsForTier(plan_tier);
        if (credits > 0) {
          // grant_credits is idempotent on (_reason, _ref_type, _ref_id), so a
          // redelivered invoice.paid will not double-grant.
          await admin.rpc("grant_credits", {
            _workspace_id: workspace_id,
            _amount: credits,
            _reason: "monthly_grant",
            _ref_type: "stripe_invoice",
            _ref_id: inv.id,
            _metadata: { plan_tier },
          });
        } else {
          console.warn(`invoice.paid: tier "${plan_tier}" resolved to 0 credits for sub ${subId}`);
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const addonKey = sub.metadata?.addon_key;
        const workspace_id = sub.metadata?.workspace_id;
        if (addonKey && isAddonKey(addonKey) && workspace_id) {
          if (addonKey.startsWith("affiliate")) {
            await admin
              .from("workspace_affiliate_settings")
              .update({ addon_status: "canceled" })
              .eq("workspace_id", workspace_id);
          } else {
            await admin
              .from("addon_requests")
              .update({ status: "canceled" })
              .eq("workspace_id", workspace_id)
              .eq("addon_key", addonKey);
          }
          break;
        }
        await admin
          .from("subscriptions")
          .update({ status: "canceled", cancel_at_period_end: false })
          .eq("stripe_subscription_id", sub.id);
        const workspace_id = sub.metadata?.workspace_id;
        if (workspace_id) {
          await admin
            .from("workspaces")
            .update({
              subscription_status: "canceled",
            })
            .eq("id", workspace_id);
        }
        break;
      }
    }
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (e) {
    console.error("webhook handler error", e);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
  }
});
