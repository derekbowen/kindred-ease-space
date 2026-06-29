// Server-only: pull Sharetribe transactions, attribute them to affiliates via
// the referrerID stored in the referred user's private data, and accrue payouts.
// Reuses the same Integration API auth pattern as the listings sync.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const SHARETRIBE_AUTH_URL = "https://flex-integ-api.sharetribe.com/v1/auth/token";
const SHARETRIBE_API_BASE = "https://flex-integ-api.sharetribe.com/v1/integration_api";

type AnyRec = Record<string, any>;

async function fetchWithRetry(input: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(input, init);
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (i < attempts - 1) {
          await new Promise((r) => setTimeout(r, [1000, 3000, 9000][i] ?? 9000));
          continue;
        }
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, [1000, 3000, 9000][i] ?? 9000));
        continue;
      }
    }
  }
  throw lastErr ?? new Error("network failure");
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const res = await fetchWithRetry(SHARETRIBE_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "integ",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`auth_failed:${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("auth_failed:no_token");
  return json.access_token;
}

function uuidOf(rel: AnyRec | undefined): string | null {
  return rel?.data?.id?.uuid ?? rel?.data?.id ?? null;
}

/** Compute the payout owed for a transaction under a program's rules. */
function computePayout(program: AnyRec, gmv: number): number {
  if (program.min_gmv != null && gmv < Number(program.min_gmv)) return 0;
  if (program.payout_type === "fixed") return Number(program.payout_value || 0);
  return (gmv * Number(program.payout_value || 0)) / 100; // percentage of GMV
}

export type AffiliateSyncResult = {
  scanned: number;
  attributed: number;
  newTransactions: number;
  payoutsAccrued: number;
};

export async function runAffiliateReferralSync(workspaceId: string): Promise<AffiliateSyncResult> {
  const sb = supabaseAdmin as any;

  const { data: settings } = await sb
    .from("workspace_affiliate_settings")
    .select("referrer_param")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const referrerParam = settings?.referrer_param || "referrerID";

  const { data: integration } = await sb
    .from("tenant_integrations")
    .select("id, client_id")
    .eq("workspace_id", workspaceId)
    .eq("provider", "sharetribe")
    .maybeSingle();
  if (!integration) throw new Error("integration_not_found");

  const { data: secretRow, error: secretErr } = await sb.rpc("tenant_get_integration_secret", {
    _workspace_id: workspaceId,
  });
  if (secretErr || !secretRow) throw new Error("secret_decrypt_failed");

  // Active programs keyed for quick lookup; affiliates keyed by referral_code.
  const { data: programs } = await sb
    .from("affiliate_programs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("active", true);
  const activePrograms = (programs ?? []) as AnyRec[];
  if (activePrograms.length === 0)
    return { scanned: 0, attributed: 0, newTransactions: 0, payoutsAccrued: 0 };

  const { data: affiliates } = await sb
    .from("affiliates")
    .select("id, program_id, referral_code, status")
    .eq("workspace_id", workspaceId)
    .eq("status", "active");
  const byCode = new Map<string, AnyRec>();
  for (const a of (affiliates ?? []) as AnyRec[])
    byCode.set(String(a.referral_code).toLowerCase(), a);
  const programById = new Map<string, AnyRec>();
  for (const p of activePrograms) programById.set(p.id, p);

  const token = await getAccessToken(integration.client_id, secretRow as string);

  let scanned = 0,
    attributed = 0,
    newTransactions = 0,
    payoutsAccrued = 0;
  let page = 1;
  let totalPages = 1;

  do {
    // include=customer so we can read the referred user's private data inline.
    const url = `${SHARETRIBE_API_BASE}/transactions/query?per_page=100&page=${page}&include=customer`;
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) break;
    const json = (await res.json()) as AnyRec;
    const rows: AnyRec[] = json?.data ?? [];
    const included: AnyRec[] = json?.included ?? [];
    totalPages = json?.meta?.totalPages ?? 1;

    // Index included users by uuid for private-data lookup.
    const usersById = new Map<string, AnyRec>();
    for (const inc of included) if (inc.type === "user") usersById.set(inc.id?.uuid ?? inc.id, inc);

    for (const tx of rows) {
      scanned++;
      const txId = tx.id?.uuid ?? tx.id;
      const customerId = uuidOf(tx.relationships?.customer);
      if (!txId || !customerId) continue;

      const user = usersById.get(customerId);
      // Private data is where the referral code lands (Sharetribe stores the URL
      // param into the referred user's privateData on signup).
      const priv = user?.attributes?.profile?.privateData ?? {};
      const code = priv?.[referrerParam];
      if (!code) continue;

      const affiliate = byCode.get(String(code).toLowerCase());
      if (!affiliate) continue;
      const program = programById.get(affiliate.program_id);
      if (!program) continue;
      attributed++;

      // GMV from payinTotal (minor units -> major).
      const payin = tx.attributes?.payinTotal ?? tx.attributes?.payoutTotal;
      const gmv = payin?.amount != null ? Number(payin.amount) / 100 : 0;

      // Skip if we've already recorded this transaction.
      const { data: existing } = await sb
        .from("affiliate_transactions")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("sharetribe_transaction_id", txId)
        .maybeSingle();
      if (existing) continue;

      // Upsert the referral for this referred user.
      const { data: referral } = await sb
        .from("affiliate_referrals")
        .upsert(
          {
            workspace_id: workspaceId,
            affiliate_id: affiliate.id,
            program_id: program.id,
            referred_sharetribe_user_id: customerId,
            first_converted_at: new Date().toISOString(),
          },
          { onConflict: "workspace_id,program_id,referred_sharetribe_user_id" },
        )
        .select("id")
        .maybeSingle();

      const payout = computePayout(program, gmv);
      // Marketplace revenue ~ commission line items if present, else 0.
      let marketplaceRevenue = 0;
      const lineItems: AnyRec[] = tx.attributes?.lineItems ?? [];
      for (const li of lineItems) {
        if (typeof li.code === "string" && li.code.includes("commission")) {
          marketplaceRevenue += Math.abs(Number(li.lineTotal?.amount ?? 0)) / 100;
        }
      }

      await sb.from("affiliate_transactions").insert({
        workspace_id: workspaceId,
        affiliate_id: affiliate.id,
        referral_id: referral?.id ?? null,
        program_id: program.id,
        sharetribe_transaction_id: txId,
        gmv,
        marketplace_revenue: marketplaceRevenue,
        payout_owed: payout,
        event_type: "transaction",
        occurred_at: tx.attributes?.createdAt ?? new Date().toISOString(),
      });
      newTransactions++;

      if (payout > 0) {
        await sb.from("affiliate_payouts").insert({
          workspace_id: workspaceId,
          affiliate_id: affiliate.id,
          program_id: program.id,
          amount: payout,
          event_type: "transaction",
          status: "pending",
          txn_count: 1,
        });
        payoutsAccrued += payout;
      }
    }
    page++;
  } while (page <= totalPages && page <= 50);

  return { scanned, attributed, newTransactions, payoutsAccrued };
}
