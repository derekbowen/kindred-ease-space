/**
 * EMAIL PROBE — what does the mail path actually do, right now?
 *
 * The auth email hook returns 200 even when EmailIt refuses the send, on
 * purpose: failing the hook fails the customer's signup, and a missed email is
 * recoverable where a broken signup is not. The cost of that choice is that a
 * delivery failure leaves no trace anywhere an operator will look — only a
 * console line in a Worker log nobody reads. founders.click ran that way for
 * months while every signup dead-ended at "check your email".
 *
 * This endpoint is the missing answer. One call reports both halves of the
 * chain:
 *
 *   1. Can mail from this domain authenticate at all (SPF/DKIM/DMARC)?
 *   2. What does EmailIt actually say when we hand it a message?
 *
 * It exists as an unauthenticated route on purpose, because the thing it
 * diagnoses is the reason nobody can log in. Gating it behind a session would
 * make it useless in exactly the situation it is for.
 *
 * Access is therefore by shared secret: the caller must present
 * SEND_EMAIL_HOOK_SECRET, which is already provisioned for the hook and is of
 * the same sensitivity as the mail path itself. Compared in constant time,
 * with the same decoder the hook uses so the dashboard's `v1,whsec_…` form
 * works verbatim.
 *
 * Sending is opt-in. Without `?send=1` this only reads DNS and reports
 * configuration, so the common case is side-effect free.
 */
import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { decodeSecret } from "@/lib/auth-email-hook";
import {
  checkSendingDomain,
  returnPathFromEnv,
  sendingDomainFromEnv,
} from "@/lib/email-deliverability";
import { sendEmail } from "@/lib/email.server";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Constant-time compare of the presented secret against the configured one. */
function authorised(presented: string | null): boolean {
  const configured = process.env.SEND_EMAIL_HOOK_SECRET;
  if (!configured || !presented) return false;
  const a = decodeSecret(presented);
  const b = decodeSecret(configured);
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const Route = createFileRoute("/api/public/ops/email-probe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const presented =
          request.headers.get("x-founders-probe-secret") ??
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
          null;

        if (!authorised(presented)) {
          // Deliberately identical for "no secret configured" and "wrong
          // secret": this endpoint is unauthenticated, so it must not become an
          // oracle for whether the hook secret is set.
          return json({ error: "unauthorized" }, 401);
        }

        const url = new URL(request.url);
        const shouldSend = url.searchParams.get("send") === "1";

        let to: string | null = null;
        if (shouldSend) {
          try {
            const body = (await request.json()) as { to?: string };
            to = typeof body?.to === "string" ? body.to.trim() : null;
          } catch {
            /* no body is fine when not sending */
          }
          if (!to || !to.includes("@")) {
            return json({ error: 'send=1 requires a JSON body: { "to": "you@example.com" }' }, 400);
          }
        }

        const from = process.env.FROM_EMAIL ?? null;
        const domain = sendingDomainFromEnv({
          FROM_EMAIL: process.env.FROM_EMAIL,
          EMAILIT_SENDER_DOMAIN: process.env.EMAILIT_SENDER_DOMAIN,
        });

        const config = {
          fromAddress: from,
          sendingDomain: domain,
          // Presence only. Never echo a key from an endpoint reachable by
          // anyone holding one secret.
          emailitApiKeyConfigured: Boolean(process.env.EMAILIT_API_KEY),
          hookSecretConfigured: Boolean(process.env.SEND_EMAIL_HOOK_SECRET),
          dkimSelectorConfigured: process.env.EMAILIT_DKIM_SELECTOR ?? null,
          returnPathConfigured: process.env.EMAILIT_RETURN_PATH_DOMAIN ?? null,
          observedReturnPathConfigured: process.env.MAIL_FROM ?? null,
          espReturnPathConfigured: process.env.EMAILIT_ESP_RETURN_PATH_DOMAIN ?? null,
        };

        let deliverability: unknown = null;
        if (domain) {
          try {
            deliverability = await checkSendingDomain(domain, {
              dkimSelector: process.env.EMAILIT_DKIM_SELECTOR,
              // SPF is evaluated against the envelope sender, which for every
              // serious ESP is a delegated subdomain. Naming it here skips the
              // discovery heuristic entirely.
              ...returnPathFromEnv({
                EMAILIT_RETURN_PATH_DOMAIN: process.env.EMAILIT_RETURN_PATH_DOMAIN,
                MAIL_FROM: process.env.MAIL_FROM,
                EMAILIT_ESP_RETURN_PATH_DOMAIN: process.env.EMAILIT_ESP_RETURN_PATH_DOMAIN,
              }),
            });
          } catch (err) {
            deliverability = {
              error: `DNS check failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }

        if (!shouldSend) {
          return json({
            probe: "config-only",
            hint: 'POST ?send=1 with {"to":"you@example.com"} to attempt a real send and see EmailIt\'s actual response.',
            config,
            deliverability,
          });
        }

        // The part that has never been visible: EmailIt's real answer.
        const started = Date.now();
        const result = await sendEmail({
          to: to!,
          subject: "founders.click email probe",
          text:
            "This is a deliverability probe from founders.click.\n\n" +
            "If you are reading it, the send path works end to end: the Worker reached " +
            "EmailIt, EmailIt accepted the message, and your provider delivered it.\n\n" +
            "Check the spam folder too — arriving in junk is a different problem from " +
            "not arriving, and it points at SPF/DKIM alignment rather than the send path.",
          html:
            "<p>This is a deliverability probe from founders.click.</p>" +
            "<p>If you are reading it, the send path works end to end: the Worker reached " +
            "EmailIt, EmailIt accepted the message, and your provider delivered it.</p>" +
            "<p><strong>Check the spam folder too</strong> — arriving in junk is a different " +
            "problem from not arriving, and it points at SPF/DKIM alignment rather than the " +
            "send path.</p>",
        });

        return json({
          probe: "send",
          config,
          deliverability,
          send: {
            attemptedTo: to,
            ok: result.ok,
            providerMessageId: result.id ?? null,
            providerStatus: result.status ?? null,
            error: result.error ?? null,
            elapsedMs: Date.now() - started,
          },
          interpretation: result.ok
            ? "EmailIt accepted the message. If it does not arrive, the failure is delivery, not sending — check the spam folder, then SPF/DKIM alignment above."
            : "EmailIt REFUSED the message. This is the failure the auth hook has been swallowing; the error field is the reason.",
        });
      },
    },
  },
});
