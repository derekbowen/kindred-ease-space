# Email code path, end to end — Task C of the email-delivery trace

Repo state audited: `84d192e19a2eed1890caee3784dfaf038d49fd52` (main, 2026-09-05 06:14Z).
Everything below is from the repository, its git history, the built Worker bundle
in `.output/server/`, the public Supabase/Cloudflare/EmailIt docs, and the
`supabase/auth` (GoTrue) source on `master` fetched 2026-09-05 (the hosted
GoTrue build for project `xbxhzinnfhosoztqaaao` is not observable; line numbers
for GoTrue are from `master` and are cited as such). No Worker logs, no EmailIt
dashboard, no Supabase dashboard were visible. Companion notes in this folder:
`provider-docs.md` (EmailIt contract), `dns-observations.md` / `dns-state.md`
(DNS), `tail-observations.md` (live Worker tail during a signup).

Confidence tags: **High** = read directly from code/docs and cross-checked;
**Medium** = inferred from code plus one corroborating observation;
**Low** = plausible from code, no corroboration available here.

---

## 0. One-paragraph verdict

Every email the product sends — signup confirmation, password recovery, magic
link, invite, email change, support-ticket receipt, support-inbox notification,
welcome, ticket status change, help-feedback follow-up, admin test send — goes
through one function, `sendEmail()` in `src/lib/email.server.ts:83-130`, which
POSTs to `https://api.emailit.com/v2/emails` with `Bearer process.env.EMAILIT_API_KEY`
and a default From of `founders.click <noreply@founders.click>`. That function
never throws; it returns `{ ok:false, status, error }` and writes one
`console.error` line. Of its nine call sites, seven discard the result and report
success to the customer (the auth hook, ticket receipt, ticket staff notice,
welcome ×2, ticket status change) — only the two admin-only functions in
`email-templates.functions.ts` throw on failure. CI proves `EMAILIT_API_KEY`
*exists* as a Worker secret before every deploy and nothing anywhere proves it
*works*: no test, no smoke, no monitor, no health check ever calls EmailIt. The
API key does load on Cloudflare (same `process.env` mechanism that demonstrably
loads `SEND_EMAIL_HOOK_SECRET`), so "key not loading" is ruled out; "key
invalid / From domain unverified / template disabled / accepted-but-held" are
not, and the code makes all four look identical to the customer: a green UI and
silence. Separately, the live tail on 2026-09-05 showed GoTrue is not calling
this Worker's hook at all for auth emails, so for signup/reset the in-repo path
is currently not even in the loop (see `tail-observations.md`); the ticket
receipt path (`help.server.ts`) *is* in the loop and also delivered nothing.

---

## 1. Signup → GoTrue → send-email hook

### 1.1 The client call

`src/routes/signup.tsx:34-41`

```ts
const { data, error } = await supabase.auth.signUp({
  email, password,
  options: {
    emailRedirectTo: `${window.location.origin}/app`,
    data: { display_name: name, full_name: name },
  },
});
```

Observed on the wire (phase2 `records.json:456`):
`POST https://xbxhzinnfhosoztqaaao.supabase.co/auth/v1/signup?redirect_to=https%3A%2F%2Fwww.founders.click%2Fapp`
→ `200` with `confirmation_sent_at` set. Outcome handling: any GoTrue error is
toasted verbatim (`signup.tsx:43-46`, which is how the customer sees
"email rate limit exceeded"); a 200 without a session shows the
"We sent a confirmation link to …" panel (`:50-55`, `:83-93`). There is no
"resend confirmation" control and no OTP-entry UI anywhere in `src/`
(`grep verifyOtp|InputOTP src/` → none outside the unused `components/ui`
primitive), so the emailed *link* is the only activation path. **High.**

### 1.2 What GoTrue does with it (supabase/auth `master`)

- `internal/api/signup.go:228-252` — email provider, user unconfirmed,
  `Mailer.Autoconfirm=false` → `a.sendConfirmation(r, tx, user, flowType)`.
- `internal/api/mail.go:793-813` — **the project-wide email rate limiter runs
  first** (`config.RateLimitEmailSent`, `a.limiterOpts.Email.Allow()`); on
  refusal it returns `EmailRateLimitExceeded`, which each caller turns into
  HTTP 429 `over_email_send_rate_limit` (`mail.go:341-342, 376-377, 419-420 …`).
- `mail.go:816-880` — `if config.Hook.SendEmail.Enabled` → build
  `mail.EmailData{ Token: otp, EmailActionType, RedirectTo: referrerURL,
  SiteURL: externalURL.String(), TokenHash: params.tokenHashWithPrefix }`
  (`:838-844`) → `a.hooksMgr.InvokeHook(tx, r, input, &output)` (`:879`).
  Otherwise (`:887-897`) the built-in/SMTP mailer (`mr.ConfirmationMail` …).
- `referrerURL` comes from `utilities.GetReferrer(r, config)` (`mail.go:68`).

**Redirect allow-list behaviour** (`internal/utilities/request.go:75-89`):

```go
func GetReferrer(r *http.Request, config *conf.GlobalConfiguration) string {
	reqref := getRedirectTo(r)              // ?redirect_to= / body
	if IsRedirectURLValid(config, reqref) { return reqref }
	reqref = r.Referer()                    // then the Referer header
	if IsRedirectURLValid(config, reqref) { return reqref }
	return config.SiteURL                   // else Site URL
}
```

So the `email_data.redirect_to` the hook receives is *already* the validated
value: if `https://www.founders.click/app` is neither the project's Site URL nor
matched by the Redirect URL allow-list (Supabase Dashboard → Authentication →
URL Configuration), GoTrue silently substitutes the **Site URL** — no error to
the client, no signal to the hook. The same function is applied again when the
link is clicked (`internal/api/verify.go:99-101`:
`params.RedirectTo = utilities.GetReferrer(r, a.config)`), so even a hook that
put `/app` into the link would be overridden at click time. Customer
experience if the allow-list is wrong: the confirmation itself succeeds, but the
browser lands on whatever the Site URL is (if it is still the Lovable host
`https://kindred-ease-space.lovable.app` or `http://localhost:3000`, the user is
"signed in" on the wrong origin / a stale build and never reaches
`www.founders.click/app`). The Site URL and allow-list values are not
observable from here — **open question**. Docs: supabase.com/docs/guides/auth/redirect-urls
("The Site URL … defines the default redirect URL when no redirectTo is
specified… This setting is critical for email confirmations and password
resets."). **High** on mechanism, **unknown** on the project's values.

### 1.3 The hook contract as implemented

Route: `src/routes/api/public/hooks/auth-send-email.ts` (server handler,
`POST` only, `:38-102`). Pure logic: `src/lib/auth-email-hook.ts`.

| Item | Where | Value |
|---|---|---|
| Endpoint expected in the dashboard | route header comment `:17-19` | `https://www.founders.click/api/public/hooks/auth-send-email`, secret copied to Worker as `SEND_EMAIL_HOOK_SECRET` |
| Secret format accepted | `auth-email-hook.ts:14-25` `decodeSecret` | `v1,whsec_<base64>` exactly as the Supabase dashboard displays it, or `whsec_<base64>`, or bare base64; decoded to raw bytes; empty → `null` |
| Headers verified | route `:54-62` | `webhook-id`, `webhook-timestamp`, `webhook-signature` (standard-webhooks) |
| Signature | `auth-email-hook.ts:33-64` | `base64(HMAC-SHA256(secret, "${id}.${timestamp}.${rawBody}"))`; header may carry several space-separated `v1,<b64>` entries, any one match passes; constant-time compare |
| Replay window | `:12`, `:48-49` | ±300 s (`TIMESTAMP_TOLERANCE_S`) |
| Body | route `:53`, `:68-73` | raw text hashed as-is, then `JSON.parse` |
| Action | route `:75` | `payload.email_data.email_action_type`, **defaults to `"signup"`** if absent |
| Recipient | route `:76-82` | `user.email`, or `user.new_email ?? user.email` when action is `email_change_new`; missing → 400 |
| Name | route `:85` | `user.user_metadata.full_name` (set by `signup.tsx:39`) |
| OTP | route `:86` → `copyFor(action, url, payload.email_data.token, name)` | the 6-digit `email_data.token` is rendered in HTML (`auth-email-hook.ts:109` "Or enter this code: **123456**") and text (`:112`). The product has no place to type it (§1.1) |
| Verify URL | route `:84` → `verifyUrl(payload.email_data, process.env.SUPABASE_URL)` | see below |
| Delivery | route `:88` | `sendEmail({ to, subject, html, text })` — **no idempotency key, no meta** |

**Exact confirmation URL** (`auth-email-hook.ts:81-93`):

```
${SUPABASE_URL with trailing "/" stripped}/auth/v1/verify
  ?token=<encodeURIComponent(email_data.token_hash)>
  &type=<encodeURIComponent(email_data.email_action_type)>
  &redirect_to=<encodeURIComponent(email_data.redirect_to || email_data.site_url || "https://www.founders.click/app")>
```

i.e. for this project
`https://xbxhzinnfhosoztqaaao.supabase.co/auth/v1/verify?token=<token_hash>&type=signup&redirect_to=https%3A%2F%2Fwww.founders.click%2Fapp`
(when the allow-list admits `/app`; otherwise `redirect_to` = Site URL, §1.2).
Parameter correctness against GoTrue `/verify` GET (`verify.go:95-103`):
`token` is read by `r.FormValue("token")` and, for GET, copied into
`TokenHash` (`verify.go:61-62`: "TODO: deprecate the token query param … use
token_hash instead") — so passing the *hash* under `token=` is correct;
`type` is dispatched at `verify.go:151-157` for `signup`, `invite`,
`recovery`, `magiclink`, `email_change`. **High.**

Two contract mismatches, latent (not on the signup/recovery path):

1. The route's `EmailAction` union (`auth-email-hook.ts:72-79`) names
   `email_change_current` / `email_change_new`, but current GoTrue sends the
   hook a single `email_action_type: "email_change"` (`mail.go:818, 838-846`,
   and the Send Email Hook JSON schema enum in the Supabase docs:
   `signup, invite, magiclink, recovery, email_change, email, reauthentication,
   password_changed_notification, email_changed_notification, …`). `copyFor`
   has no `case` for `email_change` or any `*_notification` type and returns
   `undefined`, so `mail.subject` at route `:88` throws → `src/server.ts:77-80`
   returns a branded **500** → GoTrue treats the hook as failed and fails the
   triggering request. No caller in `src/` changes email or sends magic links
   (`grep updateUser({email|signInWithOtp|inviteUserByEmail src/` → none), so
   this only bites if those flows are used from the dashboard or later added.
   **Medium** (hosted GoTrue version unknown; docs enum confirms `email_change`).
2. `type=reauthentication` is not a `/verify` type; the OTP is the real
   credential there and the button would 4xx. Cosmetic. **Medium.**

### 1.4 Failure posture of the hook (what returns non-2xx)

| Condition | Response | Log line | File:line |
|---|---|---|---|
| `SEND_EMAIL_HOOK_SECRET` unset/undecodable | **401** `{"error":"hook not configured"}` | `[auth-send-email] SEND_EMAIL_HOOK_SECRET missing/invalid — auth emails are DOWN …` | `:42-51` |
| bad/missing signature or stale timestamp | **401** `{"error":"invalid signature"}` | `[auth-send-email] rejected: bad signature/timestamp` | `:63-66` |
| body not JSON | **400** `{"error":"invalid json"}` | — | `:68-73` |
| no recipient | **400** `{"error":"no recipient"}` | — | `:80-82` |
| EmailIt returns non-2xx / throws | **200** `{}` | `[auth-send-email] EmailIt send FAILED <action> <error>` plus the `[email] …` line from `sendEmail` | `:88-98` |
| success | **200** `{}` | — | `:95-98` |

The 200-on-failure is deliberate and documented (`:20-26`, `:89-94`): a
non-2xx would fail the customer's signup outright (the 2026-09-01 outage), so a
missed email is traded for a completed signup. The consequence for diagnosis is
that **GoTrue's `confirmation_sent_at` and the client's 200 prove only that the
hook (or whatever sender is configured) answered 2xx**, never that EmailIt
accepted anything. **High.**

---

## 2. `sendEmail()` — `src/lib/email.server.ts:83-130`

### 2.1 How the API key is loaded, and whether `process.env` works on this Worker

`email.server.ts:84`: `const apiKey = process.env.EMAILIT_API_KEY;` — read per
call, not at module scope (the built chunk is
`.output/server/_ssr/email.server-DQX_sSrH.mjs:48-51`, identical).

Why this works on Cloudflare in this build (**High**):

- `wrangler.jsonc:4-5` — `"compatibility_date": "2025-09-24"`,
  `"compatibility_flags": ["nodejs_compat"]`; the generated
  `.output/server/wrangler.json` carries the same two values and declares no
  `vars` (the deploy asserts "bindings: assets only (no routes, no vars)",
  `deploy-app.yml:111-117`).
- Cloudflare docs (developers.cloudflare.com/workers/configuration/environment-variables/,
  …/compatibility-flags/#enable-auto-populating-processenv): with
  `nodejs_compat` and a compatibility date on or after **2025-04-01** the
  `nodejs_compat_populate_process_env` flag is on by default, `process.env` "will
  be populated lazily the first time that `process` is accessed", and "because
  secrets are a form of environment variable within the runtime, secrets are also
  exposed via `process.env`". Text variables are exposed directly.
- The nitro/unenv shim in the bundle (`.output/server/_libs/unenv.mjs:1-13`)
  keeps workerd's own `process` object: `const originalProcess = globalThis["process"]; globalThis.process = originalProcess ? new Proxy(originalProcess, { get(target, prop) { if (Reflect.has(target, prop)) return Reflect.get(target, prop) … } }) : process;`
  — so `process.env` resolves to workerd's populated env, not an empty unenv
  polyfill.
- `src/server.ts:70-81` passes `env` straight through to the TanStack entry and
  never copies bindings into `process.env`; nothing else in the bundle does
  either (`grep -r "process.env =" .output/server` → none). All 20 env names in
  the bundle are read the same way (`process.env.SUPABASE_URL` ×4,
  `SUPABASE_SERVICE_ROLE_KEY`, `SEND_EMAIL_HOOK_SECRET`, `CRON_SECRET` …).
- **Proof by sibling:** `src/integrations/supabase/client.server.ts:9-11` reads
  `process.env.SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` the same way and the
  site serves database-backed pages; the hook reads
  `process.env.SEND_EMAIL_HOOK_SECRET` (`auth-send-email.ts:42`) the same way and
  the production monitor gets `401 invalid signature` — not `401 hook not
  configured` — every 30 minutes (`production-monitor.yml:88-106`,
  `tail-observations.md:44-47`), which is only possible if that secret loaded.
  `EMAILIT_API_KEY` therefore loads identically. A "key missing" failure would
  log `[email] EMAILIT_API_KEY not configured` (`:86`) and is additionally
  excluded by the deploy preflight (§4).

### 2.2 The request

`email.server.ts:6` `EMAILIT_API_URL = "https://api.emailit.com/v2/emails"`;
`:92-113`:

| Field | Source | Notes |
|---|---|---|
| `from` | `params.from \|\| process.env.FROM_EMAIL \|\| "founders.click <noreply@founders.click>"` (`:90`) | no caller passes `from`; see §3 |
| `to` | `params.to` (string or string[]) | |
| `subject` | `params.subject` | |
| `html` / `text` | only when provided (`:97-98`) | every caller provides both |
| `reply_to` | `params.replyTo` (`:99`) | ticket mails only |
| `meta` | `params.meta` (`:100`) | `{ticket_id, kind}` / `{workspace_id, kind}` / `{kind, template_key}` |
| headers | `Content-Type: application/json`, `Authorization: Bearer <key>` (`:102-105`) | |
| `Idempotency-Key` | only when `params.idempotencyKey` (`:106`) | **auth hook sends none**; others in §6 |

Not sent: `tracking`, `headers`, `scheduled_at`, `template`. Not implemented:
timeout/AbortSignal, retry, response-header capture (`ratelimit-*`). Field names
match the EmailIt reference (`provider-docs.md` §3). **High.**

### 2.3 Response handling and what is logged

`:114-129`:

```ts
const data = (await res.json().catch(() => ({}))) as { id?; message?; error? };
if (!res.ok) {
  const msg = data.error || data.message || `EmailIt ${res.status}`;
  console.error("[email] send failed", res.status, msg);
  return { ok: false, error: msg, status: res.status };
}
return { ok: true, id: data.id, status: res.status };
} catch (err) { console.error("[email] send exception", msg); return { ok: false, error: msg }; }
```

- Non-2xx → `{ ok:false, status, error }`; **never throws**. With EmailIt's live
  401 body `{"statusCode":401,"error":"UnauthorizedError","message":"Invalid API key"}`
  the log line is `[email] send failed 401 UnauthorizedError`; with the documented
  422 it is `[email] send failed 422 From/Sender domain is not valid or not verified`.
- 2xx (EmailIt returns **201**, status `pending`) → `{ ok:true, id }`. A 201 is
  queue acceptance, not delivery (`provider-docs.md` §4, §7). **Every caller
  discards `id`** — nothing persists the EmailIt `em_…` id or `message_id`, so
  after the fact the only join key into EmailIt's log is `meta` /
  `Idempotency-Key` / recipient+time.
- Logging goes to `console.error` only → Cloudflare Workers console output.
  `wrangler.jsonc` has no `observability` block, so unless Workers Logs was
  enabled in the dashboard these lines are visible **only to a live
  `wrangler tail`** — which is exactly why `.github/workflows/email-trace-tail.yml`
  had to be written on 2026-09-05. No metric, no alert, no DB row. **Medium**
  on the persistence point (dashboard setting not visible), **High** on the rest.

### 2.4 Callers, and precisely which turn a failed send into "success"

| # | Caller | File:line | Result used? | Customer sees on EmailIt failure |
|---|---|---|---|---|
| 1 | Auth hook (all GoTrue email types) | `auth-send-email.ts:88-98` | logged, then **200 `{}`** regardless | "Check your email…" (signup), "Check your email for a reset link." (`reset-password.tsx:61`) |
| 2 | Support ticket → user receipt | `help.server.ts:398-408` inside `Promise.allSettled` (`:386-409`), whole block in `try` (`:365-412`) | **ignored** — `return { id: ticketId }` at `:414` runs regardless; the ticket row was already inserted (`:344-355`) | "We'll email you shortly" + ticket id |
| 3 | Support ticket → staff inbox | `help.server.ts:387-397`, same block | ignored | (staff never notified) |
| 4 | Welcome — `createWorkspace` | `workspace.functions.ts:145-164` | fire-and-forget `.then().catch()`; `sendEmail` resolves `{ok:false}` so `.catch` never fires; **not awaited** | workspace created |
| 5 | Welcome — `ensureWorkspace` (the live path per `:186-188`) | `workspace.functions.ts:186-207` | same | app loads |
| 6 | Ticket status changed → user | `help-tickets.functions.ts:149-173` | awaited, result ignored, `return { ok:true }` (`:175`) | status saved |
| 7 | Help-feedback follow-up (admin) | `email-templates.functions.ts:168-178` | **throws** `res.error \|\| "send failed"` | error surfaced to admin |
| 8 | Template test send (admin) | `email-templates.functions.ts:121-129` | **throws** | error surfaced to admin |

Row 8 matters operationally: **Admin → Email Templates → "send test"**
(`src/routes/_authenticated/app.admin.email-templates.tsx:19,38`) is the only
in-product action that displays EmailIt's actual rejection text, without a log
tail. Rows 4–5 have a second problem: on Workers a promise left un-awaited when
the server function returns is not guaranteed to run to completion (no
`ctx.waitUntil` anywhere in `src/`); the chain does a Supabase read
(`welcomeEmailTemplate` → `loadTemplateOverride`, `email.server.ts:26-45`) before
it even reaches `fetch`, so the welcome email may frequently never be *sent*, let
alone delivered. **Medium** (consistent with "the founder's own welcome email"
never appearing in 60 days, `phase2-account/records.json:136`).

A **second silent path** shared by rows 2–7: templates are rendered through
`renderTemplate` (`email.server.ts:52-63`), which consults the
`email_templates` table (`:26-45`, 30 s cache) and returns `null` when a row has
`is_enabled = false`. Every caller then skips the send with no log at all
(`help.server.ts:387/398` → `Promise.resolve()`, `workspace.functions.ts:153/195`
→ `return`, `help-tickets.functions.ts:159`). A disabled `ticket_received_user`
row would reproduce the 2026-09-02 06:51Z ticket-receipt non-delivery exactly,
with no `[email]` line to find. Check: `select key, is_enabled from
email_templates;`. **Medium** (table contents not visible here).

---

## 3. The From address and the sending-domain variable

- Default: `founders.click <noreply@founders.click>` (`email.server.ts:90`,
  comment `:70`). Introduced 2026-05-11 (`d738cc5`, first `FROM_EMAIL`
  reference); untouched since except the manifest.
- `FROM_EMAIL` is **set nowhere in the repository or CI**: not in `.env`,
  `.env.example`, `wrangler.jsonc`, any workflow (CI never sets Worker
  vars/secrets — `deploy-app.yml:119-121`, `required-secrets.txt:15-16`); it
  appears only as a `[recommended]` entry "defaults to …"
  (`required-secrets.txt:46`) and in `docs/DEPLOYMENT.md` only via that
  manifest. Whether the Worker has a `FROM_EMAIL` secret/var is unknown; the
  preflight merely *warns* if absent. If one is set to an address outside the
  EmailIt-verified domain, every send 422s (`provider-docs.md` §5), invisibly.
  **High** on repo state, **unknown** on Worker value.
- `EMAILIT_SENDER_DOMAIN`: **zero references** anywhere — `src/`, `scripts/`,
  `tests/`, `docs/`, `.github/`, `.lovable/`, `.output/`, `supabase/`, and
  `git log --all -S SENDER_DOMAIN` is empty. It is not read by this codebase; it
  is a leftover of the Lovable-era app, the same class of "dead configuration"
  that `SEND_EMAIL_HOOK_SECRET` was wrongly filed under
  (`docs/INCIDENTS.md:33-35, 52-55`). Its *value* may nonetheless be the only
  on-Worker record of which sending domain the EmailIt workspace verified; if it
  is not `founders.click`, the default From is on an unverified domain. **High**
  (not read), value unknown.
- `SUPPORT_INBOX_EMAIL` defaults to `support@founders.click`
  (`email.server.ts:360`). The apex has **no MX** (`dns-observations.md:35`), so
  the staff notification (row 3) and every `reply_to` on customer receipts
  (rows 2, 6, 7) point at an undeliverable mailbox unless the env var overrides
  it. **High** on DNS, value unknown.
- `PUBLIC_APP_URL` defaults to `https://www.founders.click` (`:135`) — link
  targets in templates are fine.

---

## 4. The secrets manifest and the deploy preflight

`scripts/required-secrets.txt:22-33` lists `EMAILIT_API_KEY` under
`[required]` ("no default, sending fails without it", `:28`);
`SEND_EMAIL_HOOK_SECRET`, `FROM_EMAIL`, `SUPPORT_INBOX_EMAIL` are
`[recommended]` (`:36-47`). `.github/workflows/deploy-app.yml:122-167` runs
`wrangler secret list --format json` in `.output/server` and fails the deploy
if any `[required]` name is absent, warns for `[recommended]`.

What that does and does not establish (**High**):

- Existence only. "Secrets persist across deploys, so CI never sets them — it
  only proves they exist" (`deploy-app.yml:119-121`). No value is read, no
  request is made to EmailIt, no format check (`em_live_…`/`em_test_…`).
- Because `wrangler secret list` shows Secrets only (`required-secrets.txt:18-20`,
  `deploy-app.yml:164`), a Text-typed `EMAILIT_API_KEY` would have *failed*
  every deploy. Deploys have been green since 2026-09-01, so `EMAILIT_API_KEY`
  exists **as a Secret** on `founders-click`. Its validity, scope (`full` vs
  `sending` limited to one domain — `provider-docs.md` §2) and workspace are
  unverified.
- Escape hatch: if `wrangler secret list` itself errors, the step prints
  "Could not list Worker secrets (first deploy?)" and **exits 0**
  (`deploy-app.yml:129-134`), so a token-permission regression would make the
  preflight pass vacuously. Not implicated here (the step has listed secrets
  successfully — the `[recommended]` warning logic depends on it), but worth
  knowing.

---

## 5. Health checks and tests that exercise EmailIt

None do. **High.**

| Artefact | What it touches | EmailIt call? |
|---|---|---|
| `tests/auth-email-hook.test.ts` (in `bun run test`, `package.json:15`; run on every deploy, `deploy-app.yml:89-90`) | `decodeSecret`, `verifySignature`, `signPayload`, `verifyUrl`, `copyFor` — pure functions | no (`sendEmail` never imported; no fetch mock) |
| `scripts/smoke-production.ts` (post-deploy) | build identity, homepage, auth entry point, assets, sitemap, DB, telemetry, auth refusal, public page (`:107-224`) | no (`grep -i email` → none) |
| `.github/workflows/production-monitor.yml:88-106` (every 30 min) | unsigned POST to the hook; expects `401 invalid signature` | no — proves the route is deployed and has a secret, nothing about mail |
| `.github/workflows/email-trace-tail.yml` (added 2026-09-05) | read-only `wrangler tail` for 300 s | no (observes only) |
| `tests/e2e/live/phase_public_contact.py` | submits a ticket "as an EmailIt delivery probe" (`:1-2`) | indirectly (row 2); delivery judged by a human reading Gmail |
| `tests/e2e/smoke.py` via `.github/workflows/smoke.yml` (cron every 6 h, `smoke.yml:11-13`; on push touching signup/login) | **performs a real signup** with `smoke<ts>@example.com` (`smoke.py:104,110`) against `SMOKE_BASE_URL` | indirectly via GoTrue → hook; each run consumes one of the project's 2 auth emails/hour (§7) and, if a mailer is working, sends to the reserved `example.com` domain (bounce → EmailIt AUP "bounce rate under 5%", `provider-docs.md` §9). Whether the workflow currently runs depends on the `SMOKE_BASE_URL` secret (unknown; check the Actions history for "E2E Smoke"). **Medium.** |
| `supabase/functions/*` | no mailer of any kind (`grep -ri emailit|smtp|resend supabase/functions` → none) | no |

---

## 6. Every email type, and the single choke point

All twelve go through `sendEmail()`; there is no second sender, no SMTP, no
Supabase built-in template in use *by this code* (whether the Supabase project
itself still uses its built-in mailer is the open question from
`tail-observations.md`). **High.**

| # | Email | Trigger | Path | Template / copy | To | Idempotency-Key | meta |
|---|---|---|---|---|---|---|---|
| 1 | Signup confirmation | `signup.tsx:34` → `POST /auth/v1/signup` | GoTrue → hook `auth-send-email.ts:88` | `copyFor("signup")` `auth-email-hook.ts:116-121` "Confirm your founders.click account" | `user.email` | none | none |
| 2 | Password recovery | `reset-password.tsx:57` `resetPasswordForEmail(email,{redirectTo: origin+"/reset-password"})` → `POST /auth/v1/recover` | hook | `copyFor("recovery")` `:134-139` | `user.email` | none | none |
| 3 | Magic link | no caller in `src/` (`signInWithOtp` absent); reachable via API/dashboard | hook | `copyFor("magiclink")` `:128-133` | | none | none |
| 4 | Invite | no caller in `src/`; dashboard "Invite user" | hook | `copyFor("invite")` `:122-127` | | none | none |
| 5 | Email change (both addresses) | no caller in `src/` | hook — **crashes on `email_change`**, see §1.3 | `:140-146` | `user.new_email` only when action is literally `email_change_new` (`route :76-79`) | none | none |
| 6 | Reauthentication | no caller | hook | `:147-152` (OTP only meaningful) | | none | none |
| 7 | Support ticket receipt → user | `/help/contact` → `submitTicket` `help.server.ts:336` | `help.server.ts:398-408` | `ticket_received_user` `email.server.ts:231-251` | submitter | `ticket-user-${ticketId}` | `{ticket_id, kind:"ticket_new_user"}` |
| 8 | Support ticket → staff | same | `help.server.ts:387-397` | `ticket_new_staff` `:182-230` | `SUPPORT_INBOX_EMAIL` (default `support@founders.click`, no MX) | `ticket-staff-${ticketId}` | `{ticket_id, kind:"ticket_new_staff"}` |
| 9 | Welcome (createWorkspace) | explicit workspace creation | `workspace.functions.ts:154-161` | `welcome` `:156-181` | JWT email | `welcome-${workspace_id}` | `{workspace_id, kind:"welcome"}` |
| 10 | Welcome (ensureWorkspace — live path, wired 2026-08-27 `98380d8`) | first app entry after confirmation | `workspace.functions.ts:196-203` | `welcome` | JWT email | `welcome-${workspace_id}` | same |
| 11 | Ticket status changed → user | admin status change | `help-tickets.functions.ts:160-168` | `ticket_status_changed` `:252-278` | ticket email | `ticket-status-${id}-${status}` | `{ticket_id, kind:"ticket_status_change", status}` |
| 12 | Help-feedback follow-up | admin action | `email-templates.functions.ts:168-176` | `help_feedback_followup` `:279-312` | feedback email | `feedback-followup-${feedbackId}` (if id) | `{kind, article_id}` |
| 13 | Template test send | admin action | `email-templates.functions.ts:121-127` | any, `[Test] ` prefix | admin-entered | none | `{kind:"template_test", template_key}` |

Not emailed at all: admin replies on a ticket (`adminPostTicketMessage`,
`help-tickets.functions.ts:178+` has no `sendEmail`), although the customer's
receipt says "just reply to this email" (`email.server.ts:241`) — and replies go
to `support@founders.click`, which has no MX. **High.**

Useful for the EmailIt-side search: the 2026-09-02 06:51:51Z ticket
`ab749c8c-cad4-45d9-8ebf-ca2e25fb0fac` (TABLES.md:21) would have been sent with
`Idempotency-Key: ticket-user-ab749c8c-cad4-45d9-8ebf-ca2e25fb0fac` and
`meta.ticket_id` = that id — `GET /v2/emails?type=outbound` filtered on that
meta value (`provider-docs.md` §7) settles whether EmailIt ever saw it.

---

## 7. Rate limiting: what `429 over_email_send_rate_limit` is, and whether it can be silent

Observed (`phase2-account/records.json:487, 496-502, 529, 538-544`): on
2026-09-05, after two accepted auth emails (05:51Z reset, 05:59:28Z signup C),
`POST /auth/v1/recover` at 05:59:39Z and `POST /auth/v1/signup` at 06:06:40Z
both returned `429 {"code":"over_email_send_rate_limit","message":"email rate limit exceeded"}`;
the signup created no account. The same limit held the 2026-09-01 Outlook resend
back ~50 min (`:529`).

Which limit (**High**): GoTrue's **project-wide "emails sent" token bucket**,
`config.RateLimitEmailSent` / `a.limiterOpts.Email.Allow()`, evaluated inside
`sendEmail()` *before* either the hook or the mailer is reached
(`mail.go:793-813`, hook branch begins `:816`), plus the per-user 60 s
`SMTP.MaxFrequency` check (`mail.go:323`, `:402 validateSentWithinFrequencyLimit`)
that maps to the same error code. Supabase's rate-limits page
(supabase.com/docs/guides/auth/rate-limits, fetched 2026-09-05) states for
"Endpoints that trigger email sends — `/auth/v1/signup` `/auth/v1/recover`
`/auth/v1/user`, sum of combined requests project-wide": "**Only 2 emails per
hour with the built-in email provider. You can only change this with a custom
SMTP setup**"; with custom SMTP the default becomes 30/hour
(supabase.com/docs/guides/auth/auth-smtp: "a low rate-limit of 30 messages per
hour is imposed"). The observed ceiling of ~2/hour is therefore the
**built-in-provider value**, i.e. this project's "Emails sent" limit has never
been raised, which in the hosted dashboard is only possible once Custom SMTP is
enabled. (The docs' error-code blurb "Too many emails have been sent to this
email address" is misleading; the code path is project-wide.) Enabling the Send
Email hook does not lift it — the limiter runs first regardless of sender.

Can it silently suppress hook calls? **No** (**High**): when the bucket is
empty the request fails with a 429 that the client sees and `signup.tsx:43-46`
toasts; the transaction is rolled back; no hook call, no `confirmation_sent_at`.
There is no code path in which GoTrue returns 200, sets `confirmation_sent_at`,
and skips the sender because of rate limits. The genuinely silent paths are
different: (a) enumeration protection — signing up an address that already
exists *and is confirmed* returns 200 with a sanitised fake user and sends
nothing (`signup.go:294-299`), not applicable to the fresh aliases used;
(b) `Mailer.Autoconfirm`, not in effect (confirmation was required);
(c) the hook's own 200-on-EmailIt-failure (§1.4). So every accepted send in the
log (06:48:37Z, 07:21:45Z on 09-02; 05:59:28Z on 09-05) really did reach *the
sender GoTrue is configured with* and got a 2xx back — and the tail shows that
sender was not this Worker (`tail-observations.md`).

Second-order effect: the 2/hour budget is shared by real customers, the audit,
and the 6-hourly `smoke.py` signup (§5). Two customers in one hour is enough to
refuse the third with a raw "email rate limit exceeded" toast. **High.**

---

## 8. Timeline correlation

Git dates are commit times (UTC); deploy times are from `docs/INCIDENTS.md`.

| When (UTC) | Event | Source |
|---|---|---|
| 2026-05-11 07:30–09:53 | EmailIt wrapper and `EMAILIT_API_KEY` / `FROM_EMAIL` first appear (`d738cc5`, `1aa33b9`, `d828143`); this is the sender ever since | `git log -S EMAILIT_API_KEY`, `git log -- src/lib/email.server.ts` |
| 2026-08-27 01:58 | Welcome email wired into the live `ensureWorkspace` path (`98380d8`; comment `workspace.functions.ts:186-188`: before this "no customer ever received the welcome email") | git |
| 2026-08-30 19:34 | CI deploy workflow added (`a38aa02`) | git |
| **2026-09-01 06:26** | **First CI deploy** replaces the May-era Worker; the dashboard's hook URI `https://founders-click.derekbowencorp.workers.dev/lovab…` becomes 404; signup 500s | `docs/INCIDENTS.md:21-31` |
| 2026-09-01 07:26:53 | In-repo hook committed (`1d02524` "Signup is down: implement the Supabase send-email hook the cutover orphaned"); monitor `ddc0c5c` 07:33 | git |
| ~2026-09-01 07:31 | Hook deployed; dashboard Endpoint re-pointed to `https://www.founders.click/api/public/hooks/auth-send-email`, existing secret kept; E2E reaches the confirmation screen | `INCIDENTS.md:37-46` |
| 2026-09-01 08:38 | Confirmation **resend** for `derekcbowen@outlook.com` → 200 (after ~50 min of 429) | `AUDIT_2026-09-02.md:79`, `records.json:529` |
| ~2026-09-02 03:20 | Password recovery for the Outlook account → accepted | `AUDIT_2026-09-02.md:30-33` |
| 2026-09-02 06:48:37 | Signup A (Gmail alias) → 200, `confirmation_sent_at` | `records.json:130` |
| 2026-09-02 06:51:51 | Support ticket `ab749c8c-…` → server fn `ok:true` (row 7 send attempted by this code) | `TABLES.md:21` |
| 2026-09-02 07:21:45 | Signup B → 200 | `records.json:132` |
| 2026-09-05 05:51 | Password reset → accepted | `records.json:529` |
| 2026-09-05 05:59:28 | Signup C → 200; **tail: 0 requests to the hook** | `records.json:454-458`, `tail-observations.md` |
| 2026-09-05 05:59:39 / 06:06:40 | Reset / signup D → 429 | `records.json:499-501, 539-543` |

**Emails known delivered after 2026-09-01 06:26 UTC: none.** Every claim in
the repo is negative: "Gmail: zero messages from founders.click in 7 days
(inbox, spam, all folders). GoTrue: both accounts still 'email_not_confirmed'
70 hours after signup. Outlook … still unconfirmed 4 days after its resend"
(`TABLES.md:17,459`; `records.json:182`); "zero delivered in 3 days"
(`LIVE_ACCEPTANCE_TEST_2026-09-02.md:64`); Outlook "still unconfirmed 4 days
later" (`:79`); "Neither has been confirmed received; the account was still
unconfirmed 19 hours later" (`AUDIT_2026-09-02.md:30-35`); "Email *delivery*
through EmailIt was not directly proven" (`INCIDENTS.md:66-67`). The only
positive verification recorded for the fix was that signup *reaches the
confirmation screen* (`INCIDENTS.md:46`), which §1.4 shows is not evidence of
mail. The same Gmail inbox also holds no founders.click message in the
preceding 60 days, including the founder's own welcome email
(`records.json:136`) — consistent with either never-sent (§2.4 rows 4–5) or
never-delivered, and in any case meaning **there is no record anywhere of
EmailIt having delivered a message from this codebase, before or after the
cutover.** **High** (as a statement about the evidence on file).

---

## 9. What the code path does and does not explain

Consistent with all evidence:

1. **Auth emails (signup, reset).** The in-repo hook cannot be the thing that
   dropped them on 2026-09-05 — it was not called (`tail-observations.md`), and
   it always returns 200 anyway. Whatever GoTrue is configured to use now (a
   hook URI elsewhere, or custom SMTP / the built-in mailer) answered 2xx. The
   2/hour ceiling says the "Emails sent" limit is at its built-in-provider
   value (§7). Neither the dashboard hook config nor the SMTP toggle is
   observable here.
2. **Ticket receipt (2026-09-02 06:51:51Z).** This one *did* run through
   `help.server.ts` → `sendEmail()`. Four code-visible ways it vanishes
   silently, all indistinguishable from the UI: EmailIt rejected it (401 bad
   key / 422 unverified From domain / 429) and the only trace was a
   `console.error` nobody was tailing; EmailIt accepted it (201) and then
   held / suppressed / bounced it (`provider-docs.md` §7); the
   `email_templates.ticket_received_user` row is disabled (no log at all,
   §2.4); or `FROM_EMAIL` on the Worker overrides the default with an
   unverified address (§3).
3. **Not plausible:** `EMAILIT_API_KEY` failing to load (§2.1); the hook
   secret or signature (the hook is not being reached); DNS for
   `emailit.founders.click` (`dns-observations.md`); GoTrue rate limits hiding
   a hook call (§7).

Fastest in-product discriminators, in order: (i) Admin → Email Templates →
send test (§2.4 row 8) — the one call that *throws* EmailIt's message to the
screen; (ii) `select key,is_enabled from email_templates`; (iii)
`wrangler secret list` for `FROM_EMAIL` / `SUPPORT_INBOX_EMAIL` and the value of
`EMAILIT_SENDER_DOMAIN`; (iv) EmailIt `GET /v2/emails?type=outbound` filtered on
`meta.ticket_id = ab749c8c-cad4-45d9-8ebf-ca2e25fb0fac`; (v) Supabase
Dashboard → Authentication → Hooks (Send Email URI/enabled), → SMTP settings,
→ URL Configuration (Site URL + allow-list), → Rate limits ("Emails sent").
