# Worker log tail during live sends — observations

> **RETRACTED (2026-09-05 06:20Z).** Runs #1–#3 of the tail workflow parsed
> `wrangler tail --format json` as one JSON object per line. wrangler
> pretty-prints each event across many lines, so the parser saw only
> fragments: the "555 events / 0 email-related" figures below are line
> counts, not events, and the sanitized artifact from run #3 contains two
> empty fragments. **Nothing below about "no hook call" is established.**
> Run #4 onward reassembles whole objects and prints the raw head of the
> stream for validation. The section is kept for the record of what was
> claimed and why it was wrong.

Read-only capture from CI (`.github/workflows/email-trace-tail.yml`, run
[33948559228](https://github.com/derekbowen/kindred-ease-space/actions/runs/33948559228)),
`wrangler tail founders-click --format json`, attached 2026-09-05 05:58:22Z,
window 300 s. The Worker code logs `[email] send failed <status> <msg>` /
`[email] send exception` / `[auth-send-email] …` on every failure path
(`src/lib/email.server.ts`, `src/routes/api/public/hooks/auth-send-email.ts`),
so a rejected EmailIt call would have appeared here.

## Sends triggered inside the window (through the public UI)

| Time (UTC) | Action | Result in the UI | Supabase response |
|---|---|---|---|
| 05:59:28 | Sign up `derekbowencorp+fclive-c@gmail.com` (`/signup`) | "Check your email to confirm your account." | `POST /auth/v1/signup` → 200, `confirmation_sent_at` set |
| 05:59:36 | Password reset for account A (`/reset-password`) | "email rate limit exceeded" | 429 `over_email_send_rate_limit` — hook not invoked by design |

## What the tail recorded

- 555 events captured; wrangler attached without any auth/permission error
  (the CI deploy token can tail).
- **0 requests to `/api/public/hooks/auth-send-email`** on any hostname the
  Worker serves (www.founders.click and founders-click.derekbowencorp.workers.dev).
- **0 log lines** matching `[email]`, `[auth-send-email]`, `emailit`, `[help]`.

## What that establishes

1. For the 05:59:28 signup, **Supabase did not call this Worker's send-email
   hook** — the only hook implementation in the repository. Yet GoTrue
   reported the confirmation as sent (200, `confirmation_sent_at`). GoTrue
   fails a signup with 500 when a configured hook errors, and with
   `email_address_not_authorized` when its built-in mailer is asked to send
   to a non-team address; neither happened.
2. Therefore GoTrue delivered the email to **something that answered 2xx and
   is not this codebase**: either a custom SMTP relay configured in the
   Supabase dashboard, or a send-email hook URI pointing at a host outside
   this Worker. The apex `https://founders.click/...` is not it (every path
   there is a Cloudflare 307 to www, which the tail would have seen).
3. The EmailIt integration in this repository (`sendEmail()` →
   `POST https://api.emailit.com/v2/emails`) was **not exercised** by these
   auth emails. Whether EmailIt itself works is still unproven either way;
   the only in-repo caller that ran in the window was none.
4. The same conclusion holds for the earlier failed sends (2026-09-01
   08:38Z resend; 2026-09-02 06:48Z, 07:21Z signups): the production monitor
   has probed this hook every 30 minutes since 2026-09-01 and always gets
   `401 invalid signature` — proving the endpoint is deployed and has a
   secret, not that Supabase points at it.

## Not observable from the audit environment

- Supabase Dashboard → Authentication → Hooks → *Send Email*: enabled? URI?
  secret? (the screenshot from 2026-09-01 showed the hook ENABLED with URI
  `https://founders-click.derekbowencorp.workers.dev/lovab…`; after "hook
  updated" the current value is unknown).
- Supabase Dashboard → Authentication → Emails / SMTP settings: custom SMTP
  host, sender, and whether "Enable Custom SMTP" is on.
- Supabase Auth logs for 05:59:28Z and 2026-09-02 06:48:37Z / 07:21:45Z:
  the mailer/hook outcome line.

The support-ticket receipt (2026-09-02 06:51:51Z) is a different path — it
is sent by `src/lib/help.server.ts` through `sendEmail()` (EmailIt) — and
also never arrived; that one *does* implicate EmailIt or its sending-domain
setup, and needs the EmailIt send log for 06:51Z.
