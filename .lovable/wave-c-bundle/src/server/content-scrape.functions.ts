import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Scrape a single content_pages row via Firecrawl and store raw_html +
 * body_markdown for human review. Idempotent — overwrites prior scrape data
 * but keeps status="pending" so a second admin step promotes it to "drafted".
 *
 * Auth: admin-only. Driven from the admin migration UI; not on a cron until
 * we've QA'd a handful of pages.
 */

const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";

async function firecrawlScrape(url: string) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not configured");

  const res = await fetch(FIRECRAWL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["markdown", "html"],
      onlyMainContent: true,
    }),
  });

  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    throw new Error(
      `Firecrawl scrape failed [${res.status}]: ${JSON.stringify(json)}`,
    );
  }
  // SDK/REST shape: data may be at top level or under data
  const doc = json?.data ?? json;
  return {
    markdown: (doc?.markdown ?? null) as string | null,
    html: (doc?.html ?? doc?.rawHtml ?? null) as string | null,
    metadata: doc?.metadata ?? null,
  };
}

async function assertAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Admin role required");
}

/**
 * Scrape one row by id. Returns the updated row so the admin UI can preview.
 */
export const scrapeContentPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ id: z.string().uuid() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);

    const { data: row, error: fetchErr } = await supabaseAdmin
      .from("content_pages")
      .select("id, source_url, title, status")
      .eq("id", data.id)
      .maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!row) throw new Error("content_pages row not found");

    const { markdown, html, metadata } = await firecrawlScrape(
      (row as any).source_url,
    );

    const meta = (metadata ?? {}) as { title?: string; description?: string };
    const update = {
      raw_html: html,
      body_markdown: markdown,
      scraped_at: new Date().toISOString(),
      status: "scraped",
      ...(!(row as any).title && meta.title ? { title: meta.title } : {}),
      ...(meta.description ? { seo_description: meta.description } : {}),
    };

    const { data: updated, error: upErr } = await (supabaseAdmin as any)
      .from("content_pages")
      .update(update)
      .eq("id", data.id)
      .select("*")
      .single();
    if (upErr) throw new Error(upErr.message);

    return { page: updated };
  });

/**
 * Pick the next pending host_acq_city row (or any template_type if specified)
 * for one-at-a-time review. Lower priority value = processed first.
 */
export const nextPendingPage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        template_type: z.string().default("host_acq_city"),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);

    const { data: row, error } = await supabaseAdmin
      .from("content_pages")
      .select("id, url_path, slug, source_url, title, status, template_type")
      .eq("template_type", data.template_type)
      .eq("status", "pending")
      .order("priority", { ascending: true })
      .order("url_path", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);

    return { page: row };
  });

/**
 * Counts of pending vs scraped rows for a given template_type so the admin
 * UI can show a live progress bar during a scrape run.
 */
export const scrapeProgress = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({ template_type: z.string().default("host_acq_city") })
      .parse(data ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);

    const base = supabaseAdmin
      .from("content_pages")
      .select("id", { count: "exact", head: true })
      .eq("template_type", data.template_type);

    const [pendingRes, scrapedRes, totalRes] = await Promise.all([
      base.eq("status", "pending"),
      supabaseAdmin
        .from("content_pages")
        .select("id", { count: "exact", head: true })
        .eq("template_type", data.template_type)
        .eq("status", "scraped"),
      supabaseAdmin
        .from("content_pages")
        .select("id", { count: "exact", head: true })
        .eq("template_type", data.template_type),
    ]);

    if (pendingRes.error) throw new Error(pendingRes.error.message);
    if (scrapedRes.error) throw new Error(scrapedRes.error.message);
    if (totalRes.error) throw new Error(totalRes.error.message);

    return {
      pending: pendingRes.count ?? 0,
      scraped: scrapedRes.count ?? 0,
      total: totalRes.count ?? 0,
    };
  });
