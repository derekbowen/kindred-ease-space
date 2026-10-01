import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { Button } from "@/components/ui/button";
import { canonicalUrl } from "@/lib/canonical";
import {
  CHANGE_PRESETS,
  DESIGN_TOKEN_COSTS,
  DESIGN_TOKEN_PACKS,
  MAGIC_DESIGN_BASES,
  formatTokenPackPrice,
} from "@/lib/magic-designs";
import { templateThumbnailPath } from "@/lib/template-store";

const TITLE = "Magic Designs — custom Sharetribe marketplace designs | founders.click";
const DESCRIPTION =
  "Describe your marketplace and get a custom design built on the Sharetribe Web Template's pages and flows. Refine it with Sharetribe-aware changes, then hand your developer a ready-to-plug-in project.";

export const Route = createFileRoute("/magic-designs")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: canonicalUrl("/magic-designs") },
      { name: "robots", content: "index, follow" },
    ],
    links: [{ rel: "canonical", href: canonicalUrl("/magic-designs") }],
  }),
  component: MagicDesignsLanding,
});

const STEPS = [
  {
    title: "Pick a starting point",
    body: "Choose one of our Sharetribe templates — rentals, services, resale, venues, stays, studios, yoga and more.",
  },
  {
    title: "Describe your marketplace",
    body: "What's listed, who lists and books, your Sharetribe transaction flow, layout, brand color and style.",
  },
  {
    title: "Refine it",
    body: "Request changes in plain words or one click — every option maps to something the Sharetribe Web Template supports.",
  },
  {
    title: "Hand it to your developer",
    body: "Download a standalone React + Tailwind project with SHARETRIBE_SETUP.md: the exact Console settings to match.",
  },
];

function MagicDesignsLanding() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SiteHeader />
      <main className="flex-1">
        <section className="border-b border-border">
          <div className="mx-auto max-w-4xl px-6 py-16 text-center sm:py-20">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-brand">
              Magic Designs by founders.click
            </p>
            <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight sm:text-5xl">
              Your marketplace, designed on the Sharetribe template in minutes
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">{DESCRIPTION}</p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button asChild size="lg">
                <Link to="/app/magic-designs">Start a custom design</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/sharetribe-templates">Browse ready-made templates</Link>
              </Button>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-14">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <div key={s.title} className="rounded-2xl border border-border p-5">
                <div className="text-sm font-semibold text-brand">Step {i + 1}</div>
                <h2 className="mt-1 font-semibold">{s.title}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-y border-border bg-muted/30">
          <div className="mx-auto max-w-6xl px-6 py-14">
            <h2 className="text-center text-2xl font-bold tracking-tight">
              Start from any of our templates
            </h2>
            <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {MAGIC_DESIGN_BASES.map((b) => (
                <div
                  key={b.slug}
                  className="overflow-hidden rounded-xl border border-border bg-background"
                >
                  <img
                    src={templateThumbnailPath(b.slug)}
                    alt={`${b.name} template`}
                    loading="lazy"
                    width={960}
                    height={720}
                    className="aspect-[4/3] w-full object-cover object-top"
                  />
                  <div className="p-3">
                    <div className="text-sm font-semibold">{b.name}</div>
                    <div className="text-xs text-muted-foreground">{b.niche}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-6 py-14">
          <h2 className="text-center text-2xl font-bold tracking-tight">
            Sharetribe-aware changes
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">
            Ask for anything in plain words, or use one-click changes built from the Sharetribe
            docs:
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {CHANGE_PRESETS.map((p) => (
              <span
                key={p.key}
                className="rounded-full border border-border px-3 py-1 text-sm text-muted-foreground"
              >
                {p.label}
              </span>
            ))}
          </div>
        </section>

        <section className="border-t border-border bg-muted/30">
          <div className="mx-auto max-w-4xl px-6 py-14 text-center">
            <h2 className="text-2xl font-bold tracking-tight">Simple token pricing</h2>
            <p className="mt-3 text-muted-foreground">
              A new design is {DESIGN_TOKEN_COSTS.create} tokens, each change{" "}
              {DESIGN_TOKEN_COSTS.change} tokens, downloads are free, and tokens never expire.
            </p>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              {DESIGN_TOKEN_PACKS.map((p) => (
                <div key={p.key} className="rounded-2xl border border-border bg-background p-6">
                  <div className="text-3xl font-bold">{formatTokenPackPrice(p.priceCents)}</div>
                  <div className="mt-1 font-semibold">
                    {p.label} · {p.tokens} tokens
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {Math.floor(p.tokens / DESIGN_TOKEN_COSTS.create)} new designs, or one design
                    and{" "}
                    {Math.floor((p.tokens - DESIGN_TOKEN_COSTS.create) / DESIGN_TOKEN_COSTS.change)}{" "}
                    changes
                  </div>
                </div>
              ))}
            </div>
            <Button asChild size="lg" className="mt-8">
              <Link to="/app/magic-designs">Get started — free account</Link>
            </Button>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
