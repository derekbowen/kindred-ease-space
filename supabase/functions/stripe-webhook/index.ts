import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { creditsForTier, resolvePlanTierFromPrice } from "../_shared/stripe-catalog.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
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
          await admin.from("credit_purchases").insert({
            workspace_id,
            stripe_session_id: s.id,
            stripe_payment_intent_id: s.payment_intent as string,
            credits,
            amount_cents: s.amount_total ?? 0,
            currency: s.currency ?? "usd",
            status: "completed",
          });
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
        const priceId = sub.items.data[0]?.price.id ?? null;
        const tier = sub.metadata?.plan_tier ?? await resolvePlanTierFromPrice(stripe, priceId);
        await admin.from("subscriptions").upsert({
          workspace_id,
          stripe_subscription_id: sub.id,
          stripe_price_id: priceId,
          plan_tier: tier,
          status: sub.status,
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          cancel_at_period_end: sub.cancel_at_period_end,
        }, { onConflict: "stripe_subscription_id" });
        break;
      }
      case "invoice.paid": {
        const inv = event.data.object as Stripe.Invoice;
        const subId = inv.subscription as string | null;
        if (!subId) break;
        const { data: sub } = await admin.from("subscriptions")
          .select("workspace_id, plan_tier").eq("stripe_subscription_id", subId).maybeSingle();
        if (!sub?.workspace_id) break;
        const credits = creditsForTier(sub.plan_tier);
        if (credits > 0) {
          await admin.rpc("grant_credits", {
            _workspace_id: sub.workspace_id,
            _amount: credits,
            _reason: "monthly_grant",
            _ref_type: "stripe_invoice",
            _ref_id: inv.id,
            _metadata: { plan_tier: sub.plan_tier },
          });
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await admin.from("subscriptions")
          .update({ status: "canceled", cancel_at_period_end: false })
          .eq("stripe_subscription_id", sub.id);
        break;
      }
    }
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (e) {
    console.error("webhook handler error", e);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
  }
});
