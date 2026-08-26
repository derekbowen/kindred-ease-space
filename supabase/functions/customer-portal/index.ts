import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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
    if (!authHeader)
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user)
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });

    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { workspace_id } = await req.json();

    const { data: member } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("workspace_id", workspace_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member)
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: corsHeaders,
      });

    const { data: cust } = await admin
      .from("stripe_customers")
      .select("stripe_customer_id")
      .eq("workspace_id", workspace_id)
      .maybeSingle();
    if (!cust)
      return new Response(JSON.stringify({ error: "no_customer" }), {
        status: 404,
        headers: corsHeaders,
      });

    // Same stale-customer guard as create-checkout: a customer stored from a
    // different Stripe account/mode (or deleted in Stripe) would otherwise throw
    // an opaque 500 instead of a usable message.
    try {
      const existing = await stripe.customers.retrieve(cust.stripe_customer_id);
      if ((existing as { deleted?: boolean }).deleted) throw { code: "resource_missing" };
    } catch (e) {
      const code = (e as { code?: string })?.code;
      const status = (e as { statusCode?: number })?.statusCode;
      if (code === "resource_missing" || status === 404) {
        console.warn(
          `customer-portal: stale stripe customer ${cust.stripe_customer_id} for workspace ${workspace_id}`,
        );
        return new Response(JSON.stringify({ error: "no_customer" }), {
          status: 404,
          headers: corsHeaders,
        });
      }
      throw e;
    }

    // Validate the Origin against an allowlist — never echo an attacker-supplied
    // Origin into Stripe's return_url (open redirect after billing management).
    const allowedOrigins = (
      Deno.env.get("ALLOWED_ORIGINS") ?? "https://www.founders.click,https://founders.click"
    )
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    const rawOrigin = req.headers.get("origin");
    const origin =
      rawOrigin && allowedOrigins.includes(rawOrigin) ? rawOrigin : allowedOrigins[0];
    const portal = await stripe.billingPortal.sessions.create({
      customer: cust.stripe_customer_id,
      return_url: `${origin}/app/billing`,
    });
    return new Response(JSON.stringify({ url: portal.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("portal error", e);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
