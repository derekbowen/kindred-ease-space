import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  creditsForTier,
  pagesForTier,
  PAGE_ADDON,
  ADDON_CATALOG,
  isAddonKey,
} from "../_shared/stripe-catalog.ts";

// Stripe is payment truth; this webhook projects it into the entitlement state
// the app runs on (workspaces.page_limit_* + subscriptions + credit grants).
// Every event is signature-verified, idempotent (stripe_webhook_events), and
// audited (billing_events).

type Admin = ReturnType<typeof createClient>;

async function logBilling(
  admin: Admin,
  workspace_id: string | null,
  event_type: string,
  stripe_event_id: string,
  data: Record<string, unknown> = {},
) {
  const { error } = await admin.from("billing_events").insert({
    workspace_id,
    event_type,
    stripe_event_id,
    data,
  });
  if (error) console.error("billing_events insert failed", error.message);
}

// Billing suspension keeps content, kills publication: published pages flip to
// billing_suspended (public routes and sitemaps only serve status='published',
// so suspended URLs 404 and leave the sitemap automatically). Reactivation
// flips them back — same rows, same slugs, same URLs.
async function suspendPages(admin: Admin, workspace_id: string) {
  const { error, count } = await admin
    .from("tenant_pages")
    .update({ status: "billing_suspended" }, { count: "exact" })
    .eq("workspace_id", workspace_id)
    .eq("status", "published");
  if (error) console.error("suspendPages failed", error.message);
  return count ?? 0;
}

async function reactivatePages(admin: Admin, workspace_id: string) {
  const { error, count } = await admin
    .from("tenant_pages")
    .update({ status: "published" }, { count: "exact" })
    .eq("workspace_id", workspace_id)
    .eq("status", "billing_suspended");
  if (error) console.error("reactivatePages failed", error.message);
  return count ?? 0;
}

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

  // Idempotency: claim the event id before doing business work. A concurrent or
  // repeated delivery either sees "processed" (ack + skip) or reclaims a
  // crashed/failed attempt (safe: every handler below is itself idempotent).
  const { error: claimErr } = await admin.from("stripe_webhook_events").insert({
    stripe_event_id: event.id,
    event_type: event.type,
  });
  if (claimErr) {
    if (claimErr.code === "23505") {
      const { data: prior } = await admin
        .from("stripe_webhook_events")
        .select("processing_status")
        .eq("stripe_event_id", event.id)
        .maybeSingle();
      if (prior?.processing_status === "processed") {
        return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
      }
      // previous attempt crashed or errored — reprocess
    } else {
      console.error("webhook event claim failed", claimErr.message);
      // Fail loud: better a Stripe retry than an unaudited business action.
      return new Response(JSON.stringify({ error: "event log unavailable" }), { status: 500 });
    }
  }

  const markEvent = async (status: "processed" | "error", errText?: string) => {
    await admin
      .from("stripe_webhook_events")
      .update({
        processing_status: status,
        processed_at: new Date().toISOString(),
        error: errText ?? null,
      })
      .eq("stripe_event_id", event.id);
  };

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
          // A duplicate delivery (23505 on the unique stripe_session_id) must
          // NOT skip the grant: grant_credits is ledger-idempotent, so a replay
          // heals a previously-failed grant instead of stranding the customer.
          if (purchaseErr && purchaseErr.code !== "23505") throw purchaseErr;
          const { error: grantErr } = await admin.rpc("grant_credits", {
            _workspace_id: workspace_id,
            _amount: credits,
            _reason: "topup_purchase",
            _ref_type: "stripe_session",
            _ref_id: s.id,
            _metadata: {},
          });
          // Never ACK Stripe with a failed grant — a 500 makes Stripe retry.
          if (grantErr) throw grantErr;
          await logBilling(admin, workspace_id, "ai_topup_purchased", event.id, { credits });
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        // Stripe does not guarantee event ordering; fetch the subscription's
        // CURRENT state so a delayed "updated" event can't resurrect a
        // canceled plan (canceled subscriptions remain retrievable).
        const evSub = event.data.object as Stripe.Subscription;
        let sub = evSub;
        try {
          sub = await stripe.subscriptions.retrieve(evSub.id);
        } catch (e) {
          console.warn(`subscription retrieve failed for ${evSub.id}; using event payload`, e);
        }
        const workspace_id = sub.metadata?.workspace_id ?? evSub.metadata?.workspace_id;
        if (!workspace_id) break;

        const entitled = ["active", "trialing", "past_due"].includes(sub.status);

        // ---- feature add-ons (dmchamp / affiliate tiers) -------------------
        const addonKey = sub.metadata?.addon_key;
        if (addonKey && isAddonKey(addonKey)) {
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
              // White-glove add-ons need a human — surface the sale as a
              // high-priority support ticket instead of an unseen table row.
              const { data: wsRow } = await admin
                .from("workspaces")
                .select("name, slug")
                .eq("id", workspace_id)
                .maybeSingle();
              const { error: ticketErr } = await admin.from("support_tickets").insert({
                workspace_id,
                email: "billing@stripe-webhook.founders.click",
                name: "Stripe webhook",
                subject: `New add-on purchase: ${ADDON_CATALOG[addonKey].name}`,
                message: `Workspace "${wsRow?.name ?? workspace_id}" (${wsRow?.slug ?? ""}) subscribed to ${ADDON_CATALOG[addonKey].name} ($${(ADDON_CATALOG[addonKey].priceCents / 100).toFixed(0)}/mo). White-glove setup required — see addon_requests for status.`,
                category: "addon-fulfilment",
                priority: "high",
              });
              if (ticketErr) console.error("addon fulfilment ticket failed", ticketErr.message);
            }
          }
          await logBilling(admin, workspace_id, "feature_addon_updated", event.id, {
            addon_key: addonKey,
            status: sub.status,
          });
          break;
        }

        // ---- recurring page capacity add-on --------------------------------
        if (sub.metadata?.page_addon === "1") {
          const qty = sub.items.data[0]?.quantity ?? 1;
          const addonPages = entitled ? qty * PAGE_ADDON.pagesPerUnit : 0;
          await admin
            .from("workspaces")
            .update({ page_limit_addon: addonPages })
            .eq("id", workspace_id);
          await logBilling(admin, workspace_id, "page_addon_updated", event.id, {
            quantity: qty,
            addon_pages: addonPages,
            status: sub.status,
          });
          break;
        }

        // ---- base page plan -------------------------------------------------
        const priceId = sub.items.data[0]?.price.id ?? null;
        const tier = sub.metadata?.plan_tier ?? (await resolveTierFromPrice(stripe, priceId));
        const includedPages = pagesForTier(tier);
        // current_period_end can be absent on some subscription states; guard
        // against new Date(NaN) which would throw and force endless retries.
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

        const wsPatch: Record<string, unknown> = {
          subscription_status: sub.status,
          current_period_end: periodEnd,
        };
        if (includedPages > 0) {
          wsPatch.plan = tier;
          // Entitlement: the plan's capacity while the subscription is entitled
          // (active/trialing/past_due keeps pages online — grace period).
          if (entitled) wsPatch.page_limit_base = includedPages;
        }
        await admin.from("workspaces").update(wsPatch).eq("id", workspace_id);

        if (entitled) {
          // Payment truth restored (e.g. past_due -> active): bring any
          // billing-suspended pages back at their original URLs.
          const restored = await reactivatePages(admin, workspace_id);
          if (restored > 0) {
            await logBilling(admin, workspace_id, "pages_reactivated", event.id, { restored });
          }
        } else if (["canceled", "unpaid", "incomplete_expired"].includes(sub.status)) {
          const suspended = await suspendPages(admin, workspace_id);
          await logBilling(admin, workspace_id, "pages_suspended", event.id, {
            suspended,
            reason: sub.status,
          });
        }

        await logBilling(admin, workspace_id, "subscription_updated", event.id, {
          plan_tier: tier,
          status: sub.status,
          included_pages: includedPages,
          cancel_at_period_end: sub.cancel_at_period_end,
        });
        break;
      }
      case "invoice.paid": {
        const inv = event.data.object as Stripe.Invoice;
        const subId = inv.subscription as string | null;
        if (!subId) break;

        // Resolve workspace + tier from our local row, falling back to Stripe
        // when the subscription.created event hasn't been processed yet.
        let workspace_id: string | null = null;
        let plan_tier: string | null = null;
        let product_kind: string | null = null;
        const { data: sub } = await admin
          .from("subscriptions")
          .select("workspace_id, plan_tier")
          .eq("stripe_subscription_id", subId)
          .maybeSingle();
        const stripeSub = await stripe.subscriptions.retrieve(subId);
        // Feature/page add-on invoices don't grant AI credits.
        if (stripeSub.metadata?.addon_key || stripeSub.metadata?.page_addon === "1") break;
        product_kind = stripeSub.metadata?.product_kind ?? null;
        if (sub?.workspace_id) {
          workspace_id = sub.workspace_id;
          plan_tier = sub.plan_tier;
        } else {
          workspace_id = stripeSub.metadata?.workspace_id ?? null;
          const priceId = stripeSub.items.data[0]?.price.id ?? null;
          plan_tier = stripeSub.metadata?.plan_tier ?? (await resolveTierFromPrice(stripe, priceId));
        }
        if (!workspace_id) break;

        // A paid invoice is proof of payment: restore suspended pages.
        const restored = await reactivatePages(admin, workspace_id);
        if (restored > 0) {
          await logBilling(admin, workspace_id, "pages_reactivated", event.id, { restored });
        }

        // Skip proration/update invoices — only grant on normal cycle or first invoice.
        const billingReason = inv.billing_reason;
        if (
          billingReason &&
          billingReason !== "subscription_cycle" &&
          billingReason !== "subscription_create"
        ) {
          break;
        }

        const credits = creditsForTier(plan_tier, product_kind);
        if (credits > 0) {
          // grant_credits is idempotent AND concurrency-safe on
          // (_reason, _ref_type, _ref_id) — a redelivered invoice.paid no-ops.
          const { error: grantErr } = await admin.rpc("grant_credits", {
            _workspace_id: workspace_id,
            _amount: credits,
            _reason: "monthly_grant",
            _ref_type: "stripe_invoice",
            _ref_id: inv.id,
            _metadata: { plan_tier },
          });
          // A silently-failed monthly grant loses the customer's included AI
          // allowance; throw so Stripe retries instead of getting a 200.
          if (grantErr) throw grantErr;
          await logBilling(admin, workspace_id, "monthly_ai_allowance_granted", event.id, {
            credits,
            plan_tier,
          });
        } else {
          console.warn(`invoice.paid: tier "${plan_tier}" resolved to 0 credits for sub ${subId}`);
        }
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        const subId = inv.subscription as string | null;
        if (!subId) break;
        const { data: sub } = await admin
          .from("subscriptions")
          .select("workspace_id")
          .eq("stripe_subscription_id", subId)
          .maybeSingle();
        if (!sub?.workspace_id) break;
        // Grace period: no page action on a failed payment — Stripe retries and
        // the subscription.updated (past_due) handler keeps pages online. Pages
        // suspend only when Stripe finally cancels/marks unpaid.
        await logBilling(admin, sub.workspace_id, "payment_failed", event.id, {
          attempt: inv.attempt_count,
          next_attempt: inv.next_payment_attempt,
        });
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
          await logBilling(admin, workspace_id, "feature_addon_canceled", event.id, {
            addon_key: addonKey,
          });
          break;
        }
        if (sub.metadata?.page_addon === "1" && workspace_id) {
          await admin.from("workspaces").update({ page_limit_addon: 0 }).eq("id", workspace_id);
          await logBilling(admin, workspace_id, "page_addon_canceled", event.id, {});
          break;
        }
        await admin
          .from("subscriptions")
          .update({ status: "canceled", cancel_at_period_end: false })
          .eq("stripe_subscription_id", sub.id);
        if (workspace_id) {
          await admin
            .from("workspaces")
            .update({ subscription_status: "canceled" })
            .eq("id", workspace_id);
          // Paid period is over: suspend publication, keep the content. The
          // rows (and their slugs/URLs) survive so payment restores everything.
          const suspended = await suspendPages(admin, workspace_id);
          await logBilling(admin, workspace_id, "subscription_canceled", event.id, { suspended });
        }
        break;
      }
    }
    await markEvent("processed");
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (e) {
    console.error("webhook handler error", e);
    await markEvent("error", e instanceof Error ? e.message : String(e));
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
  }
});

async function resolveTierFromPrice(stripe: Stripe, priceId: string | null) {
  if (!priceId) return "unknown";
  const price = await stripe.prices.retrieve(priceId);
  return price.metadata?.plan_tier ?? "unknown";
}
