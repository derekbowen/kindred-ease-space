import { useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { canonicalUrl } from "@/lib/canonical";
import {
  TEMPLATE_FLOW_LABEL,
  TEMPLATE_PAGES,
  formatTemplatePrice,
  getStoreTemplate,
  templatePreviewPath,
  templateThumbnailPath,
} from "@/lib/template-store";

export const Route = createFileRoute("/sharetribe-templates/$slug")({
  loader: ({ params }) => {
    const template = getStoreTemplate(params.slug);
    if (!template) throw notFound();
    return { template };
  },
  head: ({ loaderData }) => {
    const t = loaderData?.template;
    if (!t) return {};
    const title = `${t.name} — ${t.tagline} | Sharetribe template`;
    const url = canonicalUrl(`/sharetribe-templates/${t.slug}`);
    return {
      meta: [
        { title },
        { name: "description", content: t.description },
        { property: "og:title", content: title },
        { property: "og:description", content: t.description },
        { property: "og:type", content: "product" },
        { property: "og:image", content: canonicalUrl(templateThumbnailPath(t.slug)) },
        { name: "twitter:card", content: "summary_large_image" },
        { property: "og:url", content: url },
        { name: "robots", content: "index, follow" },
      ],
      links: [{ rel: "canonical", href: url }],
      scripts: [
        {
          type: "application/ld+json",
          children: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Product",
            name: `${t.name} Sharetribe marketplace template`,
            description: t.description,
            offers: {
              "@type": "Offer",
              price: (t.priceCents / 100).toFixed(2),
              priceCurrency: "USD",
              availability: "https://schema.org/InStock",
              url,
            },
          }),
        },
      ],
    };
  },
  validateSearch: (search: Record<string, unknown>): { canceled?: 1 } =>
    search.canceled ? { canceled: 1 } : {},
  component: TemplateDetailPage,
});

const CHECKOUT_ERRORS: Record<string, string> = {
  not_available_yet: "This template isn't available for download yet. Please check back soon.",
  unknown_template: "That template doesn't exist.",
};

function TemplateDetailPage() {
  const { template: t } = Route.useLoaderData();
  const { canceled } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function buy() {
    setBusy(true);
    setError(null);
    const { data, error: fnError } = await supabase.functions.invoke<{ url?: string }>(
      "template-checkout",
      { body: { slug: t.slug } },
    );
    if (fnError || !data?.url) {
      let code: string | undefined;
      const ctx = (fnError as { context?: Response } | null)?.context;
      try {
        code = ((await ctx?.clone().json()) as { error?: string } | undefined)?.error;
      } catch {
        // not JSON
      }
      setError(
        (code && CHECKOUT_ERRORS[code]) ?? "Checkout couldn't start. Please try again in a moment.",
      );
      setBusy(false);
      return;
    }
    window.location.assign(data.url);
  }

  const preview = templatePreviewPath(t.slug);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
        <Link
          to="/sharetribe-templates"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← All templates
        </Link>

        <div className="mt-6 grid gap-10 lg:grid-cols-[1fr_340px]">
          <div className="min-w-0">
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t.name}</h1>
            <p className="mt-2 text-lg text-muted-foreground">{t.tagline}</p>

            <div className="mt-6 overflow-hidden rounded-2xl border border-border shadow-sm">
              <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2">
                <span className="h-3 w-3 rounded-full bg-red-400" />
                <span className="h-3 w-3 rounded-full bg-yellow-400" />
                <span className="h-3 w-3 rounded-full bg-green-400" />
                <span className="ml-3 truncate text-xs text-muted-foreground">
                  Live preview — click around, every page works
                </span>
              </div>
              <iframe
                src={preview}
                title={`${t.name} live preview`}
                className="h-[70vh] min-h-[480px] w-full border-0 bg-white"
              />
            </div>

            <h2 className="mt-12 text-xl font-bold">About this template</h2>
            <p className="mt-3 text-muted-foreground">{t.description}</p>

            <h2 className="mt-10 text-xl font-bold">Highlights</h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-muted-foreground">
              {t.highlights.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>

            <h2 className="mt-10 text-xl font-bold">Make it yours with Claude Code</h2>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-muted-foreground">
              <li>Buy and download the project.</li>
              <li>
                Open the folder in{" "}
                <a
                  href="https://claude.com/claude-code"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  Claude Code
                </a>
                .
              </li>
              <li>
                Ask for your changes in plain words: your brand, your listing fields, your copy. The
                README and the single brand file tell Claude where everything lives.
              </li>
            </ol>

            <h2 className="mt-10 text-xl font-bold">Pages included</h2>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {TEMPLATE_PAGES.map((p) => (
                <div
                  key={p.name}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
                >
                  <span>{p.name}</span>
                  <code className="truncate text-xs text-muted-foreground">{p.sharetribe}</code>
                </div>
              ))}
            </div>
          </div>

          <aside className="lg:sticky lg:top-20 lg:self-start">
            <div className="rounded-2xl border border-border p-6 shadow-sm">
              <div className="text-3xl font-bold">{formatTemplatePrice(t.priceCents)}</div>
              <p className="mt-1 text-sm text-muted-foreground">
                One-time payment · commercial license
              </p>
              {canceled ? (
                <p className="mt-4 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                  Checkout was canceled — you weren't charged.
                </p>
              ) : null}
              <Button className="mt-6 h-12 w-full text-base" onClick={buy} disabled={busy}>
                {busy ? "Opening checkout…" : "Buy & download"}
              </Button>
              {error ? (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <a
                href={preview}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex h-11 w-full items-center justify-center rounded-md border border-border text-sm font-medium hover:bg-muted"
              >
                Open full preview ↗
              </a>

              <div className="mt-6 rounded-xl border border-border bg-muted/40 p-4">
                <p className="text-sm font-semibold">Want it on iOS & Android too?</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  We build matching native apps for this design and publish them to the App Store
                  and Google Play under your name.
                </p>
                <Link
                  to="/help/contact"
                  search={{
                    category: "sales",
                    subject: `iOS & Android apps for ${t.name}`,
                  }}
                  className="mt-3 inline-flex h-10 w-full items-center justify-center rounded-md bg-foreground text-sm font-medium text-background hover:opacity-90"
                >
                  Get the iOS & Android apps
                </Link>
              </div>

              <dl className="mt-6 space-y-3 border-t border-border pt-6 text-sm">
                <Row label="Niche" value={t.niche} />
                <Row label="Transaction flow" value={TEMPLATE_FLOW_LABEL[t.flow]} />
                <Row label="Built on" value="Sharetribe Web Template" />
                <Row label="Stack" value="React + Tailwind" />
              </dl>

              <div className="mt-6 border-t border-border pt-6">
                <p className="text-sm font-semibold">Best for</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {t.bestFor.map((b) => (
                    <span
                      key={b}
                      className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground"
                    >
                      {b}
                    </span>
                  ))}
                </div>
              </div>

              <p className="mt-6 text-xs text-muted-foreground">
                You download the full source project with every image included. Payments are
                processed by Stripe; your download link appears right after checkout.
              </p>
            </div>
          </aside>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
