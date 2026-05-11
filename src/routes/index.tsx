import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Sparkles, FileText, Search, Users, Zap, Brain, DollarSign } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "founders.click — The growth engine for Sharetribe marketplaces" },
      { name: "description", content: "AI-powered SEO, content factory, lead inbox and ops dashboard for Sharetribe marketplace founders. Replace your agency. Move at AI speed." },
      { property: "og:title", content: "founders.click — The growth engine for Sharetribe marketplaces" },
      { property: "og:description", content: "AI page generation at $0.012/page, competitor radar, rank tracking, lead hunting — all in one admin." },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="dark min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link to="/" className="text-lg font-bold tracking-tight">
            founders<span className="text-orange-500">.click</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link to="/login" className="text-muted-foreground hover:text-foreground">Sign in</Link>
            <Button asChild size="sm"><Link to="/signup">Start free trial</Link></Button>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 py-20 text-center">
        <p className="text-sm uppercase tracking-widest text-orange-500 mb-4">For Sharetribe marketplace founders</p>
        <h1 className="text-5xl md:text-7xl font-bold tracking-tight">
          The all-in-one growth engine.
        </h1>
        <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
          Custom-coded SEO, AI content generation, competitor radar, lead hunting and ops — without the agency price tag.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Button asChild size="lg"><Link to="/signup">Start your free trial</Link></Button>
          <Button asChild size="lg" variant="outline"><Link to="/login">Sign in</Link></Button>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">14-day trial · 250 free credits · No card required</p>
      </section>

      {/* Product demo video */}
      <section className="max-w-5xl mx-auto px-6 pb-16">
        <div className="rounded-xl border border-border overflow-hidden bg-black shadow-2xl shadow-orange-500/10">
          <video
            src="/product-demo.mp4"
            controls
            playsInline
            preload="metadata"
            className="w-full h-auto block"
          />
        </div>
        <p className="text-center text-xs text-muted-foreground mt-3">Product demo — see the Content Factory in action</p>
      </section>

      {/* Feature grid (the 7 slides condensed) */}
      <section className="max-w-6xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold mb-10">Everything you need in one admin</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div key={f.title} className="rounded-lg border border-border p-6 bg-card">
                <Icon className="h-6 w-6 text-orange-500 mb-3" />
                <h3 className="font-semibold mb-1">{f.title}</h3>
                <p className="text-sm text-muted-foreground">{f.body}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Pricing */}
      <section className="max-w-6xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold mb-2">Pricing</h2>
        <p className="text-sm text-muted-foreground mb-10">Subscription + monthly AI credits. Top up anytime.</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {PLANS.map((p) => (
            <div key={p.name} className={`rounded-lg border p-6 ${p.featured ? "border-orange-500/50 bg-orange-500/5" : "border-border bg-card"}`}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xl font-semibold">{p.name}</h3>
                {p.featured && <span className="text-xs px-2 py-0.5 bg-orange-500 text-white rounded">Popular</span>}
              </div>
              <div className="mb-3">
                <span className="text-4xl font-bold">${p.price}</span>
                <span className="text-muted-foreground">/mo</span>
              </div>
              <p className="text-sm text-orange-500 mb-4">{p.credits.toLocaleString()} AI credits / mo</p>
              <ul className="space-y-1.5 text-sm text-muted-foreground mb-6">
                {p.features.map((feat) => <li key={feat}>• {feat}</li>)}
              </ul>
              <Button asChild className="w-full" variant={p.featured ? "default" : "outline"}>
                <Link to="/signup">Start trial</Link>
              </Button>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-6 text-center">Need more credits? Top up at $10 per 1,000. Never expire.</p>
      </section>

      {/* CTA */}
      <section className="max-w-3xl mx-auto px-6 py-20 text-center">
        <h2 className="text-4xl font-bold">Ready to ship like a funded startup?</h2>
        <p className="mt-4 text-muted-foreground">Solo founders and lean teams use founders.click to compete with agency-backed competitors.</p>
        <Button asChild size="lg" className="mt-8"><Link to="/signup">Start your free trial</Link></Button>
      </section>

      <footer className="border-t border-border py-8 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} founders.click
      </footer>
    </div>
  );
}

const FEATURES = [
  { icon: Sparkles, title: "Dashboard", body: "Morning command center with live KPIs and AI-ranked action items." },
  { icon: FileText, title: "Content Factory", body: "Generate hundreds of SEO pages per day at ~$0.012 each." },
  { icon: Search, title: "SEO Intelligence", body: "Competitor radar, rank tracking, AI page auditor, keyword opportunities." },
  { icon: Users, title: "Lead Inbox", body: "Triage host/provider leads. Daily IG, TikTok, Nextdoor scraping built in." },
  { icon: Zap, title: "Move at AI Speed", body: "Publish 200 pages/day, fix 300 internal links in one click." },
  { icon: Brain, title: "SEO Coach AI", body: 'Grounded in your live site data. Ask "what should I do today?" and get step-by-step fixes.' },
];

const PLANS = [
  { name: "Starter", price: 99, credits: 1000, features: ["AI Page Builder", "Bulk Editor", "GSC sync", "1 marketplace"] },
  { name: "Pro", price: 249, credits: 5000, featured: true, features: ["Everything in Starter", "Competitor Radar", "Rank Tracker", "Lead Inbox", "3 marketplaces"] },
  { name: "Scale", price: 599, credits: 15000, features: ["Everything in Pro", "IG Lead Hunter", "Email Verify", "SEO Coach AI", "Unlimited marketplaces"] },
];
