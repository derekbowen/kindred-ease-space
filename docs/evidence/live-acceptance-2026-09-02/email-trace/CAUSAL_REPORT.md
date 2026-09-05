# Transactional email — causal report (2026-09-05)

Scope: every email founders.click sends (signup confirmation, password
reset, magic link, email change, support-ticket receipt and staff notice,
welcome, ticket status). Evidence: CI read-only tails of the production
Worker (`.github/workflows/email-trace-tail.yml`, runs #4 and #5), the
browser records in `../phase2-account/records.json`, EmailIt's public API
documentation and live unauthenticated probes (`provider-docs.md`), DNS over
HTTPS (`dns-state.md`), and the repository at `baf9985` (the build serving
production, Worker script version `7159462e-b48b-4bbb-9dbe-13ff6a989ba7`).

## Expected path

```
Browser (/signup, /reset-password, /help/contact)
  → Supabase GoTrue (project xbxhzinnfhosoztqaaao)            [auth emails]
      → send-email hook: POST https://www.founders.click/api/public/hooks/auth-send-email
          (standard-webhooks signature, SEND_EMAIL_HOOK_SECRET)
  → or the app server function directly                      [support / welcome]
  → src/lib/email.server.ts sendEmail()
      → POST https://api.emailit.com/v2/emails
        Authorization: Bearer <EMAILIT_API_KEY>   from: founders.click <noreply@founders.click>
      → EmailIt 201 {id, message_id, status:"pending"} → queue → delivery → inbox
```

## Actual path (observed)

| Hop | Auth email (password reset, run #5) | Support receipt (run #4) |
|---|---|---|
| Browser | `/reset-password` for account A, 06:59:11Z and 07:01:12Z → UI "Check your email for a reset link." | `/help/contact` 06:21:05Z → UI "Ticket received … We'll email you shortly." |
| Supabase | `POST /auth/v1/recover` → **200** (both) | n/a |
| Worker hook | `06:59:22.651Z POST www.founders.click/api/public/hooks/auth-send-email ua=Go-http-client/2.0` and `07:01:17.217Z` — **GoTrue reached this Worker**, script version `7159462e` (= build `baf9985`) | `06:21:39.997Z POST /_serverFn/<submitSupportTicket>` |
| Signature | Verified (the hook only reaches `sendEmail()` after `verifySignature` passes; unsigned probes in the same windows were logged as "rejected: bad signature/timestamp" instead) | n/a |
| **EmailIt** | **`[email] send failed 401 UnauthorizedError`** then **`[auth-send-email] EmailIt send FAILED recovery UnauthorizedError`** — both requests | **`[email] send failed 401 UnauthorizedError`** ×2 (staff notice + receipt) |
| Our response | Hook returns **200 {}** by design (`auth-send-email.ts:88-98`) | Server function returns **`{ok:true, ticketId}`** (`help.server.ts:386-409`) |
| Supabase | Records the send as successful → `confirmation_sent_at` / recovery token issued | n/a |
| Inbox | Nothing (Gmail `in:anywhere`, 7-day window, checked 07:00Z) | Nothing |

## First broken link

**EmailIt's API rejects the production API key.** Everything upstream works
(browser → GoTrue → signed hook → Worker → correctly formed request with a
Bearer header), and everything downstream is never reached (sender-domain
verification, suppression lists, credits, delivery). Per EmailIt's documented
and live-probed 401 body, `error: "UnauthorizedError"` with message
`"Invalid API key"` (a missing header yields `"API key required"`; the
Worker only calls EmailIt when the key is loaded, and logs a different line
otherwise — `email.server.ts:84-88`).

## Exact evidence

- Run #5 (auth path), job 101266318595, window 06:57:53Z–07:02:53Z, 9
  invocations parsed from 980 pretty-printed lines:
  ```
  2026-09-05T06:59:22.651Z ok fetch POST www.founders.click/api/public/hooks/auth-send-email ua=Go-http-client/2.0
     log: [email] send failed 401 UnauthorizedError
     log: [auth-send-email] EmailIt send FAILED recovery UnauthorizedError
  2026-09-05T07:01:17.217Z ok fetch POST www.founders.click/api/public/hooks/auth-send-email ua=Go-http-client/2.0
     log: [email] send failed 401 UnauthorizedError
     log: [auth-send-email] EmailIt send FAILED recovery UnauthorizedError
  ```
  (`run5-tail-sanitized.json`; the browser records for the two reset
  requests are the last two "Request a password reset" entries in
  `../phase2-account/records.json`, both `POST /auth/v1/recover → 200`.)
- Run #4 (support path), job 101261510343: `run4-emailit-401.md`,
  `run4-tail-sanitized.json`.
- Provider contract and live 401 shape: `provider-docs.md` §2.
- Key loading mechanism ruled out; header present; all 13 email types share
  `sendEmail()`: `code-path.md`.
- DNS: all EmailIt-required records present (`emailit.founders.click` MX +
  SPF, `emailit._domainkey` DKIM, `_dmarc`): `dns-state.md` — not a factor
  in a 401.
- Production project: every browser auth call in the evidence targets
  `xbxhzinnfhosoztqaaao.supabase.co`; the hook that GoTrue called carried a
  signature this Worker's `SEND_EMAIL_HOOK_SECRET` accepted, so the
  dashboard's Send Email hook for that project points at this Worker with a
  matching secret. Obsolete deployment ruled out by the script version in
  the tail (`7159462e`, the version CI recorded for `baf9985`).

## Root cause

The `EMAILIT_API_KEY` secret on the `founders-click` Worker holds a value
EmailIt no longer (or never) accepts. Why the value is invalid — rotated or
deleted in EmailIt, a key from another EmailIt workspace/account, a paste
with a `Bearer ` prefix or quotes, an `em_test_` key, or an account-level
state EmailIt reports as 401 — is visible only in EmailIt → Settings → API
Keys and is not observable from the code or the Worker. Nothing in the
product or CI ever validated the key: the deploy preflight checks the secret
*exists*, and every caller converts a provider rejection into customer-visible
success.

Secondary, separate finding: GoTrue's project-wide auth-email limit refused a
signup outright with `429 over_email_send_rate_limit` after roughly two
sends in an hour (`records.json`, account D). This is not the delivery root
cause; it is its own launch blocker (≈2 signups/hour).

## Minimal proposed correction (needs approval — production configuration)

1. In EmailIt: confirm the workspace that owns the verified `founders.click`
   sending domain; create a new API key (scope `sending`, restricted to that
   domain); note the key id.
2. On the Worker: `bunx wrangler secret put EMAILIT_API_KEY --name founders-click`
   with the bare `em_live_…` value (no quotes, no `Bearer`).
   No code change and no deploy is required for the fix itself; secrets are
   read at request time.
3. Prove it from the product before touching anything else: Admin → Email
   Templates → "send test" (the one surface that surfaces the provider
   error), then the three browser journeys below.

Follow-up code changes (separate branch, after the baseline): surface
provider failures (log-to-alert on `[email] send failed`, and a CI/monitor
check of `GET /v2/domains` with the production key); stop the ticket path
claiming "We'll email you shortly" when the send failed; raise the GoTrue
email rate limit for launch.

## Rollback plan

`bunx wrangler secret put EMAILIT_API_KEY` with the previous value (kept by
the operator) restores the prior state exactly; the fix touches no code, no
routes and no DNS. If the previous value is unavailable, `wrangler secret
delete EMAILIT_API_KEY` reproduces the current customer-visible behaviour
(no email) with a clearer log line ("EMAILIT_API_KEY not configured").

## Browser retest required after the correction

1. Fresh signup with a new test address → real confirmation email in the
   inbox (provider message id recorded) → click → successful login.
2. Forgot password → real reset email → set a new password → old password
   refused → new password logs in.
3. Support form → real receipt email (and the staff notification in the
   support inbox).

Until all three pass through the browser, **email stays FAILED** for the
customer; an EmailIt 201 alone does not close it.
