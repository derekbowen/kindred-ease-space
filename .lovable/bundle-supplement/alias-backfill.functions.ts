import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runAliasBackfill } from "./alias-backfill.server";

const inputSchema = z.object({
  limit: z.number().int().positive().max(2000).optional(),
  dryRun: z.boolean().optional(),
});

export const runAliasBackfillFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => inputSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { data: roleRow, error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "admin")
      .maybeSingle();
    if (roleErr) throw new Error(roleErr.message);
    if (!roleRow) throw new Error("Admin role required");

    return runAliasBackfill({ limit: data.limit, dryRun: data.dryRun });
  });
