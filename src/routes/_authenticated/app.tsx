import { useEffect, useState } from "react";
import { createFileRoute, Link, Outlet, useNavigate, useLocation } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { getMe } from "@/lib/auth.functions";
import { ensureWorkspace } from "@/lib/workspace.functions";
import { NAV_SECTIONS } from "@/lib/app-nav";
import { CoachLauncher } from "@/components/coach/CoachLauncher";

export const Route = createFileRoute("/_authenticated/app")({
  component: AppShell,
});

function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [me, setMe] = useState<Awaited<ReturnType<typeof getMe>> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMe()
      .then(setMe)
      .catch((e) => {
        const status = (e as { status?: number; response?: { status?: number } })?.status
          ?? (e as { response?: { status?: number } })?.response?.status;
        if (status === 401) {
          navigate({ to: "/login", search: { next: location.pathname } });
          return;
        }
        console.error("getMe failed", e);
      })
      .finally(() => setLoading(false));
  }, [navigate, location.pathname]);

  // No setup wall: if the user has no workspace yet, auto-provision one in the
  // background and drop them straight into the product. Marketplace details are
  // an optional setup step they can finish anytime in Settings.
  const [provisioning, setProvisioning] = useState(false);
  useEffect(() => {
    if (loading || !me) return;
    const memberships = Array.isArray(me.memberships) ? me.memberships : [];
    if (memberships.length > 0 || provisioning) return;
    setProvisioning(true);
    ensureWorkspace()
      .then(() => getMe().then(setMe))
      .catch((e) => console.error("ensureWorkspace failed", e))
      .finally(() => setProvisioning(false));
  }, [loading, me, provisioning]);

  const onSignOut = async () => {
    try {
      const { error } = await supabase.auth.signOut({ scope: "global" });
      if (error) console.error("signOut error", error);
    } catch (e) {
      console.error("signOut threw", e);
    }
    // Hard reload to clear any in-memory state and re-run auth guards
    window.location.assign("/login");
  };

  const activeWorkspace = me?.memberships?.[0]?.workspaces;

  return (
    <SidebarProvider>
      <div className="dark min-h-screen flex w-full bg-background text-foreground">
        <Sidebar>
          <SidebarHeader className="border-b border-sidebar-border">
            <Link to="/app" className="px-2 py-3 flex items-center gap-2">
              {activeWorkspace?.logo_url ? (
                <img
                  src={activeWorkspace.logo_url}
                  alt=""
                  className="h-7 w-7 rounded object-contain bg-white/5"
                />
              ) : (
                <div
                  className="h-7 w-7 rounded flex items-center justify-center text-white text-xs font-bold"
                  style={{ background: activeWorkspace?.brand_color ?? "hsl(var(--primary))" }}
                >
                  {(activeWorkspace?.brand_name || activeWorkspace?.name || "F").slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="text-sm min-w-0">
                <div className="font-bold tracking-tight truncate max-w-[160px]">
                  {activeWorkspace?.brand_name || activeWorkspace?.name || "founders.click"}
                </div>
                {activeWorkspace?.marketplace_domain && (
                  <div className="text-xs text-muted-foreground truncate max-w-[160px]">
                    {activeWorkspace.marketplace_domain}
                  </div>
                )}
              </div>
            </Link>
          </SidebarHeader>
          <SidebarContent>
            {NAV_SECTIONS.map((section) => (
              <SidebarGroup key={section.label}>
                <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {section.items.map((item) => {
                      const Icon = item.icon;
                      const active = item.exact
                        ? location.pathname === item.to
                        : location.pathname.startsWith(item.to) && item.to !== "/app";
                      return (
                        <SidebarMenuItem key={item.to}>
                          <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                            <Link to={item.to}>
                              <Icon className="h-4 w-4" />
                              <span className="flex-1 truncate">{item.label}</span>
                              {item.internalOnly && (
                                <Badge variant="secondary" className="ml-auto h-4 px-1 text-[10px]">
                                  internal
                                </Badge>
                              )}
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>
          <SidebarFooter className="border-t border-sidebar-border">
            <div className="px-2 py-2 text-xs text-muted-foreground truncate">{me?.email}</div>
            <Button variant="ghost" size="sm" onClick={onSignOut} className="justify-start">
              <LogOut className="h-4 w-4 mr-2" /> Sign out
            </Button>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="min-w-0 overflow-x-hidden">
          <header className="h-14 flex items-center gap-3 border-b border-border px-4">
            <SidebarTrigger />
            {activeWorkspace?.plan && (
              <Badge variant="outline" className="capitalize">
                {activeWorkspace.subscription_status === "trialing" ? "Trial" : activeWorkspace.plan}
              </Badge>
            )}
            {activeWorkspace?.marketplace_domain && (
              <span className="text-xs text-muted-foreground">{activeWorkspace.marketplace_domain}</span>
            )}
          </header>
          <main className="flex-1 w-full max-w-6xl min-w-0 px-4 py-4 sm:px-6 sm:py-6">
            <Outlet />
          </main>
        </SidebarInset>
        <CoachLauncher workspaceId={me?.memberships?.[0]?.workspace_id ?? null} />
      </div>
    </SidebarProvider>
  );
}
