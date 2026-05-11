// EmailIt API wrapper — server-only.
// Docs: https://emailit.com/docs/api-reference/

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const EMAILIT_API_URL = "https://api.emailit.com/v2/emails";

// --- Template rendering -------------------------------------------------
// Customizable templates live in the `email_templates` table. Each builder
// below has a default subject/html/text. Admins can override any field via
// the Email Templates admin page; placeholders like {{name}} are filled in
// at send time. Unknown placeholders render as empty strings.

export type RenderedEmail = { subject: string; html: string; text: string };

function applyVars(tpl: string, vars: Record<string, string | undefined | null>) {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k: string) => {
    const v = vars[k];
    return v == null ? "" : String(v);
  });
}

const TEMPLATE_CACHE = new Map<string, { row: any; at: number }>();
const CACHE_TTL_MS = 30_000;

async function loadTemplateOverride(key: string): Promise<{
  subject: string;
  html: string;
  text: string | null;
  is_enabled: boolean;
} | null> {
  const cached = TEMPLATE_CACHE.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.row;
  try {
    const { data } = await supabaseAdmin
      .from("email_templates")
      .select("subject,html,text,is_enabled")
      .eq("key", key)
      .maybeSingle();
    TEMPLATE_CACHE.set(key, { row: data ?? null, at: Date.now() });
    return (data as any) ?? null;
  } catch {
    return null;
  }
}

export function clearEmailTemplateCache(key?: string) {
  if (key) TEMPLATE_CACHE.delete(key);
  else TEMPLATE_CACHE.clear();
}

async function renderTemplate(
  key: string,
  defaults: { subject: string; html: string; text: string },
  vars: Record<string, string | undefined | null>
): Promise<RenderedEmail | null> {
  const override = await loadTemplateOverride(key);
  if (override && override.is_enabled === false) return null;
  const subject = applyVars(override?.subject || defaults.subject, vars);
  const html = applyVars(override?.html || defaults.html, vars);
  const text = applyVars(override?.text || defaults.text, vars);
  return { subject, html, text };
}

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string; // defaults to FROM_EMAIL env or noreply@founders.click
  replyTo?: string;
  idempotencyKey?: string;
  meta?: Record<string, string>;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
  status?: number;
}

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const apiKey = process.env.EMAILIT_API_KEY;
  if (!apiKey) {
    console.error("[email] EMAILIT_API_KEY not configured");
    return { ok: false, error: "EMAILIT_API_KEY not configured" };
  }

  const from =
    params.from ||
    process.env.FROM_EMAIL ||
    "founders.click <noreply@founders.click>";

  const body: Record<string, unknown> = {
    from,
    to: params.to,
    subject: params.subject,
  };
  if (params.html) body.html = params.html;
  if (params.text) body.text = params.text;
  if (params.replyTo) body.reply_to = params.replyTo;
  if (params.meta) body.meta = params.meta;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (params.idempotencyKey) headers["Idempotency-Key"] = params.idempotencyKey;

  try {
    const res = await fetch(EMAILIT_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      error?: string;
    };
    if (!res.ok) {
      const msg = data.error || data.message || `EmailIt ${res.status}`;
      console.error("[email] send failed", res.status, msg);
      return { ok: false, error: msg, status: res.status };
    }
    return { ok: true, id: data.id, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    console.error("[email] send exception", msg);
    return { ok: false, error: msg };
  }
}

// --- Templates ---------------------------------------------------------

const BRAND = "founders.click";
const APP_URL =
  process.env.PUBLIC_APP_URL || "https://founders.click";

const baseStyle = `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#0f172a;line-height:1.55;max-width:560px;margin:0 auto;padding:24px;`;
const btnStyle = `display:inline-block;background:#0f172a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;`;

export function welcomeEmailTemplate(opts: { name?: string; workspaceSlug: string }) {
  const greeting = opts.name ? `Hi ${opts.name},` : "Welcome,";
  const url = `${APP_URL}/app`;
  return {
    subject: `Welcome to ${BRAND} — let's launch your first SEO page`,
    html: `<div style="${baseStyle}">
  <h1 style="font-size:22px;margin:0 0 16px;">${greeting}</h1>
  <p>You're in. ${BRAND} turns your Sharetribe marketplace into hundreds of SEO-optimized landing pages — without writing code.</p>
  <p><strong>Three steps to your first ranked page:</strong></p>
  <ol>
    <li>Connect your Sharetribe marketplace</li>
    <li>Sync your listings (we do this automatically every 30 min)</li>
    <li>Generate your first City Hub page</li>
  </ol>
  <p style="margin:28px 0;"><a href="${url}" style="${btnStyle}">Open your dashboard</a></p>
  <p style="color:#64748b;font-size:13px;">Reply to this email if you get stuck — a real human reads every message.</p>
</div>`,
    text: `${greeting}\n\nYou're in. ${BRAND} turns your Sharetribe marketplace into SEO-optimized landing pages.\n\nNext: open ${url} and connect your marketplace.\n\nReply if you need help.`,
  };
}

// --- Support ticket templates -----------------------------------------

export const SUPPORT_INBOX_EMAIL =
  process.env.SUPPORT_INBOX_EMAIL || "support@founders.click";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function newTicketStaffTemplate(opts: {
  ticketId: string;
  subject: string;
  message: string;
  email: string;
  name?: string | null;
  category?: string | null;
  priority: string;
}) {
  const ticketUrl = `${APP_URL}/app/admin/help/tickets`;
  const who = opts.name ? `${escapeHtml(opts.name)} &lt;${escapeHtml(opts.email)}&gt;` : escapeHtml(opts.email);
  return {
    subject: `[Ticket] ${opts.priority.toUpperCase()} · ${opts.subject}`,
    html: `<div style="${baseStyle}">
  <p style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin:0 0 4px;">New support ticket</p>
  <h1 style="font-size:20px;margin:0 0 12px;">${escapeHtml(opts.subject)}</h1>
  <p style="margin:0 0 6px;"><strong>From:</strong> ${who}</p>
  <p style="margin:0 0 6px;"><strong>Priority:</strong> ${escapeHtml(opts.priority)}${opts.category ? ` · <strong>Category:</strong> ${escapeHtml(opts.category)}` : ""}</p>
  <div style="margin:18px 0;padding:14px 16px;background:#f8fafc;border-left:3px solid #0f172a;border-radius:4px;white-space:pre-wrap;font-size:14px;">${escapeHtml(opts.message)}</div>
  <p style="margin:24px 0;"><a href="${ticketUrl}" style="${btnStyle}">Open ticket inbox</a></p>
  <p style="color:#64748b;font-size:12px;">Ticket ID: ${opts.ticketId}</p>
</div>`,
    text: `New support ticket\n\nFrom: ${opts.name ? `${opts.name} <${opts.email}>` : opts.email}\nPriority: ${opts.priority}${opts.category ? `\nCategory: ${opts.category}` : ""}\n\nSubject: ${opts.subject}\n\n${opts.message}\n\nOpen inbox: ${ticketUrl}\nTicket ID: ${opts.ticketId}`,
  };
}

export function ticketReceivedUserTemplate(opts: {
  ticketId: string;
  subject: string;
  name?: string | null;
}) {
  const greeting = opts.name ? `Hi ${escapeHtml(opts.name)},` : "Hi,";
  return {
    subject: `We received your message: ${opts.subject}`,
    html: `<div style="${baseStyle}">
  <h1 style="font-size:20px;margin:0 0 12px;">${greeting}</h1>
  <p>Thanks for reaching out to ${BRAND} support. We've received your message and a real human will get back to you as soon as possible — usually within one business day.</p>
  <p><strong>Your message:</strong> ${escapeHtml(opts.subject)}</p>
  <p style="color:#64748b;font-size:13px;">If you have anything to add, just reply to this email.</p>
  <p style="color:#94a3b8;font-size:12px;margin-top:24px;">Reference: ${opts.ticketId}</p>
</div>`,
    text: `${greeting}\n\nThanks for reaching out to ${BRAND} support. We've received your message: "${opts.subject}" and will reply soon.\n\nReply to this email if you have anything to add.\n\nReference: ${opts.ticketId}`,
  };
}

const STATUS_COPY: Record<string, { label: string; body: string }> = {
  open: {
    label: "Open",
    body: "Your ticket is back in our queue and we'll respond shortly.",
  },
  in_progress: {
    label: "In progress",
    body: "We're actively working on your ticket and will follow up with an update.",
  },
  waiting: {
    label: "Waiting on you",
    body: "We need a bit more information from you to keep moving. Please reply to your last message when you can.",
  },
  resolved: {
    label: "Resolved",
    body: "We've marked this ticket as resolved. If anything is still off, reply and we'll reopen it.",
  },
  closed: {
    label: "Closed",
    body: "This ticket is now closed. You can always reply to start a new conversation.",
  },
};

export function ticketStatusChangedTemplate(opts: {
  ticketId: string;
  subject: string;
  name?: string | null;
  newStatus: string;
}) {
  const copy = STATUS_COPY[opts.newStatus] ?? {
    label: opts.newStatus,
    body: `Status updated to ${opts.newStatus}.`,
  };
  const greeting = opts.name ? `Hi ${escapeHtml(opts.name)},` : "Hi,";
  return {
    subject: `[${copy.label}] ${opts.subject}`,
    html: `<div style="${baseStyle}">
  <h1 style="font-size:20px;margin:0 0 12px;">${greeting}</h1>
  <p>Your support ticket <strong>"${escapeHtml(opts.subject)}"</strong> has been updated to <strong>${escapeHtml(copy.label)}</strong>.</p>
  <p>${copy.body}</p>
  <p style="color:#64748b;font-size:13px;margin-top:24px;">Just reply to this email to continue the conversation.</p>
  <p style="color:#94a3b8;font-size:12px;margin-top:18px;">Reference: ${opts.ticketId}</p>
</div>`,
    text: `${greeting}\n\nYour support ticket "${opts.subject}" has been updated to ${copy.label}.\n\n${copy.body}\n\nReply to this email to continue the conversation.\n\nReference: ${opts.ticketId}`,
  };
}

