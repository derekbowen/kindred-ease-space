import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const InputSchema = z.object({
  action: z.enum(["start", "status", "preflight", "resume-paused"]).default("start"),
  count: z.number().int().min(1).max(10).default(10),
  tier: z
    .enum(["T1 (200k+)", "T2 (75k–199k)", "T3 (25k–74k)", "T4 (10k–24k)", "longtail"])
    .optional(),
  stateCode: z.string().length(2).optional(),
  warmOnly: z.boolean().default(false),
  model: z.string().default("google/gemini-3-flash-preview"),
  dryRun: z.boolean().default(false),
  slugs: z.array(z.string()).optional(),
  onlyStaleValidator: z.boolean().default(false),
});

type FunctionInvokeResult = {
  data: unknown;
  error: null | {
    message?: string;
    context?: Response;
  };
};

type FunctionInvoker = {
  functions: {
    invoke: (name: string, options: { body: unknown }) => Promise<FunctionInvokeResult>;
  };
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type GenerateContentBatchResult = { [key: string]: JsonValue };

async function getFunctionErrorMessage(error: FunctionInvokeResult["error"]) {
  if (!error) return "Unknown generation error";
  const response = error.context;
  if (response) {
    const text = await response.text().catch(() => "");
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string };
        return parsed.error || parsed.message || text.slice(0, 500);
      } catch {
        return text.slice(0, 500);
      }
    }
  }
  return error.message || "Generation backend failed";
}

export const generateContentBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ context, data }): Promise<GenerateContentBatchResult> => {
    const { supabase } = context as { supabase: FunctionInvoker };
    const { data: result, error } = await supabase.functions.invoke("generate-content-batch", {
      body: data,
    });

    if (error) {
      throw new Error(await getFunctionErrorMessage(error));
    }

    return (result ?? {}) as GenerateContentBatchResult;
  });
