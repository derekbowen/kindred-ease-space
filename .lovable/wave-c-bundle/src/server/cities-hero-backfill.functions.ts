import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { backfillCityHeroes } from "./cities-hero-backfill.server";

const inputSchema = z.object({
  force: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
  onlySlugs: z.array(z.string()).max(500).optional(),
  batchSize: z.number().int().positive().max(100).optional(),
  concurrency: z.number().int().positive().max(8).optional(),
  excludeSlugs: z.array(z.string()).max(10000).optional(),
  maxDurationMs: z.number().int().positive().max(120_000).optional(),
  generateFallback: z.boolean().optional(),
  maxFallbacksPerBatch: z.number().int().positive().max(50).optional(),
});

export const runHeroBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => inputSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { data: roleRow, error: roleErr } = await supabaseAdmin
      .from("user_roles").select("role")
      .eq("user_id", context.userId).eq("role", "admin").maybeSingle();
    if (roleErr) throw new Error(roleErr.message);
    if (!roleRow) throw new Error("Admin role required");

    return backfillCityHeroes({
      force: data.force,
      limit: data.limit,
      onlySlugs: data.onlySlugs,
      batchSize: data.batchSize,
      concurrency: data.concurrency,
      excludeSlugs: data.excludeSlugs,
      maxDurationMs: data.maxDurationMs,
      generateFallback: data.generateFallback,
      maxFallbacksPerBatch: data.maxFallbacksPerBatch,
    });
  });
