// EmailIt API wrapper — server-only.
// Docs: https://emailit.com/docs/api-reference/

const EMAILIT_API_URL = "https://api.emailit.com/v2/emails";

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
