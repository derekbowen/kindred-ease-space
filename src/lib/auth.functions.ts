import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getMe = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId, claims } = context;

    const { data: profile } = await supabase
      .from("profiles")
      .select("user_id, display_name, full_name, avatar_url")
      .eq("user_id", userId)
      .maybeSingle();

    const { data: memberships } = await supabase
      .from("workspace_members")
      .select("workspace_id, role, workspaces(id, slug, name, plan, subscription_status, trial_ends_at, marketplace_domain, domain_verified_at)")
      .eq("user_id", userId);

    return {
      userId,
      email: claims.email ?? null,
      profile: profile ?? null,
      memberships: memberships ?? [],
    };
  });
