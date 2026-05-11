import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Verify the caller is a member of the workspace they are acting on.
 * Returns the user's role within that workspace ("owner" | "member" | ...).
 * All ported admin tools must call this before reading/writing workspace data.
 */
export async function assertWorkspaceMember(workspaceId: string, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden — not a member of this workspace");
  return data.role as string;
}

export async function assertWorkspaceOwner(workspaceId: string, userId: string) {
  const role = await assertWorkspaceMember(workspaceId, userId);
  if (role !== "owner") throw new Error("Forbidden — workspace owner only");
  return role;
}

/** Common Zod fragment: every workspace-scoped server fn accepts a workspaceId. */
export const workspaceIdSchema = z.string().uuid();

/**
 * Lightweight pingable helper used by the Admin layout / dashboard to confirm
 * the caller still has at least one workspace they can manage.
 */
export const getWorkspaceCapabilities = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ workspaceId: workspaceIdSchema }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const role = await assertWorkspaceMember(data.workspaceId, context.userId);
    return { workspaceId: data.workspaceId, role, isOwner: role === "owner" };
  });
