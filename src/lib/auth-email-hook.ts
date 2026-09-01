/**
 * Pure logic for the Supabase Auth send-email hook: standard-webhooks
 * signature verification, verify-URL construction, and the email copy.
 *
 * Split from the route so the security-critical pieces run in unit tests with
 * no server environment. The route
 * (src/routes/api/public/hooks/auth-send-email.ts) documents the production
 * incident this hook exists to prevent recurring.
 */
import { createHmac, timingSafeEqual } from "crypto";

export const TIMESTAMP_TOLERANCE_S = 300;

/** Accepts the secret exactly as the Supabase dashboard displays it
 *  ("v1,whsec_<base64>") or as bare base64. */
export function decodeSecret(raw: string): Buffer | null {
  const m = /^v1,whsec_(.+)$/.exec(raw.trim());
  const b64 = m ? m[1]! : raw.trim().replace(/^whsec_/, "");
  try {
    const buf = Buffer.from(b64, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

export type WebhookHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

/**
 * standard-webhooks verification:
 *   base64(HMAC-SHA256(secret, `${id}.${timestamp}.${rawBody}`))
 * The signature header may carry several space-separated "v1,<base64>"
 * entries; any single match passes. Timestamps outside the tolerance window
 * are rejected to bound replay.
 */
export function verifySignature(
  h: WebhookHeaders,
  rawBody: string,
  secret: Buffer,
  nowMs: number = Date.now(),
): boolean {
  if (!h.id || !h.timestamp || !h.signature) return false;

  const age = Math.abs(nowMs / 1000 - Number(h.timestamp));
  if (!Number.isFinite(age) || age > TIMESTAMP_TOLERANCE_S) return false;

  const expected = createHmac("sha256", secret)
    .update(`${h.id}.${h.timestamp}.${rawBody}`)
    .digest();
  for (const part of h.signature.split(" ")) {
    const candidate = part.startsWith("v1,") ? part.slice(3) : part;
    try {
      const given = Buffer.from(candidate, "base64");
      if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

/** Sign a payload the way GoTrue does — used by tests and by any future
 *  self-check that wants to POST a synthetic event at the live endpoint. */
export function signPayload(id: string, timestamp: string, rawBody: string, secret: Buffer): string {
  return "v1," + createHmac("sha256", secret).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
}

export type EmailAction =
  | "signup"
  | "invite"
  | "magiclink"
  | "recovery"
  | "email_change_current"
  | "email_change_new"
  | "reauthentication";

export function verifyUrl(
  d: { token_hash?: string; email_action_type?: string; redirect_to?: string; site_url?: string },
  supabaseUrl: string,
): string {
  const base = (supabaseUrl ?? "").replace(/\/+$/, "");
  const redirect = d.redirect_to || d.site_url || "https://www.founders.click/app";
  // GoTrue's own verify endpoint completes the action then forwards the user.
  return (
    `${base}/auth/v1/verify?token=${encodeURIComponent(d.token_hash ?? "")}` +
    `&type=${encodeURIComponent(d.email_action_type ?? "")}` +
    `&redirect_to=${encodeURIComponent(redirect)}`
  );
}

export function copyFor(
  action: EmailAction,
  url: string,
  otp: string | undefined,
  name: string,
): { subject: string; html: string; text: string } {
  const hello = name ? `Hi ${name},` : "Hi,";
  const wrap = (title: string, body: string, cta: string) => ({
    subject: title,
    html:
      `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px">` +
      `<p style="font-size:18px;font-weight:700">founders<span style="color:#f97316">.click</span></p>` +
      `<p>${hello}</p><p>${body}</p>` +
      `<p style="margin:28px 0"><a href="${url}" style="background:#f97316;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">${cta}</a></p>` +
      (otp ? `<p style="color:#666">Or enter this code: <strong>${otp}</strong></p>` : "") +
      `<p style="color:#666;font-size:13px">If you didn't request this, you can safely ignore this email.</p>` +
      `</div>`,
    text: `${hello}\n\n${body}\n\n${cta}: ${url}\n${otp ? `Or enter this code: ${otp}\n` : ""}\nIf you didn't request this, you can safely ignore this email.`,
  });

  switch (action) {
    case "signup":
      return wrap(
        "Confirm your founders.click account",
        "Welcome to founders.click! Confirm your email address to activate your 14-day free trial.",
        "Confirm my email",
      );
    case "invite":
      return wrap(
        "You've been invited to founders.click",
        "You've been invited to join a workspace on founders.click. Accept the invitation to get started.",
        "Accept invitation",
      );
    case "magiclink":
      return wrap(
        "Your founders.click sign-in link",
        "Use the button below to sign in. This link can only be used once.",
        "Sign in",
      );
    case "recovery":
      return wrap(
        "Reset your founders.click password",
        "We received a request to reset your password. Use the button below to choose a new one.",
        "Reset password",
      );
    case "email_change_current":
    case "email_change_new":
      return wrap(
        "Confirm your email change",
        "Please confirm the change to the email address on your founders.click account.",
        "Confirm email change",
      );
    case "reauthentication":
      return wrap(
        "Confirm it's you",
        "Please confirm this action on your founders.click account.",
        "Confirm",
      );
  }
}
