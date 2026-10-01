// Grants the tokens a paid design-token Checkout session bought.
//
// Called by /app/magic-designs when Stripe redirects back. Everything is
// re-read from Stripe: the session must be complete and paid, be a
// design-token purchase, and belong to the signed-in user. The grant is one
// ledger row keyed (reason='purchase', ref=<session id>), so claiming the same
// session again — a refresh, a second tab — grants nothing more.
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  DESIGN_TOKENS_KIND,
  designTokenGrantAllowed,
  findDesignTokenPack,
} from "../_shared/design-tokens.ts";

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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser();
    const user = userData.user;
    if (!user) return json({ error: "unauthorized" }, 401);

    let body: { session_id?: unknown };
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
      return json({ error: "not_paid" }, 402);
    }
    const pack = findDesignTokenPack(session.metadata?.pack);
    const paid = session.status === "complete" && session.payment_status === "paid";
    if (!paid || session.metadata?.kind !== DESIGN_TOKENS_KIND || !pack) {
      return json({ error: "not_paid" }, 402);
    }
    // A receipt is only claimable by the account that bought it.
    if (session.metadata?.user_id !== user.id) return json({ error: "not_paid" }, 402);
    if (
      !designTokenGrantAllowed(
        session.livemode,
        user.id,
        Deno.env.get("STRIPE_TEST_DESIGN_TOKEN_USER_IDS"),
      )
    ) {
      return json({ error: "not_paid" }, 402);
    }

    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error: insertErr } = await admin.from("design_token_ledger").insert({
      user_id: user.id,
      delta: pack.tokens,
      reason: "purchase",
      ref: session.id,
    });
    // 23505: this session was already claimed — the tokens are already there.
    const alreadyClaimed = insertErr?.code === "23505";
    if (insertErr && !alreadyClaimed) {
      console.error("[design-token-claim] grant failed", session.id, insertErr.message);
      return json({ error: "grant_failed" }, 500);
    }
    const { data: balance, error: balErr } = await admin.rpc("design_token_balance", {
      _user_id: user.id,
    });
    if (balErr) console.error("[design-token-claim] balance read failed", balErr.message);
    return json({
      granted: alreadyClaimed ? 0 : pack.tokens,
      alreadyClaimed,
      balance: balance ?? null,
    });
  } catch (e) {
    console.error("[design-token-claim] failed", e instanceof Error ? e.message : String(e));
    return json({ error: "claim_failed" }, 500);
  }
});
