/**
 * THE THREE PAGE TEMPLATES — what each one is about and what it needs.
 *
 * One contract per template, checked BEFORE anything costs money (the draft
 * request), again before a page is published, and again before an edit to a
 * live page is saved. page_templates.config_schema holds the same JSON
 * (migration 20260929000100; tests/templates-contract.test.ts keeps the two
 * identical), and page_templates.is_active says whether a workspace may pick
 * it. A template is offered only when it is active AND has a registered
 * renderer (src/components/templates/registry.tsx) — never silently rendered
 * as another one.
 */
import {
  PAGE_KINDS,
  TARGET_FIELDS,
  resolveFilter,
  type PageKind,
  type ResolvedFilter,
  type TargetField,
} from "@/lib/coverage/target";

export type TemplateContract = {
  kind: PageKind;
  name: string;
  summary: string;
  /** Filter fields that must be in the page's scope. */
  requiredScope: TargetField[];
  /** A page about a place must name the whole place (country, region, city). */
  wholePlace: boolean;
  /** Published pages of this kind must show matching published listings. */
  requiresListings: boolean;
  /** Shortest acceptable body (characters) for a published page. */
  minBodyChars: number;
  /** Sections the renderer draws, in order. */
  sections: string[];
};

export const TEMPLATE_CONTRACTS: Record<PageKind, TemplateContract> = {
  city_hub: {
    kind: "city_hub",
    name: "City Hub",
    summary: "A landing page for one city, with that city's live listings.",
    requiredScope: ["country", "region", "city"],
    wholePlace: true,
    requiresListings: true,
    minBodyChars: 300,
    sections: ["hero", "intro", "listing_grid", "body", "related_pages"],
  },
  category_page: {
    kind: "category_page",
    name: "Category Page",
    summary: "A page for one category, with its live listings.",
    requiredScope: ["category"],
    wholePlace: true,
    requiresListings: true,
    minBodyChars: 300,
    sections: ["hero", "intro", "listing_grid", "body", "related_pages"],
  },
  resource_article: {
    kind: "resource_article",
    name: "Resource Article",
    summary: "A useful guide, with links to relevant listings and your marketplace.",
    requiredScope: [],
    wholePlace: true,
    requiresListings: false,
    minBodyChars: 600,
    sections: ["hero", "body", "related_listings", "cta", "related_pages"],
  },
};

export function isPageKind(v: unknown): v is PageKind {
  return typeof v === "string" && (PAGE_KINDS as readonly string[]).includes(v);
}

/** The JSON stored in page_templates.config_schema for a kind. */
export function contractJson(kind: PageKind): Record<string, unknown> {
  const c = TEMPLATE_CONTRACTS[kind];
  return {
    version: 1,
    kind: c.kind,
    required_scope: c.requiredScope,
    whole_place: c.wholePlace,
    requires_listings: c.requiresListings,
    min_body_chars: c.minBodyChars,
    sections: c.sections,
  };
}

export type ContractProblem = { code: string; message: string };

const PLACE: TargetField[] = ["country", "region", "city"];

/**
 * Is this filter acceptable for this template? Returns the problems in plain
 * sentences (empty = fine). Pure: callers run it before any AI call and
 * before any write.
 */
export function checkFilterForTemplate(kind: PageKind, rawFilter: unknown): ContractProblem[] {
  const c = TEMPLATE_CONTRACTS[kind];
  const filter: ResolvedFilter | null = resolveFilter(rawFilter ?? {});
  if (!filter) {
    return [
      {
        code: "filter_invalid",
        message: "This page's listing filter isn't valid. Pick the location or category again.",
      },
    ];
  }
  const problems: ContractProblem[] = [];
  const scoped = new Set(Object.keys(filter.constraints) as TargetField[]);
  for (const field of c.requiredScope) {
    if (!scoped.has(field)) {
      problems.push({
        code: `missing_${field}`,
        message:
          field === "category"
            ? `A ${c.name} needs a category.`
            : `A ${c.name} needs its full location (city, region and country as your listings record them).`,
      });
    }
  }
  if (field_required(c, "city") && filter.constraints.city === null) {
    problems.push({
      code: "city_unknown",
      message: `A ${c.name} needs a city — these listings don't have one.`,
    });
  }
  if (field_required(c, "category") && filter.constraints.category === null) {
    problems.push({
      code: "category_unknown",
      message: `A ${c.name} needs a category — these listings don't have one.`,
    });
  }
  // A place is named whole or not at all: "Portland" alone is ambiguous.
  if (c.wholePlace && filter.version === 2) {
    const inScope = PLACE.filter((f) => scoped.has(f));
    if (inScope.length > 0 && inScope.length < PLACE.length) {
      problems.push({
        code: "partial_place",
        message:
          "A location must include its city, region and country (as your listings record them), so two places with the same name never mix.",
      });
    }
  }
  return dedupe(problems);
}

function field_required(c: TemplateContract, f: TargetField): boolean {
  return c.requiredScope.includes(f);
}

function dedupe(p: ContractProblem[]): ContractProblem[] {
  const seen = new Set<string>();
  return p.filter((x) => (seen.has(x.code) ? false : (seen.add(x.code), true)));
}

export const ALL_TARGET_FIELDS = TARGET_FIELDS;
