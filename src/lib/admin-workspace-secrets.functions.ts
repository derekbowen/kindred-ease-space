import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceOwner, workspaceIdSchema } from "./admin-helpers.functions";

export type WorkspaceSecretRow = {
  id: string;
  key_name: string;
  preview: string;
  updated_at: string;
};

export const listWorkspaceSecrets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }): Promise<{ rows: WorkspaceSecretRow[] }> => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const { data: rows } = await supabaseAdmin
      .from("workspace_secrets")
      .select("id, key_name, value, updated_at")
      .eq("workspace_id", data.workspaceId)
      .order("key_name", { ascending: true });
    return {
      rows: (rows || []).map((r: any) => ({
        id: r.id,
        key_name: r.key_name,
        // Only show length/last 4 to avoid leaking full secret to the UI.
        preview: r.value
          ? `••••${String(r.value).slice(-4)} (${String(r.value).length} chars)`
          : "(empty)",
        updated_at: r.updated_at,
      })),
    };
  });

export const upsertWorkspaceSecret = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
      keyName: z.string().min(2).max(80).regex(/^[A-Z0-9_]+$/, "Use UPPER_SNAKE_CASE"),
      value: z.string().min(8).max(4000),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const { error } = await supabaseAdmin
      .from("workspace_secrets")
      .upsert({
        workspace_id: data.workspaceId,
        key_name: data.keyName,
        value: data.value,
        created_by: context.userId,
        updated_at: new Date().toISOString(),
      }, { onConflict: "workspace_id,key_name" });
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });

export const deleteWorkspaceSecret = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    const { error } = await supabaseAdmin
      .from("workspace_secrets")
      .delete()
      .eq("workspace_id", data.workspaceId)
      .eq("id", data.id);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });
