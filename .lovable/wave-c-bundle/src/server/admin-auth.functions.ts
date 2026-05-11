import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Server-side admin role check. Used by /admin/* routes in beforeLoad to
 * prevent non-admin authenticated users from rendering the admin UI.
 * Returns { isAdmin: boolean } — caller decides where to redirect.
 */
export const checkAdminRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ isAdmin: boolean }> => {
    const { userId } = context as { userId: string };
    const { data, error } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (error) {
      console.error("[admin-auth] role lookup failed", error);
      return { isAdmin: false };
    }
    return { isAdmin: !!data };
  });
