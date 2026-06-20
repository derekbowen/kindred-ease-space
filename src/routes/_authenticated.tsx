import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

// Wait for Supabase to finish restoring the session from storage / OAuth URL hash.
// Without this, landing on /app right after a Google callback races getUser() against
// the client's URL-hash session detection — the first 1–2 visits bounce to /login
// even though the user just authenticated.
async function waitForSession(timeoutMs = 3000) {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;

  return await new Promise<typeof data.session>((resolve) => {
    const timer = setTimeout(() => {
      sub.subscription.unsubscribe();
      resolve(null);
    }, timeoutMs);
    const sub = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        clearTimeout(timer);
        sub.subscription.unsubscribe();
        resolve(session);
      }
    });
  });
}

export const Route = createFileRoute("/_authenticated")({
  // localStorage-only session — cannot be read during SSR. Gating server-side
  // causes redirect loops on hard refresh and post-OAuth landings.
  ssr: false,
  beforeLoad: async ({ location }) => {
    if (typeof window === "undefined") return;
    const session = await waitForSession();
    if (!session) {
      throw redirect({
        to: "/login",
        search: { next: location.pathname },
      });
    }
  },
  component: () => <Outlet />,
});
