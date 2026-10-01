// Starts a one-time Stripe Checkout for a Sharetribe template download.
//
// Public: buyers do not need a founders.click account. The price comes from
// _shared/template-catalog.ts, never from the request, and a template whose zip
// is not uploaded yet is refused so nobody can pay for a file we cannot serve.
//
// The session carries metadata.kind = "template_purchase" and no workspace_id,
// so stripe-webhook's billing handlers ignore it (they all key on workspace_id).
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  findTemplateProduct,
  TEMPLATE_BUCKET,
  TEMPLATE_PURCHASE_KIND,
  templateZipPath,
} from "../_shared/template-catalog.ts";

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
    let body: { slug?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    const product = findTemplateProduct(body.slug);
    if (!product) return json({ error: "unknown_template" }, 404);

    // Refuse to sell a template whose file is not in storage yet.
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: files, error: listErr } = await admin.storage
      .from(TEMPLATE_BUCKET)
      .list("", { search: templateZipPath(product.slug) });
    if (listErr) {
      console.error("[template-checkout] storage list failed", listErr.message);
      return json({ error: "unavailable" }, 503);
    }
    if (!files?.some((f) => f.name === templateZipPath(product.slug))) {
      return json({ error: "not_available_yet" }, 409);
    }

    const allowedOrigins = (
      Deno.env.get("ALLOWED_ORIGINS") ?? "https://www.founders.click,https://founders.click"
    )
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    const rawOrigin = req.headers.get("origin");
    const origin = rawOrigin && allowedOrigins.includes(rawOrigin) ? rawOrigin : allowedOrigins[0];

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: product.priceCents,
            product_data: {
              name: `${product.name} — Sharetribe marketplace template`,
              description: "Source code download (React + Tailwind), commercial license.",
            },
          },
        },
      ],
      customer_creation: "always",
      allow_promotion_codes: true,
      metadata: { kind: TEMPLATE_PURCHASE_KIND, template_slug: product.slug },
      payment_intent_data: {
        metadata: { kind: TEMPLATE_PURCHASE_KIND, template_slug: product.slug },
      },
      success_url: `${origin}/sharetribe-templates/${product.slug}/download?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/sharetribe-templates/${product.slug}?canceled=1`,
    });

    return json({ url: session.url });
  } catch (e) {
    console.error("[template-checkout] failed", e instanceof Error ? e.message : String(e));
    return json({ error: "checkout_failed" }, 500);
  }
});
