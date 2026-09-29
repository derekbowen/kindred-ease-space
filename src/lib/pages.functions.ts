/**
 * Server functions for the page builder, the editor and My Pages.
 *
 * Every handler checks workspace membership first; reads and writes then use
 * the service role, always scoped by that workspace id. Customer-facing
 * refusals come back verbatim; anything else is logged and replaced by a
 * plain sentence (customerMessage). The client never names a model, a
 * template id or a target key: it sends a quality tier, a template kind and a
 * filter the server handed it, and the server derives the rest.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import {
  CustomerFacingError,
  GENERATION_DEFAULT_TIER,
  GENERATION_TIERS,
  GENERATION_UNAVAILABLE_MESSAGE,
  customerMessage,
} from "@/lib/generation.server";
import {
  InventoryFilterV2Schema,
  PAGE_KINDS,
  makeFilter,
  listingKeys,
  placeLabel,
  resolveFilter,
  slugForTarget,
  type PageKind,
} from "@/lib/coverage/target";
import { fetchPageListings, priceSummary } from "@/lib/coverage/inventory.server";
import { loadCoverage } from "@/lib/coverage/coverage.server";
import { TEMPLATE_CONTRACTS } from "@/lib/templates/contracts";
import { BRIEF_MAX_CHARS, describePrices, listingPriceText } from "@/lib/page-grounding";
import {
  checkTarget,
  draftStatus,
  findLivePageForTarget,
  humanLabel,
  isUsableTemplate,
  readTemplates,
  runPageDraft,
  suggestedTitle,
  type DraftResult,
} from "@/lib/page-drafts.server";
import {
  PageFieldsSchema,
  archivePage as archivePageServer,
  checkStoredPage,
  deleteDraft,
  listPages,
  liveUrlFor,
  loadEditorPage,
  pageKindOf,
  publishDraft,
  readDomainReadiness,
  restorePage as restorePageServer,
  saveDraftFields,
  saveLiveFields,
  unpublishPage as unpublishPageServer,
  type PageActionResult,
} from "@/lib/page-publish.server";

const FALLBACK = "Something went wrong. Nothing was changed. Try again in a minute.";

async function guarded<T>(
  workspaceId: string,
  userId: string,
  fn: () => Promise<T>,
  fallback = FALLBACK,
): Promise<T> {
  try {
    await assertWorkspaceMember(workspaceId, userId);
    return await fn();
  } catch (e) {
    if (!(e instanceof CustomerFacingError)) {
      console.error(
        "[pages] request failed",
        workspaceId,
        e instanceof Error ? e.message : String(e),
      );
    }
    throw new Error(customerMessage(e, fallback));
  }
}

const userIdOf = (context: unknown) => (context as { userId: string }).userId;

// ---------------------------------------------------------------------------
// Builder: templates and targets
// ---------------------------------------------------------------------------

export type BuilderTemplate = {
  kind: PageKind;
  name: string;
  summary: string;
  sections: string[];
  requiresListings: boolean;
  available: boolean;
};

export type BuilderTarget = {
  targetKey: string;
  kind: "city_hub" | "category_page";
  label: string;
  listingCount: number;
  state: string;
  pageId: string | null;
  filter: z.infer<typeof InventoryFilterV2Schema>;
};

export const getBuilderSetup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).strict().parse(d))
  .handler(async ({ data, context }) =>
    guarded(data.workspaceId, userIdOf(context), async () => {
      const [templates, report, domain] = await Promise.all([
        readTemplates(),
        loadCoverage(data.workspaceId),
        readDomainReadiness(data.workspaceId),
      ]);
      const out: BuilderTemplate[] = PAGE_KINDS.map((kind) => {
        const c = TEMPLATE_CONTRACTS[kind];
        const row = templates.find((t) => t.slug === kind);
        return {
          kind,
          name: c.name,
          summary: c.summary,
          sections: c.sections,
          requiresListings: c.requiresListings,
          available: !!row && isUsableTemplate(row),
        };
      });
      const targets: BuilderTarget[] = report.items
        .filter((i) => i.kind === "city_hub" || i.kind === "category_page")
        .map((i) => ({
          targetKey: i.targetKey,
          kind: i.kind as "city_hub" | "category_page",
          label:
            i.kind === "category_page"
              ? (humanLabel(i.labels.category) ?? "Listings with no category")
              : `${placeLabel(i.labels) || "Listings with no location"}${i.labels.category ? ` · ${humanLabel(i.labels.category)}` : ""}`,
          listingCount: i.listingCount,
          state: i.state,
          pageId: i.page?.id ?? null,
          filter: i.filter,
        }));
      return {
        templates: out,
        targets,
        evidence: report.evidence,
        totals: report.totals,
        domain,
        defaultTier: GENERATION_DEFAULT_TIER,
      };
    }),
  );

const TargetInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    kind: z.enum(PAGE_KINDS),
    filter: InventoryFilterV2Schema,
  })
  .strict();

/** A whole-marketplace filter: the Resource Article's related listings. */
export function articleFilter() {
  return makeFilter([], listingKeys({}));
}

/**
 * The review step: exact count, prices per currency/unit, a sample of the
 * listings the page will show, any existing page for the target, and the
 * suggested title/address. Nothing is charged.
 */
export const reviewTarget = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => TargetInputSchema.parse(d))
  .handler(async ({ data, context }) =>
    guarded(data.workspaceId, userIdOf(context), async () => {
      const check = await checkTarget(data.workspaceId, data.kind, data.filter);
      const existing = check.targetKey
        ? await findLivePageForTarget(data.workspaceId, check.targetKey)
        : null;
      const [prices, sample] =
        check.listingCount > 0
          ? await Promise.all([
              priceSummary(data.workspaceId, check.filter),
              fetchPageListings(data.workspaceId, check.filter, 6),
            ])
          : [{ groups: [], unpriced: 0, complete: true }, []];
      const keys = {
        countryKey: data.filter.countryKey,
        regionKey: data.filter.regionKey,
        cityKey: data.filter.cityKey,
        categoryKey: data.filter.categoryKey,
      };
      const labels = { ...check.filter.labels, category: humanLabel(check.filter.labels.category) };
      const title = suggestedTitle(data.kind, check.filter);
      return {
        kind: data.kind,
        listingCount: check.listingCount,
        problems: check.problems,
        targetKey: check.targetKey,
        prices: describePrices(prices),
        sample: sample.map((l) => ({
          id: l.id,
          title: l.title ?? "Untitled listing",
          location: [l.city, l.state].filter(Boolean).join(", ") || null,
          price: listingPriceText(l) || null,
        })),
        existing: existing
          ? { id: existing.id, slug: existing.slug, title: existing.title, status: existing.status }
          : null,
        suggestion: {
          title,
          slug: data.kind === "resource_article" ? "" : slugForTarget(data.kind, labels, keys),
        },
      };
    }),
  );

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export const CreateDraftInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    requestId: z.string().uuid(),
    kind: z.enum(PAGE_KINDS),
    filter: InventoryFilterV2Schema,
    title: z.string().trim().min(3).max(140),
    slug: z.string().trim().max(80).optional(),
    description: z.string().trim().max(300).optional().default(""),
    brief: z.string().trim().max(BRIEF_MAX_CHARS).optional().default(""),
    // A quality TIER, never a model: the server maps it.
    quality: z.enum(GENERATION_TIERS).default(GENERATION_DEFAULT_TIER),
  })
  .strict();

export const createPageDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => CreateDraftInputSchema.parse(d))
  .handler(
    async ({ data, context }): Promise<DraftResult> =>
      guarded(
        data.workspaceId,
        userIdOf(context),
        () =>
          runPageDraft({
            workspaceId: data.workspaceId,
            userId: userIdOf(context),
            requestId: data.requestId,
            tier: data.quality,
            brief: data.brief,
            mode: "new",
            kind: data.kind,
            filter: data.filter,
            title: data.title,
            slug: data.slug || null,
            description: data.description,
          }),
        GENERATION_UNAVAILABLE_MESSAGE,
      ),
  );

export const RegenerateInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    requestId: z.string().uuid(),
    pageId: z.string().uuid(),
    brief: z.string().trim().max(BRIEF_MAX_CHARS).optional(),
    quality: z.enum(GENERATION_TIERS).default(GENERATION_DEFAULT_TIER),
  })
  .strict();

export const regeneratePageDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => RegenerateInputSchema.parse(d))
  .handler(
    async ({ data, context }): Promise<DraftResult> =>
      guarded(
        data.workspaceId,
        userIdOf(context),
        () =>
          runPageDraft({
            workspaceId: data.workspaceId,
            userId: userIdOf(context),
            requestId: data.requestId,
            tier: data.quality,
            brief: data.brief ?? null,
            mode: "regenerate",
            pageId: data.pageId,
          }),
        GENERATION_UNAVAILABLE_MESSAGE,
      ),
  );

export const getPageDraftStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, requestId: z.string().uuid() }).strict().parse(d),
  )
  .handler(async ({ data, context }) =>
    guarded(data.workspaceId, userIdOf(context), () =>
      draftStatus(data.workspaceId, data.requestId),
    ),
  );

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

const PageRefSchema = z
  .object({ workspaceId: workspaceIdSchema, pageId: z.string().uuid() })
  .strict();

export const getPageEditor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => PageRefSchema.parse(d))
  .handler(async ({ data, context }) =>
    guarded(data.workspaceId, userIdOf(context), async () => {
      const row = await loadEditorPage(data.workspaceId, data.pageId);
      if (!row) throw new CustomerFacingError("That page doesn't exist any more.");
      const kind = pageKindOf(row);
      const filter = resolveFilter(row.listing_filter);
      const [check, domain] = await Promise.all([
        checkStoredPage(data.workspaceId, row).catch((e) => {
          console.error(
            "[pages] editor check failed",
            row.id,
            e instanceof Error ? e.message : String(e),
          );
          return null;
        }),
        readDomainReadiness(data.workspaceId),
      ]);
      // The real template data (listings, branding, links), built exactly as
      // the public page builds it — for a draft too. A failed read shows no
      // preview rather than failing the editor.
      const { buildTenantPageData } = await import("@/lib/tenant-page-data.server");
      const preview = kind
        ? await buildTenantPageData(data.workspaceId, row, { kind }).catch((e) => {
            console.error(
              "[pages] preview unavailable",
              row.id,
              e instanceof Error ? e.message : String(e),
            );
            return null;
          })
        : null;
      return {
        page: {
          id: row.id,
          kind,
          templateName: kind
            ? TEMPLATE_CONTRACTS[kind].name
            : (row.page_templates?.name ?? "Unknown template"),
          status: row.status,
          slug: row.slug,
          title: row.title ?? "",
          h1: row.h1 ?? row.title ?? "",
          seoTitle: row.seo_title,
          metaDescription: row.meta_description,
          bodyMarkdown: row.body_markdown ?? "",
          listingLimit: filter?.limit ?? 24,
          noindex: row.noindex === true,
          version: Number(row.content_version) || 1,
          generation: row.generation,
          publishedAt: row.published_at,
          updatedAt: row.updated_at,
          targetLabel: filter
            ? [
                filter.labels.city,
                filter.labels.region,
                filter.labels.country,
                humanLabel(filter.labels.category),
              ]
                .filter(Boolean)
                .join(" · ")
            : null,
          legacyFilter: filter?.version === 1,
        },
        check,
        domain,
        liveUrl: domain.ready && row.status === "published" ? liveUrlFor(domain, row.slug) : null,
        preview,
      };
    }),
  );

const SaveInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    pageId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    fields: PageFieldsSchema,
  })
  .strict();

export const savePageDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SaveInputSchema.parse(d))
  .handler(
    async ({ data, context }): Promise<PageActionResult> =>
      guarded(data.workspaceId, userIdOf(context), () =>
        saveDraftFields(data.workspaceId, data.pageId, data.expectedVersion, data.fields),
      ),
  );

export const saveLivePage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SaveInputSchema.parse(d))
  .handler(
    async ({ data, context }): Promise<PageActionResult> =>
      guarded(data.workspaceId, userIdOf(context), () =>
        saveLiveFields(data.workspaceId, data.pageId, data.expectedVersion, data.fields),
      ),
  );

/**
 * Preview UNSAVED edits with the real template and the real listings: the
 * same data builder the public page uses, fed the fields in the editor.
 */
export const previewPageEdits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        pageId: z.string().uuid(),
        fields: PageFieldsSchema,
      })
      .strict()
      .parse(d),
  )
  .handler(async ({ data, context }) =>
    guarded(data.workspaceId, userIdOf(context), async () => {
      const row = await loadEditorPage(data.workspaceId, data.pageId);
      if (!row) throw new CustomerFacingError("That page doesn't exist any more.");
      const kind = pageKindOf(row);
      if (!kind) throw new CustomerFacingError("This page's template can't be previewed.");
      const { fieldsToRow } = await import("@/lib/page-publish.server");
      const { buildTenantPageData } = await import("@/lib/tenant-page-data.server");
      const merged = { ...row, ...fieldsToRow(data.fields, row.listing_filter) } as typeof row;
      return buildTenantPageData(data.workspaceId, merged, { kind });
    }),
  );

// ---------------------------------------------------------------------------
// Publishing and lifecycle
// ---------------------------------------------------------------------------

export const publishPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        pageId: z.string().uuid(),
        expectedVersion: z.number().int().min(1),
      })
      .strict()
      .parse(d),
  )
  .handler(
    async ({ data, context }): Promise<PageActionResult> =>
      guarded(data.workspaceId, userIdOf(context), () =>
        publishDraft(data.workspaceId, data.pageId, data.expectedVersion),
      ),
  );

export const unpublishPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => PageRefSchema.parse(d))
  .handler(
    async ({ data, context }): Promise<PageActionResult> =>
      guarded(data.workspaceId, userIdOf(context), () =>
        unpublishPageServer(data.workspaceId, data.pageId),
      ),
  );

export const archivePage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => PageRefSchema.parse(d))
  .handler(
    async ({ data, context }): Promise<PageActionResult> =>
      guarded(data.workspaceId, userIdOf(context), () =>
        archivePageServer(data.workspaceId, data.pageId),
      ),
  );

export const restorePage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => PageRefSchema.parse(d))
  .handler(
    async ({ data, context }): Promise<PageActionResult> =>
      guarded(data.workspaceId, userIdOf(context), () =>
        restorePageServer(data.workspaceId, data.pageId),
      ),
  );

export const deletePage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => PageRefSchema.parse(d))
  .handler(
    async ({ data, context }): Promise<PageActionResult> =>
      guarded(data.workspaceId, userIdOf(context), () =>
        deleteDraft(data.workspaceId, data.pageId),
      ),
  );

export const listMyPages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).strict().parse(d))
  .handler(async ({ data, context }) =>
    guarded(data.workspaceId, userIdOf(context), async () => {
      const [pages, domain] = await Promise.all([
        listPages(data.workspaceId),
        readDomainReadiness(data.workspaceId),
      ]);
      return {
        pages: pages.map((p) => ({
          ...p,
          liveUrl: domain.ready && p.status === "published" ? liveUrlFor(domain, p.slug) : null,
        })),
        domain,
      };
    }),
  );
