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
  buildTitle: (ctx: { city?: string; state?: string; category?: string }) => string;
  buildTopic: (ctx: { city?: string; state?: string; category?: string }) => string;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// `category` is the marketplace's dominant listing category (plural, lowercase —
// e.g. "pools", "boats", "studios"), derived from its own synced listings. The
// presets must work for ANY vertical, so every default is category-parameterized
// and falls back to a neutral label — never a hardcoded vertical.
export const PAGE_PRESETS: PagePreset[] = [
  {
    id: "city",
    label: "City Hub",
    description: "SEO landing with live listing grid",
    icon: Building2,
    accent: "from-sky-500/20 to-blue-600/10",
    buildTitle: ({ city, state, category }) => {
      const label = cap(category || "rentals");
      return city ? `${label} in ${city}${state ? `, ${state}` : ""}` : `${label} in Your City`;
    },
    buildTopic: ({ city, state, category }) => {
      const cat = category || "listings";
      return city
        ? `City hub page for ${city}${state ? `, ${state}` : ""}. Cover: who uses ${cat} here, popular local use cases, what to look for when booking, and a strong CTA to browse the live listings shown on the page. Use only real facts — do not invent pricing or availability.`
        : `City hub landing page for a ${cat} marketplace. Cover local demand, use cases, what to look for, and a CTA. Use only real facts — do not invent pricing.`;
    },
  },
  {
    id: "category",
    label: "Category Guide",
    description: "Deep-dive on a listing category",
    icon: Layers,
    accent: "from-violet-500/20 to-purple-600/10",
    buildTitle: ({ category }) => `The Complete Guide to ${cap(category || "rentals")}`,
    buildTopic: ({ category }) => {
      const cat = category || "rentals";
      return `Category guide for ${cat}. Explain the main types and amenities renters compare, booking tips, the factors that drive pricing, and who each option is best for. End with a CTA to browse. Use only real facts — do not invent pricing.`;
    },
  },
  {
    id: "resource",
    label: "Resource Article",
    description: "Long-form SEO content",
    icon: BookOpen,
    accent: "from-amber-500/20 to-orange-600/10",
    buildTitle: ({ category }) => `How to Book ${cap(category || "rentals")} Like a Pro`,
    buildTopic: ({ category }) => {
      const cat = category || "rentals";
      return `Resource article for people booking ${cat} on a marketplace. Cover how to compare options, questions to ask the host, timing and cancellation tips, common mistakes, and how to spot a great listing.`;
    },
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
