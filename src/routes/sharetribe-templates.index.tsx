import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { canonicalUrl } from "@/lib/canonical";
import {
  STORE_TEMPLATES,
  TEMPLATE_FLOW_LABEL,
  TEMPLATE_PAGES,
  formatTemplatePrice,
  templateThumbnailPath,
  type StoreTemplate,
} from "@/lib/template-store";

const TITLE = "Sharetribe Marketplace Templates — founders.click";
const DESCRIPTION =
  "Ready-to-launch marketplace designs built on the Sharetribe Web Template's own pages and flows: rentals, services, resale and venue booking. Live previews, instant download.";

export const Route = createFileRoute("/sharetribe-templates/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: canonicalUrl("/sharetribe-templates") },
      { name: "robots", content: "index, follow" },
    ],
    links: [{ rel: "canonical", href: canonicalUrl("/sharetribe-templates") }],
  }),
  component: TemplateStorePage,
});

function TemplateStorePage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="border-b border-border">
          <div className="mx-auto max-w-4xl px-6 py-16 text-center sm:py-20">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-brand">
              Sharetribe templates
            </p>
            <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight sm:text-5xl">
              Marketplace designs built on the Sharetribe template — not around it
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
              Most marketplace themes are mockups your developer has to reverse-engineer. These
              start from the Sharetribe Web Template's own pages and transaction flows, so every
              screen you buy maps to a page your marketplace already has.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2 text-sm">
              {["Buy a template", "Open it in Claude Code", "Add matching iOS & Android apps"].map(
                (step, i) => (
                  <span
                    key={step}
                    className="rounded-full border border-border px-3 py-1 text-muted-foreground"
                  >
                    {i + 1}. {step}
                  </span>
                ),
              )}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {STORE_TEMPLATES.map((t) => (
              <TemplateCard key={t.slug} template={t} />
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-14 sm:px-6">
          <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-border bg-gradient-to-r from-brand/10 to-transparent p-8 sm:flex-row sm:items-center">
            <div>
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-brand">
                Magic Designs by founders.click
              </p>
              <h2 className="mt-2 text-2xl font-bold tracking-tight">Need something custom?</h2>
              <p className="mt-1 max-w-xl text-muted-foreground">
                Describe your marketplace and get a custom design built on the Sharetribe template,
                refined with Sharetribe-aware changes and ready for your developer.
              </p>
            </div>
            <Link
              to="/magic-designs"
              className="inline-flex h-11 shrink-0 items-center rounded-md bg-brand px-6 font-semibold text-white hover:opacity-90"
            >
              Design yours →
            </Link>
          </div>
        </section>

        <section className="border-t border-border bg-muted/30">
          <div className="mx-auto max-w-4xl px-6 py-14">
            <h2 className="text-center text-2xl font-bold tracking-tight">
              Every template includes the core Sharetribe flows
            </h2>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {TEMPLATE_PAGES.map((p) => (
                <div
                  key={p.name}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background px-4 py-3"
                >
                  <span className="font-medium">{p.name}</span>
                  <code className="truncate text-xs text-muted-foreground">{p.sharetribe}</code>
                </div>
              ))}
            </div>
            <p className="mt-8 text-center text-sm text-muted-foreground">
              Each download is a standalone React + Tailwind project: run <code>npm install</code>{" "}
              and <code>npm run dev</code>, rebrand from one file, and port pages into your
              Sharetribe Web Template fork.
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

function TemplateCard({ template: t }: { template: StoreTemplate }) {
  return (
    <Link
      to="/sharetribe-templates/$slug"
      params={{ slug: t.slug }}
      className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <div
        className="relative aspect-[4/3] overflow-hidden border-b border-border"
        style={{ backgroundColor: t.accent }}
      >
        {/* A screenshot, not a live iframe: an iframe per card is heavy and
            renders blank wherever framing or third-party loading is blocked. */}
        <img
          src={templateThumbnailPath(t.slug)}
          alt={`${t.name} template landing page`}
          loading="lazy"
          width={960}
          height={720}
          className="absolute inset-0 h-full w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.02]"
        />
      </div>
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-lg font-bold">{t.name}</h2>
          <span className="text-lg font-bold">{formatTemplatePrice(t.priceCents)}</span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{t.tagline}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            {t.niche}
          </span>
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            {TEMPLATE_FLOW_LABEL[t.flow]}
          </span>
        </div>
        <span className="mt-5 text-sm font-semibold text-brand group-hover:underline">
          View template →
        </span>
      </div>
    </Link>
  );
}
