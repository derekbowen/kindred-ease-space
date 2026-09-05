# EmailIt provider contract — documentation excerpts

Task A of the email-delivery trace. Everything below was fetched on 2026-09-05 with
`curl` through the sandbox proxy from the public docs at https://emailit.com/docs
and cross-checked against two unauthenticated probes of the live API. No EmailIt
API key was available in the audit environment (`EMAILIT_API_KEY` unset), so no
authenticated call was made and nothing in the EmailIt dashboard was seen.

Repo call site under audit: `src/lib/email.server.ts:6` (`EMAILIT_API_URL =
"https://api.emailit.com/v2/emails"`), `:90` (default from
`founders.click <noreply@founders.click>`), `:102-106` (headers), `:109-124`
(fetch + response handling). Hook: `src/routes/api/public/hooks/auth-send-email.ts:88-98`.

---

## 1. Endpoint and version

Source: https://emailit.com/docs/api-reference/ and https://emailit.com/docs/quickstart/api/

> Our current API version is v2 with the following base URL:
> `https://api.emailit.com/v2`

> The current API version is `v2`.
> Our API v1 is deprecated and will be removed at the end of February 2026.

Source: https://emailit.com/docs/api-reference/emails/send/

> # Send Email
> Send a single email to one or multiple recipients. Supports templates, variables, attachments, scheduling, and tracking.
> POST `/emails`

Documented cURL example (verbatim):

```
curl -X POST https://api.emailit.com/v2/emails \
  -H "Authorization: Bearer your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Your Company <hello@yourdomain.com>",
    "to": ["recipient1@example.com", "recipient2@example.com"],
    "subject": "Hello World",
    "html": "<h1>Welcome!</h1><p>Thanks for signing up.</p>",
    "tracking": { "loads": true, "clicks": true }
  }'
```

**Verdict:** `POST https://api.emailit.com/v2/emails` is the current documented send
endpoint. The repo constant matches exactly.

## 2. Authentication

Source: https://emailit.com/docs/api-reference/authentication/

> The Emailit API v2 uses API keys to authenticate requests. You can view and manage your API keys in the Emailit Dashboard.
> Your API keys can either have full permission, or be limited to a sending domain.
> To authenticate your requests to the Emailit API, you need to send the API key in the `Authorization` header.

(The page's code sample for the header is rendered by a JS component and only the
base URL survives in the static HTML; the header format is confirmed instead by
every cURL sample in the reference, all of which use `-H "Authorization: Bearer <key>"`.)

Key format, from the samples and the Create API Key response
(https://emailit.com/docs/api-reference/api-keys/create/):

```
'Authorization': 'Bearer em_test_51RxCWJ...vS00p61e0qRE'     # send examples
"key": "em_live_51RxCWJ...vS00p61e0qRE"                       # create-key response
```

So keys carry an `em_` prefix and the samples show both `em_test_` and `em_live_`
prefixes. **No page documents a test/sandbox mode or what an `em_test_` key does**;
the Create API Key body only has `name`, `scope` (`full` | `sending`, default `full`)
and `sending_domain_id` (restrict key to one sending domain). The guide
(https://emailit.com/docs/guides/how-to-get-an-api-key/) says the same:

> The scope of an API key can be: `full` - for full access to the API. `sending` - for sending emails using SMTP or API.
> The sending scope can also be limited to a specific sending domain.

Live probe (unauthenticated / bogus key), 2026-09-05:

```
POST https://api.emailit.com/v2/emails  (no Authorization)        -> HTTP 401
{"statusCode":401,"error":"UnauthorizedError","message":"API key required"}

POST https://api.emailit.com/v2/emails  (Bearer em_live_invalidkey000000) -> HTTP 401
{"statusCode":401,"error":"UnauthorizedError","message":"Invalid API key"}
```

Note the live 401 body shape (`statusCode`/`error`/`message`, flat strings) differs
from the nested `{"error":{"code":401,"message":"Unauthorized"}}` shown in some
reference pages (domains/verify, events). `email.server.ts:120` reads
`data.error || data.message`, so an invalid key would be logged as
`[email] send failed 401 UnauthorizedError`.

## 3. Request body

Source: https://emailit.com/docs/api-reference/emails/send/ (Headers + Request Body)

| Field | Required | Doc text (verbatim) |
|---|---|---|
| `Authorization` header | yes | Bearer token for authentication. |
| `Idempotency-Key` header | no | Unique key (max 256 chars, alphanumeric/dash/underscore) to prevent duplicate sends for 24 hours. |
| `from` | **yes** | Sender email in RFC format: `email@domain.com` or `Display Name <email@domain.com>`. |
| `to` | **yes** | string \| string[] — Recipient email address(es). Maximum 50 recipients. |
| `subject` | conditional | Email subject line. Required unless template provides it. |
| `html` | conditional | HTML content of the email. Required unless template provides it or text is provided. |
| `text` | no | Plain text content of the email. |
| `reply_to` | no | string \| string[] — Reply-to email address(es). |
| `cc` / `bcc` | no | Maximum 50 recipients each. |
| `template` | no | Template alias or ID (tem_xxx format). |
| `variables` | no | Variables for template substitution. |
| `attachments` | no | Array of attachment objects. |
| `headers` | no | Custom email headers as key-value pairs. |
| `meta` | no | Metadata as key-value string pairs. Stored and returned with the email. |
| `scheduled_at` | no | ISO 8601, Unix timestamp, or natural language like `tomorrow at 9am`. |
| `tracking` | no | boolean \| object with `loads` and `clicks`. |

Repo mapping (`email.server.ts:92-100`): sends `from`, `to`, `subject`, `html`,
`text`, `reply_to`, `meta`, plus `Idempotency-Key` when given. All field names
match the documented ones. The default `from` is
`founders.click <noreply@founders.click>` — the `Display Name <addr>` form the docs
accept. (Whether EmailIt's parser tolerates an unquoted `.` in the display name,
which is RFC 5322 obs-phrase syntax, is not documented; see open questions.)

## 4. Success response

Source: https://emailit.com/docs/api-reference/emails/send/ — response tabs are labelled
`201` and `201 Scheduled` (the page's `data-label` attributes), i.e. **HTTP 201**,
not 200. Verbatim `201` body:

```json
{
  "object": "email",
  "id": "em_abc123xyz789def456ghi012jkl345",
  "ids": {
    "recipient1@example.com": "em_abc123xyz789def456ghi012jkl345",
    "recipient2@example.com": "em_def456abc789ghi012jkl345mno678"
  },
  "token": "abc123xyz789",
  "message_id": "<abc123xyz789@yourdomain.com>",
  "from": "hello@yourdomain.com",
  "to": ["recipient1@example.com", "recipient2@example.com"],
  "subject": "Hello World",
  "status": "pending",
  "scheduled_at": null,
  "created_at": "2026-01-08T12:00:00.123456Z",
  "tracking": { "loads": true, "clicks": true }
}
```

Key facts: the accepted send returns `id` (`em_…`), `message_id` (the SMTP
Message-ID that would appear in the recipient's headers) and `status: "pending"`.
`email.server.ts:119-124` uses `res.ok` (covers 201) and keeps `data.id` — compatible.
**A 201 is acceptance into the queue, not delivery** (see §7).

## 5. Error responses (send)

Source: https://emailit.com/docs/api-reference/emails/send/ — each tab label is the HTTP
status; bodies verbatim.

| HTTP | Situation | Body |
|---|---|---|
| 400 | malformed request / bad `from` / bad `to` | `{"error": "Validation failed", "validation_errors": ["Missing required field: from", "Invalid to email address at index 0: invalid-email"]}` |
| 404 | template missing | `{"error": "Template not found", "details": "Template 'welcome_email' not found or not published"}` |
| 413 | message too large | `{"error": "Message too large", "details": "Message size (45MB) exceeds maximum allowed size of 40MB"}` |
| **422** | **unverified sending domain** | `{"error": "From/Sender domain is not valid or not verified", "details": "The domain from email address 'sender@unverified.com' is not verified in your workspace"}` |
| 429 | rate/daily limit | `{"error": "Rate limit exceeded", "message": "Too many requests. Maximum 10 messages per second allowed.", "limit": 10, "current": 11, "retry_after": 1}` |
| 401 | invalid/missing key (live probe) | `{"statusCode":401,"error":"UnauthorizedError","message":"Invalid API key"}` |

Generic table, https://emailit.com/docs/api-reference/errors/:

> 400 Bad Request - Invalid request parameters
> 401 Unauthorized - Invalid or missing API key
> 403 Forbidden - Access denied to requested resource
> 404 Not Found - Requested resource does not exist
> 429 Too Many Requests - Rate limit exceeded
> 500 Internal Server Error - Something went wrong on our end

**Suppressed recipient is NOT an HTTP error.** Per the statuses page (§7) the send is
accepted and the email immediately gets status `suppressed`; the only signal is the
email status / `email.suppressed` webhook / event log. **Credit exhaustion is not
documented anywhere** in the API reference, guides, pricing FAQ or AUP (searched
for credit/balance/insufficient across every fetched page).

SMTP guide corroborates the domain rule (https://emailit.com/docs/guides/sending-using-smtp/):

> You also need to use the verified sending domain, otherwise the email will not be accepted.

## 6. Rate and daily limits

Source: https://emailit.com/docs/api-reference/rate-limits/ and https://emailit.com/docs/learn/sending-limits/

> Every API endpoint has a rate limit of 2 requests per second. Except for sending emails, which have a different rate limits as explained below.
> Each workspace has two starting rate limits: Per second: 2 requests. Per day: 5000 requests.
> This rate limit is shared between all API keys and API requests and SMTP requests within one workspace.
> Once you go over these limits, you will get a `429` error code.

Response headers on every send (send page, "Rate Limit Headers"):
`ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`, `ratelimit-daily-limit`,
`ratelimit-daily-remaining`, `ratelimit-daily-reset`. (The learn page names them
`X-RateLimit-*`; the send page names them `ratelimit-*`.) Daily limits reset at
midnight UTC.

Four sends in three days is nowhere near either limit.

## 7. Accepted-but-not-delivered: statuses, logs, webhooks

Source: https://emailit.com/docs/learn/email-statuses/

> Every email in Emailit has a status that tells you exactly where it is in its lifecycle. There are 12 statuses …

| status | meaning (verbatim) |
|---|---|
| accepted | The email has been accepted for delivery and is being processed. |
| scheduled | The email is scheduled for delivery at a future time specified by `scheduled_at`. |
| delivered | The email was successfully delivered to the recipient's mail server. |
| bounced | The email permanently failed to deliver. The recipient's mail server rejected the message (hard bounce). |
| attempted | Delivery was attempted but resulted in a temporary failure. The system may retry automatically. |
| failed | The email failed to deliver due to a specific error during the delivery process. |
| rejected | The email was initially accepted for delivery but was rejected afterwards. |
| loaded / clicked | open / click tracking (needs tracking enabled on the domain). |
| suppressed | The recipient's email address is on the suppression list and the email was not sent. |
| received | An incoming email was received on your domain. |
| complained | A spam complaint (feedback loop) was registered for this email by the recipient. |

> If the recipient is on your workspace's suppression list, the email will immediately receive the suppressed status and will not be delivered.
> You can check the current status of any email using the Get Email endpoint, or browse email statuses in the Emailit Dashboard.

The Retry endpoint (https://emailit.com/docs/api-reference/emails/retry/) reveals
three more states not in the 12-status list:

> Retry an email that hard failed, errored, or was held.
> | failed | Yes | Email hard bounced
> | errored | Yes | Email errored during processing
> | held | Yes | Email was held for review
> | pending | No | Email is already queued
> | sent | No | Email already sent

So yes: **a send can return 201/`pending` and then end in `suppressed`, `held`,
`errored`, `rejected`, `failed`, `bounced` or `attempted` without any further HTTP
signal to the caller.** The places it shows:

1. **Get Email** — `GET /v2/emails/{id}` (https://emailit.com/docs/api-reference/emails/get/):
   returns `status`, `message_id`, `headers`, `body`, `created_at`, `updated_at`.
   404 body: `{"error": "Email not found", "message": "Email with ID 'em_abc123' not found in your workspace"}`.
2. **List Emails** — `GET /v2/emails?page=1&limit=10&type=outbound`
   (https://emailit.com/docs/api-reference/emails/list/): paginated `data[]` of
   `{id, type, from, to, subject, status, size, created_at, updated_at, meta}` with
   `next_page_url`. **This is the sent-mail log API.**
3. **Events** — `GET /v2/events?type=email.accepted,email.delivered&include_data=true`
   (https://emailit.com/docs/api-reference/events/list/): "Requires full permission.
   Events are read-only — they are created automatically when actions occur across the API."
   Returns `evt_…` ids with `type` and optional `data.object`.
4. **Webhooks** (https://emailit.com/docs/webhooks/ and /docs/webhooks/event-types/):
   event types `email.accepted, email.scheduled, email.delivered, email.bounced,
   email.attempted, email.failed, email.rejected, email.suppressed, email.received,
   email.complained, email.clicked, email.loaded`. Payload:
   `{"event_id":"evt_…","type":"email.failed","data":{"object":{"id":"em_…","object":"email","from":…,"to":…,"subject":…,"status":"failed","meta":…,"updated_at":…,"created_at":…}}}`.
   **The failure events carry no reason/diagnostic field** — only `status`.
   Requests are `POST`, `User-Agent: Emailit-Webhooks/2.0`, signed with
   `X-Emailit-Signature` = HMAC-SHA256(`{timestamp}.{rawBody}`, `whsec_…`) and
   `X-Emailit-Timestamp`; 7 attempts (5s, 5m, 30m, 2h, 5h, 10h, 24h) then the
   webhook is auto-disabled (https://emailit.com/docs/webhooks/webhook-requests/).
5. **Dashboard** — referenced throughout as the place to "browse email statuses".

The repo registers no EmailIt webhook and never polls Get/List Email, so today the
only post-acceptance signal would be the dashboard or an authenticated
`GET /v2/emails` call.

## 8. Sending-domain DNS requirements

Source: https://emailit.com/docs/api-reference/domains/create/ and
https://emailit.com/docs/api-reference/domains/verify/ (verbatim `dns_records` from
the reference response, domain example `mail.yourdomain.com`):

```json
"dkim_identifier_string": "emailit._domainkey",
"dns_records": [
  {"required": true,  "type": "MX",    "name": "mail.yourdomain.com",              "value": "feedback-smtp.ffdc-1.emailit.com", "priority": 10},
  {"required": true,  "type": "TXT",   "name": "mail.yourdomain.com",              "value": "v=spf1 include:_spf.emailit.com ~all"},
  {"required": true,  "type": "TXT",   "name": "emailit._domainkey.yourdomain.com", "value": "v=DKIM1; t=s; h=sha256; p=MIGfMA0..."},
  {"required": false, "type": "TXT",   "name": "_dmarc.yourdomain.com",            "value": "v=DMARC1; p=none;"},
  {"required": false, "type": "CNAME", "name": "tr.yourdomain.com",                "value": "go.emailitmail.com"},
  {"required": false, "type": "MX",    "name": "inbound.yourdomain.com",           "value": "inbound.emailitmail.com", "priority": 10}
]
```

Verification rules (verify page, verbatim):

> This endpoint checks all DNS records (MX, SPF, DKIM, and DMARC) and updates the domain's verification status.
> The endpoint checks all required DNS records (MX, SPF, DKIM)
> Optional DMARC record is also checked but not required for verification
> The domain is considered verified only when all required records pass
> The `verified_at` timestamp is set when all required checks pass

Per-record `status` values: `ok`, `pending`, `failed`, `missing`; failure example
`"spf_status": "failed", "spf_error": "SPF record not found"`.

Where the records actually live — the guide is more precise than the reference
(https://emailit.com/docs/guides/creating-a-domain/, verbatim):

> Add a TXT record for DKIM verification. Add a TXT record for SPF verification. Add a MX record for email feedback. (Optional) Add a DMARC record for email authentication.
> All these records are setup on a subdomain of the chosen domain. For example, if you choose `mail.example.com` as your domain, you need to add the records to `emailit.mail.example.com`.
> This allows you to use the subdomain to send emails, while the root domain is used for verification and you can use it for other purposes.
> … It can take up to 24 hours for the records to be verified.

So for sending domain `founders.click` EmailIt expects:

| record | hostname | value |
|---|---|---|
| MX (required, return-path/feedback) | `emailit.founders.click` | `10 feedback-smtp.ffdc-1.emailit.com` |
| SPF TXT (required) | `emailit.founders.click` | `v=spf1 include:_spf.emailit.com ~all` |
| DKIM TXT (required), selector `emailit` | `emailit._domainkey.founders.click` | `v=DKIM1; t=s; h=sha256; p=…` |
| DMARC TXT (optional) | `_dmarc.founders.click` | `v=DMARC1; p=none;` |
| tracking CNAME (optional) | `tr.founders.click` | `go.emailitmail.com` |
| inbound MX (optional) | `inbound.founders.click` | `10 inbound.emailitmail.com` |

Live DNS comparison is in `dns-observations.md` (same folder). Summary: all three
**required** records and the optional DMARC record are present with exactly these
values; the two optional tracking/inbound records are absent. Whether the DKIM
public key in DNS is the one EmailIt currently holds for this workspace cannot be
checked from outside.

Note the AUP also imposes a non-DNS rule (https://emailit.com/acceptable-use-policy/):

> APEX of the sending domains need to have a working website with the same information of the sender.

`founders.click` and `www.founders.click` both resolve (A 104.21.75.79 / 172.67.217.144).

## 9. Free / trial accounts, sandbox mode, credits

Source: https://emailit.com/pricing/ (FAQ, verbatim)

> Is there a free tier? We have retired the free tier to ensure the best delivery rates for our customers. Anyone can start sending for as low as $20 with a 30-day money-back guarantee.
> How does the credit system work? Each email action costs a specific number of credits: 1 credit for API/SMTP sends, 2 credits for campaign sends, and 5 credits for email verification. You only pay for what you use.
> Do email credits expire? No, all email credits have no expiration date.
> Are there any sending limits? Sending starts at 2 messages per second and up to 5,000 messages per day.
> Are there any feature limits? There are no limits based on users, sending domains, or credentials.

- **No sandbox / "verified recipients only" mode is documented anywhere.** The
  only "test" hint is the `em_test_` prefix in code samples, whose semantics are
  undocumented.
- Because there is no free tier, a workspace with **zero purchased credits** is a
  plausible state; the docs do not say whether a send then returns an error, is
  accepted and `held`, or is silently dropped. A third-party integration guide
  treats "ran out of credits" as a send failure
  (https://www.gravityforms.com/blog/how-to-send-wordpress-transactional-emails-with-emailit-and-gravity-smtp/:
  "If an email ever fails to send via Emailit for any reason (e.g. you ran out of credits)"),
  and that same (older) guide still describes a 1,000-credit/month free tier the
  pricing page now says was retired — so account age matters for which regime applies.
- A user review describes accepted mail never being attempted, with status
  `Held` — "Recipient … is on the suppression list (reason: too many hard fails)" —
  and "it happens behind the scenes without any notification to the emailit
  subscriber"
  (https://appsumo.com/products/emailit/reviews/another-experience-1-year-later-369496/, Dec 10 2025).
  Anecdotal, but consistent with the documented `held` status.
- AUP (https://emailit.com/acceptable-use-policy/): "Keep your complaint rate below
  0.1%. Maintain a bounce rate under 5%. Exceeding these limits may lead to immediate
  account suspension without prior notice."

## 10. Suppressions API

Source: https://emailit.com/docs/api-reference/suppressions/list/ and /get/

`GET /v2/suppressions`, `GET /v2/suppressions/{id-or-urlencoded-email}`; object:
`{"email": "bounced@example.com", "type": "bounce", "reason": "Hard bounce - mailbox does not exist"}`,
types `recipient`, `bounce`, `complaint`, `unsubscribe`. This is the call that would
show whether `derekbowencorp+fclive-*@gmail.com` / `derekcbowen@outlook.com` are
suppressed in the workspace.

## 11. Idempotency-Key

Only documented sentence: "Unique key (max 256 chars, alphanumeric/dash/underscore)
to prevent duplicate sends for 24 hours." The response to a replayed key is not
documented. Repo usage: `welcome-${workspace_id}` (`src/lib/workspace.functions.ts:159,201`),
`ticket-staff-${ticketId}` / `ticket-user-${ticketId}` (`src/lib/help.server.ts:394,405`),
`ticket-status-${id}-${status}` (`src/lib/help-tickets.functions.ts:166`). The auth
hook sends **no** idempotency key, so confirmation resends are not deduplicated by
EmailIt.

## 12. Raw material

Fetched HTML and text conversions are in the audit scratchpad (not committed).
Pages fetched (all HTTP 200 on 2026-09-05): `/docs/`, `/docs/api-reference/`,
`/docs/api-reference/{authentication,errors,rate-limits,endpoints}/`,
`/docs/api-reference/emails/{send,list,get,retry,cancel,update,meta}/`,
`/docs/api-reference/domains/{create,get,verify,list}/`,
`/docs/api-reference/api-keys/create/`, `/docs/api-reference/events/{list,get}/`,
`/docs/api-reference/suppressions/{list,create}/`, `/docs/api-reference/webhooks/create/`,
`/docs/webhooks/`, `/docs/webhooks/event-types/`, `/docs/webhooks/webhook-requests/`,
`/docs/webhooks/request-signature/`, `/docs/webhooks/events/email/*`,
`/docs/learn/{email-statuses,sending-limits}/`, `/docs/quickstart/{api,smtp}/`,
`/docs/guides/{creating-a-domain,how-to-get-an-api-key,sending-using-smtp}/`,
`/pricing/`, `/acceptable-use-policy/`. 404: `/docs/introduction/`,
`/docs/api-reference/introduction/`, `/help/`, `help.emailit.com`.
