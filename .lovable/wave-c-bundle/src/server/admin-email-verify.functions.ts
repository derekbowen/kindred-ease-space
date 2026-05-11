import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const API_BASE = "https://app.emailverify.io/api";

// per the question answers
const VALID_STATUSES = new Set(["valid"]);
// "invalid", "unknown", "catch-all", "risky", "abuse", "do_not_mail", "spamtrap" → not sendable

function isSendable(status: string | null | undefined): boolean {
  if (!status) return false;
  return VALID_STATUSES.has(status.toLowerCase());
}

async function assertAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Forbidden");
}

export const getEmailVerifyBalance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin((context as { userId: string }).userId);
  const key = process.env.EMAILVERIFY_API_KEY;
  if (!key) return { ok: false, error: "EMAILVERIFY_API_KEY not configured" };
  try {
    const res = await fetch(`${API_BASE}/v2/check-account-balance?key=${encodeURIComponent(key)}`);
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `Balance check failed (${res.status})`, raw: data };
    return { ok: true, status: data.api_status, credits: data.available_credits ?? 0 };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Network error" };
  }
});

export const getEmailVerifyStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin((context as { userId: string }).userId);
  try {
    const { data, error } = await supabaseAdmin
      .from("host_leads")
      .select("email_status, email_sendable, email_verified_at");
    if (error) throw error;
    const total = data?.length || 0;
    const verified = data?.filter((r) => r.email_verified_at).length || 0;
    const unverified = total - verified;
    const sendable = data?.filter((r) => r.email_sendable === true).length || 0;
    const invalid = data?.filter((r) => r.email_verified_at && r.email_sendable === false).length || 0;
    const byStatus: Record<string, number> = {};
    for (const r of data || []) {
      if (r.email_status) byStatus[r.email_status] = (byStatus[r.email_status] || 0) + 1;
    }
    return { ok: true, total, verified, unverified, sendable, invalid, byStatus };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Stats failed", total: 0, verified: 0, unverified: 0, sendable: 0, invalid: 0, byStatus: {} };
  }
});

export const verifyHostLeadBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ limit: z.number().min(1).max(100).default(25) }).parse)
  .handler(async ({ data, context }) => {
    await assertAdmin((context as { userId: string }).userId);
    const key = process.env.EMAILVERIFY_API_KEY;
    if (!key) return { ok: false, error: "EMAILVERIFY_API_KEY not configured", processed: 0, results: [] };

    try {
      const { data: rows, error } = await supabaseAdmin
        .from("host_leads")
        .select("id, email")
        .is("email_verified_at", null)
        .order("created_at", { ascending: false })
        .limit(data.limit);
      if (error) throw error;

      if (!rows || rows.length === 0) {
        return { ok: true, processed: 0, results: [], message: "No unverified leads remaining" };
      }

      const results: Array<{ id: string; email: string; status: string; sub_status: string; sendable: boolean; error?: string }> = [];

      for (const row of rows) {
        try {
          const url = `${API_BASE}/v1/validate?key=${encodeURIComponent(key)}&email=${encodeURIComponent(row.email)}`;
          const res = await fetch(url);
          const v: any = await res.json().catch(() => ({}));

          if (!res.ok) {
            results.push({ id: row.id, email: row.email, status: "error", sub_status: "", sendable: false, error: v?.error || `HTTP ${res.status}` });
            // stop the loop on auth or credit errors
            if (res.status === 401 || res.status === 402 || /credit/i.test(JSON.stringify(v))) break;
            continue;
          }

          const status = String(v.status || "unknown").toLowerCase();
          const sub = String(v.sub_status || "");
          const sendable = isSendable(status);

          await supabaseAdmin
            .from("host_leads")
            .update({
              email_status: status,
              email_sub_status: sub,
              email_sendable: sendable,
              email_verified_at: new Date().toISOString(),
            })
            .eq("id", row.id);

          results.push({ id: row.id, email: row.email, status, sub_status: sub, sendable });
        } catch (e: any) {
          results.push({ id: row.id, email: row.email, status: "error", sub_status: "", sendable: false, error: e?.message || "Request failed" });
        }
      }

      return { ok: true, processed: results.length, results };
    } catch (e: any) {
      return { ok: false, error: e?.message || "Batch failed", processed: 0, results: [] };
    }
  });

export const listVerifiedLeads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ filter: z.enum(["all", "sendable", "invalid", "unverified"]).default("all") }).parse)
  .handler(async ({ data, context }) => {
    await assertAdmin((context as { userId: string }).userId);
    try {
      let q = supabaseAdmin
        .from("host_leads")
        .select("id, name, email, phone_e164, city, region, created_at, email_status, email_sub_status, email_sendable, email_verified_at")
        .order("created_at", { ascending: false })
        .limit(500);

      if (data.filter === "sendable") q = q.eq("email_sendable", true);
      else if (data.filter === "invalid") q = q.eq("email_sendable", false);
      else if (data.filter === "unverified") q = q.is("email_verified_at", null);

      const { data: rows, error } = await q;
      if (error) throw error;
      return { ok: true, rows: rows || [] };
    } catch (e: any) {
      return { ok: false, error: e?.message || "Load failed", rows: [] };
    }
  });
