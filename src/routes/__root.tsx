import { useEffect } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import appCss from "../styles.css?url";
import { installServerFnAuthFetch } from "@/integrations/supabase/server-fn-fetch";
import { supabase } from "@/integrations/supabase/client";
import { authEventNavigation, authLandingFromHash } from "@/lib/auth-landing";
import { I18nProvider } from "@/lib/i18n";
import { canonicalUrl } from "@/lib/canonical";
import { Toaster } from "@/components/ui/sonner";

if (typeof window !== "undefined") {
  installServerFnAuthFetch();
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "founders.click" },
      { name: "description", content: "Growth tools for Sharetribe marketplace founders." },
      { name: "author", content: "founders.click" },
      {
        property: "og:title",
        content: "founders.click — The growth engine for Sharetribe marketplaces",
      },
      {
        property: "og:description",
        content:
          "SEO landing pages for Sharetribe marketplaces: AI-written pages built from your live listings, hosted with sitemaps and schema.",
      },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "founders.click" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "founders.click — Growth engine for Sharetribe" },
      {
        name: "twitter:description",
        content: "SEO landing pages for Sharetribe marketplaces, built from your live listings.",
      },
      { property: "og:image", content: canonicalUrl("/product-demo-poster.jpg") },
      { name: "twitter:image", content: canonicalUrl("/product-demo-poster.jpg") },
      { name: "google-site-verification", content: "wXqrsZ8WyZHOQwr7E-AKXmC_fwxEpLBVgHLsFIepwlw" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/favicon.svg" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <AuthStateBridge />
      <I18nProvider>
        <Outlet />
        {/* Global toast host — without this, every toast.success/error in the app
            is silently dropped, making forms (login, signup, onboarding) look dead. */}
        <Toaster richColors position="top-center" />
      </I18nProvider>
    </QueryClientProvider>
  );
}

/** Identity transitions: the ones that refresh router context and queries. */
const IDENTITY_EVENTS = new Set(["SIGNED_IN", "SIGNED_OUT", "USER_UPDATED", "PASSWORD_RECOVERY"]);

/**
 * Single global Supabase auth listener. Without this, sign-in / sign-out in
 * one tab doesn't refresh router context or react-query caches in another,
 * and post-OAuth landings can keep stale `getMe` results. Filter to identity
 * transitions to avoid thrashing on TOKEN_REFRESHED / INITIAL_SESSION.
 */
function AuthStateBridge() {
  const router = useRouter();
  const queryClient = useQueryClient();
  useEffect(() => {
    // Where an auth link that landed on a marketing route should take the
    // user. Decided from the URL hash BEFORE supabase-js consumes it: the
    // client strips the fragment as it stores the session, so by the time
    // SIGNED_IN fires the hash is gone.
    //
    // A `let`, CONSUMED EXACTLY ONCE: by the FIRST auth event of any kind,
    // whatever that event is. @supabase/auth-js re-emits SIGNED_IN on
    // tab visibility recovery and this listener lives for the whole session,
    // so a landing that stayed armed was replayed later: a customer editing a
    // page under /app was sent back to the dashboard every time they switched
    // tabs and returned, and a recovery link — whose PASSWORD_RECOVERY never
    // consumed the landing — sent the customer to the password form again on
    // a later tab switch.
    let landing = authLandingFromHash(window.location.hash, window.location.pathname);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      // The pathname is re-read at event time, not at mount: if the customer
      // is already inside /app (or on the password form) there is nothing to
      // correct. Recovery links emit PASSWORD_RECOVERY rather than SIGNED_IN
      // (auth-js 2.105.4): it goes to the password form in update mode,
      // /reset-password?recovery=1, which reset-password.tsx honours with the
      // live recovery session. Confirmation and magic links redirect to the
      // Auth "Site URL", which is the marketing homepage, with the session in
      // the fragment: the session is stored fine, but the customer is left on
      // a page that says "Sign in" — take them where the link was for, once.
      const to = authEventNavigation(event, landing, window.location.pathname, !!session);
      landing = null;
      if (IDENTITY_EVENTS.has(event)) {
        router.invalidate();
        // On SIGNED_OUT, don't refetch protected queries against a cleared
        // session — that just produces a 401 storm. Sign-out flows clear the
        // cache themselves.
        if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
      }
      if (to) router.navigate({ href: to, replace: true });
    });
    return () => sub.subscription.unsubscribe();
  }, [router, queryClient]);
  return null;
}
