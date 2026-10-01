// Exchanges a paid Stripe Checkout session for a short-lived download link.
//
// The zip lives in the PRIVATE `template-downloads` bucket; the only way to it
// is a signed URL minted here, and only after Stripe itself confirms the
// session is a completed, paid template purchase for that exact template.
// Nothing about payment state is trusted from the request.
//
// The session id acts as the buyer's receipt: the same link re-issues a fresh
// signed URL, so a buyer who loses the download can come back to it.
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

/** Signed links expire quickly; the receipt link can always mint another. */
const SIGNED_URL_TTL_SECONDS = 15 * 60;

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
    let body: { session_id?: unknown; slug?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    const sessionId = body.session_id;
    if (typeof sessionId !== "string" || !/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
      return json({ error: "invalid_session" }, 400);
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch {
      // Unknown or foreign session id. Same answer as unpaid: no oracle.
      return json({ error: "not_paid" }, 402);
    }

    const product = findTemplateProduct(session.metadata?.template_slug);
    const paid = session.status === "complete" && session.payment_status === "paid";
    if (!paid || session.metadata?.kind !== TEMPLATE_PURCHASE_KIND || !product) {
      return json({ error: "not_paid" }, 402);
    }
    // The page asks for the template it is showing; a receipt for a different
    // template must not download this one (or vice versa).
    if (body.slug !== undefined && body.slug !== product.slug) {
      return json({ error: "wrong_template" }, 409);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const fileName = `${product.slug}-sharetribe-template.zip`;
    const { data, error } = await admin.storage
      .from(TEMPLATE_BUCKET)
      .createSignedUrl(templateZipPath(product.slug), SIGNED_URL_TTL_SECONDS, {
        download: fileName,
      });
    if (error || !data?.signedUrl) {
      console.error("[template-download] signed url failed", product.slug, error?.message);
      return json({ error: "file_unavailable" }, 503);
    }

    return json({
      url: data.signedUrl,
      fileName,
      templateName: product.name,
      email: session.customer_details?.email ?? null,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    });
  } catch (e) {
    console.error("[template-download] failed", e instanceof Error ? e.message : String(e));
    return json({ error: "download_failed" }, 500);
  }
});
