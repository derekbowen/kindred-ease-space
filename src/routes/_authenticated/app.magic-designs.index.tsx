/**
 * MAGIC DESIGNS — the customer's home: token balance, token packs, a brief for
 * a new custom design, and their designs.
 *
 * Stripe returns here (?tokens=claim&session_id=…) after a token purchase;
 * design-token-claim re-checks the session with Stripe and grants once.
 */
import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Coins, Loader2, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { userMessage } from "@/lib/user-message";
import {
  DESIGN_TOKEN_COSTS,
  DESIGN_TOKEN_PACKS,
  MAGIC_DESIGN_BASES,
  TRANSACTION_TYPES,
  formatTokenPackPrice,
  isBookingType,
  type MagicDesignBrief,
  type TransactionTypeKey,
} from "@/lib/magic-designs";
import { templateThumbnailPath } from "@/lib/template-store";
import { createMagicDesign, getMagicDesignsHome } from "@/lib/magic-designs.functions";

export const Route = createFileRoute("/_authenticated/app/magic-designs/")({
  head: () => ({ meta: [{ title: "Magic Designs — founders.click" }] }),
  validateSearch: (s: Record<string, unknown>): { tokens?: string; session_id?: string } => ({
    ...(typeof s.tokens === "string" ? { tokens: s.tokens } : {}),
    ...(typeof s.session_id === "string" ? { session_id: s.session_id } : {}),
  }),
  component: MagicDesignsHome,
});

type Home = Awaited<ReturnType<typeof getMagicDesignsHome>>;

const EMPTY_BRIEF: MagicDesignBrief = {
  marketplaceName: "",
  whatIsListed: "",
  providers: "",
  customers: "",
  transactionType: "booking-day",
  multipleSeats: false,
  priceVariations: false,
  searchLayout: "map",
  listingLayout: "carousel",
  brandColor: "#4F46E5",
  vibe: "",
  listingFields: "",
  notes: "",
};

async function edgeErrorCode(error: unknown): Promise<string | undefined> {
  const ctx = (error as { context?: Response } | null)?.context;
  try {
    return ((await ctx?.clone().json()) as { error?: string } | undefined)?.error;
  } catch {
    return undefined;
  }
}

function MagicDesignsHome() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const loadHome = useServerFn(getMagicDesignsHome);
  const create = useServerFn(createMagicDesign);
  const [home, setHome] = useState<Home | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [base, setBase] = useState<string>(MAGIC_DESIGN_BASES[0].slug);
  const [brief, setBrief] = useState<MagicDesignBrief>(EMPTY_BRIEF);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setHome(await loadHome());
    } catch (e) {
      toast.error(userMessage(e, "Couldn't load your designs. Try again in a moment."));
    }
  }, [loadHome]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Returning from Stripe: claim the purchase exactly once per visit.
  useEffect(() => {
    if (search.tokens === "canceled") {
      toast("Checkout canceled — you weren't charged.");
      void navigate({ to: "/app/magic-designs", search: {}, replace: true });
      return;
    }
    if (search.tokens !== "claim" || !search.session_id) return;
    void (async () => {
      const { data, error } = await supabase.functions.invoke<{
        granted: number;
        balance: number | null;
      }>("design-token-claim", { body: { session_id: search.session_id } });
      if (error) {
        const code = await edgeErrorCode(error);
        toast.error(
          code === "not_paid"
            ? "We couldn't confirm that payment yet. Refresh in a few seconds."
            : "Couldn't add your tokens. Contact support with your Stripe receipt.",
        );
      } else if (data && data.granted > 0) {
        toast.success(`${data.granted} design tokens added.`);
      }
      await navigate({ to: "/app/magic-designs", search: {}, replace: true });
      void refresh();
    })();
  }, [search.tokens, search.session_id, navigate, refresh]);

  async function buy(pack: string) {
    setBuying(pack);
    const { data, error } = await supabase.functions.invoke<{ url?: string }>(
      "design-token-checkout",
      {
        body: { pack },
      },
    );
    if (error || !data?.url) {
      toast.error("Checkout couldn't start. Try again in a moment.");
      setBuying(null);
      return;
    }
    window.location.assign(data.url);
  }

  const set = <K extends keyof MagicDesignBrief>(k: K, v: MagicDesignBrief[K]) =>
    setBrief((b) => ({ ...b, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const { id } = await create({ data: { baseTemplate: base, brief } });
      toast.success("Your design is being generated. This takes a few minutes.");
      await navigate({ to: "/app/magic-designs/$id", params: { id } });
    } catch (err) {
      toast.error(userMessage(err, "Couldn't start the design. Your tokens were not used."));
      setCreating(false);
      void refresh();
    }
  }

  const balance = home?.balance ?? 0;
  const canAfford = balance >= DESIGN_TOKEN_COSTS.create;

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-brand">
            Magic Designs by founders.click
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">
            Custom Sharetribe marketplace designs
          </h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">
            Describe your marketplace, get a full custom design built on the Sharetribe Web
            Template's pages, refine it with Sharetribe-aware changes, and download a project your
            developer can plug in.
          </p>
        </div>
        <Card className="flex items-center gap-3 px-4 py-3">
          <Coins className="h-5 w-5 text-brand" />
          <div>
            <div className="text-2xl font-bold leading-none">{home ? balance : "—"}</div>
            <div className="text-xs text-muted-foreground">design tokens</div>
          </div>
        </Card>
      </div>

      {home && !home.engineReady ? (
        <Card className="border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Magic Designs is being set up and will open shortly. You can still buy tokens.
        </Card>
      ) : null}

      <section>
        <h2 className="text-lg font-semibold">Token packs</h2>
        <p className="text-sm text-muted-foreground">
          A new design costs {DESIGN_TOKEN_COSTS.create} tokens, each change{" "}
          {DESIGN_TOKEN_COSTS.change} tokens. Downloads are free. Tokens don't expire.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {DESIGN_TOKEN_PACKS.map((p) => (
            <Card key={p.key} className="flex items-center justify-between p-5">
              <div>
                <div className="font-semibold">
                  {p.label} · {p.tokens} tokens
                </div>
                <div className="text-sm text-muted-foreground">
                  {formatTokenPackPrice(p.priceCents)} · about{" "}
                  {Math.floor((p.tokens - DESIGN_TOKEN_COSTS.create) / DESIGN_TOKEN_COSTS.change)}{" "}
                  changes after your first design
                </div>
              </div>
              <Button onClick={() => void buy(p.key)} disabled={buying !== null}>
                {buying === p.key ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  `Buy ${formatTokenPackPrice(p.priceCents)}`
                )}
              </Button>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Wand2 className="h-5 w-5" /> New custom design
        </h2>
        <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-6">
          <div>
            <Label>Start from</Label>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-5">
              {MAGIC_DESIGN_BASES.map((b) => (
                <button
                  type="button"
                  key={b.slug}
                  onClick={() => setBase(b.slug)}
                  className={`overflow-hidden rounded-lg border text-left transition ${
                    base === b.slug
                      ? "border-brand ring-2 ring-brand/40"
                      : "border-border hover:border-foreground/30"
                  }`}
                >
                  <img
                    src={templateThumbnailPath(b.slug)}
                    alt=""
                    loading="lazy"
                    className="aspect-[4/3] w-full object-cover object-top"
                  />
                  <div className="px-2 py-1.5">
                    <div className="text-xs font-semibold">{b.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{b.niche}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Marketplace name" required>
              <Input
                value={brief.marketplaceName}
                onChange={(e) => set("marketplaceName", e.target.value)}
                maxLength={80}
                required
              />
            </Field>
            <Field label="Brand color">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={brief.brandColor}
                  onChange={(e) => set("brandColor", e.target.value.toUpperCase())}
                  className="h-10 w-12 cursor-pointer rounded border border-border"
                  aria-label="Brand color"
                />
                <Input
                  value={brief.brandColor}
                  onChange={(e) => set("brandColor", e.target.value)}
                  pattern="#[0-9a-fA-F]{6}"
                />
              </div>
            </Field>
            <Field label="What is listed?" required>
              <Input
                value={brief.whatIsListed}
                onChange={(e) => set("whatIsListed", e.target.value)}
                placeholder="e.g. electric bikes and cargo bikes"
                required
              />
            </Field>
            <Field label="Who lists them? (providers)" required>
              <Input
                value={brief.providers}
                onChange={(e) => set("providers", e.target.value)}
                placeholder="e.g. local bike shops and owners"
                required
              />
            </Field>
            <Field label="Who books or buys? (customers)" required>
              <Input
                value={brief.customers}
                onChange={(e) => set("customers", e.target.value)}
                placeholder="e.g. tourists and commuters"
                required
              />
            </Field>
            <Field label="Transaction flow (Sharetribe listing type)">
              <Select
                value={brief.transactionType}
                onValueChange={(v) => set("transactionType", v as TransactionTypeKey)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TRANSACTION_TYPES).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Search page layout">
              <Select
                value={brief.searchLayout}
                onValueChange={(v) => set("searchLayout", v as "map" | "grid")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="map">Results with map (location matters)</SelectItem>
                  <SelectItem value="grid">Grid with filter sidebar (no map)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Listing page images">
              <Select
                value={brief.listingLayout}
                onValueChange={(v) => set("listingLayout", v as "carousel" | "coverPhoto")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="carousel">Image carousel with thumbnails</SelectItem>
                  <SelectItem value="coverPhoto">Full-width cover photo</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap gap-6">
            {isBookingType(brief.transactionType) ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={brief.multipleSeats}
                  onCheckedChange={(v) => set("multipleSeats", v === true)}
                />
                Several customers can book the same time slot (seats)
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={brief.priceVariations}
                onCheckedChange={(v) => set("priceVariations", v === true)}
              />
              Listings offer packages / price tiers
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Listing fields / search filters (comma separated)">
              <Input
                value={brief.listingFields}
                onChange={(e) => set("listingFields", e.target.value)}
                placeholder="e.g. frame size, motor power, range"
              />
            </Field>
            <Field label="Look and feel">
              <Input
                value={brief.vibe}
                onChange={(e) => set("vibe", e.target.value)}
                placeholder="e.g. playful, bold type, lots of photos"
              />
            </Field>
          </div>
          <Field label="Anything else?">
            <Textarea
              value={brief.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={3}
              maxLength={1500}
              placeholder="Pages to emphasize, features you need, copy ideas…"
            />
          </Field>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="lg" disabled={creating || !canAfford || !home?.engineReady}>
              {creating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              Generate design · {DESIGN_TOKEN_COSTS.create} tokens
            </Button>
            {home && !canAfford ? (
              <span className="text-sm text-muted-foreground">
                Buy a token pack above to start.
              </span>
            ) : null}
          </div>
        </form>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Your designs</h2>
        {home && home.designs.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No designs yet.</p>
        ) : null}
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {home?.designs.map((d) => (
            <Link
              key={d.id}
              to="/app/magic-designs/$id"
              params={{ id: d.id }}
              className="rounded-xl border border-border p-4 transition hover:border-foreground/30"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{d.name}</span>
                <StatusBadge status={d.status} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                From{" "}
                {MAGIC_DESIGN_BASES.find((b) => b.slug === d.base_template)?.name ??
                  d.base_template}{" "}
                · {new Date(d.created_at).toLocaleDateString()}
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: "generating" | "ready" | "failed" }) {
  if (status === "ready") return <Badge>Ready</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  return (
    <Badge variant="secondary" className="gap-1">
      <Loader2 className="h-3 w-3 animate-spin" /> Generating
    </Badge>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
    </div>
  );
}
