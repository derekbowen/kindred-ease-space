import { useEffect, useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { getStoreTemplate } from "@/lib/template-store";

/**
 * Where Stripe sends a buyer after paying. The session id in the URL is their
 * receipt: template-download re-checks it with Stripe on every visit and mints
 * a fresh short-lived link, so this page can be bookmarked and revisited.
 */
export const Route = createFileRoute("/sharetribe-templates/$slug_/download")({
  loader: ({ params }) => {
    const template = getStoreTemplate(params.slug);
    if (!template) throw notFound();
    return { template };
  },
  validateSearch: (search: Record<string, unknown>): { session_id?: string } =>
    typeof search.session_id === "string" ? { session_id: search.session_id } : {},
  head: () => ({
    meta: [
      { title: "Your template download — founders.click" },
      // A receipt page: never index it.
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: DownloadPage,
});

type DownloadState =
  | { kind: "loading" }
  | { kind: "ready"; url: string; fileName: string; email: string | null }
  | { kind: "error"; text: string };

const DOWNLOAD_ERRORS: Record<string, string> = {
  not_paid:
    "We couldn't confirm a completed payment for this link. If you just paid, wait a few seconds and refresh.",
  invalid_session: "This download link is incomplete. Use the link from your checkout.",
  wrong_template: "This receipt is for a different template.",
  file_unavailable: "The file is temporarily unavailable. Please try again shortly.",
};

function DownloadPage() {
  const { template: t } = Route.useLoaderData();
  const { session_id } = Route.useSearch();
  const [state, setState] = useState<DownloadState>({ kind: "loading" });

  async function load() {
    if (!session_id) {
      setState({ kind: "error", text: DOWNLOAD_ERRORS.invalid_session });
      return;
    }
    setState({ kind: "loading" });
    const { data, error } = await supabase.functions.invoke<{
      url?: string;
      fileName?: string;
      email?: string | null;
    }>("template-download", { body: { session_id, slug: t.slug } });
    if (error || !data?.url) {
      let code: string | undefined;
      const ctx = (error as { context?: Response } | null)?.context;
      try {
        code = ((await ctx?.clone().json()) as { error?: string } | undefined)?.error;
      } catch {
        // not JSON
      }
      setState({
        kind: "error",
        text: (code && DOWNLOAD_ERRORS[code]) ?? "Something went wrong preparing your download.",
      });
      return;
    }
    setState({
      kind: "ready",
      url: data.url,
      fileName: data.fileName ?? `${t.slug}.zip`,
      email: data.email ?? null,
    });
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session_id, t.slug]);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-xl flex-1 px-6 py-16 text-center">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-brand">
          Sharetribe templates
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight">{t.name}</h1>

        {state.kind === "loading" ? (
          <p className="mt-8 text-muted-foreground">Confirming your payment…</p>
        ) : state.kind === "ready" ? (
          <div className="mt-8">
            <p className="text-lg">Thanks for your purchase — your download is ready.</p>
            {state.email ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Stripe sent your receipt to {state.email}.
              </p>
            ) : null}
            <Button asChild className="mt-8 h-12 px-8 text-base">
              <a href={state.url} download={state.fileName}>
                Download {state.fileName}
              </a>
            </Button>
            <p className="mt-6 text-sm text-muted-foreground">
              The button's link expires after 15 minutes. Bookmark this page to download again later
              — it creates a fresh link each time.
            </p>
            <div className="mt-10 rounded-xl border border-border p-5 text-left text-sm">
              <p className="font-semibold">Get started</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>Unzip the file and open the folder in your editor.</li>
                <li>
                  Run <code>npm install</code>, then <code>npm run dev</code>.
                </li>
                <li>Change the brand name and colors in the theme/brand file under src/.</li>
                <li>Read README.md for how the pages map to the Sharetribe Web Template.</li>
              </ol>
            </div>
          </div>
        ) : (
          <div className="mt-8">
            <p role="alert" className="text-destructive">
              {state.text}
            </p>
            <Button variant="outline" className="mt-6" onClick={() => void load()}>
              Try again
            </Button>
            <p className="mt-6 text-sm text-muted-foreground">
              Still stuck?{" "}
              <Link to="/help/contact" className="underline hover:text-foreground">
                Contact support
              </Link>{" "}
              with your Stripe receipt.
            </p>
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
