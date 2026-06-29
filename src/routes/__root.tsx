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
          "AI-powered SEO, content factory, lead inbox and ops dashboard for Sharetribe marketplace founders.",
      },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "founders.click" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "founders.click — Growth engine for Sharetribe" },
      {
        name: "twitter:description",
        content: "AI SEO + content factory + lead inbox for marketplace founders.",
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
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
      // On SIGNED_OUT, don't refetch protected queries against a cleared
      // session — that just produces a 401 storm. Sign-out flows clear the
      // cache themselves.
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => sub.subscription.unsubscribe();
  }, [router, queryClient]);
  return null;
}
