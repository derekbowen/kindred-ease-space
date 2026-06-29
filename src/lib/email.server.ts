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
  vars: Record<string, string | undefined | null>,
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

  const from = params.from || process.env.FROM_EMAIL || "founders.click <noreply@founders.click>";

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
const APP_URL = process.env.PUBLIC_APP_URL || "https://founders.click";

const baseStyle = `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#0f172a;line-height:1.55;max-width:560px;margin:0 auto;padding:24px;`;
const btnStyle = `display:inline-block;background:#0f172a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;`;

// --- Template registry ------------------------------------------------
//
// Each entry defines the default subject/html/text plus the placeholders
// admins can use when customizing it from the Email Templates admin page.

export type TemplateDefinition = {
  key: string;
  name: string;
  description: string;
  category: "tickets" | "help" | "account";
  defaultSubject: string;
  defaultHtml: string;
  defaultText: string;
  placeholders: { name: string; description: string; sample: string }[];
};

export const TEMPLATE_DEFINITIONS: TemplateDefinition[] = [
  {
    key: "welcome",
    name: "Welcome email",
    description: "Sent to a new user after they create their workspace.",
    category: "account",
    defaultSubject: `Welcome to ${BRAND} — let's launch your first SEO page`,
    defaultHtml: `<div style="${baseStyle}">
  <h1 style="font-size:22px;margin:0 0 16px;">{{greeting}}</h1>
  <p>You're in. ${BRAND} turns your Sharetribe marketplace into hundreds of SEO-optimized landing pages — without writing code.</p>
  <p><strong>Three steps to your first ranked page:</strong></p>
  <ol>
    <li>Connect your Sharetribe marketplace</li>
    <li>Sync your listings (we do this automatically every 30 min)</li>
    <li>Generate your first City Hub page</li>
  </ol>
  <p style="margin:28px 0;"><a href="{{appUrl}}" style="${btnStyle}">Open your dashboard</a></p>
  <p style="color:#64748b;font-size:13px;">Reply to this email if you get stuck — a real human reads every message.</p>
</div>`,
    defaultText: `{{greeting}}\n\nYou're in. ${BRAND} turns your Sharetribe marketplace into SEO-optimized landing pages.\n\nNext: open {{appUrl}} and connect your marketplace.\n\nReply if you need help.`,
    placeholders: [
      { name: "greeting", description: "Personalized salutation", sample: "Hi Alex," },
      { name: "name", description: "Recipient first name", sample: "Alex" },
      { name: "appUrl", description: "Dashboard URL", sample: `${APP_URL}/app` },
    ],
  },
  {
    key: "ticket_new_staff",
    name: "New ticket → staff inbox",
    description: "Notifies the support inbox when a user submits a ticket.",
    category: "tickets",
    defaultSubject: `[Ticket] {{priorityUpper}} · {{subject}}`,
    defaultHtml: `<div style="${baseStyle}">
  <p style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin:0 0 4px;">New support ticket</p>
  <h1 style="font-size:20px;margin:0 0 12px;">{{subject}}</h1>
  <p style="margin:0 0 6px;"><strong>From:</strong> {{who}}</p>
  <p style="margin:0 0 6px;"><strong>Priority:</strong> {{priority}}{{categoryLine}}</p>
  <div style="margin:18px 0;padding:14px 16px;background:#f8fafc;border-left:3px solid #0f172a;border-radius:4px;white-space:pre-wrap;font-size:14px;">{{message}}</div>
  <p style="margin:24px 0;"><a href="{{ticketUrl}}" style="${btnStyle}">Open ticket inbox</a></p>
  <p style="color:#64748b;font-size:12px;">Ticket ID: {{ticketId}}</p>
</div>`,
    defaultText: `New support ticket\n\nFrom: {{whoText}}\nPriority: {{priority}}{{categoryLineText}}\n\nSubject: {{subject}}\n\n{{message}}\n\nOpen inbox: {{ticketUrl}}\nTicket ID: {{ticketId}}`,
    placeholders: [
      { name: "subject", description: "Ticket subject", sample: "Cannot publish page" },
      {
        name: "message",
        description: "Original message body",
        sample: "I keep getting an error...",
      },
      {
        name: "who",
        description: "Submitter HTML (Name <email>)",
        sample: "Alex &lt;alex@x.com&gt;",
      },
      { name: "whoText", description: "Submitter plain text", sample: "Alex <alex@x.com>" },
      { name: "priority", description: "Priority", sample: "high" },
      { name: "priorityUpper", description: "Priority uppercase", sample: "HIGH" },
      {
        name: "categoryLine",
        description: "Optional category line (HTML)",
        sample: " · <strong>Category:</strong> billing",
      },
      {
        name: "categoryLineText",
        description: "Optional category line (text)",
        sample: "\nCategory: billing",
      },
      { name: "ticketId", description: "Ticket ID", sample: "abc-123" },
      {
        name: "ticketUrl",
        description: "Admin inbox URL",
        sample: `${APP_URL}/app/admin/help/tickets`,
      },
    ],
  },
  {
    key: "ticket_received_user",
    name: "Ticket received → user",
    description: "Auto-acknowledgement sent to the user after they open a ticket.",
    category: "tickets",
    defaultSubject: `We received your message: {{subject}}`,
    defaultHtml: `<div style="${baseStyle}">
  <h1 style="font-size:20px;margin:0 0 12px;">{{greeting}}</h1>
  <p>Thanks for reaching out to ${BRAND} support. We've received your message and a real human will get back to you as soon as possible — usually within one business day.</p>
  <p><strong>Your message:</strong> {{subject}}</p>
  <p style="color:#64748b;font-size:13px;">If you have anything to add, just reply to this email.</p>
  <p style="color:#94a3b8;font-size:12px;margin-top:24px;">Reference: {{ticketId}}</p>
</div>`,
    defaultText: `{{greeting}}\n\nThanks for reaching out to ${BRAND} support. We've received your message: "{{subject}}" and will reply soon.\n\nReply to this email if you have anything to add.\n\nReference: {{ticketId}}`,
    placeholders: [
      { name: "greeting", description: "Salutation", sample: "Hi Alex," },
      { name: "name", description: "Recipient name", sample: "Alex" },
      { name: "subject", description: "Ticket subject", sample: "Cannot publish page" },
      { name: "ticketId", description: "Ticket ID", sample: "abc-123" },
    ],
  },
  {
    key: "ticket_status_changed",
    name: "Ticket status changed → user",
    description: "Notifies the user when staff updates the ticket status.",
    category: "tickets",
    defaultSubject: `[{{statusLabel}}] {{subject}}`,
    defaultHtml: `<div style="${baseStyle}">
  <h1 style="font-size:20px;margin:0 0 12px;">{{greeting}}</h1>
  <p>Your support ticket <strong>"{{subject}}"</strong> has been updated to <strong>{{statusLabel}}</strong>.</p>
  <p>{{statusBody}}</p>
  <p style="color:#64748b;font-size:13px;margin-top:24px;">Just reply to this email to continue the conversation.</p>
  <p style="color:#94a3b8;font-size:12px;margin-top:18px;">Reference: {{ticketId}}</p>
</div>`,
    defaultText: `{{greeting}}\n\nYour support ticket "{{subject}}" has been updated to {{statusLabel}}.\n\n{{statusBody}}\n\nReply to this email to continue the conversation.\n\nReference: {{ticketId}}`,
    placeholders: [
      { name: "greeting", description: "Salutation", sample: "Hi Alex," },
      { name: "name", description: "Recipient name", sample: "Alex" },
      { name: "subject", description: "Ticket subject", sample: "Cannot publish page" },
      { name: "statusLabel", description: "New status label", sample: "Resolved" },
      {
        name: "statusBody",
        description: "Status-specific copy",
        sample: "We've marked this ticket as resolved.",
      },
      { name: "ticketId", description: "Ticket ID", sample: "abc-123" },
    ],
  },
  {
    key: "help_feedback_followup",
    name: "Help feedback follow-up",
    description:
      "Sent to a user who left negative feedback on a help article so staff can ask what was missing.",
    category: "help",
    defaultSubject: `Following up on your feedback about "{{articleTitle}}"`,
    defaultHtml: `<div style="${baseStyle}">
  <h1 style="font-size:20px;margin:0 0 12px;">{{greeting}}</h1>
  <p>Thanks for letting us know that our article <strong>"{{articleTitle}}"</strong> didn't fully answer your question. We'd love to make it better.</p>
  {{commentBlock}}
  <p>Could you share what you were trying to do, or what was missing? Just reply to this email — it goes straight to our help team.</p>
  <p style="margin:24px 0;"><a href="{{articleUrl}}" style="${btnStyle}">Re-open the article</a></p>
  <p style="color:#94a3b8;font-size:12px;margin-top:18px;">— The ${BRAND} help team</p>
</div>`,
    defaultText: `{{greeting}}\n\nThanks for letting us know that our article "{{articleTitle}}" didn't fully answer your question. We'd love to make it better.\n\n{{commentBlockText}}Could you share what you were trying to do, or what was missing? Just reply to this email.\n\nArticle: {{articleUrl}}\n\n— The ${BRAND} help team`,
    placeholders: [
      { name: "greeting", description: "Salutation", sample: "Hi there," },
      { name: "name", description: "Recipient name (optional)", sample: "Alex" },
      { name: "articleTitle", description: "Article title", sample: "How billing works" },
      { name: "articleUrl", description: "Public article URL", sample: `${APP_URL}/help/billing` },
      {
        name: "commentBlock",
        description: "Quoted feedback block (HTML)",
        sample: "<blockquote>Couldn't find pricing tiers</blockquote>",
      },
      {
        name: "commentBlockText",
        description: "Quoted feedback (plain text)",
        sample: "> Couldn't find pricing tiers\n\n",
      },
      { name: "staffName", description: "Staff signing the email", sample: "Sam" },
    ],
  },
];

const TPL_BY_KEY = new Map(TEMPLATE_DEFINITIONS.map((t) => [t.key, t]));

export function getTemplateDefinition(key: string) {
  return TPL_BY_KEY.get(key) ?? null;
}

async function buildEmail(
  key: string,
  vars: Record<string, string | undefined | null>,
): Promise<RenderedEmail | null> {
  const def = TPL_BY_KEY.get(key);
  if (!def) return null;
  return renderTemplate(
    key,
    { subject: def.defaultSubject, html: def.defaultHtml, text: def.defaultText },
    vars,
  );
}

export function renderTemplatePreview(
  def: TemplateDefinition,
  override: { subject?: string | null; html?: string | null; text?: string | null } | null,
  vars: Record<string, string | undefined | null>,
): RenderedEmail {
  return {
    subject: applyVars(override?.subject || def.defaultSubject, vars),
    html: applyVars(override?.html || def.defaultHtml, vars),
    text: applyVars(override?.text || def.defaultText, vars),
  };
}

// --- Public template builders ----------------------------------------

export async function welcomeEmailTemplate(opts: { name?: string; workspaceSlug: string }) {
  const greeting = opts.name ? `Hi ${opts.name},` : "Welcome,";
  return buildEmail("welcome", {
    greeting,
    name: opts.name ?? "",
    appUrl: `${APP_URL}/app`,
    workspaceSlug: opts.workspaceSlug,
  });
}

// --- Support ticket templates -----------------------------------------

export const SUPPORT_INBOX_EMAIL = process.env.SUPPORT_INBOX_EMAIL || "support@founders.click";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function newTicketStaffTemplate(opts: {
  ticketId: string;
  subject: string;
  message: string;
  email: string;
  name?: string | null;
  category?: string | null;
  priority: string;
}) {
  const ticketUrl = `${APP_URL}/app/admin/help/tickets`;
  const who = opts.name
    ? `${escapeHtml(opts.name)} &lt;${escapeHtml(opts.email)}&gt;`
    : escapeHtml(opts.email);
  const whoText = opts.name ? `${opts.name} <${opts.email}>` : opts.email;
  return buildEmail("ticket_new_staff", {
    ticketId: opts.ticketId,
    subject: escapeHtml(opts.subject),
    message: escapeHtml(opts.message),
    who,
    whoText,
    priority: escapeHtml(opts.priority),
    priorityUpper: opts.priority.toUpperCase(),
    categoryLine: opts.category ? ` · <strong>Category:</strong> ${escapeHtml(opts.category)}` : "",
    categoryLineText: opts.category ? `\nCategory: ${opts.category}` : "",
    ticketUrl,
  });
}

export async function ticketReceivedUserTemplate(opts: {
  ticketId: string;
  subject: string;
  name?: string | null;
}) {
  const greeting = opts.name ? `Hi ${escapeHtml(opts.name)},` : "Hi,";
  return buildEmail("ticket_received_user", {
    ticketId: opts.ticketId,
    subject: escapeHtml(opts.subject),
    name: opts.name ?? "",
    greeting,
  });
}

const STATUS_COPY: Record<string, { label: string; body: string }> = {
  open: { label: "Open", body: "Your ticket is back in our queue and we'll respond shortly." },
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

export async function ticketStatusChangedTemplate(opts: {
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
  return buildEmail("ticket_status_changed", {
    ticketId: opts.ticketId,
    subject: escapeHtml(opts.subject),
    name: opts.name ?? "",
    greeting,
    statusLabel: escapeHtml(copy.label),
    statusBody: copy.body,
  });
}

export async function helpFeedbackFollowUpTemplate(opts: {
  name?: string | null;
  articleTitle: string;
  articleUrl: string;
  comment?: string | null;
  staffName?: string | null;
}) {
  const greeting = opts.name ? `Hi ${escapeHtml(opts.name)},` : "Hi there,";
  const commentBlock = opts.comment
    ? `<blockquote style="margin:18px 0;padding:12px 14px;background:#f8fafc;border-left:3px solid #94a3b8;color:#475569;font-size:14px;white-space:pre-wrap;">${escapeHtml(opts.comment)}</blockquote>`
    : "";
  const commentBlockText = opts.comment ? `> ${opts.comment}\n\n` : "";
  return buildEmail("help_feedback_followup", {
    greeting,
    name: opts.name ?? "",
    articleTitle: escapeHtml(opts.articleTitle),
    articleUrl: opts.articleUrl,
    commentBlock,
    commentBlockText,
    staffName: opts.staffName ?? "",
  });
}
