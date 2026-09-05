# EMAIL_TRACE — why "UI success, nothing delivered" (founders.click, 2026-09-01 → 2026-09-05)

Synthesis of the four working notes in this folder (`provider-docs.md`,
`dns-state.md` + `dns-observations.md`, `code-path.md`, `tail-observations.md`)
plus new observations made while writing this on 2026-09-05 06:20–06:30 UTC.
Repository state: branch `claude/ecstatic-lamport-li8bun`; every `src/…` citation
below was re-read from the working tree, and the production Worker is build
`baf9985e1ada8500bc5bd414f967824b6b13772d` (live
`GET https://www.founders.click/api/public/edge-health` at 06:27Z →
`{"sha":"baf9985e…","shaShort":"baf9985","builtAt":"2026-09-02T03:46:32.825Z"}`),
whose email code is byte-identical to the cited files (§0.3).

Evidence labels used throughout:

- **OBSERVED** — seen directly (a live HTTP response, a DNS answer, a CI log
  line, a repo file, an inbox query), with the source named.
- **INFERRED** — follows from code plus at least one corroborating observation.
- **NOT OBSERVABLE** — needs a console/dashboard/log this environment cannot
  reach (Cloudflare Worker logs other than the bounded CI tail, the EmailIt
  dashboard/API — no key here, the Supabase dashboard and Auth logs — the
  Supabase MCP returns "You do not have permission to perform this action" and
  `list_projects` is empty, the Outlook inbox).

Confidence: **High** / **Medium** / **Low** per finding.

---

## 0. Verdict in four sentences

1. **EmailIt is rejecting the Worker's API key.** During a support-ticket
   submission at 2026-09-05 06:21:39.997Z, the production Worker logged
   `[email] send failed 401 UnauthorizedError` twice — once for the staff
   notification, once for the customer receipt — and returned the customer a
   green "Ticket received … We'll email you shortly." (CI tail run #4, verbatim in
   `tail-raw/run4-job-101261510343-excerpt.log`; format string at
   `src/lib/email.server.ts:121`.) **OBSERVED, High.**
2. That 401 is produced *before* EmailIt looks at the From domain, the
   recipient, credits or suppressions, so the DNS/verification findings
   (all required records present) and the accepted-then-held theories cannot be
   the first cause — they may still be second causes that only become testable
   once the key is accepted. **INFERRED, High.**
3. Every other email type (signup confirmation, password recovery, welcome,
   ticket status change) goes through the same `sendEmail()` with the same
   `process.env.EMAILIT_API_KEY`, and production has been running the same code
   (`baf9985`, deployed 2026-09-02 03:47Z) for all sends on 09-02 and 09-05; so
   the same 401 is the single explanation consistent with all five failed
   sends. **INFERRED, High** for the ticket path; **Medium-High** for the auth
   path, because it additionally assumes Supabase is calling this hook (§3 H2).
4. Nothing in this repository or its CI has ever proved EmailIt accepted a
   message; the only in-product surface that would have shown the 401 is Admin
   → Email Templates → "send test" (`src/lib/email-templates.functions.ts:128`
   throws the provider text), which was never used.

### 0.1 The one new observation (2026-09-05, CI tail run #4)

Workflow `.github/workflows/email-trace-tail.yml` (read-only
`wrangler tail founders-click --format json`, 300 s), run
[33949514845](https://github.com/derekbowen/kindred-ease-space/actions/runs/33949514845),
window **06:20:01Z → 06:25:02Z**. Runs #1–#3 are void (their parser split
wrangler's pretty-printed JSON by line and saw nothing — `tail-observations.md`
header); run #4 reassembles objects and printed:

```
--- parsed objects: 4 ---
2026-09-05T06:21:39.997Z ok fetch POST www.founders.click/_serverFn/REDACTED ua=Mozilla/5.0 (X11; Linux x86_64) AppleWeb
   log: [email] send failed 401 UnauthorizedError
   log: [email] send failed 401 UnauthorizedError
2026-09-05T06:23:04.626Z ok fetch POST www.founders.click/api/public/hooks/auth-send-email ua=curl/8.5.0
   log: [auth-send-email] rejected: bad signature/timestamp
2026-09-05T06:23:05.082Z ok fetch POST founders-click.derekbowencorp.workers.dev/api/public/hooks/auth-send-email ua=curl/8.5.0
   log: [auth-send-email] rejected: bad signature/timestamp
```

- The 06:21:39.997Z invocation is the support ticket recorded in
  `../phase2-account/records.json:650-693` (POST `/_serverFn/3fd163f1…` at
  06:21:42Z → 200, `ticketId 3c5724b6-42a8-4e78-ac43-be05274a360f`).
- Two `[email] send failed 401` lines = the two `sendEmail()` calls in
  `src/lib/help.server.ts:386-409` (staff notice to `SUPPORT_INBOX_EMAIL`,
  receipt to the submitter). EmailIt answered HTTP 401 to both.
- The 06:23:04Z / 06:23:05Z events are this author's own unsigned `curl` probes
  of the hook on both hostnames (both returned `{"error":"invalid signature"}`
  HTTP 401 to the caller). They prove the tail sees the hook route and that
  `SEND_EMAIL_HOOK_SECRET` is loaded (`auth-send-email.ts:42-51` would
  otherwise log "hook not configured").
- No Supabase call to the hook occurred in the window — **but no auth email was
  requested in the window** (the project was inside its 2-per-hour GoTrue
  budget refusal, §2.5), so this says nothing about whether Supabase calls the
  hook. The earlier "Supabase did not call the hook" claim in
  `tail-observations.md` is retracted and is **not** relied on here.
- Same window, Gmail (`in:anywhere newer_than:7d from:founders.click`, queried
  06:25Z): **zero threads**; a second query on subjects (`"founders.click"`,
  `"We received your message"`, `"live acceptance"`): **zero threads**. The
  receipts for the three tickets submitted on 09-05 (06:07:14Z, 06:13:47Z,
  06:21:42Z) never arrived. **OBSERVED, High.**

### 0.2 What "401 UnauthorizedError" means, exactly

`src/lib/email.server.ts:114-122` logs `data.error || data.message`. EmailIt's
live 401 bodies (probed unauthenticated in `provider-docs.md` §2, re-probed
06:23:05Z: `{"statusCode":401,"error":"UnauthorizedError","message":"API key required"}`)
have `error: "UnauthorizedError"` and a `message` of either `API key required`
(no header) or `Invalid API key` (bad key). The Worker only reaches `fetch`
when `apiKey` is truthy (`:84-88`, otherwise it logs
`[email] EMAILIT_API_KEY not configured` and never calls EmailIt), and it always
sends `Authorization: Bearer <key>` (`:102-105`). So the header was present and
EmailIt did not accept its value. The `message` text is not in the log, hence
"Invalid API key" is **INFERRED, High**; that the key was *loaded* is
**OBSERVED, High** (wrong log line otherwise).

Sub-causes that all present as this exact line (ranked in §3 H1):
the Worker secret holds a key that has been rotated/revoked/deleted in EmailIt;
a key from another EmailIt workspace/account; a value pasted with a `Bearer `
prefix or quotes; an `em_test_…` key whose semantics EmailIt does not document
(`provider-docs.md` §2); or an account-level state (suspension/closure) that
EmailIt reports as 401 (undocumented). A trailing newline in the secret is
**excluded**: `fetch` would throw on the header and the log would read
`[email] send exception …`, not `send failed 401`.

### 0.3 Which code was running when

| Build | Deployed (UTC) | Serving during | Email code vs cited files |
|---|---|---|---|
| `1d02524` (in-repo hook first deployed; committed 2026-09-01 07:26:53Z) | 2026-09-01 ~07:31 (`docs/INCIDENTS.md:37-46`) | Outlook resend 09-01 08:38Z | **identical hook/mailer code**: `git log 1d02524..baf9985 -- src/lib/email.server.ts src/routes/api/public/hooks/auth-send-email.ts src/lib/auth-email-hook.ts` is empty (§6.5.1) |
| `baf9985` (Deploy App run #16, job 100116874559, green; preflight "required Worker secrets" step 03:46:59–03:47:02Z success) | 2026-09-02 03:47:08 | 09-02 06:48Z, 06:51Z, 07:21Z; 09-05 05:51Z, 06:07Z, 06:13Z, 06:21Z; **still live at 06:27Z 09-05** (edge-health) | `git diff --stat baf9985 HEAD -- <email files>` is empty: identical to the cited working tree |

So the hook and `sendEmail()` that ran for the 09-01 resend, the 09-02 sends,
the 09-05 sends and the observed 401 are one and the same code (the six main
commits between `1d02524` and `baf9985` — `ddc0c5c`, `1227508`, `2ce7593`,
`eccbd56`, `53b8730`, `baf9985` — touch none of those three files), and
`sendEmail()`'s key handling (`process.env.EMAILIT_API_KEY`, `Bearer`) has been
unchanged since it was introduced on 2026-05-11 (`d738cc5`, `code-path.md` §8).
**OBSERVED (git), High.** The only thing that could differ between those dates
is the *value* of the Worker secret, which CI never reads.

---

## 1. The production path, hop by hop

Two chains share the last four hops. Chain A is every GoTrue-originated email
(signup confirmation, recovery, magic link, invite, email change). Chain B is
the support-ticket receipt; the welcome email and ticket-status email are
Chain-B-shaped (server function → `sendEmail`).

### 1.1 Chain A — signup / password reset (auth emails)

| # | Hop | Where (file:line) | What happens | Status |
|---|---|---|---|---|
| A1 | Browser: "Start free trial" | `src/routes/signup.tsx:34-41` | `supabase.auth.signUp({email,password,options:{emailRedirectTo: origin+"/app", data:{display_name,full_name}}})` | **OBSERVED** on the wire: `POST https://xbxhzinnfhosoztqaaao.supabase.co/auth/v1/signup?redirect_to=https%3A%2F%2Fwww.founders.click%2Fapp` → 200 (`records.json:454-458`, 09-05 05:59:32Z; `:17-25`, 09-02 06:48:37Z) |
| A1′ | Browser: "Send reset link" | `src/routes/reset-password.tsx:57-59` | `resetPasswordForEmail(email,{redirectTo: origin+"/reset-password"})` | **OBSERVED**: `POST …/auth/v1/recover?redirect_to=https%3A%2F%2Fwww.founders.click%2Freset-password` → 200 `{}` (`records.json:413-419`, 09-05 05:51:22Z) |
| A2 | Browser outcome | `signup.tsx:43-46` (error → toast), `:50-55`, `:83-93` ("We sent a confirmation link to …"); `reset-password.tsx:61-62` ("Check your email for a reset link.") | UI shows success on any 2xx. No "resend" control and no OTP entry exist in `src/` (`code-path.md` §1.1), so the emailed link is the only activation path | **OBSERVED** (screens in `records.json`) |
| A3 | GoTrue: rate limiter, then sender | supabase/auth `master` `internal/api/mail.go:793-813` (limiter), `:816-880` (`if config.Hook.SendEmail.Enabled` → build `email_data{token, token_hash, email_action_type, redirect_to, site_url}` → `InvokeHook`) | Refusal is a visible 429 `over_email_send_rate_limit`; acceptance sets `confirmation_sent_at` and calls **whatever sender the project is configured with** | Limiter **OBSERVED** (429s at `records.json:497-502`, `:538-544`; 200 with `confirmation_sent_at` at `:458`). Which sender is configured: **NOT OBSERVABLE** (Supabase Dashboard → Authentication → Hooks / SMTP). Best inference §3 H2 |
| A4 | Worker endpoint: send-email hook | `src/routes/api/public/hooks/auth-send-email.ts:41-99`; expected URI `https://www.founders.click/api/public/hooks/auth-send-email` (`:17-19`) | Verifies standard-webhooks signature (`:53-66`, logic `src/lib/auth-email-hook.ts:40-64`, ±300 s `:12`), picks recipient (`:76-82`), builds verify URL (`:84` → `auth-email-hook.ts:81-93`), renders copy (`:86` → `copyFor`, `:95-154`), then `sendEmail({to,subject,html,text})` (`:88`) with **no idempotency key, no meta** | Endpoint deployed + secret loaded: **OBSERVED** (unsigned POST → `401 {"error":"invalid signature"}` on `www` and `workers.dev` at 06:23:04/05Z, seen both from the caller and inside the tail). Signed calls from GoTrue: **NOT OBSERVED** in any valid tail window (none contained an auth send) |
| A5 | Hook failure posture | `auth-send-email.ts:89-98` (design rationale `:20-26`) | If `sendEmail` returns `ok:false`, log `[auth-send-email] EmailIt send FAILED <action> <error>` and **still return 200 `{}`** → GoTrue records the email as sent | **OBSERVED** in code; behaviour under a real 401 **INFERRED, High** (`sendEmail` never throws, `:83-130`) |
| A6 | `sendEmail()` | `src/lib/email.server.ts:83-130` | Reads `process.env.EMAILIT_API_KEY` per call (`:84`); `from = params.from ‖ FROM_EMAIL ‖ "founders.click <noreply@founders.click>"` (`:90`); JSON `{from,to,subject,html,text[,reply_to][,meta]}` (`:92-100`); `Authorization: Bearer <key>` (`:102-105`); `fetch("https://api.emailit.com/v2/emails")` (`:6`, `:109-113`) | Key loaded: **OBSERVED** (§0.2). Same mechanism as the demonstrably-working `SEND_EMAIL_HOOK_SECRET` (`auth-send-email.ts:42`) and `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (`src/integrations/supabase/client.server.ts:9-11`; the ticket row insert at `help.server.ts:344-355` succeeded → those loaded). `wrangler.jsonc:4-5` `compatibility_date 2025-09-24` + `nodejs_compat` ⇒ `process.env` auto-populated from bindings/secrets (`code-path.md` §2.1) |
| A7 | EmailIt API response | `email.server.ts:114-124` | 2xx (EmailIt documents **201** `{id:"em_…",message_id,status:"pending"}`) → `{ok:true,id}` — **id discarded by every caller**; non-2xx → `console.error("[email] send failed", status, data.error‖data.message)` and `{ok:false}` | **OBSERVED 2026-09-05 06:21:39.997Z: HTTP 401 `UnauthorizedError`** (Chain B, same function). For the five historical sends: **NOT OBSERVABLE** (no Workers Logs retention — `wrangler.jsonc` has no `observability` block; only a live tail sees `console.error`) |
| A8 | Provider delivery | EmailIt queue → MTA (`_spf.emailit.com` IPs, `dns-state.md` §1.8) → Gmail/Outlook MX | Only after a 201. Post-acceptance states `suppressed/held/errored/failed/bounced` are visible solely in EmailIt (`provider-docs.md` §7); the repo registers no webhook and never polls | **Never reached** for the observed send (401). Historical sends: **NOT OBSERVABLE** without the EmailIt log |
| A9 | Inbox | Gmail via connector; Outlook via founder | Link is `https://xbxhzinnfhosoztqaaao.supabase.co/auth/v1/verify?token=<token_hash>&type=signup&redirect_to=https%3A%2F%2Fwww.founders.click%2Fapp` (`auth-email-hook.ts:88-92`) | **OBSERVED: nothing delivered** — Gmail zero founders.click messages in 7 days and in the preceding 60 days (`records.json:136`, `:182`; re-checked 06:25Z today); both Gmail accounts `email_not_confirmed` 70 h later (`:182`); Outlook still unconfirmed 4 days after its resend (`docs/LIVE_ACCEPTANCE_TEST_2026-09-02.md:79`) |

### 1.2 Chain B — support-ticket receipt (the path whose provider response was observed)

| # | Hop | Where | What happens | Status |
|---|---|---|---|---|
| B1 | Browser: Contact form submit | `src/routes/help.contact.tsx:40` (`useServerFn(submitSupportTicket)`), `:48-58` | POST to the TanStack server function | **OBSERVED**: `POST https://www.founders.click/_serverFn/3fd163f1136006d6fbf31da913ed2096497aba5a4e3a403c69d2678acfc59e14` → 200 (`records.json:587-591`, `:631-635`, `:675-679`); 09-02 06:51:51Z `records.json:101-105` |
| B2 | Server function | `src/lib/help.functions.ts:183-204` | IP rate limit 5/window (`:188`), then `submitTicket(...)` (`:192-198`), returns `{ok:true, ticketId}` (`:199`); a throw becomes `{ok:false,error:"Failed to submit ticket"}` (`:200-203`) | **OBSERVED** (`ok:true` + ticket ids in the records) |
| B3 | Ticket persistence + notify | `src/lib/help.server.ts:336-415` | Insert `support_tickets` (`:344-359`); then, inside `try` (`:365-412`), render both templates (`:369-384`, `renderTemplate` returns `null` if `email_templates.is_enabled=false`, `email.server.ts:52-63`), then `Promise.allSettled([sendEmail(staff), sendEmail(user)])` (`:386-409`); **results ignored**, `return {id}` (`:414`) | **OBSERVED**: both `sendEmail` calls ran on 09-05 06:21Z (two `[email]` lines) ⇒ templates were **enabled** at that time |
| B4 | UI outcome | `help.contact.tsx:73-80` | "Ticket received … We'll email you shortly." on `ok:true` | **OBSERVED** (screenshots 011/013/014) |
| B5–B8 | = A6–A9 | | Staff notice: `to: SUPPORT_INBOX_EMAIL` (`help.server.ts:389`; default `support@founders.click`, `email.server.ts:360`), `Idempotency-Key: ticket-staff-<id>` (`:394`), `meta {ticket_id, kind:"ticket_new_staff"}` (`:395`). Receipt: `to: params.email`, `reply_to: SUPPORT_INBOX_EMAIL`, `Idempotency-Key: ticket-user-<id>` (`:400-406`) | **OBSERVED 401 at 06:21:39.997Z for both** |

### 1.3 The other callers (same choke point)

| Email | Caller | Result handling | Note |
|---|---|---|---|
| Welcome (live path) | `src/lib/workspace.functions.ts:186-207` (`ensureWorkspace`), also `:145-164` | fire-and-forget `.then().catch()`; `sendEmail` resolves `{ok:false}` so `.catch` never fires; **not awaited**, no `waitUntil` | Would 401 the same way; may also never run to completion on Workers (`code-path.md` §2.4) |
| Ticket status changed | `src/lib/help-tickets.functions.ts:148-173` | awaited, result ignored, `return {ok:true}` (`:175`) | same 401 |
| Help-feedback follow-up (admin) | `src/lib/email-templates.functions.ts:168-178` | **throws** `res.error` (`:177`) | would surface "UnauthorizedError" to the admin |
| Template test send (admin) | `src/lib/email-templates.functions.ts:121-129`, UI `src/routes/_authenticated/app.admin.email-templates.tsx:19,38` | **throws** `res.error` (`:128`) | the one in-product way to *see* the provider's answer |

**All email types share one integration** (`sendEmail` is the only outbound
mailer: `grep -ri "emailit\|smtp\|resend" supabase/functions` → none; no second
sender in `src/`; `code-path.md` §6). **OBSERVED, High.**

---

## 2. Per-send trace

Common facts (apply to every row unless stated):

- **Provider/endpoint**: `POST https://api.emailit.com/v2/emails`
  (`email.server.ts:6`) — matches EmailIt's current documented endpoint
  (`provider-docs.md` §1). Chain A additionally goes through GoTrue → hook.
- **Key loading**: identical to working secrets (§1.1 A6). Exists as a Worker
  *Secret* (Deploy App preflight passes; a Text var or absent name would fail
  the deploy — `.github/workflows/deploy-app.yml:122-167`,
  `scripts/required-secrets.txt:18-20,28`). Its **value's validity is what
  fails** (§0.2). **OBSERVED** for the 06:21Z send; **INFERRED, High** for the rest.
- **Sender**: `founders.click <noreply@founders.click>` — the code default
  (`email.server.ts:90`). **OBSERVED**: the Worker has **no `FROM_EMAIL`**
  secret (deploy #16 preflight warning, §6.4/§6.5.2) and `FROM_EMAIL` is set
  nowhere in the repo/CI (`code-path.md` §3), so the From domain is
  `founders.click` for every send. Also **no `SUPPORT_INBOX_EMAIL`** ⇒ the staff
  notice and every `Reply-To` target `support@founders.click`, which has no MX
  (`dns-state.md` §6) — a separate, already-broken promise ("just reply to this
  email", `email.server.ts:241`).
- **Sending-domain DNS** (`dns-state.md` §0, §3; raw in `dns-raw/`): all three
  records EmailIt requires for a domain named `founders.click` are present with
  exact values — `emailit.founders.click MX 10 feedback-smtp.ffdc-1.emailit.com.`,
  `emailit.founders.click TXT "v=spf1 include:_spf.emailit.com ~all"`,
  `emailit._domainkey.founders.click TXT "v=DKIM1; t=s; h=sha256; p=MIIBIjANBgkq…QIDAQAB;"`
  (valid RSA-2048) — plus optional `_dmarc.founders.click TXT "v=DMARC1; p=none;"`.
  Whether EmailIt's workspace shows the domain *verified* (and whether the DKIM
  key pair matches): **NOT OBSERVABLE** (needs dashboard → Domains or
  `GET /v2/domains`). Apex has no MX (so `support@founders.click` cannot receive)
  and no apex SPF (not required by EmailIt).
- **SPF/DKIM/DMARC outcome if a message were sent**: SPF pass (MAIL FROM under
  `emailit.founders.click`, relaxed-aligned), DKIM pass (`d=founders.click`,
  `s=emailit`, strict-aligned), DMARC pass (`dns-state.md` §4). **INFERRED, Medium-High** (no delivered message to read headers from).
- **Did our function return success after a provider rejection?** By design:
  hook → **200 `{}`** (`auth-send-email.ts:89-98`); ticket → **`{ok:true,ticketId}`**
  (`help.server.ts:386-414`, `help.functions.ts:199`). **OBSERVED** for 06:21Z (401 logged, UI green).
- **EmailIt send-log status**: **UNKNOWN** — needs EmailIt dashboard → Emails
  (or `GET /v2/emails?type=outbound`). Prediction: because a 401 is refused
  before an email object is created, **no record will exist** for these
  timestamps; finding one would mean the key was valid at that time and shift
  the cause downstream (§3 H4).
- **Suppression / suspension / credits**: **UNKNOWN**. Cannot be the first
  cause today (401 precedes them). Check: dashboard → Suppressions for
  `derekbowencorp+fclive-a@gmail.com`, `+fclive-b`, `+fclive-c`,
  `derekcbowen@outlook.com`, `support@founders.click`; dashboard → Billing for
  credit balance (no free tier, prepaid credits — `provider-docs.md` §9);
  account status/AUP notices.
- **Confirmation-link construction** (Chain A only): `auth-email-hook.ts:81-93`
  → `${SUPABASE_URL}/auth/v1/verify?token=<token_hash>&type=<action>&redirect_to=<email_data.redirect_to ‖ site_url ‖ https://www.founders.click/app>`;
  `redirect_to` as sent by the browser: `https://www.founders.click/app`
  (signup) / `https://www.founders.click/reset-password` (recover) — **OBSERVED**
  in the query strings above. GoTrue validates it against Site URL + Redirect
  allow-list *before* the hook sees it and again at click time
  (`utilities/request.go:75-89`, `verify.go:99-101`); if not allow-listed it
  silently becomes the Site URL. Allow-list values: **NOT OBSERVABLE**. This
  affects where a user lands *after* delivery, not whether mail arrives.

| Send | Browser → Supabase/app (OBSERVED) | Path | Provider response | Send-log | Notes |
|---|---|---|---|---|---|
| **Signup A** — 2026-09-02 06:48:37Z, `derekbowencorp+fclive-a@gmail.com` | `POST /auth/v1/signup` → 200, user `0a15386b-…`, `confirmation_sent_at` set (`records.json:17-25`, `:130`) | Chain A (GoTrue → hook → `sendEmail`) under build `baf9985` | **UNKNOWN** for this instant. Same key/function returned **401** on 09-05 06:21Z. If GoTrue called the hook, the Worker logged `[auth-send-email] EmailIt send FAILED signup UnauthorizedError` and answered 200 | UNKNOWN (expect none) | Gmail: never arrived (polled +3…+42 min; zero at 7 d) |
| **Ticket** — 2026-09-02 06:51:51Z, receipt to `+fclive-a`, ticket `ab749c8c-cad4-45d9-8ebf-ca2e25fb0fac` | server fn `ok:true` (`records.json:97-118`; `../TABLES.md:21`) | Chain B, build `baf9985` — the identical path observed on 09-05 | **UNKNOWN** for this instant; **the same path is OBSERVED returning 401** three days later with unchanged code and (unless rotated in between) unchanged secret | UNKNOWN; search `meta.ticket_id = ab749c8c-…` / `Idempotency-Key ticket-user-ab749c8c-…` — expect none | Also implies the staff notice to `support@founders.click` failed |
| **Signup B** — 2026-09-02 07:21:45Z, `+fclive-b` | `POST /auth/v1/signup` → 200 (`records.json:58-77`, `:132`) | Chain A, `baf9985` | UNKNOWN (as Signup A) | UNKNOWN | `email_not_confirmed` at +70 h (`:182`) |
| **Outlook resend** — 2026-09-01 08:38Z, `derekcbowen@outlook.com` | `POST /auth/v1/resend` → 429 ×4 then **200** (`docs/AUDIT_2026-09-02.md:268`, `:79`) | Chain A under the **09-01 build** (`1d02524`-era; hook repointed to `www` ~07:31Z, `docs/INCIDENTS.md:37-46`) | UNKNOWN. Same `sendEmail` key handling as today. Caveat: if this address is the Supabase org owner's, GoTrue's *built-in* mailer could also have accepted it — only the dashboard settles which sender was active | UNKNOWN | Still unconfirmed 4 days later (`LIVE_ACCEPTANCE_TEST_2026-09-02.md:79`); Outlook inbox **NOT OBSERVABLE** here |
| **Reset request** — 2026-09-05 05:51:22Z, account B | `POST /auth/v1/recover?redirect_to=…%2Freset-password` → 200 `{}` (`records.json:404-427`) | Chain A (`recovery`), `baf9985` | UNKNOWN for this instant (the tail runs #1–#3 covering 05:58–06:17Z are void, and 05:51Z predates all of them). Would log `… EmailIt send FAILED recovery UnauthorizedError` | UNKNOWN | Link would be `…/verify?token=…&type=recovery&redirect_to=https%3A%2F%2Fwww.founders.click%2Freset-password` |
| *Ticket* — 2026-09-05 06:07:14Z, `7e3a9f2b-…` | `records.json:562-605` | Chain B | UNKNOWN (tail run #2 window 06:05–06:10Z was void) | UNKNOWN | not in Gmail at 06:25Z |
| *Ticket* — 2026-09-05 06:13:47Z, `40848973-…` | `records.json:606-649` | Chain B | UNKNOWN (run #3 window 06:12–06:17Z void: "0 notable events shown of 339" line-count) | UNKNOWN | not in Gmail |
| **Ticket — 2026-09-05 06:21:42Z, `3c5724b6-42a8-4e78-ac43-be05274a360f`** | `records.json:650-693` | Chain B | **OBSERVED: HTTP 401 `UnauthorizedError` ×2** (staff + user) at 06:21:39.997Z, run #4 | UNKNOWN (expect none) | not in Gmail at 06:25Z; UI "Ticket received" |

### 2.5 Rate limiting is a *visible* failure, not a silent one

The 429s (`records.json:497-502` 05:59:39Z recover, `:538-544` 06:06:40Z signup;
~50 min of 429 before the 09-01 resend) come from GoTrue's project-wide "emails
sent" bucket, evaluated before any sender is invoked (`mail.go:793-813`); the
client sees the error and the account is not created. The observed ceiling
(~2 accepted auth emails/hour) is the value Supabase documents for the built-in
provider ("Only 2 emails per hour with the built-in email provider. You can
only change this with a custom SMTP setup" — `code-path.md` §7). Consequences:
(a) it is a separate P0 for launch, independent of the 401; (b) it consumes the
budget needed to reproduce Chain A under a tail — plan one signup per tail
window, ≥1 h apart. **OBSERVED, High.**

---

## 3. Ranked failure hypotheses and the single observation that settles each

| Rank | Hypothesis | Current standing | The one observation that confirms / refutes |
|---|---|---|---|
| **H1** | **EmailIt rejects the Worker's `EMAILIT_API_KEY` (HTTP 401).** All sends through `sendEmail()` fail before anything else is evaluated; callers report success | **CONFIRMED for Chain B on 2026-09-05 06:21:39Z** (tail run #4). Explains all five failures given the shared function and unchanged build | *Already observed.* Independent re-confirmation from the founder's side: `curl -sS -H "Authorization: Bearer <the value stored as the Worker secret>" https://api.emailit.com/v2/domains` → `401 {"statusCode":401,"error":"UnauthorizedError","message":"Invalid API key"}` confirms; a 200 with the domain list means the Worker holds a *different* value than the one tested |
| H1a | …because the key was rotated/revoked/deleted, or belongs to another EmailIt workspace/account | Most likely sub-cause (Medium) | EmailIt dashboard → API Keys: no key whose "last used" is recent / none matching the prefix the founder believes is deployed |
| H1b | …because the stored value is malformed (`Bearer ` prefix, quotes, wrong key such as the webhook `whsec_…` or a v1 key) | Possible (Low-Medium) | Re-`wrangler secret put EMAILIT_API_KEY` with a freshly created key, then Admin → Email Templates → send test: success (or a *different* error) |
| H1c | …because the EmailIt account is suspended/closed and the API reports that as 401 | Possible, undocumented (Low) | EmailIt dashboard login / account status page / support ticket |
| **H2** | Supabase is not calling this Worker's hook for auth emails (custom SMTP, or a hook URI elsewhere) — so Chain A fails for a *different* reason than H1 | **OPEN.** The 09-05 tail claim to this effect is retracted. Against it: (i) the 2/hour ceiling is the built-in-provider value ⇒ custom SMTP not enabled; (ii) the 09-01 incident proves the project *was* hook-configured and INCIDENTS.md records the repoint to `www`; (iii) signups to non-team Gmail aliases returned 200 rather than the built-in mailer's `email_address_not_authorized`. Net: hook-is-called **INFERRED, Medium-High** | A tail window containing one real signup: **presence** of `POST www.founders.click/api/public/hooks/auth-send-email` (non-curl UA) followed by `[auth-send-email] EmailIt send FAILED signup UnauthorizedError` confirms the hook is called *and* H1 applies to auth mail; **absence** of any hook request while GoTrue returned 200 refutes hook-is-called. Or: Supabase Dashboard → Authentication → Hooks → Send Email (enabled? URI?) and → SMTP Settings |
| H3 | Sending domain not verified in the EmailIt workspace (HTTP 422 `From/Sender domain is not valid or not verified`), or `FROM_EMAIL` overrides the From with an unverified domain | **Refuted as the first cause** (401 precedes it). The `FROM_EMAIL`-override variant is **refuted outright** — no such secret on the Worker (§6.4). Workspace verification state **untested as a second cause**; DNS side is clean | After H1 is fixed: tail line `[email] send failed 422 From/Sender domain is not valid or not verified` confirms; EmailIt → Domains → `founders.click` `verified_at` set + all statuses `ok` refutes |
| H4 | EmailIt accepts (201) then suppresses/holds/fails the message (suppression list, zero credits, `held` for review, bounce) | **Refuted for the observed send** (no 201). Possible after H1 is fixed | Tail shows *no* `[email]` line for a send (success logs nothing) yet nothing arrives ⇒ EmailIt → Emails → that message's status (`suppressed`/`held`/…) or `GET /v2/emails/{id}` |
| H5 | `email_templates.<key>.is_enabled = false` skips the send silently (`email.server.ts:58`) | **Refuted for tickets** on 09-05 (both sends reached `fetch`). Open for `welcome` | `select key,is_enabled from email_templates` |
| H6 | `EMAILIT_API_KEY` not loaded in the Worker (`process.env` empty) | **Refuted** — the log line would have been `[email] EMAILIT_API_KEY not configured` (`:86`); and the deploy preflight lists it as a Secret | — |
| H7 | Public DNS (SPF/DKIM/MX) missing or wrong | **Refuted** (`dns-state.md` §3; Cloudflare + Google DoH agree) | — |
| H8 | EmailIt rate/daily limit (429) | **Refuted** for the observed send; volume is ~1/day | tail `[email] send failed 429 …` |
| H9 | Recipient-side rejection (Gmail/Outlook filtering) | Not reached — nothing was ever handed to an MTA | DMARC `rua=` mailbox / EmailIt delivery events after H1 |
| H10 | Redirect allow-list / Site URL misconfiguration | Irrelevant to non-delivery; affects post-click landing only | Supabase → Authentication → URL Configuration |

---

## 4. What the founder must check (exact screens) and what the CI tail will show

### 4.1 EmailIt dashboard (app.emailit.com), in this order

1. **Settings → API Keys.** List every key: name, prefix (`em_live_…`/`em_test_…`),
   scope (`full` vs `sending`), sending-domain restriction, created, last used.
   The Worker's value cannot be read back (`wrangler secret list` shows names
   only), so: **create a new key** (scope `full`, or `sending` restricted to
   `founders.click`), then on a trusted machine
   `wrangler secret put EMAILIT_API_KEY` (paste the bare `em_live_…` value — no
   `Bearer`, no quotes). Deleting the old key afterwards is optional but tells
   you whether anything else was using it.
2. **Domains → founders.click.** Confirm the domain exists under exactly that
   name and shows verified (`verified_at`), with MX/SPF/DKIM/return-path `ok`.
   Click "Check DNS" if it is pending — public DNS already has the records
   (`dns-state.md` §3). The optional tracking CNAME will read `missing` because
   `go.founders.click` is Cloudflare-proxied (`dns-state.md` §5) — cosmetic.
3. **Emails / Logs** for 2026-09-01 08:38Z, 2026-09-02 06:48–07:22Z (incl. the
   06:51:51Z ticket `ab749c8c-…`), 2026-09-05 05:51Z, 06:07Z, 06:13Z, 06:21Z.
   Expected under H1: **no entries at all**. Any entry present ⇒ record its
   status (`pending/accepted/delivered/suppressed/held/failed/bounced`) and
   `message_id`, and the key *was* valid at that moment.
4. **Suppressions.** Search the five addresses in §2. Remove any that are
   listed only because of earlier test bounces.
5. **Account / Billing.** Credit balance (must be > 0; no free tier), any
   suspension/AUP notice, and which **workspace** the key in step 1 belongs to
   (a key from workspace X cannot send for a domain verified in workspace Y).
6. **Webhooks.** None expected; optional later for `email.failed/suppressed/bounced`.

### 4.2 Supabase dashboard (project `xbxhzinnfhosoztqaaao`)

- **Authentication → Hooks → Send Email**: enabled? URI must be exactly
  `https://www.founders.click/api/public/hooks/auth-send-email`; secret matches
  the Worker's `SEND_EMAIL_HOOK_SECRET` (it does today — the monitor's
  `401 invalid signature` proves the secret decodes; a mismatch would show as
  GoTrue 500s on signup).
- **Authentication → SMTP Settings**: expected *off* (if on, H2 is true and the
  SMTP provider's log is where auth mail died).
- **Authentication → Rate Limits → "Emails sent"**: currently behaving as 2/h.
- **Authentication → URL Configuration**: Site URL should be
  `https://www.founders.click`; allow-list should include
  `https://www.founders.click/app` and `https://www.founders.click/reset-password`.
- **Logs → Auth** at the timestamps in §2: the hook invocation lines
  (URL, status, duration) — the only record of whether GoTrue called `www`.

### 4.3 Cloudflare (Worker `founders-click`)

- `wrangler secret list` — confirms `EMAILIT_API_KEY` exists as a Secret. As
  of deploy #16, `FROM_EMAIL` and `SUPPORT_INBOX_EMAIL` are **not set** (§6.4):
  the From is the code default on `founders.click` (fine, once the domain is
  verified in the same EmailIt workspace as the key), and staff notices go to
  an address with no MX. If `SUPPORT_INBOX_EMAIL` is ever set it must be a real
  mailbox; if `FROM_EMAIL` is ever set its domain must be the verified one.
- Optionally enable Workers Logs (dashboard → Worker → Observability) so the
  `[email]` lines persist beyond a live tail.

### 4.4 What the CI tail workflow will show, step by step

Trigger: push a new timestamp to `.github/email-trace-trigger` on branch
`claude/ecstatic-lamport-li8bun` (`email-trace-tail.yml:8-12`); the window is
300 s from the "tail window … starting" line. The parser prints only
"interesting" events (`:68-69`); **a successful send prints nothing** because
`sendEmail` logs only on failure (`email.server.ts:119-129`), so a Chain-B
invocation that appears in the histogram with no `log:` lines is a 2xx.

| Action inside the window | Line(s) to expect | Meaning |
|---|---|---|
| Submit `/help/contact` (as done at 06:21Z) | `POST www.founders.click/_serverFn/…` + `log: [email] send failed 401 UnauthorizedError` ×2 | H1 still true (before key rotation) |
| Same, after rotating the key | `POST …/_serverFn/…` with **no** `log:` lines | EmailIt returned 201 for both; then check inbox / EmailIt status (H4 territory) |
| Same | `log: [email] send failed 422 From/Sender domain is not valid or not verified` | H3: domain/workspace mismatch |
| Same | `log: [email] send failed 429 …` | EmailIt limit (unexpected at this volume) |
| Same | `log: [email] send exception …` | network/TLS/timeout from Worker to `api.emailit.com` |
| One real signup (budget: ≤2 auth emails/h) | `POST www.founders.click/api/public/hooks/auth-send-email ua=<non-curl>` then `log: [auth-send-email] EmailIt send FAILED signup UnauthorizedError` | H2 refuted (hook is called) and H1 applies to auth mail |
| One real signup | hook request present, **no** `log:` line | hook called, EmailIt 201 — mail should arrive |
| One real signup | **no** hook request at all while GoTrue answered 200 | H2 confirmed: Supabase sends auth mail elsewhere |
| Anything | `log: [auth-send-email] SEND_EMAIL_HOOK_SECRET missing/invalid …` | secret lost (monitor would also alarm) |

---

## 5. What this trace cannot and does not claim

- It does **not** show the provider's answer for the five historical sends;
  Cloudflare kept no logs (no Workers Logs), and the EmailIt/Supabase consoles
  were out of reach. The 401 is *observed once*, on the ticket path, on
  2026-09-05, and *inferred* backwards over unchanged code and a secret that,
  as far as CI can tell, has merely continued to exist.
- It does **not** prove Supabase is calling the in-repo hook (§3 H2); the only
  tail evidence about that was retracted. The inference rests on the incident
  history, the rate-limit ceiling and GoTrue's built-in-mailer behaviour.
- It does **not** say why the key is rejected (rotated, wrong workspace,
  malformed, suspended account). Only the EmailIt API Keys screen — or a fresh
  key — settles that.
- It does **not** evaluate the provider's post-acceptance behaviour
  (verification state, credits, suppressions); those become testable only
  after a 2xx is seen.
- The Outlook side was never inspected.

---

## 6. Evidence index

### 6.1 Observations made for this synthesis (2026-09-05 UTC)

| Time | Observation | Source |
|---|---|---|
| 06:20:01–06:25:02 | Worker tail: 4 invocations; `[email] send failed 401 UnauthorizedError` ×2 at 06:21:39.997Z on `POST /_serverFn/…` | `tail-raw/run4-job-101261510343-excerpt.log` (GitHub job log, run 33949514845) |
| 06:23:04 / 06:23:05 | `POST /api/public/hooks/auth-send-email` with `{}` on `www` and `workers.dev` → `401 {"error":"invalid signature"}` (0.37 s / 0.46 s) | curl from this sandbox; both also visible inside the tail |
| 06:23:05 | `POST https://api.emailit.com/v2/emails` without auth → `401 {"statusCode":401,"error":"UnauthorizedError","message":"API key required"}` | curl |
| ~06:25 | Gmail `in:anywhere newer_than:7d from:founders.click` → `{}` (no threads); subject query → `{}` | Gmail connector (inbox `derekbowencorp@gmail.com`, the alias parent) |
| 06:27 | `GET https://www.founders.click/api/public/edge-health` → `{"sha":"baf9985e…","builtAt":"2026-09-02T03:46:32.825Z"}` | curl |
| — | Supabase MCP: `list_projects` → `[]`; `query_logs(xbxhzinnfhosoztqaaao)` → "You do not have permission to perform this action" | MCP |
| — | Deploy App run #16 (`baf9985`, 2026-09-02 03:46–03:47Z): all steps green incl. "Preflight — required Worker secrets are configured" (runtime line `all required secrets present`); `wrangler deploy` printed `Current Version ID: 7159462e-b48b-4bbb-9dbe-13ff6a989ba7`; post-deploy `serving baf9985e1ada8500bc5bd414f967824b6b13772d on 8 consecutive reads after 24s` | GitHub Actions job 100116874559 |
| — | **Version linkage**: the tail's every event carries `"scriptVersion":{"id":"7159462e-b48b-4bbb-9dbe-13ff6a989ba7"}` — the same Version ID deploy #16 created. The Worker that returned the 401 *is* build `baf9985`, the build that served every 09-02 and 09-05 send | `tail-raw/run4-job-101261510343-excerpt.log` vs deploy #16 log |
| — | Tail run #3 (06:12:11–06:17:12Z): "0 notable events shown of 339" with the line-splitting parser — void, not evidence | GitHub job 101260560206 |

### 6.2 Prior notes relied on

`provider-docs.md` §1–§11 (endpoint, auth, 401/422/429 bodies, 201 shape,
statuses, DNS contract, credits); `dns-state.md` §0–§7 and `dns-raw/*.json`
(115 raw DoH answers); `code-path.md` §1–§9 (hop-by-hop code reading, GoTrue
`master` citations, caller table, timeline) — **except** its statements that the
hook "was not called" on 09-05, which depended on the void tail runs;
`tail-observations.md` (retraction header).

### 6.3 Build lineage check

See the `git` output appended in §6.5 (diff of email code between the live
build and HEAD; commits touching the hook/mailer between the incident fix and
the live build).

### 6.4 Deploy preflight — which recommended secrets exist

From the Deploy App run #16 job log (§6.5.2): every `[required]` name exists as
a Worker Secret (`EMAILIT_API_KEY` included); of the `[recommended]` names only
`SEND_EMAIL_HOOK_SECRET` exists; **`FROM_EMAIL` and `SUPPORT_INBOX_EMAIL` are
absent**, so the From address is the code default on `founders.click` and the
support inbox is the MX-less `support@founders.click`.

### 6.5 Appendix — raw outputs

#### 6.5.1 Build lineage (`git`, run 2026-09-05 06:27Z in the audit checkout)

```
$ git log -1 --format='%H %cI %s' baf9985
baf9985e1ada8500bc5bd414f967824b6b13772d 2026-09-02T03:46:03+00:00 ci: require a stable rollout before judging a deploy

$ git diff --stat baf9985 HEAD -- src/lib/email.server.ts src/routes/api/public/hooks/auth-send-email.ts \
    src/lib/auth-email-hook.ts src/lib/help.server.ts src/lib/help.functions.ts src/routes/help.contact.tsx \
    src/routes/signup.tsx src/routes/reset-password.tsx wrangler.jsonc
(empty — identical)

$ git log --oneline 1d02524..baf9985 -- src/lib/email.server.ts src/routes/api/public/hooks/auth-send-email.ts src/lib/auth-email-hook.ts
(empty — no commits touched the hook or the mailer between the incident fix and the live build)

$ git log -1 --format='%H %cI %s' 1d02524
1d0252427ef62c1698bf52389b26a8624b4b07f8 2026-09-01T07:26:53+00:00 Signup is down: implement the Supabase send-email hook the cutover orphaned

$ git log --format='%h %cI %s' 1d02524..baf9985
baf9985 2026-09-02T03:46:03+00:00 ci: require a stable rollout before judging a deploy
53b8730 2026-09-02T03:40:24+00:00 ci: wait for the new Worker version to propagate before smoking
eccbd56 2026-09-02T03:38:11+00:00 docs: launch readiness audit, 2026-09-02
2ce7593 2026-09-02T03:34:18+00:00 Harden public surfaces: security headers, JSON-LD escaping, rate limits, safe redirects
1227508 2026-09-01T08:11:57+00:00 test: authenticated per-feature browser audit across all customer-visible nav routes
ddc0c5c 2026-09-01T07:33:22+00:00 Monitor the auth email hook; record the signup incident
```

#### 6.5.2 Deploy App run #16 — secrets preflight extract

Job 100116874559 (`https://github.com/derekbowen/kindred-ease-space/actions/runs/33588287019/job/100116874559`),
step "Preflight — required Worker secrets are configured" (03:46:59–03:47:02Z),
runtime lines extracted by pattern from the 194 KB job log (the log is one
JSON-escaped line; only matches are shown, verbatim):

```
worker: founders-click
bindings: assets only (no routes, no vars) — correct
##[warning]Not set (code has defaults): CRON_SECRET FROM_EMAIL SUPPORT_INBOX_EMAIL PUBLIC_APP_URL CLOUDFLARE_EDGE_WORKER PLATFORM_AI_MODEL AI_CREDIT_VALUE_MICROS AI_CREDIT_MARKUP
all required secrets present
Deployed founders-click triggers (0.60 sec)
Current Version ID: 7159462e-b48b-4bbb-9dbe-13ff6a989ba7
serving baf9985e1ada8500bc5bd414f967824b6b13772d on 8 consecutive reads after 24s
serving baf9985 built 2026-09-02T03:46:32.825Z
deployed build matches this commit         baf9985
```

Reading (`scripts/required-secrets.txt:22-53` defines the two sections;
`deploy-app.yml:153-167` prints them):

| Secret | Section | On the Worker at 2026-09-02 03:47Z? | Consequence |
|---|---|---|---|
| `EMAILIT_API_KEY` | required | **present** (as a Secret; otherwise the deploy fails) | value rejected by EmailIt (§0) |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID` | required | present | — |
| `SEND_EMAIL_HOOK_SECRET` | recommended | **present** (not in the warning list) | matches the monitor's/tail's `401 invalid signature` |
| `FROM_EMAIL` | recommended | **absent** | From is the code default `founders.click <noreply@founders.click>` (`email.server.ts:90`) |
| `SUPPORT_INBOX_EMAIL` | recommended | **absent** | staff notices and every `Reply-To` go to `support@founders.click`, which has no MX (`dns-state.md` §6) |
| `CRON_SECRET`, `PUBLIC_APP_URL`, `CLOUDFLARE_EDGE_WORKER`, `PLATFORM_AI_MODEL`, `AI_CREDIT_VALUE_MICROS`, `AI_CREDIT_MARKUP` | recommended | absent | defaults apply (out of scope here) |

Caveat: `wrangler secret list` reports Secrets only. A plaintext Text variable
set in the dashboard would also read "not set" here — but the generated
config declares no `vars` and `wrangler.jsonc` has no `keep_vars`, so
`wrangler deploy` would drop dashboard vars on every CI deploy; the practical
state is therefore the one in the table. **OBSERVED (CI log), High** for
Secrets; **INFERRED, Medium-High** for the absence of Text vars.
