// Starts a one-time Stripe Checkout for a pack of Magic Designs tokens.
//
// Signed-in users only: tokens belong to an account. The pack size and price
// come from _shared/design-tokens.ts, never from the request. The session
// carries kind=design_tokens, user_id and pack, and no workspace_id, so
// stripe-webhook's SaaS billing handlers ignore it. Tokens are granted by
// design-token-claim after Stripe confirms payment.
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { DESIGN_TOKENS_KIND, findDesignTokenPack } from "../_shared/design-tokens.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "unauthorized" }, 401);
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: { headers: { Authorization: authHeader } },
      },
    );
    const { data: userData } = await userClient.auth.getUser();
    const user = userData.user;
    if (!user) return json({ error: "unauthorized" }, 401);

    let body: { pack?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    const pack = findDesignTokenPack(body.pack);
    if (!pack) return json({ error: "unknown_pack" }, 400);

    const allowedOrigins = (
      Deno.env.get("ALLOWED_ORIGINS") ?? "https://www.founders.click,https://founders.click"
    )
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    const rawOrigin = req.headers.get("origin");
    const origin = rawOrigin && allowedOrigins.includes(rawOrigin) ? rawOrigin : allowedOrigins[0];

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
    const metadata = { kind: DESIGN_TOKENS_KIND, user_id: user.id, pack: pack.key };
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: user.email ?? undefined,
      client_reference_id: user.id,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: pack.priceCents,
            product_data: {
              name: `Magic Designs — ${pack.tokens} design tokens`,
              description: "Tokens for custom Sharetribe marketplace designs on founders.click.",
            },
          },
        },
      ],
      allow_promotion_codes: true,
      metadata,
      payment_intent_data: { metadata },
      success_url: `${origin}/app/magic-designs?tokens=claim&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/app/magic-designs?tokens=canceled`,
    });
    return json({ url: session.url });
  } catch (e) {
    console.error("[design-token-checkout] failed", e instanceof Error ? e.message : String(e));
    return json({ error: "checkout_failed" }, 500);
  }
});
