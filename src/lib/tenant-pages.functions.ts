import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

async function assertMember(workspaceId: string, userId: string) {
  const { data, error } = await sb().rpc("is_workspace_member", {
    _workspace_id: workspaceId,
    _user_id: userId,
  });
  if (error || !data) throw new Error("forbidden");
}

// No "/": the public route /p/$slug matches a single path segment, so a slug
// containing a slash creates a page that can never be reached.
const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9-]*$/i, "Use letters, numbers and dashes");

export const listPageTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data } = await sb()
      .from("page_templates")
      .select("id, slug, name, description, config_schema, preview_image_url, is_active")
      .order("name", { ascending: true });
    return { templates: data ?? [] };
  });

export const listTenantPages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);
    const { data: rows } = await sb()
      .from("tenant_pages")
      .select(
        "id, slug, title, status, published_at, updated_at, template_id, page_templates:template_id(name, slug)",
      )
      .eq("workspace_id", data.workspaceId)
      .order("updated_at", { ascending: false });
    return { pages: rows ?? [] };
  });

export const getTenantPage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ workspaceId: z.string().uuid(), id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);
    const { data: row } = await sb()
      .from("tenant_pages")
      .select("*, page_templates:template_id(slug, name, config_schema)")
      .eq("workspace_id", data.workspaceId)
      .eq("id", data.id)
      .maybeSingle();
    return { page: row ?? null };
  });

const upsertSchema = z.object({
  workspaceId: z.string().uuid(),
  id: z.string().uuid().optional(),
  templateId: z.string().uuid(),
  slug: slugSchema,
  title: z.string().min(2).max(200),
  metaDescription: z.string().max(320).nullable().optional(),
  h1: z.string().max(200).nullable().optional(),
  bodyMarkdown: z.string().max(50_000).nullable().optional(),
  variables: z.record(z.string(), z.any()).default({}),
  listingFilter: z.record(z.string(), z.any()).default({}),
  status: z.enum(["draft", "published", "archived"]).default("draft"),
});

export const upsertTenantPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => upsertSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);

    // Publishing consumes a page-entitlement slot, so the status flip goes
    // through the atomic DB gate (publish_tenant_pages), never a direct write:
    // content is saved first (as draft when not already live), then the gate
    // decides whether a slot is available. Editing an ALREADY-published page
    // doesn't consume a new slot and stays a direct update.
    const wantsPublish = data.status === "published";
    let alreadyPublished = false;
    if (data.id) {
      const { data: existing } = await sb()
        .from("tenant_pages")
        .select("status")
        .eq("id", data.id)
        .eq("workspace_id", data.workspaceId)
        .maybeSingle();
      alreadyPublished = existing?.status === "published";
    }

    const row: Record<string, any> = {
      workspace_id: data.workspaceId,
      template_id: data.templateId,
      slug: data.slug.toLowerCase(),
      title: data.title,
      meta_description: data.metaDescription ?? null,
      h1: data.h1 ?? null,
      body_markdown: data.bodyMarkdown ?? null,
      variables: data.variables,
      listing_filter: data.listingFilter,
      status: wantsPublish && alreadyPublished ? "published" : wantsPublish ? "draft" : data.status,
    };

    let pageId: string;
    if (data.id) {
      const { data: out, error } = await sb()
        .from("tenant_pages")
        .update(row)
        .eq("id", data.id)
        .eq("workspace_id", data.workspaceId)
        .select("id")
        .single();
      if (error) return { ok: false as const, error: error.message };
      pageId = out.id;
    } else {
      const { data: out, error } = await sb()
        .from("tenant_pages")
        .insert(row)
        .select("id")
        .single();
      if (error) return { ok: false as const, error: error.message };
      pageId = out.id;
    }

    if (wantsPublish && !alreadyPublished) {
      // CONTRACT GATE, before the entitlement gate and in that order on purpose.
      // A page that would ship with `noindex`, or that duplicates one already
      // live, must not consume a paid capacity slot — the customer would be
      // charged for a page incapable of ranking. Checking capacity first would
      // burn the slot before we ever noticed.
      const { checkPageBeforePublish } = await import("@/lib/seo/page-contract.server");
      let contract;
      try {
        contract = await checkPageBeforePublish(data.workspaceId, {
          id: pageId,
          slug: row.slug,
          title: data.title,
          metaDescription: data.metaDescription ?? null,
          h1: data.h1 ?? null,
          bodyMarkdown: data.bodyMarkdown ?? null,
          listingFilter: data.listingFilter,
          variables: data.variables,
        });
      } catch (e) {
        // Cannot prove the page is publishable => do not claim it is.
        console.error("[publish] contract check unavailable", data.workspaceId, pageId, String(e));
        return {
          ok: false as const,
          code: "contract_unavailable" as const,
          error:
            "We couldn't verify this page is ready to publish, so it stayed a draft. Please try again.",
          id: pageId,
        };
      }
      if (!contract.ok) {
        // Pair each problem with its fix. A UI that renders only `error` still
        // tells the customer what to DO — being told a page "isn't ready"
        // with no next step is its own way of blocking the golden path.
        return {
          ok: false as const,
          code: "contract_failed" as const,
          error: `This page isn't ready to publish yet. ${contract.blocking
            .map((v) => `${v.message} ${v.fix}`)
            .join(" ")} Your changes were saved as a draft.`,
          id: pageId,
          violations: contract.violations,
        };
      }

      const { publishPagesAtomically, pageLimitMessage } = await import(
        "@/lib/entitlements.functions"
      );
      const gate = await publishPagesAtomically(data.workspaceId, [pageId]);
      if (gate.published === 0) {
        return {
          ok: false as const,
          code: "page_limit" as const,
          error: `${pageLimitMessage(gate.limit)} Your changes were saved as a draft.`,
          id: pageId,
          limit: gate.limit,
          publishedTotal: gate.publishedTotal,
        };
      }
    }

    return { ok: true as const, id: pageId };
  });

export const deleteTenantPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ workspaceId: z.string().uuid(), id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);
    const { error } = await sb()
      .from("tenant_pages")
      .delete()
      .eq("id", data.id)
      .eq("workspace_id", data.workspaceId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const bulkCreatePages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        workspaceId: z.string().uuid(),
        templateId: z.string().uuid(),
        rows: z
          .array(
            z.object({
              slug: slugSchema,
              title: z.string().min(2).max(200),
              metaDescription: z.string().max(320).optional(),
              variables: z.record(z.string(), z.any()).default({}),
              listingFilter: z.record(z.string(), z.any()).default({}),
            }),
          )
          .min(1)
          .max(500),
        status: z.enum(["draft", "published"]).default("draft"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);

    // Protect already-published pages: a re-import (same workspace+slug) must not
    // silently overwrite a live page's edited content, status, or published_at.
    // Skip published slugs; upsert only new pages and existing drafts.
    // A duplicate slug inside one batch makes the upsert fail with a raw
    // Postgres "cannot affect row a second time" error — keep the first
    // occurrence and count the rest as skipped.
    const seenSlugs = new Set<string>();
    const uniqueRows = data.rows.filter((r) => {
      const s = r.slug.toLowerCase();
      if (seenSlugs.has(s)) return false;
      seenSlugs.add(s);
      return true;
    });
    const dupSkipped = data.rows.length - uniqueRows.length;

    const slugs = uniqueRows.map((r) => r.slug.toLowerCase());
    const { data: existing } = await sb()
      .from("tenant_pages")
      .select("slug, status")
      .eq("workspace_id", data.workspaceId)
      .in("slug", slugs);
    const publishedSlugs = new Set(
      (existing ?? []).filter((r: any) => r.status === "published").map((r: any) => r.slug),
    );

    // Bulk pre-check (§31): know the entitlement BEFORE generating/publishing.
    // Rows are always written as drafts; if publishing was requested, the
    // atomic gate then flips as many as the plan allows and reports the rest.
    const inserts = uniqueRows
      .filter((r) => !publishedSlugs.has(r.slug.toLowerCase()))
      .map((r) => ({
        workspace_id: data.workspaceId,
        template_id: data.templateId,
        slug: r.slug.toLowerCase(),
        title: r.title,
        meta_description: r.metaDescription ?? null,
        h1: r.title,
        variables: r.variables,
        listing_filter: r.listingFilter,
        status: "draft",
      }));

    const skipped = uniqueRows.length - inserts.length + dupSkipped;
    if (inserts.length === 0) {
      return { ok: true as const, count: 0, skipped, publishedCount: 0, limitDenied: 0, limit: null as number | null };
    }
    const { data: out, error } = await sb()
      .from("tenant_pages")
      // slug comes back so returned rows can be matched to their source by KEY
      // rather than by array position — upsert does not guarantee it returns
      // rows in input order, and pairing by index would validate one page's
      // content against another page's id.
      .upsert(inserts, { onConflict: "workspace_id,slug", ignoreDuplicates: false })
      .select("id, slug");
    if (error) return { ok: false as const, error: error.message };

    let publishedCount = 0;
    let limitDenied = 0;
    let limit: number | null = null;
    let contractRejected = 0;
    let contractReasons: string[] = [];
    if (data.status === "published" && out && out.length > 0) {
      // Bulk is where thin and duplicate pages get mass-produced, so the
      // contract gate matters MORE here than on a single publish. Pages are
      // checked against each other as well as against what is already live:
      // importing 200 near-identical city pages would otherwise pass, since
      // none of them is published at the moment of the check.
      const returned = out as Array<{ id: string; slug: string }>;
      const bySlug = new Map(inserts.map((r) => [r.slug, r] as const));
      const candidates = returned
        .map((r) => {
          const src = bySlug.get(r.slug);
          if (!src) return null;
          return {
            id: r.id,
            slug: src.slug,
            title: src.title as string | null,
            metaDescription: src.meta_description as string | null,
            h1: src.h1 as string | null,
            // Bulk rows carry no body copy, so a page with no matching
            // inventory is thin by construction — which is exactly the
            // "thousands of pages with missing source data" case we must stop.
            bodyMarkdown: null,
            listingFilter: src.listing_filter as Record<string, any>,
            variables: src.variables as Record<string, any>,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const ids = candidates.map((c) => c.id);
      const { checkBatchBeforePublish } = await import("@/lib/seo/page-contract.server");
      let verdicts;
      try {
        verdicts = await checkBatchBeforePublish(data.workspaceId, candidates);
      } catch (e) {
        console.error("[bulk publish] contract check unavailable", data.workspaceId, String(e));
        return {
          ok: true as const,
          count: out.length,
          skipped,
          publishedCount: 0,
          limitDenied: 0,
          limit: null as number | null,
          contractRejected: out.length,
          contractReasons: [
            "We couldn't verify these pages were ready to publish, so they were saved as drafts.",
          ],
        };
      }

      const eligible = ids.filter((id) => verdicts.get(id)?.ok);
      contractRejected = ids.length - eligible.length;
      // Distinct reasons, so 200 rejections do not produce 200 identical lines.
      contractReasons = [
        ...new Set(
          ids
            .filter((id) => !verdicts.get(id)?.ok)
            .flatMap((id) => verdicts.get(id)!.blocking.map((v) => v.message)),
        ),
      ].slice(0, 5);

      if (eligible.length > 0) {
        const { publishPagesAtomically } = await import("@/lib/entitlements.functions");
        const gate = await publishPagesAtomically(data.workspaceId, eligible);
        publishedCount = gate.published;
        limitDenied = gate.denied;
        limit = gate.limit;
      }
    }

    return {
      ok: true as const,
      count: out?.length ?? 0,
      skipped,
      publishedCount,
      limitDenied,
      limit,
      contractRejected,
      contractReasons,
    };
  });
