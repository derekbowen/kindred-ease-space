import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceOwner, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import { runAffiliateReferralSync } from "@/lib/affiliate-sync.server";

/** Pull Sharetribe transactions and attribute referrals/payouts. Owner-gated. */
export const runAffiliateSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    try {
      const result = await runAffiliateReferralSync(data.workspaceId);
      return { ok: true as const, ...result };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "sync_failed" };
    }
  });
