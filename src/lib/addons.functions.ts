import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  assertWorkspaceMember,
  assertWorkspaceOwner,
  workspaceIdSchema,
} from "@/lib/admin-helpers.functions";
import {
  AFFILIATE_REQUIREMENT_NOTE,
  affiliateConnectionProblem,
} from "@/lib/affiliate-requirements";
import { readSharetribeConnectionMode } from "@/lib/affiliate-requirements.server";

const sb = () => supabaseAdmin as any;

export type AddonCatalogItem = {
  key: string;
  name: string;
  tagline: string;
  description: string;
  priceCents: number;
  cadence: string;
  bullets: string[];
  fulfilment: "managed" | "self_serve";
  /** What the customer must have set up for the add-on to work, said where it is sold. */
  requires?: string;
};

// Resellable add-ons offered inside founders.click. "managed" = white-glove:
// a purchase records intent and the operator sets the customer up by hand.
export const ADDON_CATALOG: AddonCatalogItem[] = [
  {
    key: "dmchamp",
    name: "DM Champ — AI Sales Agent",
    tagline: "A white-label AI agent that sells and books appointments in DMs.",
    description:
      "An AI agent for WhatsApp, Instagram and Messenger that engages leads 24/7, answers questions, qualifies, and books appointments while you sleep — fully white-labeled as your brand.",
    priceCents: 9900,
    cadence: "month",
    bullets: [
      "WhatsApp, Instagram & Messenger in one inbox",
      "AI that sells and books appointments 24/7",
      "White-label: your brand, your domain",
      "Done-for-you setup included",
    ],
    fulfilment: "managed",
  },
  {
    key: "affiliate-standard",
    name: "Affiliate Programs",
    tagline: "Run referral/affiliate programs on your Sharetribe marketplace.",
    description:
      "Create affiliate programs, track referred sign-ups and transactions, manage affiliates, and issue payouts — integrated with your Sharetribe marketplace through its Integration API. Roughly half the price of standalone tools.",
    priceCents: 3000,
    cadence: "month",
    bullets: [
      "Auto-enroll affiliates on first transaction",
      "Referral tracking via Sharetribe Integration API",
      "Payout lifecycle (pending → ready → paid)",
      "Public, branded affiliate sign-up pages",
    ],
    fulfilment: "self_serve",
    // Round-4 release review M1: the read-only Marketplace API connection
    // (the default) cannot read transactions, so the add-on tracks nothing
    // there. The trial and the checkout refuse it; the card says so first.
    requires: AFFILIATE_REQUIREMENT_NOTE,
  },
];

export const getAddons = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const [{ data: reqs }, { data: affSettings }] = await Promise.all([
      sb()
        .from("addon_requests")
        .select("addon_key, status, created_at")
        .eq("workspace_id", data.workspaceId)
        .order("created_at", { ascending: false }),
      sb()
        .from("workspace_affiliate_settings")
        .select("addon_status")
        .eq("workspace_id", data.workspaceId)
        .maybeSingle(),
    ]);
    const statusByKey = new Map<string, string>();
    for (const r of (reqs ?? []) as Array<{ addon_key: string; status: string }>) {
      if (!statusByKey.has(r.addon_key)) statusByKey.set(r.addon_key, r.status);
    }
    const affStatus = (affSettings as { addon_status?: string } | null)?.addon_status;
    if (affStatus === "active" || affStatus === "trialing") {
      statusByKey.set("affiliate-standard", "active");
    }
    // Why the Affiliate add-on cannot be started on this workspace's
    // Sharetribe connection (the same rule startAffiliateTrial and
    // create-checkout enforce), or null. A failed read shows no warning and
    // blocks nothing here — the trial and the checkout still check for real.
    let affiliateBlocked: string | null = null;
    try {
      affiliateBlocked = affiliateConnectionProblem(
        await readSharetribeConnectionMode(data.workspaceId),
      );
    } catch {
      affiliateBlocked = null;
    }
    return {
      catalog: ADDON_CATALOG.map((a) => ({
        ...a,
        requestStatus: statusByKey.get(a.key) ?? null,
        blockedReason: a.key === "affiliate-standard" ? affiliateBlocked : null,
      })),
    };
  });

export const requestAddon = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ workspaceId: workspaceIdSchema, addonKey: z.string().trim().min(2).max(60) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const item = ADDON_CATALOG.find((a) => a.key === data.addonKey);
    if (!item) throw new Error("Unknown add-on");

    // Don't double-request an outstanding one.
    const { data: existing } = await sb()
      .from("addon_requests")
      .select("id, status")
      .eq("workspace_id", data.workspaceId)
      .eq("addon_key", item.key)
      .in("status", ["requested", "contacted", "active"])
      .maybeSingle();
    if (existing) return { ok: true as const, already: true };

    const email = (context.claims as { email?: string } | undefined)?.email ?? null;
    const { error } = await sb().from("addon_requests").insert({
      workspace_id: data.workspaceId,
      addon_key: item.key,
      addon_name: item.name,
      price_cents: item.priceCents,
      status: "requested",
      contact_email: email,
      requested_by: context.userId,
    });
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
