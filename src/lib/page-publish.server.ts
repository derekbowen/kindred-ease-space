/**
 * PUBLISHING = A REACHABLE PAGE, AND EDITS THAT NEVER BREAK A LIVE ONE.
 *
 * A draft goes live only when every one of these holds, checked in this order
 * and reported in plain sentences:
 *   1. it is this workspace's draft, nobody is writing it, and it is the
 *      version the owner reviewed (content_version);
 *   2. its template is active and has a renderer;
 *   3. its filter still meets the template's contract and still matches
 *      enough published listings (the same query the page renders with);
 *   4. its text passes the published-page contract (title, description,
 *      duplicates, thin content) and the template's minimum;
 *   5. the workspace has an ACTIVE verified domain — proven reachable over
 *      HTTPS by the activation check — or the owner is told the exact
 *      remaining step (and no URL is shown);
 *   6. the plan has room: publish_tenant_page_checked flips the page under
 *      the workspace's publish lock, only while it is still that draft at
 *      that version.
 * Then the live URL is fetched once to confirm the page answers.
 *
 * An edit to a live page is validated in full BEFORE anything is written; a
 * rejected edit leaves the live version exactly as it was. The slug of a live
 * page never changes (its URL is what search engines know).
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";
import {
  PAGE_LISTING_LIMIT_MAX,
  MIN_LISTINGS_FOR_PAGE,
  resolveFilter,
  type PageKind,
} from "@/lib/coverage/target";
import { countMatchingListings, readAll } from "@/lib/coverage/inventory.server";
import { TEMPLATE_CONTRACTS, checkFilterForTemplate, isPageKind } from "@/lib/templates/contracts";
import { proseLength, validatePageContract } from "@/lib/seo/page-contract";
import { intentForPage, loadSiblingContext } from "@/lib/seo/page-contract.server";
import {
  isGenerationActive,
  isUsableTemplate,
  type GenerationState,
} from "@/lib/page-drafts.server";

const sb = () => supabaseAdmin as any;

// ---------------------------------------------------------------------------
// Domain readiness
// ---------------------------------------------------------------------------

export type DomainReadiness =
  | { ready: true; hostname: string; baseUrl: string }
  | { ready: false; hostname: string | null; status: string | null; step: string };

type DomainRow = {
  hostname: string;
  verified: boolean | null;
  status: string | null;
  route_prefix: string | null;
  last_error: string | null;
  activated_at: string | null;
  created_at: string | null;
};

export const EDGE_TARGET = "proxy.founders.click";

/** The exact next step for a domain that isn't serving pages yet. Pure. */
export function domainStep(rows: DomainRow[]): DomainReadiness {
  const active = rows.find((r) => r.verified === true && r.status === "active");
  if (active) {
    const prefix = `/${String(active.route_prefix ?? "/a/").replace(/^\/+|\/+$/g, "") || "a"}`;
    return {
      ready: true,
      hostname: active.hostname,
      baseUrl: `https://${active.hostname}${prefix}`,
    };
  }
  if (rows.length === 0) {
    return {
      ready: false,
      hostname: null,
      status: null,
      step: "Connect a domain in Settings → Domains. Pages go live on your own domain (for example pages.yourmarketplace.com), never on founders.click.",
    };
  }
  const verifiedRow = rows.find((r) => r.verified === true);
  if (!verifiedRow) {
    const r = rows[0]!;
    return {
      ready: false,
      hostname: r.hostname,
      status: r.status,
      step: `Verify that you own ${r.hostname}: add the TXT record shown in Settings → Domains, then press Verify.`,
    };
  }
  const last = verifiedRow.last_error ? ` Last check: ${verifiedRow.last_error}` : "";
  return {
    ready: false,
    hostname: verifiedRow.hostname,
    status: verifiedRow.status,
    step: `Point ${verifiedRow.hostname} at ${EDGE_TARGET} with a CNAME record at your DNS provider, then run the connection check in Settings → Domains. Pages publish once it passes.${last}`,
  };
}

export async function readDomainReadiness(workspaceId: string): Promise<DomainReadiness> {
  const { data, error } = await sb()
    .from("workspace_domains")
    .select("hostname, verified, status, route_prefix, last_error, activated_at, created_at")
    .eq("workspace_id", workspaceId)
    .order("activated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`domain read failed: ${error.message}`);
  return domainStep((data ?? []) as DomainRow[]);
}

export function liveUrlFor(
  domain: Extract<DomainReadiness, { ready: true }>,
  slug: string,
): string {
  return `${domain.baseUrl}/${encodeURIComponent(slug)}`;
}

// ---------------------------------------------------------------------------
// The page as the editor and publisher see it
// ---------------------------------------------------------------------------

export const EDITOR_PAGE_COLUMNS =
  "id, workspace_id, slug, title, h1, seo_title, meta_description, body_markdown, listing_filter, variables, target_key, status, noindex, content_version, generation, published_at, updated_at, created_at, template_id, page_templates:template_id(id, slug, name, is_active, config_schema)";

export type EditorPageRow = {
  id: string;
  workspace_id: string;
  slug: string;
  title: string | null;
  h1: string | null;
  seo_title: string | null;
  meta_description: string | null;
  body_markdown: string | null;
  listing_filter: unknown;
  variables: Record<string, unknown> | null;
  target_key: string | null;
  status: string;
  noindex: boolean | null;
  content_version: number | null;
  generation: GenerationState | null;
  published_at: string | null;
  updated_at: string | null;
  created_at: string | null;
  template_id: string;
  page_templates: {
    id: string;
    slug: string;
    name: string | null;
    is_active: boolean | null;
    config_schema: unknown;
  } | null;
};

export async function loadEditorPage(
  workspaceId: string,
  pageId: string,
): Promise<EditorPageRow | null> {
  const { data, error } = await sb()
    .from("tenant_pages")
    .select(EDITOR_PAGE_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", pageId)
    .maybeSingle();
  if (error) throw new Error(`page read failed: ${error.message}`);
  return (data as EditorPageRow | null) ?? null;
}

export function pageKindOf(row: Pick<EditorPageRow, "page_templates">): PageKind | null {
  const k = row.page_templates?.slug;
  return isPageKind(k) ? k : null;
}

// ---------------------------------------------------------------------------
// Editable fields
// ---------------------------------------------------------------------------

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const PageFieldsSchema = z
  .object({
    title: z.string().trim().min(3, "A title needs at least 3 characters.").max(140),
    h1: z.string().trim().min(3, "The heading needs at least 3 characters.").max(200),
    seoTitle: z
      .string()
      .trim()
      .max(70, "Keep the search title to 70 characters or fewer.")
      .nullable(),
    metaDescription: z.string().trim().max(320).nullable(),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(80)
      .regex(
        SLUG_PATTERN,
        "Use lowercase letters, numbers and single dashes (for example pool-rentals-austin).",
      ),
    bodyMarkdown: z.string().max(50_000),
    listingLimit: z.number().int().min(1).max(PAGE_LISTING_LIMIT_MAX),
    noindex: z.boolean(),
  })
  .strict();

export type PageFields = z.infer<typeof PageFieldsSchema>;

/** The stored filter with a new listing limit, keeping everything else. */
export function withListingLimit(rawFilter: unknown, limit: number): unknown {
  if (!rawFilter || typeof rawFilter !== "object" || Array.isArray(rawFilter)) return rawFilter;
  return { ...(rawFilter as Record<string, unknown>), limit };
}

export function fieldsToRow(f: PageFields, rawFilter: unknown): Record<string, unknown> {
  return {
    title: f.title,
    h1: f.h1,
    seo_title: f.seoTitle || null,
    meta_description: f.metaDescription || null,
    slug: f.slug,
    body_markdown: f.bodyMarkdown,
    listing_filter: withListingLimit(rawFilter, f.listingLimit),
    noindex: f.noindex,
  };
}

// ---------------------------------------------------------------------------
// Content checks — shared by publish and live edits
// ---------------------------------------------------------------------------

export type PageProblem = { code: string; message: string; fix?: string };

export type ContentCheck = {
  ok: boolean;
  problems: PageProblem[];
  warnings: PageProblem[];
  listingCount: number;
};

const NEW_PAGE_FIX = "Start a new page for this location or category from Opportunities.";

/**
 * Everything about a page's content that must hold before it is (or stays)
 * live. Throws only when a read fails (the caller refuses: "couldn't verify").
 */
export async function checkPageContent(
  workspaceId: string,
  page: {
    id: string;
    kind: PageKind | null;
    templateUsable: boolean;
    slug: string;
    title: string;
    h1: string;
    seoTitle: string | null;
    metaDescription: string | null;
    bodyMarkdown: string | null;
    listingFilter: unknown;
    variables: Record<string, unknown> | null;
  },
): Promise<ContentCheck> {
  const problems: PageProblem[] = [];
  const warnings: PageProblem[] = [];
  if (!page.kind || !page.templateUsable) {
    problems.push({
      code: "template_unavailable",
      message: "This page's template isn't available, so it can't be shown correctly.",
      fix: NEW_PAGE_FIX,
    });
    return { ok: false, problems, warnings, listingCount: 0 };
  }
  const contract = TEMPLATE_CONTRACTS[page.kind];
  for (const p of checkFilterForTemplate(page.kind, page.listingFilter)) {
    problems.push({ code: p.code, message: p.message, fix: NEW_PAGE_FIX });
  }
  const filter = resolveFilter(page.listingFilter);
  const listingCount = filter ? await countMatchingListings(workspaceId, filter) : 0;
  if (contract.requiresListings && listingCount < MIN_LISTINGS_FOR_PAGE) {
    problems.push({
      code: "not_enough_listings",
      message:
        listingCount === 0
          ? "No published listings match this page any more, so it would show nothing."
          : `Only ${listingCount} published listing${listingCount === 1 ? "" : "s"} match this page; a ${contract.name} needs at least ${MIN_LISTINGS_FOR_PAGE}.`,
      fix: "Sync your listings, or keep this page as a draft until more listings match.",
    });
  }
  const prose = proseLength(page.bodyMarkdown);
  if (prose < contract.minBodyChars) {
    problems.push({
      code: "body_too_short",
      message: `The page text is ${prose} characters; a ${contract.name} needs at least ${contract.minBodyChars}.`,
      fix: "Add useful, page-specific text, or regenerate the draft.",
    });
  }
  if (page.seoTitle && page.seoTitle.length > 60) {
    warnings.push({
      code: "seo_title_long",
      message: `The search title is ${page.seoTitle.length} characters and may be cut off in results.`,
      fix: "Aim for 60 characters or fewer.",
    });
  }
  const siblings = await loadSiblingContext(workspaceId, page.id);
  const verdict = validatePageContract(
    {
      slug: page.slug,
      title: page.title,
      metaDescription: page.metaDescription,
      h1: page.h1,
      bodyMarkdown: page.bodyMarkdown,
      listingCount,
      internalLinkCount: Math.min(siblings.publishedCount, 8),
    },
    {
      ...siblings,
      intent: intentForPage(page.title, page.variables, page.listingFilter as any) ?? undefined,
    },
  );
  for (const v of verdict.violations) {
    const item = { code: v.code, message: v.message, fix: v.fix };
    (v.severity === "BLOCKING" ? problems : warnings).push(item);
  }
  return { ok: problems.length === 0, problems, warnings, listingCount };
}

function rowForCheck(row: EditorPageRow, over: Partial<PageFields> = {}) {
  return {
    id: row.id,
    kind: pageKindOf(row),
    templateUsable: !!row.page_templates && isUsableTemplate(row.page_templates),
    slug: over.slug ?? row.slug,
    title: over.title ?? row.title ?? "",
    h1: over.h1 ?? row.h1 ?? row.title ?? "",
    seoTitle: over.seoTitle !== undefined ? over.seoTitle : row.seo_title,
    metaDescription:
      over.metaDescription !== undefined ? over.metaDescription : row.meta_description,
    bodyMarkdown: over.bodyMarkdown ?? row.body_markdown,
    listingFilter:
      over.listingLimit !== undefined
        ? withListingLimit(row.listing_filter, over.listingLimit)
        : row.listing_filter,
    variables: row.variables,
  };
}

export async function checkStoredPage(
  workspaceId: string,
  row: EditorPageRow,
): Promise<ContentCheck> {
  return checkPageContent(workspaceId, rowForCheck(row));
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type PageActionResult =
  | {
      ok: true;
      version: number;
      status: string;
      slug: string;
      liveUrl?: string | null;
      reachable?: ReachResult | null;
      warnings?: PageProblem[];
    }
  | {
      ok: false;
      code:
        | "not_found"
        | "conflict"
        | "not_draft"
        | "not_live"
        | "generating"
        | "invalid"
        | "slug_taken"
        | "slug_locked"
        | "domain_not_ready"
        | "limit_reached"
        | "not_entitled"
        | "target_taken"
        | "check_failed";
      message: string;
      problems?: PageProblem[];
      warnings?: PageProblem[];
      step?: string;
    };

export const CONFLICT_MESSAGE =
  "This page changed since you opened it (another tab or person saved it). Reload to see the latest version, then make your change again.";
const CHECK_FAILED_MESSAGE =
  "We couldn't verify this page just now, so nothing was changed. Try again in a minute.";

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

async function slugTaken(workspaceId: string, slug: string, exceptId: string): Promise<boolean> {
  const { data, error } = await sb()
    .from("tenant_pages")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .neq("id", exceptId)
    .limit(1);
  if (error) throw new Error(`slug read failed: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Conditional update: only this page, only at the version the editor loaded. */
async function writeAtVersion(
  workspaceId: string,
  pageId: string,
  expectedVersion: number,
  status: string,
  patch: Record<string, unknown>,
): Promise<
  | { ok: true; row: { content_version: number; status: string; slug: string } }
  | { ok: false; slugTaken: boolean }
> {
  const { data, error } = await sb()
    .from("tenant_pages")
    .update({
      ...patch,
      content_version: expectedVersion + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", pageId)
    .eq("workspace_id", workspaceId)
    .eq("status", status)
    .eq("content_version", expectedVersion)
    .select("content_version, status, slug");
  if (error) {
    if (error.code === "23505" && /slug/.test(`${error.message} ${error.details ?? ""}`))
      return { ok: false, slugTaken: true };
    throw new Error(`page save failed: ${error.message}`);
  }
  const row = (data ?? [])[0];
  return row ? { ok: true, row } : { ok: false, slugTaken: false };
}

/** Save a draft's fields. Drafts may be incomplete; only the fields themselves are validated. */
export async function saveDraftFields(
  workspaceId: string,
  pageId: string,
  expectedVersion: number,
  fields: PageFields,
): Promise<PageActionResult> {
  const row = await loadEditorPage(workspaceId, pageId);
  if (!row) return { ok: false, code: "not_found", message: "That page doesn't exist any more." };
  if (row.status !== "draft") {
    return row.status === "published"
      ? {
          ok: false,
          code: "not_draft",
          message: "This page is live: save it with “Update live page” so it is checked first.",
        }
      : {
          ok: false,
          code: "not_draft",
          message: "Archived and paused pages can't be edited. Restore it as a draft first.",
        };
  }
  if (isGenerationActive(row.generation)) {
    return {
      ok: false,
      code: "generating",
      message: "This draft is still being written. Wait for it to finish, then edit.",
    };
  }
  if ((Number(row.content_version) || 1) !== expectedVersion)
    return { ok: false, code: "conflict", message: CONFLICT_MESSAGE };
  if (fields.slug !== row.slug && (await slugTaken(workspaceId, fields.slug, pageId))) {
    return {
      ok: false,
      code: "slug_taken",
      message: `Another page already uses the address /a/${fields.slug}. Pick a different one.`,
    };
  }
  const w = await writeAtVersion(
    workspaceId,
    pageId,
    expectedVersion,
    "draft",
    fieldsToRow(fields, row.listing_filter),
  );
  if (!w.ok) {
    return w.slugTaken
      ? {
          ok: false,
          code: "slug_taken",
          message: `Another page already uses the address /a/${fields.slug}. Pick a different one.`,
        }
      : { ok: false, code: "conflict", message: CONFLICT_MESSAGE };
  }
  return { ok: true, version: w.row.content_version, status: w.row.status, slug: w.row.slug };
}

/**
 * Save an edit to a LIVE page: the proposed version is checked in full first;
 * a failing edit writes nothing, so the live page stays exactly as it was.
 */
export async function saveLiveFields(
  workspaceId: string,
  pageId: string,
  expectedVersion: number,
  fields: PageFields,
): Promise<PageActionResult> {
  const row = await loadEditorPage(workspaceId, pageId);
  if (!row) return { ok: false, code: "not_found", message: "That page doesn't exist any more." };
  if (row.status !== "published") {
    return {
      ok: false,
      code: "not_live",
      message: "This page isn't live. Save it as a draft instead.",
    };
  }
  if ((Number(row.content_version) || 1) !== expectedVersion)
    return { ok: false, code: "conflict", message: CONFLICT_MESSAGE };
  if (fields.slug !== row.slug) {
    return {
      ok: false,
      code: "slug_locked",
      message: `A live page's address can't change (search engines know it as /a/${row.slug}). Unpublish it first if you really need a new address.`,
    };
  }
  let check: ContentCheck;
  try {
    check = await checkPageContent(workspaceId, rowForCheck(row, fields));
  } catch (e) {
    console.error(
      "[pages] live edit check failed",
      pageId,
      e instanceof Error ? e.message : String(e),
    );
    return { ok: false, code: "check_failed", message: CHECK_FAILED_MESSAGE };
  }
  if (!check.ok) {
    return {
      ok: false,
      code: "invalid",
      message: "Not saved — the live page is unchanged. Fix these first:",
      problems: check.problems,
      warnings: check.warnings,
    };
  }
  const w = await writeAtVersion(
    workspaceId,
    pageId,
    expectedVersion,
    "published",
    fieldsToRow(fields, row.listing_filter),
  );
  if (!w.ok) return { ok: false, code: "conflict", message: CONFLICT_MESSAGE };
  return {
    ok: true,
    version: w.row.content_version,
    status: w.row.status,
    slug: w.row.slug,
    warnings: check.warnings,
  };
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export type ReachResult = { reachable: boolean; status: number | null; detail: string };

/**
 * Fetch the live URL once. A page counts as reachable when it answers 200 and
 * the HTML carries its own canonical URL. Anything else is reported plainly —
 * the page IS published; this says whether the internet can see it yet.
 */
export async function probeLiveUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReachResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetchImpl(url, {
      redirect: "manual",
      signal: ctrl.signal,
      headers: { "cache-control": "no-cache" },
    });
    const html = res.status === 200 ? await res.text() : "";
    if (res.status !== 200) {
      return {
        reachable: false,
        status: res.status,
        detail: `Your domain answered HTTP ${res.status} for this page.`,
      };
    }
    const canonical =
      html.includes(`rel="canonical" href="${url}"`) ||
      html.includes(`href="${url}" rel="canonical"`);
    return canonical
      ? { reachable: true, status: 200, detail: "The page answers on your domain." }
      : {
          reachable: false,
          status: 200,
          detail:
            "Your domain answered, but not with this page. Check that the domain points at proxy.founders.click.",
        };
  } catch (e) {
    return {
      reachable: false,
      status: null,
      detail: `We couldn't reach your domain (${e instanceof Error && e.name === "AbortError" ? "timed out" : "connection failed"}).`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function explainNoCapacity(
  workspaceId: string,
  result: string,
  limit: number,
): Promise<string> {
  if (result === "limit_reached") {
    return `Your plan allows ${limit.toLocaleString()} published page${limit === 1 ? "" : "s"} and they're all in use. Unpublish a page you no longer need, or choose a larger plan in Billing. This page stays a draft.`;
  }
  try {
    const { readEntitlement } = await import("@/lib/entitlements.functions");
    const ent = await readEntitlement(workspaceId);
    return `${ent.billingReason || "Your plan doesn't allow publishing right now."} Choose a plan in Billing to publish. This page stays a draft.`;
  } catch {
    return "Your plan doesn't allow publishing right now. Check Billing. This page stays a draft.";
  }
}

export async function publishDraft(
  workspaceId: string,
  pageId: string,
  expectedVersion: number,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PageActionResult> {
  const row = await loadEditorPage(workspaceId, pageId);
  if (!row) return { ok: false, code: "not_found", message: "That page doesn't exist any more." };
  if (row.status === "published")
    return { ok: false, code: "not_draft", message: "This page is already live." };
  if (row.status !== "draft") {
    return {
      ok: false,
      code: "not_draft",
      message: "Only drafts can be published. Restore this page as a draft first.",
    };
  }
  if (isGenerationActive(row.generation)) {
    return {
      ok: false,
      code: "generating",
      message: "This draft is still being written. Publish it when it's ready.",
    };
  }
  if ((Number(row.content_version) || 1) !== expectedVersion)
    return { ok: false, code: "conflict", message: CONFLICT_MESSAGE };

  let check: ContentCheck;
  try {
    check = await checkStoredPage(workspaceId, row);
  } catch (e) {
    console.error(
      "[pages] publish check failed",
      pageId,
      e instanceof Error ? e.message : String(e),
    );
    return { ok: false, code: "check_failed", message: CHECK_FAILED_MESSAGE };
  }
  if (!check.ok) {
    return {
      ok: false,
      code: "invalid",
      message: "This draft isn't ready to publish yet. It stays a draft until these are fixed:",
      problems: check.problems,
      warnings: check.warnings,
    };
  }

  const domain = await readDomainReadiness(workspaceId);
  if (!domain.ready) {
    return {
      ok: false,
      code: "domain_not_ready",
      message:
        "Your domain isn't serving pages yet, so this page stays a draft (it would not be reachable).",
      step: domain.step,
    };
  }

  const { data, error } = await sb().rpc("publish_tenant_page_checked", {
    _workspace_id: workspaceId,
    _page_id: pageId,
    _expected_version: expectedVersion,
  });
  if (error) {
    console.error("[pages] publish gate failed", workspaceId, pageId, error.message);
    return { ok: false, code: "check_failed", message: CHECK_FAILED_MESSAGE };
  }
  const r = (data ?? {}) as { result?: string; limit?: number };
  switch (r.result) {
    case "published":
      break;
    case "already_published":
      return { ok: false, code: "not_draft", message: "This page is already live." };
    case "version_conflict":
      return { ok: false, code: "conflict", message: CONFLICT_MESSAGE };
    case "not_draft":
      return {
        ok: false,
        code: "not_draft",
        message: "Only drafts can be published. Restore this page as a draft first.",
      };
    case "not_found":
      return { ok: false, code: "not_found", message: "That page doesn't exist any more." };
    case "limit_reached":
    case "not_entitled":
      return {
        ok: false,
        code: r.result,
        message: await explainNoCapacity(workspaceId, r.result, Number(r.limit) || 0),
      };
    default:
      return { ok: false, code: "check_failed", message: CHECK_FAILED_MESSAGE };
  }

  const liveUrl = liveUrlFor(domain, row.slug);
  const reachable = await probeLiveUrl(liveUrl, deps.fetchImpl);
  return {
    ok: true,
    version: expectedVersion,
    status: "published",
    slug: row.slug,
    liveUrl,
    reachable,
    warnings: check.warnings,
  };
}

// ---------------------------------------------------------------------------
// Unpublish / archive / restore / delete
// ---------------------------------------------------------------------------

async function setStatus(
  workspaceId: string,
  pageId: string,
  from: string[],
  to: string,
): Promise<
  | { ok: true; version: number }
  | { ok: false; error: { code?: string; message: string; details?: string } | null }
> {
  const { data, error } = await sb()
    .from("tenant_pages")
    .update({ status: to, updated_at: new Date().toISOString() })
    .eq("id", pageId)
    .eq("workspace_id", workspaceId)
    .in("status", from)
    .select("content_version");
  if (error) return { ok: false, error };
  const row = (data ?? [])[0];
  return row ? { ok: true, version: Number(row.content_version) || 1 } : { ok: false, error: null };
}

export async function unpublishPage(
  workspaceId: string,
  pageId: string,
): Promise<PageActionResult> {
  const r = await setStatus(workspaceId, pageId, ["published"], "draft");
  if (!r.ok) {
    if (r.error) throw new Error(`unpublish failed: ${r.error.message}`);
    return { ok: false, code: "not_live", message: "This page isn't live." };
  }
  const row = await loadEditorPage(workspaceId, pageId);
  return { ok: true, version: r.version, status: "draft", slug: row?.slug ?? "" };
}

export async function archivePage(workspaceId: string, pageId: string): Promise<PageActionResult> {
  const row = await loadEditorPage(workspaceId, pageId);
  if (!row) return { ok: false, code: "not_found", message: "That page doesn't exist any more." };
  if (isGenerationActive(row.generation)) {
    return {
      ok: false,
      code: "generating",
      message: "This draft is still being written. Archive it when it's ready.",
    };
  }
  const r = await setStatus(workspaceId, pageId, ["draft", "published"], "archived");
  if (!r.ok) {
    if (r.error) throw new Error(`archive failed: ${r.error.message}`);
    return { ok: false, code: "not_draft", message: "Only drafts and live pages can be archived." };
  }
  return { ok: true, version: r.version, status: "archived", slug: row.slug };
}

export async function restorePage(workspaceId: string, pageId: string): Promise<PageActionResult> {
  const row = await loadEditorPage(workspaceId, pageId);
  if (!row) return { ok: false, code: "not_found", message: "That page doesn't exist any more." };
  const r = await setStatus(workspaceId, pageId, ["archived"], "draft");
  if (!r.ok) {
    if (
      r.error?.code === "23505" &&
      /live_target/.test(`${r.error.message} ${r.error.details ?? ""}`)
    ) {
      return {
        ok: false,
        code: "target_taken",
        message:
          "Another page now covers this location or category, so this one can't come back as a second page. Open that page from Pages instead.",
      };
    }
    if (r.error) throw new Error(`restore failed: ${r.error.message}`);
    return { ok: false, code: "not_draft", message: "Only archived pages can be restored." };
  }
  return { ok: true, version: r.version, status: "draft", slug: row.slug };
}

/** Drafts only: live pages are unpublished or archived, never deleted from here. */
export async function deleteDraft(workspaceId: string, pageId: string): Promise<PageActionResult> {
  const row = await loadEditorPage(workspaceId, pageId);
  if (!row) return { ok: false, code: "not_found", message: "That page doesn't exist any more." };
  if (row.status !== "draft" && row.status !== "archived") {
    return {
      ok: false,
      code: "not_draft",
      message: "Unpublish or archive a live page instead of deleting it.",
    };
  }
  if (isGenerationActive(row.generation)) {
    return {
      ok: false,
      code: "generating",
      message: "This draft is still being written. Delete it when it's ready.",
    };
  }
  const { error } = await sb()
    .from("tenant_pages")
    .delete()
    .eq("id", pageId)
    .eq("workspace_id", workspaceId)
    .in("status", ["draft", "archived"]);
  if (error) throw new Error(`delete failed: ${error.message}`);
  return { ok: true, version: 0, status: "deleted", slug: row.slug };
}

// ---------------------------------------------------------------------------
// My Pages
// ---------------------------------------------------------------------------

export type MyPageRow = {
  id: string;
  slug: string;
  title: string | null;
  status: string;
  kind: PageKind | null;
  targetKey: string | null;
  updatedAt: string | null;
  publishedAt: string | null;
  generationState: GenerationState["state"] | null;
  generationError: string | null;
  generating: boolean;
  noindex: boolean;
};

export async function listPages(workspaceId: string): Promise<MyPageRow[]> {
  const { rows, complete } = await readAll<EditorPageRow>(
    () =>
      sb()
        .from("tenant_pages")
        .select(
          "id, slug, title, status, target_key, updated_at, published_at, generation, noindex, page_templates:template_id(slug)",
        )
        .eq("workspace_id", workspaceId)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true }),
    100_000,
  );
  if (!complete) throw new Error("pages: too many pages to list completely");
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    status: r.status,
    kind: pageKindOf(r),
    targetKey: r.target_key,
    updatedAt: r.updated_at,
    publishedAt: r.published_at,
    generationState: r.generation?.state ?? null,
    generationError: r.generation?.state === "failed" ? (r.generation.error ?? null) : null,
    generating: isGenerationActive(r.generation),
    noindex: r.noindex === true,
  }));
}
