import { createFileRoute, Link } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/app/billing")({
  head: () => ({ meta: [{ title: "Billing & Credits — founders.click" }] }),
  component: BillingPage,
});

const PLANS = [
  {
    name: "Starter",
    price: 99,
    credits: 1000,
    features: ["AI Page Builder", "Bulk Editor", "GSC sync", "1 marketplace"],
  },
  {
    name: "Pro",
    price: 249,
    credits: 5000,
    featured: true,
    features: ["Everything in Starter", "Competitor Radar", "Rank Tracker", "Lead Inbox", "3 marketplaces"],
  },
  {
    name: "Scale",
    price: 599,
    credits: 15000,
    features: ["Everything in Pro", "IG Lead Hunter", "Email Verify (100k credits)", "SEO Coach AI", "Unlimited marketplaces"],
  },
];

function BillingPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Billing & Credits</h1>
        <p className="text-sm text-muted-foreground">Pick a plan. Top up extra credits anytime at $10 per 1,000.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Stripe checkout — coming online</CardTitle>
          <CardDescription>
            Plans below are confirmed pricing. Checkout activates as soon as Stripe is connected.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" disabled>Connect Stripe (admin)</Button>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {PLANS.map((p) => (
          <Card key={p.name} className={p.featured ? "border-orange-500/50" : ""}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{p.name}</CardTitle>
                {p.featured && <Badge className="bg-orange-500">Popular</Badge>}
              </div>
              <div className="pt-2">
                <span className="text-3xl font-bold">${p.price}</span>
                <span className="text-sm text-muted-foreground">/mo</span>
              </div>
              <CardDescription>{p.credits.toLocaleString()} AI credits / month</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {p.features.map((f) => (
                  <li key={f}>• {f}</li>
                ))}
              </ul>
              <Button className="w-full mt-4" disabled variant={p.featured ? "default" : "outline"}>
                Choose {p.name}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Need more credits?</CardTitle>
          <CardDescription>Top-ups carry over and never expire.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          $10 per 1,000 credits. Available once Stripe is live.
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        <Link to="/app" className="hover:text-foreground">← Back to dashboard</Link>
      </p>
    </div>
  );
}
