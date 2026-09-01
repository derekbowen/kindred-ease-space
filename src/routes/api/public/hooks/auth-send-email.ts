/**
 * SUPABASE AUTH "SEND EMAIL" HOOK.
 *
 * GoTrue calls this for every auth email — signup confirmation, recovery,
 * magic link, email change — instead of sending through Supabase's built-in
 * mailer. We render branded copy and deliver through EmailIt.
 *
 * WHY THIS FILE EXISTS, bluntly: the Supabase project was already configured
 * with a send-email hook pointing at an endpoint served only by a Lovable
 * build that this repository never contained. When www.founders.click was cut
 * over to the CI-deployed Worker, that endpoint became a 404, GoTrue's hook
 * call failed, and every signup returned
 *   {"code":"unexpected_failure","message":"Unexpected status code returned from hook: 404"}
 * — signup was down platform-wide. This is the in-repo replacement, so the
 * hook target can never again live outside version control.
 *
 * Activation (Supabase dashboard → Authentication → Hooks → Send Email):
 *   URI:    https://www.founders.click/api/public/hooks/auth-send-email
 *   Secret: copy into the Worker as SEND_EMAIL_HOOK_SECRET (type Secret)
 *
 * FAILURE POSTURE: a non-2xx from here fails the customer's signup — the
 * outage we are fixing. So the ONLY hard failures are a missing/invalid
 * signature (a forged call must never trigger mail) and a missing recipient.
 * An EmailIt delivery error still returns 200 with the failure logged loudly:
 * an account that exists but must use "resend confirmation" beats a signup
 * that appears completely broken.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  copyFor,
  decodeSecret,
  verifySignature,
  verifyUrl,
  type EmailAction,
} from "@/lib/auth-email-hook";
import { sendEmail } from "@/lib/email.server";

export const Route = createFileRoute("/api/public/hooks/auth-send-email")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secretRaw = process.env.SEND_EMAIL_HOOK_SECRET;
        const secret = secretRaw ? decodeSecret(secretRaw) : null;
        if (!secret) {
          // Configured in Supabase but not here => every auth email fails.
          // Say so in the logs on every single call.
          console.error(
            "[auth-send-email] SEND_EMAIL_HOOK_SECRET missing/invalid — auth emails are DOWN until it is set",
          );
          return new Response(JSON.stringify({ error: "hook not configured" }), { status: 401 });
        }

        const rawBody = await request.text();
        const ok = verifySignature(
          {
            id: request.headers.get("webhook-id"),
            timestamp: request.headers.get("webhook-timestamp"),
            signature: request.headers.get("webhook-signature"),
          },
          rawBody,
          secret,
        );
        if (!ok) {
          console.error("[auth-send-email] rejected: bad signature/timestamp");
          return new Response(JSON.stringify({ error: "invalid signature" }), { status: 401 });
        }

        let payload: any;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
        }

        const action: EmailAction = payload?.email_data?.email_action_type ?? "signup";
        const to: string | undefined =
          action === "email_change_new"
            ? (payload?.user?.new_email ?? payload?.user?.email)
            : payload?.user?.email;
        if (!to) {
          return new Response(JSON.stringify({ error: "no recipient" }), { status: 400 });
        }

        const url = verifyUrl(payload?.email_data ?? {}, process.env.SUPABASE_URL ?? "");
        const name: string = payload?.user?.user_metadata?.full_name ?? "";
        const mail = copyFor(action, url, payload?.email_data?.token, name);

        const result = await sendEmail({ to, subject: mail.subject, html: mail.html, text: mail.text });
        if (!result.ok) {
          // Deliberate 200: failing the hook fails the SIGNUP itself, which is
          // a platform-wide outage. A missed email is recoverable ("resend
          // confirmation"); a failed signup is not. Loud log, calm response.
          console.error("[auth-send-email] EmailIt send FAILED", action, result.error);
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
