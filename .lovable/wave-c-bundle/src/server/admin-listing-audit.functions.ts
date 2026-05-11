import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sendViaEmailit } from "@/lib/email/emailit";

const sb = () => supabaseAdmin;

async function assertAdmin(userId: string) {
  const { data } = await sb().from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
  if (!data) throw new Error("Admin only");
}

export type ListingAuditRow = {
  id: string;
  listing_url: string;
  listing_title: string | null;
  host_email: string | null;
  host_name: string | null;
  score: number | null;
  summary: string | null;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  pricing_notes: string | null;
  photo_notes: string | null;
  audited_at: string;
  emailed_at: string | null;
  email_status: string | null;
};

function normalizeListingUrl(input: string): string {
  let u = (input || "").trim();
  if (!u) return u;
  if (!/^https?:\/\//i.test(u)) {
    // Treat bare paths as poolrentalnearme.com listings
    u = `https://www.poolrentalnearme.com${u.startsWith("/") ? "" : "/"}${u}`;
  }
  return u;
}

async function scrapeListing(url: string): Promise<{ html: string; markdown: string; title: string }> {
  const fcKey = process.env.FIRECRAWL_API_KEY;
  if (!fcKey) throw new Error("FIRECRAWL_API_KEY not configured");
  const resp = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown", "html"], onlyMainContent: true }),
  });
  if (!resp.ok) throw new Error(`Firecrawl ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const j = await resp.json();
  const data = j?.data || j || {};
  return {
    html: data.html || "",
    markdown: data.markdown || "",
    title: data?.metadata?.title || data?.metadata?.ogTitle || "",
  };
}

export const auditListing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      listing_url: z.string().min(5).max(500),
      host_email: z.string().email().max(255).optional().or(z.literal("")),
      host_name: z.string().max(120).optional().or(z.literal("")),
      send_email: z.boolean().default(false),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const lovKey = process.env.LOVABLE_API_KEY;
    if (!lovKey) return { ok: false, error: "LOVABLE_API_KEY not configured" };

    const url = normalizeListingUrl(data.listing_url);
    let scraped: { markdown: string; html: string; title: string };
    try { scraped = await scrapeListing(url); }
    catch (e: any) { return { ok: false, error: `Could not fetch listing: ${e?.message || e}` }; }

    const body = (scraped.markdown || scraped.html.replace(/<[^>]+>/g, " ")).slice(0, 9000);
    if (body.trim().length < 100) {
      return { ok: false, error: "Listing page returned almost no content. Double-check the URL." };
    }

    const prompt = `You are an expert pool rental marketplace listing coach for Pool Rental Near Me (a Swimply-style platform).
Audit this host listing. Score 0-100 against best-in-class listings (great photos, clear amenities, fair pricing $40-150/hr typical, detailed description, house rules, response info).
Return STRICT JSON only, no markdown fences:
{
  "score": <0-100>,
  "summary": "<one sentence overall verdict written to the host>",
  "strengths": ["<short bullet>", ...],
  "weaknesses": ["<short bullet>", ...],
  "recommendations": ["<specific actionable bullet>", ...],
  "pricing_notes": "<2-3 sentences on pricing positioning>",
  "photo_notes": "<2-3 sentences on photo quality, count, angles>"
}

Listing URL: ${url}
Listing title: ${scraped.title || "(unknown)"}

Listing content (truncated):
${body}`;

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${lovKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!aiResp.ok) return { ok: false, error: `AI ${aiResp.status}: ${(await aiResp.text()).slice(0, 200)}` };
    const aiJson = await aiResp.json();
    const content: string = aiJson?.choices?.[0]?.message?.content || "";
    const cleaned = content.replace(/```json\s*/i, "").replace(/```\s*$/i, "").trim();
    let parsed: any;
    try { parsed = JSON.parse(cleaned); } catch {
      return { ok: false, error: "AI returned non-JSON", raw: content.slice(0, 300) };
    }

    const hostEmail = (data.host_email || "").trim() || null;
    const hostName = (data.host_name || "").trim() || null;

    const { data: row, error } = await sb().from("listing_audits").insert({
      listing_url: url,
      listing_title: scraped.title || null,
      host_email: hostEmail,
      host_name: hostName,
      score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
      summary: String(parsed.summary || "").slice(0, 1000),
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 20) : [],
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.slice(0, 20) : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 20) : [],
      pricing_notes: parsed.pricing_notes ? String(parsed.pricing_notes).slice(0, 2000) : null,
      photo_notes: parsed.photo_notes ? String(parsed.photo_notes).slice(0, 2000) : null,
      raw_excerpt: body.slice(0, 4000),
      created_by: (context as any).userId,
    }).select("*").maybeSingle();
    if (error) return { ok: false, error: error.message };

    let emailResult: { sent: boolean; error?: string } = { sent: false };
    if (data.send_email && hostEmail) {
      emailResult = await sendListingAuditEmailInternal(row as any);
      await sb().from("listing_audits").update({
        emailed_at: emailResult.sent ? new Date().toISOString() : null,
        email_status: emailResult.sent ? "sent" : `error: ${emailResult.error || "unknown"}`,
      }).eq("id", (row as any).id);
    }

    const { data: refreshed } = await sb().from("listing_audits").select("*").eq("id", (row as any).id).maybeSingle();
    return { ok: true, audit: refreshed as ListingAuditRow, email: emailResult };
  });

function renderAuditHtml(row: any): string {
  const items = (arr: any[], emoji: string) =>
    (arr || []).map((s: string) => `<li style="margin:6px 0;">${emoji} ${escape(String(s))}</li>`).join("");
  const greeting = row.host_name ? `Hi ${escape(row.host_name)},` : "Hi there,";
  const scoreColor = row.score >= 80 ? "#059669" : row.score >= 60 ? "#d97706" : "#dc2626";
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#ffffff;color:#0f172a;margin:0;padding:0;">
  <div style="max-width:640px;margin:0 auto;padding:24px 20px;">
    <h1 style="font-size:22px;margin:0 0 4px;">Your Pool Rental Near Me listing audit</h1>
    <p style="color:#64748b;margin:0 0 20px;font-size:13px;">${escape(row.listing_url)}</p>

    <p style="margin:0 0 16px;">${greeting}</p>
    <p style="margin:0 0 20px;">We ran a free AI audit on your listing. Here is what stood out and how to push more bookings your way.</p>

    <div style="border:1px solid #e2e8f0;border-radius:14px;padding:18px;margin:0 0 18px;display:flex;align-items:center;justify-content:space-between;gap:16px;">
      <div>
        <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:#64748b;text-transform:uppercase;">Overall score</div>
        <div style="font-size:14px;color:#334155;margin-top:4px;">${escape(row.summary || "")}</div>
      </div>
      <div style="font-size:44px;font-weight:800;color:${scoreColor};line-height:1;">${row.score ?? "—"}</div>
    </div>

    <h2 style="font-size:15px;margin:20px 0 6px;">What you're doing well</h2>
    <ul style="padding-left:20px;margin:0 0 16px;">${items(row.strengths, "✅")}</ul>

    <h2 style="font-size:15px;margin:20px 0 6px;">Where you're losing bookings</h2>
    <ul style="padding-left:20px;margin:0 0 16px;">${items(row.weaknesses, "⚠️")}</ul>

    <h2 style="font-size:15px;margin:20px 0 6px;">Do these next</h2>
    <ul style="padding-left:20px;margin:0 0 16px;">${items(row.recommendations, "👉")}</ul>

    ${row.pricing_notes ? `<h2 style="font-size:15px;margin:20px 0 6px;">Pricing</h2><p style="margin:0 0 14px;">${escape(row.pricing_notes)}</p>` : ""}
    ${row.photo_notes ? `<h2 style="font-size:15px;margin:20px 0 6px;">Photos</h2><p style="margin:0 0 14px;">${escape(row.photo_notes)}</p>` : ""}

    <p style="margin:24px 0 4px;color:#64748b;font-size:12px;">Pool Rental Near Me · 10% flat host fee · $2M liability included on every booking.</p>
  </div>
</body></html>`;
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function sendListingAuditEmailInternal(row: any): Promise<{ sent: boolean; error?: string }> {
  if (!row?.host_email) return { sent: false, error: "no host email" };
  try {
    await sendViaEmailit({
      from: "Pool Rental Near Me <hosts@poolrentalnearme.online>",
      to: row.host_email,
      subject: `Your listing audit: ${row.score}/100`,
      html: renderAuditHtml(row),
      replyTo: "hosts@poolrentalnearme.online",
    });
    return { sent: true };
  } catch (e: any) {
    return { sent: false, error: e?.message || String(e) };
  }
}

export const emailListingAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid(),
      override_email: z.string().email().max(255).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { data: row } = await sb().from("listing_audits").select("*").eq("id", data.id).maybeSingle();
    if (!row) return { ok: false, error: "Audit not found" };
    const target = { ...row, host_email: data.override_email || row.host_email };
    if (!target.host_email) return { ok: false, error: "No host email on file" };
    const r = await sendListingAuditEmailInternal(target);
    await sb().from("listing_audits").update({
      host_email: target.host_email,
      emailed_at: r.sent ? new Date().toISOString() : row.emailed_at,
      email_status: r.sent ? "sent" : `error: ${r.error || "unknown"}`,
    }).eq("id", data.id);
    return r.sent ? { ok: true } : { ok: false, error: r.error };
  });

export const listListingAudits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ limit: z.number().int().min(5).max(200).default(40) }).parse(d ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ rows: ListingAuditRow[] }> => {
    await assertAdmin((context as any).userId);
    const { data: rows } = await sb().from("listing_audits")
      .select("*").order("audited_at", { ascending: false }).limit(data.limit);
    return { rows: (rows || []) as ListingAuditRow[] };
  });

export const deleteListingAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    await sb().from("listing_audits").delete().eq("id", data.id);
    return { ok: true };
  });
