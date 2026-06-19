import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ensureCreditPackPrice, ensureSubscriptionPrice, ensureAddonPrice, isAddonKey } from "../_shared/stripe-catalog.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders });

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser();
    const user = userData.user;
    if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders });

    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { workspace_id, mode, quantity, tier, addon_key } = await req.json();

    // Validate inputs to avoid leaking TypeErrors from Stripe
    const validModes = ["credits", "subscription", "addon"] as const;
    const validTiers = ["starter", "pro", "scale"] as const;
    if (!workspace_id || typeof workspace_id !== "string") {
      return new Response(JSON.stringify({ error: "invalid_request" }), { status: 400, headers: corsHeaders });
    }
    if (!validModes.includes(mode)) {
      return new Response(JSON.stringify({ error: "invalid_mode" }), { status: 400, headers: corsHeaders });
    }
    if (mode === "subscription" && !validTiers.includes(tier)) {
      return new Response(JSON.stringify({ error: "invalid_tier" }), { status: 400, headers: corsHeaders });
    }
    if (mode === "addon" && !isAddonKey(addon_key)) {
      return new Response(JSON.stringify({ error: "invalid_addon" }), { status: 400, headers: corsHeaders });
    }

    const { data: member } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("workspace_id", workspace_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: corsHeaders });

    let { data: cust } = await admin
      .from("stripe_customers")
      .select("stripe_customer_id")
      .eq("workspace_id", workspace_id)
      .maybeSingle();

    let customerId = cust?.stripe_customer_id;
    if (!customerId) {
      const created = await stripe.customers.create({
        email: user.email,
        metadata: { workspace_id, user_id: user.id },
      });
      customerId = created.id;
      await admin.from("stripe_customers").insert({
        workspace_id,
        stripe_customer_id: customerId,
        email: user.email,
      });
    }

    const origin = req.headers.get("origin") ?? "https://founders.click";
    const isSubscription = mode === "subscription" || mode === "addon";
    const selectedPrice =
      mode === "credits"
        ? await ensureCreditPackPrice(stripe)
        : mode === "addon"
          ? await ensureAddonPrice(stripe, addon_key)
          : await ensureSubscriptionPrice(stripe, tier);

    const returnPath = mode === "addon" ? "addons" : "billing";

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: isSubscription ? "subscription" : "payment",
      line_items: [{ price: selectedPrice.id, quantity: mode === "credits" ? (quantity ?? 1) : 1 }],
      success_url: `${origin}/app/${returnPath}?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/app/${returnPath}?canceled=1`,
      metadata: {
        workspace_id,
        mode: mode ?? "subscription",
        plan_tier: selectedPrice.metadata?.plan_tier ?? "",
        credits_per_pack: selectedPrice.metadata?.credits ?? "",
        addon_key: mode === "addon" ? addon_key : "",
      },
      subscription_data: isSubscription
        ? {
            metadata: {
              workspace_id,
              plan_tier: mode === "addon" ? "" : (selectedPrice.metadata?.plan_tier ?? tier),
              addon_key: mode === "addon" ? addon_key : "",
              addon_tier: mode === "addon" ? (selectedPrice.metadata?.addon_tier ?? "") : "",
            },
          }
        : undefined,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("create-checkout error", e);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: corsHeaders });
  }
});
