# Tail run #4 — EmailIt rejects the production API key (401)

Source: `.github/workflows/email-trace-tail.yml` run
[33949514845](https://github.com/derekbowen/kindred-ease-space/actions/runs/33949514845)
(job 101261510343), `wrangler tail founders-click --format json`, window
2026-09-05 06:20:01Z → 06:25:02Z, parser reassembling whole JSON objects
(validated by the raw head printed in the log). 4 Worker invocations in the
window; sanitized copy in `run4-tail-sanitized.json` (no headers, no bodies).

## The support-ticket send, end to end

| Hop | Observed |
|---|---|
| Browser | `/help/contact` form submitted 06:21:05Z by the harness (`tests/e2e/live/phase_public_contact.py`), recipient `derekbowencorp+fclive-c@gmail.com`; UI showed "Ticket received … We'll email you shortly." |
| Worker | `06:21:39.997Z ok fetch POST www.founders.click/_serverFn/<submitSupportTicket>` — script version `7159462e-b48b-4bbb-9dbe-13ff6a989ba7` (the current deploy) |
| App function | `src/lib/help.server.ts` `submitTicket()` → inserts `support_tickets`, then two `sendEmail()` calls (support inbox + customer receipt) |
| EmailIt API | `POST https://api.emailit.com/v2/emails`, `Authorization: Bearer <EMAILIT_API_KEY>` |
| **Provider response** | **HTTP 401, body message `UnauthorizedError`** — logged twice: `[email] send failed 401 UnauthorizedError` (one per recipient) |
| Our function | Returned `{ ok: true, ticketId }` to the browser (by design: `help.server.ts` treats a failed send as non-fatal) |
| Inbox | Nothing (Gmail `in:anywhere`, checked 06:24Z and later) |

## What this proves

- The Worker → EmailIt leg **runs** in production and **fails at
  authentication**: the API key the Worker holds as the `EMAILIT_API_KEY`
  secret is not accepted by EmailIt (`401 UnauthorizedError`). Sender-domain
  verification, SPF/DKIM, suppression lists and quotas are never reached — a
  401 is returned before the message is evaluated.
- The customer-visible success is produced by the application after the
  provider rejection: `help.server.ts` (and `workspace.functions.ts` welcome
  email, and the auth hook) all convert `ok:false` into a 200 for the user.
- CI's secret preflight only checks that `EMAILIT_API_KEY` *exists*
  (`scripts/required-secrets.txt`), not that EmailIt accepts it.

## Same window, auth path

Two unsigned `POST /api/public/hooks/auth-send-email` probes at 06:23:04Z
(www) and 06:23:05Z (workers.dev) from `curl/8.5.0` — the production
monitor — were correctly rejected (`[auth-send-email] rejected: bad
signature/timestamp`). No GoTrue-originated hook call occurred in this
window because no auth email was requested (rate limit). The auth path is
observed in the 07:02Z run (password reset for test account A).

## Why `confirmation_sent_at` is populated with no email

If the Supabase hook points at this Worker (to be confirmed at 07:02Z), the
sequence for a signup is: GoTrue → hook (signature verifies) → `sendEmail()`
→ EmailIt 401 → hook logs and returns **200** → GoTrue records the send as
successful and sets `confirmation_sent_at` → the UI says "check your email".
One rejected key explains every failed email type observed since
2026-09-01: signup confirmations, password resets, support receipts and
welcome emails all go through the same `sendEmail()`.
