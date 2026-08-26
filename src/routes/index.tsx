import { useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  Factory,
  Inbox,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Share2,
  Sparkles,
  X,
} from "lucide-react";
import { canonicalUrl } from "@/lib/canonical";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "founders.click — The growth engine for Sharetribe marketplaces" },
      {
        name: "description",
        content:
          "AI-powered SEO, content generation, competitor radar and lead hunting for Sharetribe marketplace founders. 14-day free trial, no card required.",
      },
      {
        property: "og:title",
        content: "founders.click — The growth engine for Sharetribe marketplaces",
      },
      {
        property: "og:description",
        content:
          "AI page generation from pennies per page, competitor radar, rank tracking, lead hunting — all in one admin.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: canonicalUrl("/") },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "founders.click — Growth engine for Sharetribe" },
      {
        name: "twitter:description",
        content: "AI SEO + content factory + lead inbox for marketplace founders.",
      },
    ],
    links: [{ rel: "canonical", href: canonicalUrl("/") }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "founders.click",
          applicationCategory: "BusinessApplication",
          operatingSystem: "Web",
          description:
            "AI-powered SEO, content factory, lead inbox and ops dashboard for Sharetribe marketplace founders.",
          offers: {
            "@type": "AggregateOffer",
            priceCurrency: "USD",
            lowPrice: "99",
            highPrice: "599",
          },
        }),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: FAQS.map((f) => ({
            "@type": "Question",
            name: f.question,
            acceptedAnswer: { "@type": "Answer", text: f.answer },
          })),
        }),
      },
    ],
  }),
  component: Landing,
});

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]";

function Landing() {
  return (
    <div className="dark min-h-screen bg-[#0a0a0a] text-foreground antialiased selection:bg-orange-500/30 selection:text-white">
      <SiteHeader />
      <main>
        <Hero />
        <ProductDemo />
        <ProblemFix />
        <Features />
        <HowItWorks />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden pb-14 pt-20 sm:pb-20 sm:pt-28">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-0 h-[520px] w-[900px] max-w-[140vw] -translate-x-1/2 rounded-full opacity-60 blur-[120px]"
        style={{
          background:
            "radial-gradient(circle at center, rgba(249,115,22,0.30) 0%, rgba(249,115,22,0.10) 45%, rgba(10,10,10,0) 70%)",
        }}
      />
      <div className="relative mx-auto w-full max-w-4xl px-5 text-center sm:px-8">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-orange-500">
          For Sharetribe marketplace founders
        </p>
        <h1 className="mt-6 text-[2.75rem] font-semibold leading-[1.02] tracking-[-0.04em] text-white sm:text-6xl lg:text-7xl">
          The all-in-one growth engine.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-zinc-400 sm:text-lg">
          Custom-coded SEO, AI content generation, competitor radar, lead hunting and ops — without
          the agency price tag.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/signup"
            className={`group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-orange-500 px-6 py-3.5 text-sm font-semibold text-black shadow-[0_0_40px_-8px_rgba(249,115,22,0.8)] transition-colors hover:bg-orange-400 sm:w-auto ${FOCUS_RING}`}
          >
            Start your free trial
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <a
            href="#demo"
            className={`inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/[0.12] px-6 py-3.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/[0.06] hover:text-white sm:w-auto ${FOCUS_RING}`}
          >
            <Play className="h-4 w-4" />
            Watch the demo
          </a>
        </div>
        <p className="mt-6 text-xs text-zinc-500">
          14-day trial · 250 free credits · No card required
        </p>
      </div>
    </section>
  );
}

function ProductDemo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  return (
    <section id="demo" aria-label="Product demo" className="relative scroll-mt-24">
      <div className="mx-auto w-full max-w-6xl px-5 sm:px-8">
        <figure>
          <div className="group relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.02] p-1.5 shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)]">
            <div className="relative aspect-video overflow-hidden rounded-xl bg-[#0d0d0d]">
              <video
                ref={videoRef}
                controls={playing}
                playsInline
                muted
                preload="metadata"
                poster="/product-demo-poster.jpg"
                className="h-full w-full object-cover"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
              >
                <source src="/product-demo.mp4" type="video/mp4" />
                Your browser does not support the video tag.{" "}
                <a href="/product-demo.mp4" className="underline">
                  Download the demo
                </a>
                .
              </video>
              {!playing && (
                <button
                  type="button"
                  aria-label="Play product demo video"
                  onClick={() => videoRef.current?.play()}
                  className={`absolute inset-0 flex items-center justify-center bg-black/30 transition-colors hover:bg-black/20 ${FOCUS_RING}`}
                >
                  <span className="flex h-16 w-16 items-center justify-center rounded-full bg-orange-500 text-black shadow-[0_0_50px_-6px_rgba(249,115,22,0.9)] transition-transform group-hover:scale-105">
                    <Play className="ml-0.5 h-6 w-6 fill-black" />
                  </span>
                </button>
              )}
            </div>
          </div>
          <figcaption className="mt-4 text-center text-sm text-zinc-500">
            See the Content Factory in action
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

const PAINS = [
  "Agencies charge thousands a month and report on vanity metrics.",
  "Freelancers ghost you halfway through the content calendar.",
  "Your competitors are publishing pages faster than you can write them.",
];

const FIXES = [
  "One subscription, no retainer, no scope calls.",
  "Pages generated from your real listings — in minutes, not sprints.",
  "A daily briefing telling you the single highest-ROI thing to ship.",
];

function ProblemFix() {
  return (
    <section className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8 sm:py-32">
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-8 sm:p-10">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-500">
            The problem
          </p>
          <h2 className="mt-5 text-3xl font-semibold leading-[1.1] tracking-[-0.03em] text-white sm:text-4xl">
            Growth is a full-time job you can&apos;t afford to hire for.
          </h2>
          <ul className="mt-8 space-y-4">
            {PAINS.map((pain) => (
              <li key={pain} className="flex gap-3 text-sm text-zinc-400">
                <X className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" />
                <span>{pain}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-2xl border border-orange-500/25 bg-orange-500/[0.04] p-8 shadow-[0_0_80px_-40px_rgba(249,115,22,0.7)] sm:p-10">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-orange-500">
            The fix
          </p>
          <h2 className="mt-5 text-3xl font-semibold leading-[1.1] tracking-[-0.03em] text-white sm:text-4xl">
            Ship the output of a growth team. Solo.
          </h2>
          <ul className="mt-8 space-y-4">
            {FIXES.map((fix) => (
              <li key={fix} className="flex gap-3 text-sm text-zinc-300">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
                <span>{fix}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

const FEATURES = [
  {
    icon: Factory,
    title: "Content Factory",
    description: "Generate SEO landing pages in bulk from your live listings.",
  },
  {
    icon: Radar,
    title: "SEO Intelligence",
    description: "Competitor radar, rank tracking, AI page auditor, keyword gaps.",
  },
  {
    icon: Sparkles,
    title: "AI Growth Coach",
    description: "A daily briefing that ranks your highest-ROI actions.",
  },
  {
    icon: Inbox,
    title: "Lead Inbox",
    description: "Capture and triage host/provider leads in one place.",
  },
  {
    icon: RefreshCw,
    title: "Sharetribe Sync",
    description: "Your listings, synced automatically in the background.",
  },
  {
    icon: Share2,
    title: "Affiliate Programs",
    description: "Run referral programs that pay out on real transactions.",
  },
];

function Features() {
  return (
    <section
      id="features"
      aria-labelledby="features-heading"
      className="mx-auto w-full max-w-6xl scroll-mt-24 px-5 py-24 sm:px-8 sm:py-28"
    >
      <div className="max-w-2xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-orange-500">
          Everything included
        </p>
        <h2
          id="features-heading"
          className="mt-5 text-4xl font-semibold leading-[1.05] tracking-[-0.035em] text-white sm:text-5xl"
        >
          One engine. Every growth surface.
        </h2>
      </div>

      <ul className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(({ icon: Icon, title, description }) => (
          <li key={title}>
            <div className="group h-full rounded-2xl border border-white/[0.08] bg-white/[0.02] p-7 transition-all duration-300 hover:-translate-y-1 hover:border-orange-500/40 hover:shadow-[0_0_50px_-20px_rgba(249,115,22,0.8)]">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-orange-500/20 bg-orange-500/10">
                <Icon className="h-5 w-5 text-orange-500" aria-hidden="true" />
              </span>
              <h3 className="mt-6 text-base font-semibold tracking-tight text-white">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">{description}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const STEPS = [
  {
    number: "1",
    title: "Connect your marketplace",
    description:
      "Add your Sharetribe Integration API credentials. We pull your listings, categories and locations automatically.",
  },
  {
    number: "2",
    title: "Generate your pages",
    description:
      "The Content Factory turns your live inventory into indexable landing pages, grounded in real listing data.",
  },
  {
    number: "3",
    title: "Publish on your domain",
    description:
      "Connect and verify your own domain, then track positions and let the Growth Coach tell you what to ship next.",
  },
];

function HowItWorks() {
  return (
    <section aria-labelledby="how-heading" className="border-y border-white/[0.08] bg-white/[0.015]">
      <div className="mx-auto w-full max-w-6xl px-5 py-24 sm:px-8 sm:py-28">
        <div className="max-w-2xl">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-orange-500">
            How it works
          </p>
          <h2
            id="how-heading"
            className="mt-5 text-4xl font-semibold leading-[1.05] tracking-[-0.035em] text-white sm:text-5xl"
          >
            Live in an afternoon.
          </h2>
        </div>

        <ol className="relative mt-16 grid grid-cols-1 gap-12 md:grid-cols-3 md:gap-8">
          <div
            aria-hidden="true"
            className="absolute left-5 top-0 hidden h-full w-px bg-white/[0.08] md:left-0 md:top-5 md:block md:h-px md:w-full"
          />
          {STEPS.map((step) => (
            <li key={step.number} className="relative">
              <span className="flex h-10 w-10 items-center justify-center rounded-full border border-orange-500/30 bg-[#0a0a0a] font-mono text-sm font-medium text-orange-500">
                {step.number}
              </span>
              <h3 className="mt-6 text-lg font-semibold tracking-tight text-white">{step.title}</h3>
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-zinc-400">
                {step.description}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// Tiers differ by monthly credit allowance only — every feature is available on
// every plan. Page estimates are approximate and depend on page length.
const PLANS = [
  {
    name: "Starter",
    price: "$99",
    credits: "500 AI credits/mo",
    pages: "≈ 40 generated pages a month",
    blurb: "For a marketplace finding its first organic traffic.",
    featured: false,
  },
  {
    name: "Pro",
    price: "$249",
    credits: "2,500 AI credits/mo",
    pages: "≈ 200 generated pages a month",
    blurb: "For operators publishing city and category pages at pace.",
    featured: true,
  },
  {
    name: "Scale",
    price: "$599",
    credits: "10,000 AI credits/mo",
    pages: "≈ 800 generated pages a month",
    blurb: "For national coverage and aggressive expansion.",
    featured: false,
  },
];

const INCLUDED = [
  "Content Factory",
  "SEO Intelligence",
  "AI Growth Coach",
  "Lead Inbox",
  "Sharetribe Sync",
  "Custom domain",
];

function Pricing() {
  return (
    <section
      id="pricing"
      aria-labelledby="pricing-heading"
      className="mx-auto w-full max-w-6xl scroll-mt-24 px-5 py-24 sm:px-8 sm:py-32"
    >
      <div className="mx-auto max-w-2xl text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-orange-500">Pricing</p>
        <h2
          id="pricing-heading"
          className="mt-5 text-4xl font-semibold leading-[1.05] tracking-[-0.035em] text-white sm:text-5xl"
        >
          Less than one agency invoice.
        </h2>
        <p className="mt-5 text-sm text-zinc-400">
          Every plan unlocks every feature. Pick a plan for how much you publish — not for which
          tools you&apos;re allowed to use.
        </p>
      </div>

      <div className="mt-14 grid grid-cols-1 gap-5 lg:grid-cols-3">
        {PLANS.map((tier) => (
          <div
            key={tier.name}
            className={`relative flex flex-col rounded-2xl border p-8 ${
              tier.featured
                ? "border-orange-500/60 bg-orange-500/[0.04] shadow-[0_0_90px_-40px_rgba(249,115,22,0.9)]"
                : "border-white/[0.08] bg-white/[0.02]"
            }`}
          >
            {tier.featured && (
              <span className="absolute -top-3 left-8 rounded-full bg-orange-500 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-black">
                Most popular
              </span>
            )}

            <h3 className="text-sm font-medium uppercase tracking-[0.14em] text-zinc-400">
              {tier.name}
            </h3>

            <p className="mt-6 flex items-baseline gap-1">
              <span className="text-5xl font-semibold tracking-[-0.04em] text-white">
                {tier.price}
              </span>
              <span className="text-sm text-zinc-500">/mo</span>
            </p>

            <p className="mt-3 font-mono text-sm text-orange-500">{tier.credits}</p>

            <div className="mt-8 flex-1 space-y-3.5">
              <p className="flex gap-3 text-sm text-zinc-300">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" aria-hidden="true" />
                <span>{tier.pages}</span>
              </p>
              <p className="flex gap-3 text-sm text-zinc-300">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" aria-hidden="true" />
                <span>Every feature unlocked — no gates</span>
              </p>
              <p className="text-sm leading-relaxed text-zinc-500">{tier.blurb}</p>
            </div>

            <Link
              to="/signup"
              className={`mt-9 w-full rounded-xl px-5 py-3 text-center text-sm font-semibold transition-colors ${FOCUS_RING} ${
                tier.featured
                  ? "bg-orange-500 text-black shadow-[0_0_40px_-10px_rgba(249,115,22,0.9)] hover:bg-orange-400"
                  : "border border-white/[0.12] text-white hover:bg-white/[0.06]"
              }`}
            >
              Start free trial
            </Link>
          </div>
        ))}
      </div>

      <div className="mt-12 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-8">
        <p className="text-center font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-500">
          Every plan includes
        </p>
        <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
          {INCLUDED.map((item) => (
            <li key={item} className="flex items-center gap-2 text-sm text-zinc-300">
              <Check className="h-4 w-4 shrink-0 text-orange-500" aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-8 text-center text-sm text-zinc-500">
        Run out? Top up at $10 per 1,000 credits. Purchased credits never expire.
      </p>
    </section>
  );
}

const FAQS = [
  {
    question: "Do I need to be technical?",
    answer:
      "No. You connect your Sharetribe marketplace with your Integration API credentials, and everything else happens in the dashboard. If you can publish a listing, you can run founders.click.",
  },
  {
    question: "What is a credit?",
    answer:
      "A credit is one unit of AI work — generating a landing page, auditing a page, or running a competitor scan. A typical landing page costs roughly 5 to 15 credits depending on its length, so the 250 free trial credits cover your first batch of pages.",
  },
  {
    question: "Can I use my own domain?",
    answer:
      "Yes. Add your domain under Settings, verify it with a DNS record or a file upload, and your generated pages serve on your own domain with self-referential canonical tags.",
  },
  {
    question: "Does it work with any Sharetribe marketplace?",
    answer:
      "It works with Sharetribe marketplaces of any category — rentals, services, gear and local marketplaces. Pages are generated from your real listing data, including city, category and pricing fields.",
  },
  {
    question: "Can I cancel anytime?",
    answer:
      "Anytime, from the billing portal in your dashboard. Your subscription stays active until the end of the period you have already paid for, and purchased top-up credits never expire.",
  },
];

function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section
      id="faq"
      aria-labelledby="faq-heading"
      className="mx-auto w-full max-w-3xl scroll-mt-24 px-5 py-24 sm:px-8 sm:py-28"
    >
      <h2
        id="faq-heading"
        className="text-4xl font-semibold leading-[1.05] tracking-[-0.035em] text-white sm:text-5xl"
      >
        Questions, answered.
      </h2>

      <div className="mt-12 divide-y divide-white/[0.08] border-y border-white/[0.08]">
        {FAQS.map((faq, index) => {
          const isOpen = openIndex === index;
          return (
            <div key={faq.question}>
              <h3>
                <button
                  type="button"
                  onClick={() => setOpenIndex(isOpen ? null : index)}
                  aria-expanded={isOpen}
                  aria-controls={`faq-panel-${index}`}
                  id={`faq-button-${index}`}
                  className={`flex w-full items-center justify-between gap-6 py-5 text-left ${FOCUS_RING}`}
                >
                  <span className="text-base font-medium text-white">{faq.question}</span>
                  <Plus
                    aria-hidden="true"
                    className={`h-4 w-4 shrink-0 text-orange-500 transition-transform duration-200 ${
                      isOpen ? "rotate-45" : ""
                    }`}
                  />
                </button>
              </h3>
              <div
                id={`faq-panel-${index}`}
                role="region"
                aria-labelledby={`faq-button-${index}`}
                hidden={!isOpen}
              >
                <p className="pb-6 pr-10 text-sm leading-relaxed text-zinc-400">{faq.answer}</p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section
      aria-labelledby="final-cta-heading"
      className="relative overflow-hidden border-y border-white/[0.08]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 120% at 50% 120%, rgba(249,115,22,0.22) 0%, rgba(249,115,22,0.06) 45%, rgba(10,10,10,0) 75%)",
        }}
      />
      <div className="relative mx-auto w-full max-w-3xl px-5 py-24 text-center sm:px-8 sm:py-32">
        <h2
          id="final-cta-heading"
          className="text-4xl font-semibold leading-[1.05] tracking-[-0.035em] text-white sm:text-5xl"
        >
          Ready to ship like a funded startup?
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-base text-zinc-400">
          Connect your marketplace and generate your first pages today.
        </p>
        <Link
          to="/signup"
          className={`group mt-9 inline-flex items-center justify-center gap-2 rounded-xl bg-orange-500 px-7 py-3.5 text-sm font-semibold text-black shadow-[0_0_50px_-10px_rgba(249,115,22,0.9)] transition-colors hover:bg-orange-400 ${FOCUS_RING}`}
        >
          Start your free trial
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </section>
  );
}
