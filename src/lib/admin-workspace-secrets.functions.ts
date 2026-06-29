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
      .select("id, key_name, last_four, value_length, updated_at")
      .eq("workspace_id", data.workspaceId)
      .order("key_name", { ascending: true });
    return {
      rows: (rows || []).map((r: any) => ({
        id: r.id,
        key_name: r.key_name,
        preview: r.last_four ? `••••${r.last_four} (${r.value_length ?? 0} chars)` : "(empty)",
        updated_at: r.updated_at,
      })),
    };
  });

export const upsertWorkspaceSecret = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        keyName: z
          .string()
          .min(2)
          .max(80)
          .regex(/^[A-Z0-9_]+$/, "Use UPPER_SNAKE_CASE"),
        value: z.string().min(8).max(4000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceOwner(data.workspaceId, context.userId);
    // Use the authenticated user's client so the RPC's auth.uid() owner check
    // sees the caller — supabaseAdmin would run as service_role with null uid.
    const { error } = await context.supabase.rpc("tenant_set_workspace_secret", {
      _workspace_id: data.workspaceId,
      _key_name: data.keyName,
      _value: data.value,
    });
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
    const { error } = await context.supabase.rpc("tenant_delete_workspace_secret", {
      _workspace_id: data.workspaceId,
      _id: data.id,
    });
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });
