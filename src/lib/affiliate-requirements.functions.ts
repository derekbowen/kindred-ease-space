import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import { affiliateConnectionProblem } from "@/lib/affiliate-requirements";
import { readSharetribeConnectionMode } from "@/lib/affiliate-requirements.server";

/**
 * Whether the workspace's Sharetribe connection can run the Affiliate add-on
 * (member-only, computed server-side). `problem` is the customer sentence to
 * show when it cannot; the trial and the checkout refuse on the same rule.
 */
export const getAffiliateRequirement = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const mode = await readSharetribeConnectionMode(data.workspaceId);
    return { mode, ready: mode === "integration", problem: affiliateConnectionProblem(mode) };
  });
