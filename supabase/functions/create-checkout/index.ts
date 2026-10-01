import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  ensureSubscriptionPrice,
  ensureAddonPrice,
  ensurePageAddonPrice,
  isAddonKey,
  isPlanTier,
  PAGE_PLANS,
} from "../_shared/stripe-catalog.ts";
import {
  affiliateConnectionRefusal,
  isAffiliateAddonKey,
} from "../_shared/affiliate-requirement.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Live or Stripe test mode, chosen by the deployment name, never by the
 * caller. The same source is deployed twice, like stripe-webhook and
 * stripe-webhook-test: as `create-checkout` (STRIPE_SECRET_KEY) and as
 * `create-checkout-test` (STRIPE_SECRET_KEY_TEST). The name is the FIRST path
 * segment after /functions/v1, so a sub-path of the live function stays live.
 */
export function checkoutModeFor(url: string): { test: boolean; keyName: string } {
  const path = new URL(url).pathname.replace(/^\/functions\/v1(?=\/|$)/, "");
  const name = path.split("/").find((segment) => segment.length > 0) ?? "";
  const test = name === "create-checkout-test";
  return { test, keyName: test ? "STRIPE_SECRET_KEY_TEST" : "STRIPE_SECRET_KEY" };
}

/**
 * The test deployment writes stripe_customers just like the live one, and a
 * test-mode customer id in a real workspace's row would break its live
 * billing. So test mode serves only the workspaces listed in
 * STRIPE_TEST_WORKSPACE_IDS (comma-separated UUIDs of a throwaway workspace,
 * never a customer's — the allowlist stripe-webhook-test reads too). Unset or
 * empty refuses everything. The live deployment never reads it.
 */
export function testModeWorkspaceAllowed(raw: string | null | undefined, workspaceId: string) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const allowed = String(raw ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((id) => uuid.test(id));
  return allowed.includes(workspaceId.trim().toLowerCase());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const checkoutMode = checkoutModeFor(req.url);
    const stripe = new Stripe(Deno.env.get(checkoutMode.keyName)!, { apiVersion: "2024-06-20" });
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader)
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser();
    const user = userData.user;
    if (!user)
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });

    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { workspace_id, mode, quantity: rawQuantity, tier, addon_key } = await req.json();
    const maxQty = mode === "page_addon" ? 10 : 100;
    const quantity = Math.max(1, Math.min(maxQty, Math.floor(Number(rawQuantity) || 1)));

    // Validate inputs to avoid leaking TypeErrors from Stripe. "addon" is not
    // among them: add-ons are deferred (refused with 410 just below).
    const validModes = ["subscription", "page_addon"] as const;
    if (!workspace_id || typeof workspace_id !== "string") {
      return new Response(JSON.stringify({ error: "invalid_request" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    // Before any database read or Stripe call (see testModeWorkspaceAllowed).
    // A live key stored under the _TEST name would make "test mode" create
    // live objects, so the test deployment also refuses any key that is not a
    // Stripe test-mode key.
    if (checkoutMode.test && !/^(sk|rk)_test_/.test(Deno.env.get(checkoutMode.keyName) ?? "")) {
      return new Response(
        JSON.stringify({
          error: "test_mode_misconfigured",
          message: "Test-mode checkout needs a Stripe test-mode key.",
        }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (
      checkoutMode.test &&
      !testModeWorkspaceAllowed(Deno.env.get("STRIPE_TEST_WORKSPACE_IDS"), workspace_id)
    ) {
      return new Response(
        JSON.stringify({
          error: "test_mode_workspace_refused",
          message: "Test-mode checkout is limited to the allowlisted test workspace.",
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    // AI credits were withdrawn as a customer-facing SKU. The UI stopped
    // offering them, but this endpoint kept accepting mode:"credits" and would
    // provision a $10/1,000-credit price for anyone who posted it directly —
    // a product we do not sell, purchasable by API. Refused explicitly rather
    // than as a generic invalid_mode so the answer is unambiguous if it is ever
    // deliberately restored: the catalog entry and ensureCreditPackPrice() are
    // left intact in _shared/stripe-catalog.ts for exactly that reason.
    if (mode === "credits") {
      return new Response(
        JSON.stringify({
          error: "credits_unavailable",
          message: "AI credit packs are no longer sold. Page capacity is included with every plan.",
        }),
        { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    // Add-ons (Affiliate Programs, DM Champ) are DEFERRED for the MVP
    // (2026-09-28): not sold to anyone, whatever the workspace or its
    // entitlement. Hiding the Add-ons page does not close the endpoint, so
    // mode:"addon" is refused here, the same way as credits: 410, before any
    // database read or Stripe call. The catalogue entries, ensureAddonPrice()
    // and the add-on branches below are left intact for a deliberate restore.
    // Nobody holds an add-on today (verified in production); existing Stripe
    // objects, if any, are untouched.
    if (mode === "addon") {
      return new Response(
        JSON.stringify({
          error: "addon_unavailable",
          message: "Add-ons aren't available right now.",
        }),
        { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!validModes.includes(mode)) {
      return new Response(JSON.stringify({ error: "invalid_mode" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    if (mode === "subscription" && !isPlanTier(tier)) {
      return new Response(JSON.stringify({ error: "invalid_tier" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    if (mode === "addon" && !isAddonKey(addon_key)) {
      return new Response(JSON.stringify({ error: "invalid_addon" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const { data: member } = await admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member)
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: corsHeaders,
      });
    // Billing is owner-only: an invited member must not be able to start paid
    // subscriptions on the workspace's card.
    if (member.role !== "owner")
      return new Response(
        JSON.stringify({
          error: "owner_only",
          message: "Only the workspace owner can manage billing.",
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );

    // The Affiliate add-on tracks referrals by reading transactions through
    // Sharetribe's Integration API; on the read-only Marketplace API
    // connection (the default) it can track nothing, so it is not sold there
    // (round-4 release review M1). Checked before any Stripe object exists.
    if (mode === "addon" && isAffiliateAddonKey(addon_key)) {
      const { data: integration, error: integrationError } = await admin
        .from("tenant_integrations")
        .select("auth_mode")
        .eq("workspace_id", workspace_id)
        .eq("provider", "sharetribe")
        .maybeSingle();
      if (integrationError) {
        console.error("create-checkout: connection read failed", integrationError.message);
        return new Response(
          JSON.stringify({
            error: "connection_unverified",
            message: "Couldn't check your Sharetribe connection. Try again in a minute.",
          }),
          { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const refusal = affiliateConnectionRefusal(integration);
      if (refusal) {
        return new Response(
          JSON.stringify({ error: "integration_api_required", message: refusal }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Block a second concurrent plan subscription: Stripe happily creates
    // parallel subscriptions for the same customer, which would double-bill and
    // double-grant monthly credits. Plan changes must go through the customer
    // portal (upgrade/downgrade), not a second checkout. Add-ons are separate
    // subscriptions by design and stay allowed.
    if (mode === "subscription") {
      const { data: activeSub } = await admin
        .from("subscriptions")
        .select("id, status")
        .eq("workspace_id", workspace_id)
        .in("status", ["active", "trialing", "past_due"])
        .limit(1)
        .maybeSingle();
      if (activeSub) {
        return new Response(
          JSON.stringify({
            error: "already_subscribed",
            message: "This workspace already has an active plan. Use Manage billing to change it.",
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const { data: cust } = await admin
      .from("stripe_customers")
      .select("stripe_customer_id")
      .eq("workspace_id", workspace_id)
      .maybeSingle();

    // Extra page capacity only makes sense on top of an active plan.
    if (mode === "page_addon") {
      const { data: baseSub } = await admin
        .from("subscriptions")
        .select("id")
        .eq("workspace_id", workspace_id)
        .in("status", ["active", "trialing", "past_due"])
        .limit(1)
        .maybeSingle();
      if (!baseSub) {
        return new Response(
          JSON.stringify({
            error: "plan_required",
            message: "Pick a plan first — extra page capacity stacks on top of a base plan.",
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      // Only one page-capacity subscription per workspace; adjust its quantity
      // instead of stacking parallel subscriptions.
      const { data: existingAddons } = await stripe.subscriptions.list({
        customer: cust?.stripe_customer_id ?? undefined,
        status: "active",
        limit: 100,
      }).then(
        (r) => ({ data: r.data.filter((x) => x.metadata?.page_addon === "1" && x.metadata?.workspace_id === workspace_id) }),
        () => ({ data: [] as Stripe.Subscription[] }),
      );
      if (existingAddons.length > 0) {
        return new Response(
          JSON.stringify({
            error: "addon_exists",
            message:
              "You already have extra page capacity. Use Manage billing to change its quantity.",
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }


    const createCustomer = async () => {
      const created = await stripe.customers.create({
        email: user.email,
        metadata: { workspace_id, user_id: user.id },
      });
      await admin.from("stripe_customers").upsert(
        {
          workspace_id,
          stripe_customer_id: created.id,
          email: user.email,
        },
        { onConflict: "workspace_id" },
      );
      return created.id;
    };

    let customerId = cust?.stripe_customer_id;
    if (!customerId) {
      customerId = await createCustomer();
    } else {
      // A stored customer can go stale — the Stripe account or mode changed, or
      // the customer was deleted in Stripe. Without this check the stale id is
      // passed to checkout and every purchase fails permanently with an opaque
      // 500. Verify it, and transparently re-create when Stripe doesn't know it.
      try {
        const existing = await stripe.customers.retrieve(customerId);
        if ((existing as { deleted?: boolean }).deleted) {
          customerId = await createCustomer();
        }
      } catch (e) {
        const code = (e as { code?: string; statusCode?: number })?.code;
        const status = (e as { statusCode?: number })?.statusCode;
        if (code === "resource_missing" || status === 404) {
          console.warn(
            `create-checkout: stale stripe customer ${customerId} for workspace ${workspace_id}; recreating`,
          );
          customerId = await createCustomer();
        } else {
          throw e;
        }
      }
    }

    const allowedOrigins = (
      Deno.env.get("ALLOWED_ORIGINS") ?? "https://www.founders.click,https://founders.click"
    )
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    const rawOrigin = req.headers.get("origin");
    const origin = rawOrigin && allowedOrigins.includes(rawOrigin) ? rawOrigin : allowedOrigins[0];
    const isSubscription = mode === "subscription" || mode === "addon" || mode === "page_addon";
    const selectedPrice =
      mode === "addon"
        ? await ensureAddonPrice(stripe, addon_key)
        : mode === "page_addon"
          ? await ensurePageAddonPrice(stripe)
          : await ensureSubscriptionPrice(stripe, tier);

    const returnPath = mode === "addon" ? "addons" : "billing";

    // Stripe enables Managed Payments by default on new accounts, but it requires
    // API version 2025-03-31.basil+, while this integration is pinned to
    // 2024-06-20 (the version the webhook's subscription/invoice field handling
    // is written against). Opt out per session so checkout runs on classic
    // Billing. Revisit as a deliberate upgrade: bump the pinned apiVersion here
    // AND in stripe-webhook, then re-verify invoice.paid / subscription events.
    const sessionParams = {
      customer: customerId,
      mode: isSubscription ? "subscription" : "payment",
      // Not in the stripe@14 typings yet — sent through as a raw param.
      managed_payments: { enabled: false },
      line_items: [
        {
          price: selectedPrice.id,
          quantity: mode === "credits" || mode === "page_addon" ? quantity : 1,
        },
      ],
      success_url: `${origin}/app/${returnPath}?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/app/${returnPath}?canceled=1`,
      metadata: {
        workspace_id,
        mode: mode ?? "subscription",
        plan_tier: selectedPrice.metadata?.plan_tier ?? "",
        credits_per_pack: selectedPrice.metadata?.credits ?? "",
        addon_key: mode === "addon" ? addon_key : "",
        page_addon: mode === "page_addon" ? "1" : "",
      },
      subscription_data: isSubscription
        ? {
            metadata: {
              workspace_id,
              product_kind:
                mode === "page_addon" ? "page_addon" : mode === "addon" ? "feature_addon" : "page_plan",
              plan_tier:
                mode === "addon" || mode === "page_addon"
                  ? ""
                  : (selectedPrice.metadata?.plan_tier ?? tier),
              addon_key: mode === "addon" ? addon_key : "",
              addon_tier: mode === "addon" ? (selectedPrice.metadata?.addon_tier ?? "") : "",
              page_addon: mode === "page_addon" ? "1" : "",
            },
          }
        : undefined,
    } as unknown as Stripe.Checkout.SessionCreateParams;

    const session = await stripe.checkout.sessions.create(sessionParams);

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("create-checkout error", e);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
