import { BookOpen, Building2, Layers, Sparkles, type LucideIcon } from "lucide-react";

export function slugifyPageTitle(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[\u2018\u2019']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export type PagePreset = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  accent: string;
  buildTitle: (ctx: { city?: string; state?: string }) => string;
  buildTopic: (ctx: { city?: string; state?: string; category?: string }) => string;
};

export const PAGE_PRESETS: PagePreset[] = [
  {
    id: "city",
    label: "City Hub",
    description: "SEO landing with live listing grid",
    icon: Building2,
    accent: "from-sky-500/20 to-blue-600/10",
    buildTitle: ({ city, state }) =>
      city ? `Pool Rental in ${city}${state ? `, ${state}` : ""}` : "Pool Rental in Your City",
    buildTopic: ({ city, state }) =>
      city
        ? `City hub page for ${city}${state ? `, ${state}` : ""}. Cover: who rents pools here, popular use cases (parties, photoshoots, staycations), typical pricing, what to look for when booking, and a strong CTA to browse listings.`
        : "City hub landing page for a pool rental marketplace. Cover local demand, use cases, pricing, and a CTA.",
  },
  {
    id: "category",
    label: "Category Guide",
    description: "Deep-dive on a listing category",
    icon: Layers,
    accent: "from-violet-500/20 to-purple-600/10",
    buildTitle: () => "Complete Guide to Renting Private Pools",
    buildTopic: () =>
      "Category guide for pool rentals. Explain types of pools (heated, infinity, rooftop), amenities, booking tips, pricing factors, and who each type is best for. End with CTA to browse.",
  },
  {
    id: "resource",
    label: "Resource Article",
    description: "Long-form SEO content",
    icon: BookOpen,
    accent: "from-amber-500/20 to-orange-600/10",
    buildTitle: () => "How to Plan the Perfect Pool Party",
    buildTopic: () =>
      "Resource article for pool renters planning an event. Cover guest count, rules, catering, music, timing, weather backup plans, and how to pick the right pool on a marketplace.",
  },
  {
    id: "ai",
    label: "Custom Brief",
    description: "You write the angle from scratch",
    icon: Sparkles,
    accent: "from-emerald-500/20 to-teal-600/10",
    buildTitle: () => "",
    buildTopic: () => "",
  },
];

export const GENERATION_STEPS = [
  "Reading your brief",
  "Structuring SEO outline",
  "Writing on-brand copy",
  "Optimizing meta tags",
  "Publishing live page",
] as const;

export type PreviewPage = {
  title: string;
  slug: string;
  metaDescription: string;
  h1: string;
  bodyMarkdown: string;
  city?: string;
  state?: string;
  categoryPlural?: string;
  listingCount?: number;
};